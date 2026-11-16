import { execFile, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  installClaudeOtel,
  installStatuslineCapture,
  revertClaudeOtel,
  revertStatuslineCapture,
  type OtelInstallRecord,
  type StatuslineInstallRecord,
} from './adapters/claude';
import { detectTools, type GeminiProduct, type ToolFinding } from './adapters/detect';
import { startOtlpReceiver, type OtlpServerHandle } from './adapters/otlp';
import {
  Collector,
  defaultDataDir,
  ensureDefaultProfiles,
  machineId,
  newProfile,
  readCollectorStatuses,
  verifyProfile,
  VERSION,
  type CollectorConfig,
} from './collector';
import { buildDemoStore } from './core/demo';
import { label, recommend } from './core/recommend';
import { Store } from './core/store';
import type { ExecutionProfile, Provider, Settings } from './core/types';
import { exists, redact, slug } from './core/util';
import { buildViewModel, CLASS_LABEL, gatherInput, type Range, type ViewModel } from './core/viewmodel';
import { DashboardPanel } from './ui/dashboard';
import { AccountsTree, AlertsTree } from './ui/tree';
import { isLoopback, loadOrCreateToken, startWebServer, type WebHandle } from './web';

let store: Store | undefined;
let collector: Collector | undefined;
let otlp: OtlpServerHandle | undefined;
let otlpError: string | null = null;
let web: WebHandle | undefined;
let lastDetection: { findings: ToolFinding[]; gemini: GeminiProduct } | null = null;
/** Resolves once tool detection has created the default profiles. */
let startup: Promise<void> = Promise.resolve();
let output: vscode.OutputChannel;
const timers: NodeJS.Timeout[] = [];

function cfg() {
  return vscode.workspace.getConfiguration('aiControlCenter');
}

function readSettings(): Settings {
  const c = cfg();
  return {
    timeZone: c.get<string>('timeZone') || 'America/Guayaquil',
    staleMinutes: c.get<number>('staleMinutes') ?? 30,
    thresholds: c.get<number[]>('alertThresholds') ?? [70, 85, 95],
    reservePercent: c.get<number>('reservePercent') ?? 10,
    resetSoonMinutes: c.get<number>('resetSoonMinutes') ?? 15,
  };
}

function dataDir(): string {
  return cfg().get<string>('dataDirectory')?.trim() || defaultDataDir();
}

function collectorConfig(): CollectorConfig {
  const c = cfg();
  return {
    dataDir: dataDir(),
    claudeCommand: c.get<string>('claudeCommand') || 'claude',
    codexCommand: c.get<string>('codexCommand') || 'codex',
    pollMinutes: Math.max(1, c.get<number>('pollMinutes') ?? 5),
    retentionDays: c.get<number>('retentionDays') ?? 90,
    settings: readSettings(),
  };
}

