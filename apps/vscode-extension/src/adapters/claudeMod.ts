import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Store } from '../core/store';
import type { ExecutionProfile, QuotaSnapshot } from '../core/types';
import { toIso } from '../core/util';

/**
 * Reader for the «ai-control-center-feed» Claude Code mod (apps/claude-mod).
 *
 * The mod listens to Claude Code's official `session.measure` event — the status line's own figures, pushed after
 * each turn and whenever a rate-limit window moves a whole point — in EVERY surface (terminal and the VS Code
 * panel, where the statusLine command never runs) and writes `<data dir>/inbox/claude-mod-<session>.json`:
 *   { source, version, observedAt, sessionId, claudeConfigDir, rateLimits: [{ kind, percentUsed, resetsAt }],
 *     context: { percent, tokens, window }, costUsd }
 */

export interface ModFeed {
  source: 'claude-mod';
  version?: string;
  observedAt: string;
  sessionId: string;
  claudeConfigDir: string | null;
  rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[];
  context?: { percent: number | null; tokens: number | null; window: number } | null;
  costUsd?: number | null;
}

const WINDOWS: Record<string, { limitId: string; label: string; minutes: number | null }> = {
  five_hour: { limitId: 'five_hour', label: '5 h', minutes: 300 },
  seven_day: { limitId: 'seven_day', label: '7 d', minutes: 10080 },
  spend_limit: { limitId: 'spend_limit', label: 'límite de gasto', minutes: null },
};

/** The profile whose CLAUDE_CONFIG_DIR wrote the file (no variable = the default ~/.claude). */
export function profileForConfigDir(profiles: ExecutionProfile[], configDir: string | null): ExecutionProfile | undefined {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const target = norm(configDir ?? path.join(os.homedir(), '.claude'));
  return profiles.find((p) => p.provider === 'claude' && p.configDir && norm(p.configDir) === target);
}

export function feedToSnapshots(accountId: string, f: ModFeed): QuotaSnapshot[] {
  return (f.rateLimits ?? [])
    .filter((r) => r && typeof r.percentUsed === 'number')
    .map((r) => {
      const w = WINDOWS[r.kind] ?? { limitId: r.kind, label: r.kind, minutes: null };
      const used = Math.max(0, r.percentUsed);
      return {
        accountId,
        limitId: w.limitId,
        limitLabel: w.label,
        windowMinutes: w.minutes,
        usedPercent: used,
        remainingPercent: Math.max(0, 100 - used),
        resetsAt: toIso(r.resetsAt),
        source: 'claude-mod',
        confidence: 'high',
        observedAt: f.observedAt,
        status: 'live',
        extra: null,
      } satisfies QuotaSnapshot;
    });
}

/** Reads every changed claude-mod-*.json in the inbox. Returns the number of new quota snapshots. */
export function ingestClaudeModInbox(store: Store, dataDir: string, machineId: string): number {
  const inbox = path.join(dataDir, 'inbox');
  try {
    fs.mkdirSync(inbox, { recursive: true }); // the mod writes only where this folder exists
  } catch {
    return 0;
  }
  let names: string[];
  try {
    names = fs.readdirSync(inbox).filter((n) => /^claude-mod-[A-Za-z0-9_-]+\.json$/.test(n));
  } catch {
    return 0;
  }
  const profiles = store.listProfiles('claude');
  let n = 0;
  for (const name of names) {
    const file = path.join(inbox, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const cur = store.getCursor(file);
    if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) continue;
    let f: ModFeed;
    try {
      f = JSON.parse(fs.readFileSync(file, 'utf8')) as ModFeed;
    } catch {
      continue; // being written: next pass
    }
    store.setCursor(file, st.size, st.size, st.mtimeMs);
    if (f.source !== 'claude-mod' || !f.observedAt || !f.sessionId) continue;
    const p = profileForConfigDir(profiles, f.claudeConfigDir);
    if (!p) continue;
    for (const s of feedToSnapshots(p.id, f)) if (store.insertQuota(machineId, s)) n++;
    store.upsertSession({
      sessionKey: `${p.id}:${f.sessionId}`,
      accountId: p.id,
      machineId,
      project: null,
      model: null,
      startedAt: f.observedAt,
      lastSeenAt: f.observedAt,
      source: 'claude-mod',
    });
    if (typeof f.costUsd === 'number') {
      store.upsertCost({ eventKey: `claude-mod:${p.id}:${f.sessionId}`, accountId: p.id, amount: f.costUsd, currency: 'USD', costBasis: 'estimated', timestamp: f.observedAt, source: 'claude-mod' });
    }
    // Context fill of the most recently measured session, shown on the card.
    const prev = store.getSetting(`claude-context:${p.id}`);
    const prevAt = prev ? (JSON.parse(prev) as { at: string }).at : '';
    if (f.context && f.observedAt >= prevAt) {
      store.setSetting(`claude-context:${p.id}`, JSON.stringify({ at: f.observedAt, sessionId: f.sessionId, percent: f.context.percent, tokens: f.context.tokens, window: f.context.window }));
    }
  }
  return n;
}
