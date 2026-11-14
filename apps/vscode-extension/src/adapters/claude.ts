import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailJsonl } from '../core/jsonl';
import type { Store } from '../core/store';
import type { ExecutionProfile, QuotaSnapshot } from '../core/types';
import { maskEmail, projectName, redact, sha256, shellCommand, toIso } from '../core/util';

export const defaultClaudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');

// ---------------- identity: `claude auth status` (official command) ----------------

export interface ClaudeAuthResult {
  ok: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  plan: string | null;
  identityLabel: string | null;
  identityHash: string | null;
  configDirectory: string | null;
  error: string | null;
}

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthResult {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) {
    return { ok: false, loggedIn: false, authMethod: null, plan: null, identityLabel: null, identityHash: null, configDirectory: null, error: 'salida no reconocida de claude auth status' };
  }
  const j = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  const idSource = (j.orgId as string) ?? (j.email as string) ?? null;
  return {
    ok: true,
    loggedIn: j.loggedIn === true,
    authMethod: (j.authMethod as string) ?? null,
    plan: (j.subscriptionType as string) ?? null,
    identityLabel: maskEmail(j.email as string),
    identityHash: idSource ? sha256(`claude:${idSource}`) : null,
    configDirectory: (j.configDirectory as string) ?? null,
    error: null,
  };
}

export function readClaudeAuth(command: string, configDir: string | null, timeoutMs = 25000): Promise<ClaudeAuthResult> {
  const env = { ...process.env };
  if (configDir && path.resolve(configDir) !== path.resolve(path.join(os.homedir(), '.claude'))) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return new Promise((resolve) => {
    const sc = shellCommand(command, ['auth', 'status']);
    execFile(
      sc.file,
      sc.args,
      { env, timeout: timeoutMs, windowsHide: true, shell: sc.shell, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          if (stdout && stdout.includes('{')) {
            resolve(parseClaudeAuthStatus(stdout));
            return;
          }
        } catch {
          /* fall through */
        }
        resolve({
          ok: false,
          loggedIn: false,
          authMethod: null,
          plan: null,
          identityLabel: null,
          identityHash: null,
          configDirectory: null,
          error: redact((err?.message ?? '') + ' ' + (stderr ?? '')).trim() || 'sin salida',
        });
      },
    );
  });
}

// ---------------- quota capture through statusLine (opt-in, reversible) ----------------

export interface StatuslineInstallRecord {
  profileId: string;
  settingsPath: string;
  previous: unknown; // the user's statusLine value before install (null = none)
  installedCommand: string;
  backup: string | null;
  installedAt: string;
}