function log(msg: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${redact(msg)}`);
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('AI Control Center');
  ctx.subscriptions.push(output);

  try {
    store = new Store(path.join(dataDir(), 'ai-control-center.sqlite'));
  } catch (e) {
    const msg = `No se pudo abrir la base local (node:sqlite requiere VS Code ≥ 1.101): ${(e as Error).message}`;
    log(msg);
    void vscode.window.showErrorMessage(`AI Control Center: ${msg}`);
    return;
  }
  const st = store;
  const mid = machineId();
  st.touchMachine(mid, mid, `${os.platform()}-${os.arch()}`, new Date().toISOString());
  collector = new Collector(st, collectorConfig(), mid, `ext-${process.pid}-${crypto.randomBytes(3).toString('hex')}`, 'extension');

  const accountsTree = new AccountsTree();
  const alertsTree = new AlertsTree();
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiControlCenter.accounts', accountsTree),
    vscode.window.registerTreeDataProvider('aiControlCenter.alerts', alertsTree),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'aiControlCenter.dashboard';
  status.show();
  ctx.subscriptions.push(status);

  let demo: Store | null = null;
  const getVm = (range: Range = '24h'): ViewModel => {
    const now = new Date();
    if (cfg().get<boolean>('demoMode')) {
      demo ??= buildDemoStore(now);
      return buildViewModel(gatherInput(demo, range, now, readSettings().timeZone), readSettings(), range, now, true);
    }
    return buildViewModel(gatherInput(st, range, now, readSettings().timeZone), readSettings(), range, now, false);
  };

  const refreshUi = () => {
    try {
      const vm = getVm();
      accountsTree.update(vm);
      alertsTree.update(vm);
      status.text = `$(pulse) ${vm.status.text}`;
      status.tooltip = vm.status.tooltip + '\n\nClic: abrir dashboard';
      DashboardPanel.refreshIfOpen();
    } catch (e) {
      log(`refreshUi: ${(e as Error).message}`);
    }
  };

  const notify = (alerts: { severity: string; message: string }[]) => {
    if (!cfg().get<boolean>('notifications')) return;
    for (const a of alerts.slice(0, 3)) {
      const fn = a.severity === 'error' ? vscode.window.showErrorMessage : a.severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void fn(`AI Control Center: ${a.message}`, 'Abrir dashboard').then((x) => {
        if (x) void vscode.commands.executeCommand('aiControlCenter.dashboard');
      });
    }
  };

  let running: Promise<void> | null = null;
  const collect = async (force = false): Promise<void> => {
    if (!collector) return;
    if (running) {
      // A manual refresh during a background run waits for it instead of returning stale data.
      if (force) await running;
      return;
    }
    running = collectNow(force);
    try {
      await running;
    } finally {
      running = null;
    }
  };
  const collectNow = async (force: boolean): Promise<void> => {
    if (!collector) return;
    await startup;
    try {
      collector.cfg = collectorConfig();
      if (force || collector.canPoll()) {
        const r = await collector.runOnce({ force });
        log(`recolección: ${JSON.stringify(r.ingested)}${r.statuses.filter((s) => !s.ok).map((s) => ` · ${s.accountId}: ${s.error}`).join('')}`);
        notify(r.newAlerts);
      }
    } catch (e) {
      log(`recolección falló: ${(e as Error).message}`);
    } finally {
      refreshUi();
    }
  };

  const startOtlpIfNeeded = async () => {
    const enabled = st.listProfiles('claude').some((p) => st.getSetting(`otel:${p.id}`));
    if (!enabled || otlp) return;
    try {
      otlp = await startOtlpReceiver(
        st,
        cfg().get<number>('otlpPort') ?? 4318,
        () => new Set(st.listProfiles('claude').map((p) => p.id)),
        mid,
        (r) => {
          if (r.stored) refreshUi();
        },
      );
      otlpError = null;
      log(`receptor OTLP escuchando en 127.0.0.1:${otlp.port}`);
    } catch (e) {
      otlpError = (e as Error).message;
      // EADDRINUSE: another VS Code window already receives on this port and writes the same database.
      log(`receptor OTLP no iniciado: ${otlpError}`);
    }
  };

  const runDetection = async () => {
    const c = collectorConfig();
    lastDetection = await detectTools(
      vscode.extensions.all.map((e) => ({ id: e.id, version: String(e.packageJSON?.version ?? ''), displayName: e.packageJSON?.displayName })),
      { claude: c.claudeCommand, codex: c.codexCommand },
    );
    const created = ensureDefaultProfiles(st, mid, lastDetection.gemini);
    if (created.length) st.audit('detect', `perfiles creados: ${created.map((p) => p.id).join(', ')}`, new Date().toISOString());
    return { detection: lastDetection, created };
  };

  // ---------------- commands ----------------
  const pickProfile = async (filter: (p: ExecutionProfile) => boolean = () => true, placeHolder = 'Elige un perfil') => {
    const items = st.listProfiles().filter(filter).map((p) => ({ label: label(p), description: [p.plan, p.identityLabel, p.verification].filter(Boolean).join(' · '), p }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No hay perfiles que sirvan para esta acción.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.p;
  };

  const reg = (id: string, fn: (...a: unknown[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('aiControlCenter.dashboard', () => {
    DashboardPanel.show(ctx, getVm, () => {
      st.acknowledgeAlerts();
      refreshUi();
    });
  });

  reg('aiControlCenter.refresh', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'AI Control Center: actualizando' }, () => collect(true));
  });

  reg('aiControlCenter.detectTools', async () => {
    const { detection, created } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Detectando herramientas…' },
      runDetection,
    );
    output.appendLine('\n=== Detección de herramientas ===');
    for (const f of detection.findings) output.appendLine(`${f.found ? '✔' : '✘'} ${f.name}${f.version ? ` ${f.version}` : ''} — ${f.kind} (${f.detail})`);
    output.appendLine(`Gemini: ${detection.gemini.name} — ${detection.gemini.compatibility}`);
    output.appendLine('Una extensión instalada NO equivale a una sesión iniciada; la sesión se verifica con «Probar conector».');
    output.show(true);
    void vscode.window.showInformationMessage(
      `Detectadas ${detection.findings.filter((f) => f.found).length}/${detection.findings.length} piezas. ${created.length ? `Perfiles nuevos: ${created.map((p) => label(p)).join(', ')}.` : ''}`,
    );
    await collect(true);
  });

  reg('aiControlCenter.testConnector', async (node?: unknown) => {
    const p = profileFromNode(st, node) ?? (await pickProfile());
    if (!p) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Probando ${label(p)}…` }, () => verifyProfile(st, collectorConfig(), p));
    refreshUi();
    const msg = `${label(p)}: ${r.ok ? 'OK' : 'FALLO'} — ${r.message}`;
    if (r.ok) void vscode.window.showInformationMessage(msg);
    else {
      const act = r.authProblem && p.provider !== 'gemini' ? await vscode.window.showWarningMessage(msg, 'Abrir terminal para iniciar sesión') : await vscode.window.showWarningMessage(msg);
      if (act) openProfileTerminal(p, true);
    }
  });

  reg('aiControlCenter.linkProfile', async () => {
    const prov = await vscode.window.showQuickPick(
      [
        { label: 'Claude Code', provider: 'claude' as Provider, env: 'CLAUDE_CONFIG_DIR', base: '.claude' },
        { label: 'Codex', provider: 'codex' as Provider, env: 'CODEX_HOME', base: '.codex' },
      ],
      { placeHolder: 'Proveedor del perfil de ejecución (Gemini/Antigravity no admite perfiles aislados verificables)' },
    );
    if (!prov) return;
    const alias = await vscode.window.showInputBox({ prompt: 'Alias del perfil (p. ej. «trabajo», «cuenta 2»)', validateInput: (v) => (v.trim() ? null : 'Escribe un alias') });
    if (!alias) return;
    const id = `${prov.provider}-${slug(alias)}`;
    if (st.getProfile(id)) {
      void vscode.window.showWarningMessage(`Ya existe el perfil ${id}.`);
      return;
    }
    const proposed = path.join(os.homedir(), `${prov.base}-${slug(alias)}`);
    const where = await vscode.window.showQuickPick(
      [
        { label: `Crear carpeta nueva: ${proposed}`, value: 'new' },
        { label: 'Elegir una carpeta existente…', value: 'pick' },
      ],
      { placeHolder: `Carpeta ${prov.env} aislada para este perfil (nunca se copian sesiones entre carpetas)` },
    );
    if (!where) return;
    let dir = proposed;
    if (where.value === 'pick') {
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: `Usar como ${prov.env}` });
      if (!sel?.[0]) return;
      dir = sel[0].fsPath;
    } else fs.mkdirSync(dir, { recursive: true });
    const sep = await vscode.window.showQuickPick(
      [
        { label: 'Sí: entorno de VS Code separado (--user-data-dir) para abrirlo con este perfil', value: true },
        { label: 'No: solo terminal con la variable de entorno', value: false },
      ],
      { placeHolder: 'Un perfil de VS Code NO aísla la sesión OAuth. ¿Crear un entorno separado?' },
    );
    const p = newProfile(prov.provider, id, alias.trim(), dir, mid);
    if (sep?.value) p.vscodeUserDataDir = path.join(dataDir(), 'vscode-profiles', id);
    st.upsertProfile(p);
    st.audit('link-profile', `${id} (${prov.env}=${path.basename(dir)})`, new Date().toISOString());
    const r = await verifyProfile(st, collectorConfig(), p);
    refreshUi();
    if (r.ok) void vscode.window.showInformationMessage(`${label(p)} vinculado: ${r.message}`);
    else {
      const act = await vscode.window.showInformationMessage(
        `${label(p)} creado, pero aún sin sesión (${r.message}). Inicia sesión TÚ desde la herramienta oficial en una terminal con ${prov.env} y luego usa «Probar conector».`,
        'Abrir terminal para iniciar sesión',
      );
      if (act) openProfileTerminal(p, true);
    }
  });

  reg('aiControlCenter.editProfile', async (node?: unknown) => {
    const p = profileFromNode(st, node) ?? (await pickProfile());
    if (!p) return;
    const act = await vscode.window.showQuickPick(
      [
        { label: 'Cambiar alias', v: 'alias' },
        { label: p.enabled ? 'Deshabilitar' : 'Habilitar', v: 'toggle' },
        ...(p.provider === 'claude' ? [{ label: `Fuente de tokens: ${p.tokenSource} → cambiar`, v: 'tokens' }] : []),
        ...(p.provider === 'gemini' ? [{ label: `Plan declarado: ${p.plan ?? 'ninguno'} → cambiar`, v: 'plan' }] : []),
        { label: 'Quitar perfil (borra su historial local; no toca la herramienta)', v: 'delete' },
      ],
      { placeHolder: label(p) },
    );
    if (!act) return;
    if (act.v === 'alias') {
      const a = await vscode.window.showInputBox({ value: p.alias, prompt: 'Nuevo alias' });
      if (a?.trim()) p.alias = a.trim();
    } else if (act.v === 'toggle') p.enabled = !p.enabled;
    else if (act.v === 'tokens') p.tokenSource = p.tokenSource === 'otel' ? 'transcript' : 'otel';
    else if (act.v === 'plan') {
      // Antigravity does not report the plan: it is the user's declaration and is labelled as such.
      const v = await vscode.window.showInputBox({ prompt: 'Plan de la cuenta (lo declaras tú; Antigravity no lo informa)', value: (p.plan ?? 'Google AI Pro').replace(/ \(declarado\)$/, '') });
      if (v === undefined) return;
      p.plan = v.trim() ? `${v.trim()} (declarado)` : null;
    }
    else if (act.v === 'delete') {
      const ok = await vscode.window.showWarningMessage(`¿Quitar ${label(p)} y su historial local?`, { modal: true }, 'Quitar');
      if (ok !== 'Quitar') return;
      st.deleteProfile(p.id);
      st.audit('delete-profile', p.id, new Date().toISOString());
      refreshUi();
      return;
    }
    st.upsertProfile(p);
    st.audit('edit-profile', `${p.id}: ${act.v}`, new Date().toISOString());
    refreshUi();
  });

  reg('aiControlCenter.showDataSource', async (node?: unknown) => {
    const p = profileFromNode(st, node) ?? (await pickProfile());
    if (!p) return;
    const vm = getVm();
    const pv = vm.profiles.find((x) => x.id === p.id);
    output.appendLine(`\n=== Origen de los datos: ${label(p)} ===`);
    output.appendLine(`Perfil ${p.id} · carpeta ${p.configDir ? path.basename(p.configDir) : '—'} · verificación ${p.verification} (${p.verificationDetail ?? ''})`);
    if (!pv?.buckets.length) output.appendLine('Cuota oficial: No disponible.');
    for (const b of pv?.buckets ?? []) {
      output.appendLine(`- ${b.label}: ${b.usedPercent ?? '—'} % · fuente ${b.source} · confianza ${b.confidence} · observado ${b.observedLocal} (${b.age}) · reinicio ${b.resetsLocal} · estado ${b.state} (${b.reason})`);
    }
    const how: Record<Provider, string> = {
      codex: 'Cuota: `codex app-server` → account/rateLimits/read (todos los buckets de rateLimitsByLimitId). Identidad: account/read (refreshToken=false). Tokens diarios: account/usage/read. Consumo local: sessions/**/rollout-*.jsonl (eventos token_count; solo contadores).',
      claude: 'Identidad/plan: `claude auth status`. Cuota 5 h / 7 d: statusLine (rate_limits), solo si habilitaste la captura y usas `claude` en terminal. Consumo local: projects/**/*.jsonl (message.usage; solo contadores) u OTel si lo habilitaste.',
      gemini: 'Sin interfaz oficial de cuota para el producto detectado. Solo detección y registro manual etiquetado.',
    };
    output.appendLine(how[p.provider]);
    output.show(true);
  });

  reg('aiControlCenter.chooseNext', async () => {
    const s = readSettings();
    const r = recommend(st.listProfiles(), st.latestQuotas(), { now: new Date(), staleMinutes: s.staleMinutes, reservePercent: s.reservePercent });
    st.recordRecommendation('general', r.ranked.map((c) => ({ id: c.profile.id, cls: c.classification, score: c.score })), r.selected?.profile.id ?? null, r.summary, new Date().toISOString());
    const pick = await vscode.window.showQuickPick(
      r.ranked.map((c) => ({
        label: `${c === r.selected ? '$(star-full) ' : c.eligible ? '' : '$(circle-slash) '}${label(c.profile)}`,
        description: CLASS_LABEL[c.classification] ?? c.classification,
        detail: c.rationale,
        c,
      })),
      { placeHolder: r.summary, matchOnDetail: true },
    );
    if (!pick) return;
    const p = pick.c.profile;
    if (!pick.c.eligible) {
      const go = await vscode.window.showWarningMessage(`${label(p)} no es recomendable ahora: ${pick.c.rationale}. ¿Continuar igualmente?`, 'Continuar');
      if (!go) return;
    }
    const actions = [
      ...(p.provider !== 'gemini' ? [{ label: 'Abrir terminal con este perfil', v: 'term' }] : []),
      ...(p.vscodeUserDataDir && p.verification === 'verified' ? [{ label: 'Abrir VS Code con este perfil', v: 'code' }] : []),
      { label: 'Solo registrar la elección', v: 'none' },
    ];
    const a = await vscode.window.showQuickPick(actions, { placeHolder: `${label(p)} — ninguna sesión se cambia sin tu acción` });
    if (a?.v === 'term') openProfileTerminal(p, false);
    if (a?.v === 'code') openVsCodeWithProfile(p);
  });

  reg('aiControlCenter.openTerminal', async (node?: unknown) => {
    const p = profileFromNode(st, node) ?? (await pickProfile((x) => x.provider !== 'gemini'));
    if (p) openProfileTerminal(p, false);
  });

  reg('aiControlCenter.openProfile', async () => {
    const p = await pickProfile((x) => !!x.vscodeUserDataDir, 'Perfiles con entorno de VS Code propio');
    if (!p) return;
    if (p.verification !== 'verified') {
      void vscode.window.showWarningMessage(`${label(p)} no está verificado (${p.verificationDetail ?? 'sin verificar'}). Usa «Probar conector» primero.`);
      return;
    }
    openVsCodeWithProfile(p);
  });

  reg('aiControlCenter.export', async () => {
    const fmt = await vscode.window.showQuickPick(['JSON (todas las tablas)', 'CSV (una tabla)'], { placeHolder: 'Formato' });
    if (!fmt) return;
    const tables = ['provider_accounts', 'quota_snapshots', 'token_usage_events', 'account_daily_usage', 'provider_sessions', 'cost_events', 'routing_recommendations', 'alerts', 'audit_logs'];
    const scrub = (rows: Record<string, unknown>[]) =>
      rows.map((r) => {
        const o: Record<string, unknown> = { ...r };
        for (const k of ['config_dir', 'vscode_user_data_dir']) if (typeof o[k] === 'string') o[k] = path.basename(o[k] as string);
        return o;
      });
    if (fmt.startsWith('JSON')) {
      const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, defaultUri: vscode.Uri.file(path.join(os.homedir(), `ai-control-center-${new Date().toISOString().slice(0, 10)}.json`)) });
      if (!uri) return;
      const data: Record<string, unknown> = { exportedAt: new Date().toISOString(), version: VERSION };
      for (const t of tables) data[t] = scrub(st.dumpTable(t));
      fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2));
      void vscode.window.showInformationMessage(`Exportado: ${uri.fsPath}`);
    } else {
      const t = await vscode.window.showQuickPick(tables, { placeHolder: 'Tabla' });
      if (!t) return;
      const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(path.join(os.homedir(), `${t}.csv`)) });
      if (!uri) return;
      fs.writeFileSync(uri.fsPath, toCsv(scrub(st.dumpTable(t))));
      void vscode.window.showInformationMessage(`Exportado: ${uri.fsPath}`);
    }
  });

  reg('aiControlCenter.diagnostics', async () => {
    if (!lastDetection) await runDetection();
    const o = output;
    o.appendLine('\n=== Diagnóstico AI Control Center ===');
    o.appendLine(`Versión ${VERSION} · VS Code ${vscode.version} · Node ${process.versions.node} · ${os.platform()} ${os.arch()} · remoteName=${vscode.env.remoteName ?? 'local'}`);
    o.appendLine(`Base: ${path.join(dataDir(), 'ai-control-center.sqlite')} · esquema v${st.schemaVersion()} · equipo ${mid}`);
    for (const f of lastDetection?.findings ?? []) o.appendLine(`${f.found ? '✔' : '✘'} ${f.name} ${f.version ?? ''}`);
    o.appendLine(`Gemini: ${lastDetection?.gemini.name} — ${lastDetection?.gemini.compatibility}`);
    for (const p of st.listProfiles()) {
      const sl = st.getSetting(`statusline:${p.id}`) ? 'captura statusLine: sí' : 'captura statusLine: no';
      const ot = st.getSetting(`otel:${p.id}`) ? 'OTel: sí' : 'OTel: no';
      o.appendLine(`Perfil ${p.id} (${label(p)}): ${p.verification} · ${p.verificationDetail ?? ''}${p.provider === 'claude' ? ` · ${sl} · ${ot}` : ''}`);
    }
    for (const c of readCollectorStatuses(st)) o.appendLine(`Recolector ${c.accountId}: ${c.ok ? 'OK' : `ERROR ${c.error}`} (${c.at})`);
    for (const h of st.heartbeats()) o.appendLine(`Latido ${h.kind} ${h.holder}: ${h.lastSeen}`);
    o.appendLine(`Receptor OTLP: ${otlp ? `127.0.0.1:${otlp.port} · ${JSON.stringify(otlp.stats)}` : otlpError ? `no iniciado (${otlpError})` : 'apagado (no hay perfiles con OTel)'}`);
    // Secret-leak self-check over everything stored locally.
    const leaks: string[] = [];
    for (const t of ['provider_accounts', 'quota_snapshots', 'token_usage_events', 'provider_sessions', 'alerts', 'audit_logs']) {
      for (const row of st.dumpTable(t)) {
        const { identity_label: _masked, ...rest } = row;
        const txt = JSON.stringify(rest);
        if (redact(txt) !== txt) leaks.push(t);
      }
    }
    o.appendLine(`Autocomprobación de secretos en la base: ${leaks.length ? `REVISAR (${[...new Set(leaks)].join(', ')})` : 'sin tokens, JWT ni correos completos'}`);
    o.appendLine('Últimas acciones auditadas:');
    for (const a of st.auditLog(10)) o.appendLine(`  ${a.at} ${a.action} ${a.detail ?? ''}`);
    o.show(true);
  });

  reg('aiControlCenter.enableClaudeQuotaCapture', async () => {
    const p = await pickProfile((x) => x.provider === 'claude' && !!x.configDir && !st.getSetting(`statusline:${x.id}`), 'Perfil de Claude donde capturar la cuota');
    if (!p || !p.configDir) return;
    const node = await findNode();
    if (!node) {
      void vscode.window.showErrorMessage('No encontré `node` en el PATH; el captador statusLine lo necesita.');
      return;
    }
    const settingsPath = path.join(p.configDir, 'settings.json');
    const ok = await vscode.window.showWarningMessage(
      `Se modificará ${settingsPath}: la clave statusLine pasará a un captador que guarda rate_limits (5 h / 7 d) y luego ejecuta tu statusLine actual sin cambios. Antes se hace una copia de respaldo; «Claude: revertir captura» lo deshace. Solo funciona con sesiones \`claude\` en terminal (el panel gráfico no ejecuta statusLine).`,
      { modal: true },
      'Habilitar',
    );
    if (ok !== 'Habilitar') return;
    try {
      const rec = installStatuslineCapture({ profile: p, dataDir: dataDir(), nodePath: node, wrapperSource: path.join(ctx.extensionPath, 'resources', 'statusline-capture.js') });
      st.setSetting(`statusline:${p.id}`, JSON.stringify(rec));
      st.audit('statusline-install', `${p.id} respaldo=${rec.backup ? path.basename(rec.backup) : 'sin archivo previo'}`, new Date().toISOString());
      void vscode.window.showInformationMessage(`Captura habilitada en ${label(p)}. Tras la próxima respuesta de \`claude\` en terminal aparecerán los porcentajes. Respaldo: ${rec.backup ?? 'no había settings.json'}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`No se habilitó: ${(e as Error).message}`);
    }
  });

  reg('aiControlCenter.disableClaudeQuotaCapture', async () => {
    const p = await pickProfile((x) => !!st.getSetting(`statusline:${x.id}`), 'Perfil con captura statusLine');
    if (!p) return;
    const rec = JSON.parse(st.getSetting(`statusline:${p.id}`)!) as StatuslineInstallRecord;
    const r = revertStatuslineCapture(rec);
    if (r.reverted) st.db.prepare('DELETE FROM settings WHERE key = ?').run(`statusline:${p.id}`);
    st.audit('statusline-revert', `${p.id}: ${r.reason}`, new Date().toISOString());
    void vscode.window.showInformationMessage(`${label(p)}: ${r.reason}`);
  });

  reg('aiControlCenter.enableClaudeOtel', async () => {
    const p = await pickProfile((x) => x.provider === 'claude' && !!x.configDir && !st.getSetting(`otel:${x.id}`), 'Perfil de Claude para telemetría local');
    if (!p || !p.configDir) return;
    const port = cfg().get<number>('otlpPort') ?? 4318;
    const ok = await vscode.window.showWarningMessage(
      `Se añadirán variables OTEL_* y CLAUDE_CODE_ENABLE_TELEMETRY=1 al bloque env de ${path.join(p.configDir, 'settings.json')} (respaldo previo). Claude enviará métricas de tokens/costo/sesiones SOLO a 127.0.0.1:${port}; no se activan logs ni prompts. Las sesiones nuevas de Claude (terminal y extensión) lo aplicarán. La fuente de tokens del perfil pasará a OTel para no contar dos veces.`,
      { modal: true },
      'Habilitar',
    );
    if (ok !== 'Habilitar') return;
    try {
      const rec = installClaudeOtel({ profile: p, dataDir: dataDir(), port });
      st.setSetting(`otel:${p.id}`, JSON.stringify(rec));
      p.tokenSource = 'otel';
      st.upsertProfile(p);
      st.audit('otel-install', `${p.id} puerto ${port}`, new Date().toISOString());
      await startOtlpIfNeeded();
      refreshUi();
      void vscode.window.showInformationMessage(`Telemetría local habilitada para ${label(p)}. Respaldo: ${rec.backup ?? 'no había settings.json'}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`No se habilitó: ${(e as Error).message}`);
    }
  });

  reg('aiControlCenter.disableClaudeOtel', async () => {
    const p = await pickProfile((x) => !!st.getSetting(`otel:${x.id}`), 'Perfil con telemetría local');
    if (!p) return;
    const rec = JSON.parse(st.getSetting(`otel:${p.id}`)!) as OtelInstallRecord;
    const r = revertClaudeOtel(rec);
    st.db.prepare('DELETE FROM settings WHERE key = ?').run(`otel:${p.id}`);
    p.tokenSource = 'transcript';
    st.upsertProfile(p);
    st.audit('otel-revert', `${p.id}: ${r.reason}`, new Date().toISOString());
    refreshUi();
    void vscode.window.showInformationMessage(`${label(p)}: ${r.reason}`);
  });

  reg('aiControlCenter.manualSnapshot', async () => {
    const p = await pickProfile();
    if (!p) return;
    const lim = await vscode.window.showInputBox({ prompt: 'Nombre de la ventana o límite (como lo muestra la herramienta oficial)', value: p.provider === 'gemini' ? 'cuota diaria' : '5 h' });
    if (!lim) return;
    const used = await vscode.window.showInputBox({ prompt: '% usado que muestra la herramienta oficial (0-100)', validateInput: (v) => (/^\d+(\.\d+)?$/.test(v) && Number(v) <= 100 ? null : 'Número 0-100') });
    if (!used) return;
    const hrs = await vscode.window.showInputBox({ prompt: '¿En cuántas horas se reinicia? (vacío = desconocido)', validateInput: (v) => (!v || /^\d+(\.\d+)?$/.test(v) ? null : 'Número de horas') });
    const now = new Date();
    st.insertQuota(mid, {
      accountId: p.id,
      limitId: `manual:${slug(lim)}`,
      limitLabel: `${lim} (manual)`,
      windowMinutes: null,
      usedPercent: Number(used),
      remainingPercent: 100 - Number(used),
      resetsAt: hrs ? new Date(now.getTime() + Number(hrs) * 3600000).toISOString() : null,
      source: 'manual',
      confidence: 'low',
      observedAt: now.toISOString(),
      status: 'estimated',
      extra: { enteredBy: 'usuario' },
    });
    st.audit('manual-snapshot', `${p.id} ${lim}=${used}%`, now.toISOString());
    refreshUi();
  });

  reg('aiControlCenter.openWeb', async () => {
    const host = cfg().get<string>('webHost') || '127.0.0.1';
    const port = cfg().get<number>('webPort') ?? 4320;
    const token = loadOrCreateToken(dataDir());
    if (!isLoopback(host)) {
      const ok = await vscode.window.showWarningMessage(
        `El panel escuchará en ${host}:${port}: cualquier equipo de tu red podrá pedirlo. Sigue siendo de solo lectura y exige el token. ¿Continuar?`,
        { modal: true },
        'Abrir en la red',
      );
      if (ok !== 'Abrir en la red') return;
    }
    if (!web) {
      try {
        web = await startWebServer(st, { host, port, token, settings: readSettings });
        st.audit('web-start', `${host}:${web.port}`, new Date().toISOString());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          void vscode.window.showErrorMessage(`No se pudo abrir el panel web: ${(e as Error).message}`);
          return;
        }
        // Another window or the resident agent already serves it (same database, same token).
      }
    }
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const url = `http://${shown}:${web?.port ?? port}/?token=${token}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const pick = await vscode.window.showInformationMessage('Panel web abierto en el navegador.', 'Copiar URL con token');
    if (pick) await vscode.env.clipboard.writeText(url);
  });

  reg('aiControlCenter.installAgent', async () => {
    if (process.platform !== 'win32') {
      void vscode.window.showInformationMessage('El instalador del agente residente está implementado solo para Windows. En macOS/Linux ejecútalo a mano: node dist/agent.js --data-dir <carpeta> (ver docs/install.md).');
      return;
    }
    const node = await findNode();
    if (!node) {
      void vscode.window.showErrorMessage('No encontré `node` (≥ 22.13) en el PATH.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'El agente residente sigue leyendo cuotas y archivos locales con VS Code cerrado. Se añadirá una entrada de inicio de sesión en HKCU\\…\\Run («AIControlCenterAgent») que lanza node oculto. «Desinstalar monitoreo» la quita.',
      { modal: true },
      'Instalar',
    );
    if (ok !== 'Instalar') return;
    const bin = path.join(dataDir(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(path.join(ctx.extensionPath, 'dist', 'agent.js'), path.join(bin, 'agent.js'));
    const c = collectorConfig();
    const vbs = path.join(bin, 'agent-launch.vbs');
    const args = `""${node}"" ""${path.join(bin, 'agent.js')}"" --data-dir ""${dataDir()}"" --interval ${c.pollMinutes} --claude ""${c.claudeCommand}"" --codex ""${c.codexCommand}"" --web --web-host ${cfg().get<string>('webHost') || '127.0.0.1'} --web-port ${cfg().get<number>('webPort') ?? 4320}`;
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${args}", 0, False\r\n`);
    await execP('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AIControlCenterAgent', '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    st.audit('agent-install', vbs, new Date().toISOString());
    void vscode.window.showInformationMessage('Agente residente instalado e iniciado.');
  });

  reg('aiControlCenter.uninstallMonitoring', async () => {
    const ok = await vscode.window.showWarningMessage(
      'Se revertirán las capturas statusLine y la telemetría OTel instaladas por esta extensión, se quitará el agente residente y se detendrá el receptor local. Tus sesiones y credenciales no se tocan.',
      { modal: true },
      'Desinstalar',
    );
    if (ok !== 'Desinstalar') return;
    const report: string[] = [];
    for (const p of st.listProfiles('claude')) {
      const sl = st.getSetting(`statusline:${p.id}`);
      if (sl) {
        const r = revertStatuslineCapture(JSON.parse(sl) as StatuslineInstallRecord);
        if (r.reverted) st.db.prepare('DELETE FROM settings WHERE key = ?').run(`statusline:${p.id}`);
        report.push(`${p.id} statusLine: ${r.reason}`);
      }
      const ot = st.getSetting(`otel:${p.id}`);
      if (ot) {
        const r = revertClaudeOtel(JSON.parse(ot) as OtelInstallRecord);
        st.db.prepare('DELETE FROM settings WHERE key = ?').run(`otel:${p.id}`);
        p.tokenSource = 'transcript';
        st.upsertProfile(p);
        report.push(`${p.id} OTel: ${r.reason}`);
      }
    }
    if (process.platform === 'win32') {
      const r = await execP('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AIControlCenterAgent', '/f']);
      report.push(`agente (registro de inicio): ${r.ok ? 'quitado' : 'no estaba instalado'}`);
      const pidFile = path.join(dataDir(), 'agent.pid');
      if (exists(pidFile)) {
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
          report.push('agente detenido');
        } catch {
          report.push('agente no estaba en ejecución');
        }
      }
    }
    if (web) {
      await web.close();
      web = undefined;
      report.push('panel web detenido');
    }
    if (otlp) {
      await otlp.close();
      otlp = undefined;
      report.push('receptor OTLP detenido');
    }
    st.audit('uninstall-monitoring', report.join(' | '), new Date().toISOString());
    output.appendLine('\n=== Desinstalar monitoreo ===\n' + report.join('\n'));
    output.show(true);
    const del = await vscode.window.showWarningMessage('¿Borrar también el historial local (base SQLite)?', { modal: true }, 'Borrar historial');
    if (del === 'Borrar historial') {
      void vscode.window.showInformationMessage(`Cierra VS Code y borra la carpeta ${dataDir()} (la base está abierta mientras la extensión corre).`);
    }
    refreshUi();
  });

  // ---------------- lifecycle ----------------
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiControlCenter')) {
        demo = null;
        refreshUi();
      }
    }),
    { dispose: () => timers.forEach((t) => clearInterval(t)) },
    { dispose: () => collector?.release() },
    { dispose: () => void otlp?.close() },
    { dispose: () => void web?.close() },
    { dispose: () => st.close() },
  );

  refreshUi();
  startup = (async () => {
    await runDetection().catch((e) => log(`detección falló: ${(e as Error).message}`));
    refreshUi();
    await startOtlpIfNeeded();
  })();
  void startup.then(() => collect(false));
  timers.push(setInterval(() => void collect(false), collectorConfig().pollMinutes * 60000));
  // Cheap UI refresh from the shared database (picks up data written by other windows / the agent).
  timers.push(setInterval(refreshUi, 30000));
}

