// Runs inside the Extension Development Host. Writes a JSON report to $ACC_SMOKE_OUT and throws on failure.
'use strict';
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const report = { checks: [] };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    if (!ok) throw new Error(`FALLÓ: ${name} ${detail ? JSON.stringify(detail) : ''}`);
  };
  try {
    const ext = vscode.extensions.getExtension('ai-control-center.ai-control-center');
    check('extensión presente', !!ext);
    await ext.activate();
    check('extensión activa', ext.isActive);

    const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
    const registered = await vscode.commands.getCommands(true);
    const missing = declared.filter((c) => !registered.includes(c));
    check('todos los comandos registrados', missing.length === 0, { declared: declared.length, missing });

    await vscode.commands.executeCommand('aiControlCenter.refresh');
    const dbPath = path.join(process.env.ACC_SMOKE_DATA, 'ai-control-center.sqlite');
    check('base SQLite creada en dataDirectory', fs.existsSync(dbPath), dbPath);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // Right after "Actualizar datos" the profiles must already be verified through the official tools.
    const profiles = db.prepare('SELECT id, provider, verification, plan FROM provider_accounts').all();
    check('perfiles detectados', profiles.length >= 2, profiles.map((p) => `${p.id}:${p.verification}:${p.plan}`));
    for (const p of profiles.filter((x) => x.provider !== 'gemini')) {
      check(`perfil ${p.id} verificado con la herramienta oficial`, p.verification === 'verified' && !!p.plan, p);
    }
    const codexQuota = db
      .prepare("SELECT limit_id, limit_label, used_percent, resets_at, source FROM quota_snapshots WHERE source = 'codex-app-server' ORDER BY id DESC LIMIT 2")
      .all();
    check('cuota oficial de Codex leída del App Server', codexQuota.length > 0, codexQuota);
    report.codexQuota = codexQuota;
    const gem = profiles.find((p) => p.provider === 'gemini');
    if (gem) check('Gemini marcado sin soporte de cuota', gem.verification === 'unsupported', gem);

    await vscode.commands.executeCommand('aiControlCenter.dashboard');
    await sleep(1500);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    check('dashboard abierto como pestaña', tabs.includes('AI Control Center'), tabs);

    await vscode.commands.executeCommand('aiControlCenter.diagnostics');
    check('diagnóstico ejecutado', true);

    await vscode.workspace.getConfiguration('aiControlCenter').update('demoMode', true, vscode.ConfigurationTarget.Global);
    await sleep(500);
    const demoRows = db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE id LIKE 'demo-%'").get();
    check('modo demo no escribe en la base real', Number(demoRows.n) === 0);
    await vscode.workspace.getConfiguration('aiControlCenter').update('demoMode', false, vscode.ConfigurationTarget.Global);
    db.close();
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.message);
    throw e;
  } finally {
    fs.writeFileSync(process.env.ACC_SMOKE_OUT, JSON.stringify(report, null, 2));
  }
};