export function statuslineInboxPath(dataDir: string): string {
  return path.join(dataDir, 'inbox', 'claude-statusline.jsonl');
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

export function buildStatuslineCommand(nodePath: string, wrapperPath: string, profileId: string, inbox: string, previousCommand: string | null): string {
  let cmd = `"${fwd(nodePath)}" "${fwd(wrapperPath)}" --profile ${profileId} --inbox "${fwd(inbox)}"`;
  if (previousCommand) cmd += ` --wrap ${Buffer.from(previousCommand, 'utf8').toString('base64')}`;
  return cmd;
}

function readJsonFile(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${p} no es un objeto JSON`);
  return parsed as Record<string, unknown>;
}

function backupFile(p: string, dataDir: string, tag: string): string | null {
  if (!fs.existsSync(p)) return null;
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(p, dest);
  return dest;
}

/**
 * Wraps (never replaces) the user's statusLine: the wrapper records rate_limits and then runs the
 * original command with the same stdin, printing its output unchanged. Backup first; reversible.
 */
export function installStatuslineCapture(opts: {
  profile: ExecutionProfile;
  dataDir: string;
  nodePath: string;
  wrapperSource: string;
}): StatuslineInstallRecord {
  const { profile, dataDir } = opts;
  if (!profile.configDir) throw new Error('el perfil no tiene carpeta de configuración');
  const settingsPath = path.join(profile.configDir, 'settings.json');
  const settings = readJsonFile(settingsPath);
  const prev = settings.statusLine ?? null;
  const prevObj = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : null;
  if (prevObj && typeof prevObj.command === 'string' && prevObj.command.includes('statusline-capture.js')) {
    throw new Error('la captura ya está instalada en este perfil');
  }
  const binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, 'statusline-capture.js');
  fs.copyFileSync(opts.wrapperSource, wrapperPath);
  const inbox = statuslineInboxPath(dataDir);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  const previousCommand = prevObj && typeof prevObj.command === 'string' ? prevObj.command : null;
  const command = buildStatuslineCommand(opts.nodePath, wrapperPath, profile.id, inbox, previousCommand);
  const backup = backupFile(settingsPath, dataDir, `claude-settings-${profile.id}`);
  const next: Record<string, unknown> = { type: 'command', command };
  if (prevObj?.padding !== undefined) next.padding = prevObj.padding;
  if (prevObj?.refreshInterval !== undefined) next.refreshInterval = prevObj.refreshInterval;
  if (prevObj?.hideVimModeIndicator !== undefined) next.hideVimModeIndicator = prevObj.hideVimModeIndicator;
  settings.statusLine = next;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { profileId: profile.id, settingsPath, previous: prev, installedCommand: command, backup, installedAt: new Date().toISOString() };
}

/** Restores the previous statusLine only if ours is still in place; otherwise touches nothing. */
export function revertStatuslineCapture(rec: StatuslineInstallRecord): { reverted: boolean; reason: string } {
  const settings = readJsonFile(rec.settingsPath);
  const cur = settings.statusLine as Record<string, unknown> | undefined;
  if (!cur || cur.command !== rec.installedCommand) {
    return { reverted: false, reason: `statusLine fue modificado después de instalar; no se toca. Respaldo: ${rec.backup ?? 'no había archivo'}` };
  }
  if (rec.previous === null || rec.previous === undefined) delete settings.statusLine;
  else settings.statusLine = rec.previous;
  fs.writeFileSync(rec.settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { reverted: true, reason: 'statusLine restaurado' };
}

/** Inbox line written by resources/statusline-capture.js */
export interface StatuslineCapture {
  profile: string;
  observedAt: string;
  sessionId?: string | null;
  model?: string | null;
  project?: string | null;
  version?: string | null;
  costUsd?: number | null;
  rateLimits?: Record<string, { used_percentage?: number; resets_at?: number; used_usd?: number; limit_usd?: number; period?: string }> | null;
}

const CLAUDE_WINDOWS: Record<string, { label: string; minutes: number | null }> = {
  five_hour: { label: '5 h', minutes: 300 },
  seven_day: { label: '7 d', minutes: 10080 },
  spend_limit: { label: 'límite de gasto', minutes: null },
};

export function statuslineCaptureToSnapshots(c: StatuslineCapture): QuotaSnapshot[] {
  const out: QuotaSnapshot[] = [];
  if (!c.rateLimits) return out;
  for (const [key, w] of Object.entries(c.rateLimits)) {
    if (!w || typeof w.used_percentage !== 'number') continue;
    const meta = CLAUDE_WINDOWS[key] ?? { label: key, minutes: null };
    out.push({
      accountId: c.profile,
      limitId: key,
      limitLabel: meta.label,
      windowMinutes: meta.minutes,
      usedPercent: w.used_percentage,
      remainingPercent: Math.max(0, 100 - w.used_percentage),
      resetsAt: toIso(w.resets_at ?? null),
      source: 'claude-statusline',
      confidence: 'high',
      observedAt: c.observedAt,
      status: 'live',
      extra: w.period ? { period: w.period, usedUsd: w.used_usd ?? null, limitUsd: w.limit_usd ?? null } : null,
    });
  }
  return out;
}

export async function ingestStatuslineInbox(store: Store, dataDir: string, machineId: string): Promise<number> {
  const inbox = statuslineInboxPath(dataDir);
  let n = 0;
  const known = new Set(store.listProfiles('claude').map((p) => p.id));
  await tailJsonl(
    store,
    inbox,
    () => true,
    (rec) => {
      const c = rec as unknown as StatuslineCapture;
      if (!c.profile || !known.has(c.profile) || !c.observedAt) return;
      for (const s of statuslineCaptureToSnapshots(c)) if (store.insertQuota(machineId, s)) n++;
      if (c.sessionId) {
        store.upsertSession({
          sessionKey: `${c.profile}:${c.sessionId}`,
          accountId: c.profile,
          machineId,
          project: c.project ? projectName(c.project) : null,
          model: c.model ?? null,
          startedAt: c.observedAt,
          lastSeenAt: c.observedAt,
          source: 'claude-statusline',
        });
        if (typeof c.costUsd === 'number') {
          // Cumulative per session, estimated by Claude Code: the latest value replaces the earlier one.
          store.upsertCost({
            eventKey: `claude-sl:${c.profile}:${c.sessionId}`,
            accountId: c.profile,
            amount: c.costUsd,
            currency: 'USD',
            costBasis: 'estimated',
            timestamp: c.observedAt,
            source: 'claude-statusline',
          });
        }
      }
    },
  );
  return n;
}

// ---------------- OpenTelemetry env (opt-in, reversible) ----------------

export interface OtelInstallRecord {
  profileId: string;
  settingsPath: string;
  previousEnv: Record<string, string | null>;
  installedEnv: Record<string, string>;
  backup: string | null;
  installedAt: string;
}

export function otelEnvFor(profileId: string, port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_METRIC_EXPORT_INTERVAL: '30000',
    OTEL_RESOURCE_ATTRIBUTES: `acc.profile=${profileId}`,
  };
}

export function installClaudeOtel(opts: { profile: ExecutionProfile; dataDir: string; port: number }): OtelInstallRecord {
  const { profile } = opts;
  if (!profile.configDir) throw new Error('el perfil no tiene carpeta de configuración');
  const settingsPath = path.join(profile.configDir, 'settings.json');
  const settings = readJsonFile(settingsPath);
  const env = (settings.env && typeof settings.env === 'object' ? settings.env : {}) as Record<string, string>;
  const wanted = otelEnvFor(profile.id, opts.port);
  const conflicts = Object.keys(wanted).filter((k) => env[k] !== undefined && env[k] !== wanted[k]);
  if (conflicts.length) {
    throw new Error(`ya tienes telemetría propia configurada (${conflicts.join(', ')}); no se sobrescribe`);
  }
  const previousEnv: Record<string, string | null> = {};
  for (const k of Object.keys(wanted)) previousEnv[k] = env[k] ?? null;
  const backup = backupFile(settingsPath, opts.dataDir, `claude-settings-${profile.id}`);
  settings.env = { ...env, ...wanted };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { profileId: profile.id, settingsPath, previousEnv, installedEnv: wanted, backup, installedAt: new Date().toISOString() };
}

export function revertClaudeOtel(rec: OtelInstallRecord): { reverted: boolean; reason: string } {
  const settings = readJsonFile(rec.settingsPath);
  const env = (settings.env && typeof settings.env === 'object' ? { ...(settings.env as Record<string, string>) } : {}) as Record<string, string>;
  const changed = Object.keys(rec.installedEnv).filter((k) => env[k] !== rec.installedEnv[k]);
  for (const [k, v] of Object.entries(rec.previousEnv)) {
    if (changed.includes(k)) continue; // edited by the user afterwards: leave it alone
    if (v === null) delete env[k];
    else env[k] = v;
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  fs.writeFileSync(rec.settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return {
    reverted: true,
    reason: changed.length ? `restaurado, salvo variables que editaste después: ${changed.join(', ')}` : 'variables de telemetría retiradas',
  };
}