export function deactivate(): void {
  timers.forEach((t) => clearInterval(t));
}

// ---------------- helpers ----------------

function profileFromNode(st: Store, node: unknown): ExecutionProfile | undefined {
  const n = node as { kind?: string; p?: { id: string } } | undefined;
  return n?.kind === 'profile' && n.p ? st.getProfile(n.p.id) : undefined;
}

function profileEnv(p: ExecutionProfile): Record<string, string> {
  if (!p.configDir) return {};
  return p.provider === 'claude' ? { CLAUDE_CONFIG_DIR: p.configDir } : p.provider === 'codex' ? { CODEX_HOME: p.configDir } : {};
}

function openProfileTerminal(p: ExecutionProfile, forLogin: boolean): void {
  const t = vscode.window.createTerminal({ name: `AI · ${label(p)}`, env: profileEnv(p) });
  t.show();
  // Pre-filled, NOT executed: the user starts the official login/session themselves.
  if (forLogin) t.sendText(p.provider === 'claude' ? 'claude auth login' : 'codex login', false);
  else t.sendText(p.provider === 'claude' ? 'claude' : 'codex', false);
}

function openVsCodeWithProfile(p: ExecutionProfile): void {
  if (!p.vscodeUserDataDir) return;
  fs.mkdirSync(p.vscodeUserDataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...profileEnv(p) };
  // The extension host runs with ELECTRON_RUN_AS_NODE and VSCODE_* IPC variables: drop them so a
  // fresh VS Code main process starts (a separate --user-data-dir is what makes the env stick).
  for (const k of Object.keys(env)) if (k.startsWith('VSCODE_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const args = ['--user-data-dir', p.vscodeUserDataDir, '--new-window', ...(folder ? [folder] : [])];
  spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' }).unref();
  void vscode.window.showInformationMessage(`Abriendo VS Code con ${label(p)} (entorno separado). Si es la primera vez, instala allí las extensiones que uses.`);
}

function execP(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout) })));
}

async function findNode(): Promise<string | null> {
  const r = await execP(process.platform === 'win32' ? 'where' : 'which', ['node']);
  const first = r.out.split(/\r?\n/).find((l) => l.trim());
  return r.ok && first ? first.trim() : null;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
