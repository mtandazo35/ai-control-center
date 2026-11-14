import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Store } from '../core/store';
import type { ExecutionProfile } from '../core/types';

/**
 * Google Antigravity has no usage/quota interface: it does not write percentages or tokens anywhere.
 * What its own logs DO contain (verified with agy 1.5.3, 2026-11-09):
 *   - each run: start, model (`Print mode: starting (… model="X"` / `Resolving model X`), conversation id,
 *     tool steps (`step N`), end (last line);
 *   - the server's quota error: `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 120h0m0s.`
 * Only that is read: never the prompt, the conversation content or the auth state files.
 * Logs are glog lines `IMMDD HH:MM:SS.uuuuuu pid file:line] msg` in the PC's local time; the year comes from
 * the file name `cli-YYYYMMDD_HHMMSS.log`.
 */

export const defaultAntigravityLogDirs = (): string[] => [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log'),
  path.join(os.homedir(), '.gemini', 'antigravity', 'log'),
];

export interface AntigravityRun {
  file: string;
  conversationId: string | null;
  model: string | null;
  printMode: boolean;
  startedAt: string;
  endedAt: string;
  steps: number;
  exhausted: { at: string; resetsAt: string | null; message: string } | null;
  failed: boolean;
}

const LINE = /^([IWEF])(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,6})\s+\d+\s+\S+\]\s?(.*)$/;
const FILE = /cli-(\d{4})(\d{2})(\d{2})_\d{6}\.log$/;
const RESETS_IN = /Resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;

/** glog timestamp (local time) → ISO UTC. The file's year is used; December→January rolls over. */
export function glogTime(fileYear: number, fileMonth: number, mm: string, dd: string, hh: string, mi: string, ss: string, us: string): string {
  const month = Number(mm);
  const year = month < fileMonth ? fileYear + 1 : fileYear;
  const d = new Date(year, month - 1, Number(dd), Number(hh), Number(mi), Number(ss), Math.floor(Number(us.padEnd(6, '0')) / 1000));
  return d.toISOString();
}

export function parseResetsIn(msg: string): number | null {
  const m = RESETS_IN.exec(msg);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Parses one log file into a run. Returns null for files without any timestamped line. */
export function parseAntigravityLog(file: string, text: string): AntigravityRun | null {
  const fm = FILE.exec(path.basename(file));
  const fileYear = fm ? Number(fm[1]) : new Date().getFullYear();
  const fileMonth = fm ? Number(fm[2]) : new Date().getMonth() + 1;
  let first: string | null = null;
  let last: string | null = null;
  const run: AntigravityRun = { file, conversationId: null, model: null, printMode: false, startedAt: '', endedAt: '', steps: 0, exhausted: null, failed: false };
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const at = glogTime(fileYear, fileMonth, m[2], m[3], m[4], m[5], m[6], m[7]);
    first ??= at;
    last = at;
    const msg = m[8];
    if (!run.model) {
      const mm = /model="([^"]+)"/.exec(msg) ?? /Resolving model (\S+)/.exec(msg);
      if (mm) run.model = mm[1];
    }
    if (msg.includes('Print mode:')) run.printMode = true;
    if (!run.conversationId) {
      const c = /(?:Created conversation|conversation=)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(msg);
      if (c) run.conversationId = c[1];
    }
    const st = /\bstep (\d+)\b/.exec(msg);
    if (st) run.steps = Math.max(run.steps, Number(st[1]));
    if (/RESOURCE_EXHAUSTED|quota reached|quota exceeded/i.test(msg) && !run.exhausted) {
      const ms = parseResetsIn(msg);
      const q = /(Individual quota reached[^.]*\.|[A-Za-z ]*quota (?:reached|exceeded)[^.]*\.)/i.exec(msg);
      run.exhausted = {
        at,
        resetsAt: ms === null ? null : new Date(new Date(at).getTime() + ms).toISOString(),
        message: (q ? q[1] : 'cuota agotada').trim(),
      };
    }
    if (m[1] === 'E' && /run ended with error/.test(msg)) run.failed = true;
  }
  if (!first || !last) return null;
  run.startedAt = first;
  run.endedAt = last;
  return run;
}

/**
 * Files are small (KB): a changed file is parsed again whole and written idempotently (same keys).
 * Unchanged files (same size + mtime) are skipped through the shared ingest cursor.
 */
export function ingestAntigravityLogs(
  store: Store,
  profile: ExecutionProfile,
  machineId: string,
  dirs: string[] = defaultAntigravityLogDirs(),
): { files: number; runs: number; exhaustions: number } {
  const out = { files: 0, runs: 0, exhaustions: 0 };
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /^cli-.*\.log$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      out.files++;
      const cur = store.getCursor(file);
      if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) continue;
      const run = parseAntigravityLog(file, fs.readFileSync(file, 'utf8'));
      store.setCursor(file, st.size, st.size, st.mtimeMs);
      if (!run) continue;
      applyAntigravityRun(store, profile.id, machineId, run);
      out.runs++;
      if (run.exhausted) out.exhaustions++;
    }
  }
  return out;
}

export function applyAntigravityRun(store: Store, accountId: string, machineId: string, run: AntigravityRun): void {
  // Daemon logs of the VS Code extension carry no model/conversation: they only matter for quota errors.
  if (run.model || run.conversationId) {
    store.upsertSession({
      sessionKey: `${accountId}:${run.conversationId ?? path.basename(run.file)}`,
      accountId,
      machineId,
      project: null,
      model: run.model,
      startedAt: run.startedAt,
      lastSeenAt: run.endedAt,
      source: 'antigravity-log',
    });
  }
  if (run.exhausted) {
    store.insertQuota(machineId, {
      accountId,
      limitId: 'agy:individual',
      limitLabel: 'cuota individual',
      windowMinutes: null,
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: run.exhausted.resetsAt,
      source: 'antigravity-log',
      confidence: 'medium',
      observedAt: run.exhausted.at,
      status: 'live',
      extra: { serverMessage: run.exhausted.message, model: run.model },
    });
  } else if (run.steps > 0 && !run.failed) {
    // A run that worked proves the quota was NOT exhausted at that moment, but the percentage is still unknown.
    store.insertQuota(machineId, {
      accountId,
      limitId: 'agy:individual',
      limitLabel: 'cuota individual',
      windowMinutes: null,
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      source: 'antigravity-log',
      confidence: 'medium',
      observedAt: run.endedAt,
      status: 'unavailable',
      extra: { note: 'ejecución completada: había cuota; Antigravity no publica el porcentaje', model: run.model },
    });
  }
}
