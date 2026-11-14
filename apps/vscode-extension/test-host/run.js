// Smoke test inside a real VS Code (Extension Development Host), isolated user-data/extensions dirs.
//   node test-host/run.js [path-to-Code-executable]
// Uses the locally installed VS Code (no download). Providers are read-only: detection, `claude auth
// status`, `codex app-server` reads. The extension's database goes to a temporary directory.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const exe =
    process.argv[2] ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')
      : process.platform === 'darwin'
        ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
        : 'code');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-smoke-'));
  const userData = path.join(tmp, 'user-data');
  const dataDir = path.join(tmp, 'acc-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'aiControlCenter.dataDirectory': dataDir, 'aiControlCenter.notifications': false, 'workbench.startupEditor': 'none' }),
  );
  const out = path.join(tmp, 'result.json');
  // Do not inherit the parent VS Code's IPC variables (they would attach to the running instance).
  for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_') || k === 'ELECTRON_RUN_AS_NODE') delete process.env[k];
  process.env.ACC_SMOKE_OUT = out;
  process.env.ACC_SMOKE_DATA = dataDir;
  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: ['--user-data-dir', userData, '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
  } finally {
    if (fs.existsSync(out)) process.stdout.write(fs.readFileSync(out, 'utf8') + '\n');
  }
}

main().catch((e) => {
  process.stderr.write(`smoke test FAILED: ${e && e.message}\n`);
  process.exit(1);
});
