/**
 * Optional resident agent: same collectors as the extension, without VS Code.
 *   node agent.js --data-dir <dir> [--interval 5] [--claude claude] [--codex codex] [--once]
 *                 [--web [--web-host 127.0.0.1] [--web-port 4320]]   local read-only web panel
 * Read-only towards the providers; writes only to its own SQLite database.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTools } from './adapters/detect';
import { Collector, defaultDataDir, ensureDefaultProfiles, machineId } from './collector';
import { Store } from './core/store';
import { redact } from './core/util';
import { isLoopback, loadOrCreateToken, startWebServer } from './web';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const dataDir = arg('--data-dir', defaultDataDir())!;
  const interval = Math.max(1, Number(arg('--interval', '5')));
  const once = process.argv.includes('--once');
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'agent.log');
  const log = (m: string) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${redact(m)}\n`);
  const store = new Store(path.join(dataDir, 'ai-control-center.sqlite'));
  const mid = machineId();
  store.touchMachine(mid, mid, `${os.platform()}-${os.arch()}`, new Date().toISOString());
  const commands = { claude: arg('--claude', 'claude')!, codex: arg('--codex', 'codex')! };
  const det = await detectTools([], commands);
  ensureDefaultProfiles(store, mid, det.gemini.product === 'none' ? null : det.gemini);
  const agentSettings = { timeZone: 'America/Guayaquil', staleMinutes: 30, thresholds: [70, 85, 95], reservePercent: 10, resetSoonMinutes: 15 };
  const collector = new Collector(
    store,
    {
      dataDir,
      claudeCommand: commands.claude,
      codexCommand: commands.codex,
      pollMinutes: interval,
      retentionDays: 90,
      settings: agentSettings,
    },
    mid,
    `agent-${process.pid}`,
    'agent',
  );
  if (!once) fs.writeFileSync(path.join(dataDir, 'agent.pid'), String(process.pid));
  // When its own file is replaced (extension update, rebuild), the agent starts the new version and leaves:
  // the login entry keeps working and nobody has to kill it by hand.
  const self = path.resolve(process.argv[1] ?? '');
  const mtime = () => {
    try {
      return fs.statSync(self).mtimeMs;
    } catch {
      return 0;
    }
  };
  const startedMtime = mtime();
  const tick = async () => {
    if (!once && startedMtime && mtime() > startedMtime) {
      log('nueva versión del agente: reiniciando');
      collector.release();
      store.close();
      spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      process.exit(0);
    }
    try {
      if (once || collector.canPoll()) {
        const r = await collector.runOnce();
        log(`ok ${JSON.stringify(r.ingested)} alertas nuevas=${r.newAlerts.length}`);
        if (once) process.stdout.write(JSON.stringify({ ingested: r.ingested, statuses: r.statuses }, null, 2) + '\n');
      }
    } catch (e) {
      log(`error ${(e as Error).message}`);
    }
  };
  await tick();
  if (once) {
    collector.release();
    store.close();
    return;
  }
  setInterval(() => void tick(), interval * 60000);
  // The new-version check runs every minute, not only on each collection.
  if (interval > 1) setInterval(() => {
    if (startedMtime && mtime() > startedMtime) void tick();
  }, 60000);
  if (process.argv.includes('--web')) {
    const host = arg('--web-host', '127.0.0.1')!;
    const port = Number(arg('--web-port', '4320'));
    try {
      const web = await startWebServer(store, { host, port, token: loadOrCreateToken(dataDir), settings: () => agentSettings });
      fs.writeFileSync(path.join(dataDir, 'web-url.txt'), web.url + '\n', { mode: 0o600 });
      log(`panel web en ${host}:${web.port}${isLoopback(host) ? '' : ' (accesible en la red: requiere token)'}`);
      process.stdout.write(`Panel web: ${web.url}\n`);
    } catch (e) {
      log(`panel web no iniciado: ${(e as Error).message}`);
    }
  }
  const stop = () => {
    collector.release();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
