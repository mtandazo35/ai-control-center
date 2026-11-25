import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Store } from '../core/store';
import type { ExecutionProfile, QuotaSnapshot } from '../core/types';
import { slug, toIso } from '../core/util';

/**
 * Claude subscription quota without touching any configuration.
 *
 * 1. `cachedUsageUtilization` in Claude Code's state file (`~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json`):
 *    Claude Code stores there the same data `/usage` shows (verified with 2.1.319, 2026-11-09):
 *    `{ fetchedAtMs, accountUuid, utilization: { limits: [{ kind, group, percent, severity, resets_at, scope, is_active }],
 *    five_hour, seven_day, … } }`. UNDOCUMENTED internal cache: if its shape changes, nothing is shown (never a guess).
 *    ONLY that key is read; the rest of the file (projects, account, settings) is ignored and nothing else is stored.
 * 2. The limit notice Claude Code writes into the transcript when a limit is hit:
 *    `You've hit your 5-hour limit · resets 4:30pm (America/Guayaquil)` (synthetic message, error = rate_limit).
 */

export function claudeStateFile(configDir: string | null): string {
  const def = path.join(os.homedir(), '.claude');
  if (!configDir || path.resolve(configDir) === path.resolve(def)) return path.join(os.homedir(), '.claude.json');
  return path.join(configDir, '.claude.json');
}

interface CacheLimit {
  kind?: string;
  group?: string;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null; id?: string | null } | null; surface?: string | null } | null;
}

/** Same limit ids as the statusLine capture (five_hour / seven_day) so every source shares one timeline. */
function limitIdentity(l: CacheLimit): { limitId: string; label: string; minutes: number | null } {
  const model = l.scope?.model?.display_name ?? l.scope?.model?.id ?? null;
  const surface = l.scope?.surface ?? null;
  const suffix = model ? ` · ${model}` : surface ? ` · ${surface}` : '';
  const idSuffix = model ? `:${slug(model)}` : surface ? `:${slug(surface)}` : '';
  if (l.kind === 'session' || l.group === 'session') return { limitId: `five_hour${idSuffix}`, label: `5 h${suffix}`, minutes: 300 };
  if (l.group === 'weekly' || /weekly/.test(l.kind ?? '')) return { limitId: `seven_day${idSuffix}`, label: `7 d${suffix}`, minutes: 10080 };
  const k = l.kind ?? 'limite';
  return { limitId: `${slug(k)}${idSuffix}`, label: `${k}${suffix}`, minutes: null };
}

export function usageCacheToSnapshots(accountId: string, cache: unknown): QuotaSnapshot[] {
  if (!cache || typeof cache !== 'object') return [];
  const c = cache as { fetchedAtMs?: number; utilization?: { limits?: CacheLimit[]; five_hour?: { utilization?: number; resets_at?: string | null } | null; seven_day?: { utilization?: number; resets_at?: string | null } | null } };
  const observedAt = typeof c.fetchedAtMs === 'number' ? toIso(c.fetchedAtMs) : null;
  const u = c.utilization;
  if (!observedAt || !u || typeof u !== 'object') return [];
  let limits: CacheLimit[] = Array.isArray(u.limits) ? u.limits.filter((l) => l && typeof l.percent === 'number') : [];
  if (!limits.length) {
    // Older shape: only the five_hour / seven_day objects.
    limits = [];
    if (u.five_hour && typeof u.five_hour.utilization === 'number') limits.push({ kind: 'session', percent: u.five_hour.utilization, resets_at: u.five_hour.resets_at ?? null });
    if (u.seven_day && typeof u.seven_day.utilization === 'number') limits.push({ kind: 'weekly_all', group: 'weekly', percent: u.seven_day.utilization, resets_at: u.seven_day.resets_at ?? null });
  }
  return limits.map((l) => {
    const id = limitIdentity(l);
    const used = Math.max(0, Math.min(100, Number(l.percent)));
    return {
      accountId,
      limitId: id.limitId,
      limitLabel: id.label,
      windowMinutes: id.minutes,
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: toIso(l.resets_at ?? null),
      source: 'claude-usage-cache',
      confidence: 'medium',
      observedAt,
      status: 'live',
      extra: { severity: l.severity ?? null, active: l.is_active ?? null, kind: l.kind ?? null },
    } satisfies QuotaSnapshot;
  });
}

/** Reads only `cachedUsageUtilization`; returns the number of new snapshots. */
export function ingestClaudeUsageCache(store: Store, profile: ExecutionProfile, machineId: string, file = claudeStateFile(profile.configDir)): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let cache: unknown;
  try {
    cache = (JSON.parse(raw) as Record<string, unknown>).cachedUsageUtilization;
  } catch {
    return 0;
  }
  let n = 0;
  for (const s of usageCacheToSnapshots(profile.id, cache)) if (store.insertQuota(machineId, s)) n++;
  return n;
}

// ---------------- limit notice in the transcript ----------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const NOTICE =
  /hit your ([\w -]+?) limit\b[^\n]*?resets\s+(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

/** Offset (ms) of an IANA zone at a given instant: local wall time − UTC. */
function zoneOffset(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return guess - zoneOffset(guess - zoneOffset(guess, tz), tz);
}

export interface LimitNotice {
  limitId: string;
  label: string;
  windowMinutes: number | null;
  resetsAt: string | null;
}

/** "You've hit your 5-hour limit · resets 5:30pm (America/Guayaquil)" written at `at` → next 17:30 in that zone. */
export function parseLimitNotice(text: string, at: string): LimitNotice | null {
  const m = NOTICE.exec(text);
  if (!m) return null;
  const kind = m[1].toLowerCase().trim();
  let id: { limitId: string; label: string; windowMinutes: number | null };
  if (/5-hour|five|session/.test(kind)) id = { limitId: 'five_hour', label: '5 h', windowMinutes: 300 };
  else if (/week|7-day/.test(kind)) {
    const model = kind.replace(/weekly|7-day|limit/g, '').trim();
    id = model ? { limitId: `seven_day:${slug(model)}`, label: `7 d · ${model}`, windowMinutes: 10080 } : { limitId: 'seven_day', label: '7 d', windowMinutes: 10080 };
  } else id = { limitId: slug(kind), label: kind, windowMinutes: null };

  let tz = (m[7] ?? 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  let h = Number(m[4]);
  const mi = Number(m[5] ?? 0);
  const ap = m[6]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const base = new Date(at).getTime();
  const off = zoneOffset(base, tz);
  const wall = new Date(base + off); // wall-clock of the notice in tz, read with getUTC*
  let y = wall.getUTCFullYear();
  let mo = wall.getUTCMonth() + 1;
  let d = wall.getUTCDate();
  if (m[2] && MONTHS[m[2].toLowerCase()]) {
    mo = MONTHS[m[2].toLowerCase()];
    d = Number(m[3]);
    if (mo < wall.getUTCMonth() + 1) y += 1;
  }
  let reset = wallToUtc(y, mo, d, h, mi, tz);
  if (!m[2]) while (reset <= base) reset += 86400000; // "resets 1:20am" = the next 1:20am after the notice
  return { ...id, resetsAt: new Date(reset).toISOString() };
}

export function noticeToSnapshot(accountId: string, n: LimitNotice, at: string): QuotaSnapshot {
  return {
    accountId,
    limitId: n.limitId,
    limitLabel: n.label,
    windowMinutes: n.windowMinutes,
    usedPercent: 100,
    remainingPercent: 0,
    resetsAt: n.resetsAt,
    source: 'claude-transcript',
    confidence: 'medium',
    observedAt: at,
    status: 'live',
    extra: { notice: 'límite alcanzado (aviso de Claude Code)' },
  };
}

// ---------------- 5-hour window estimated from local activity ----------------

const H5 = 5 * 3600000;
const TEN_MIN = 600000;

/**
 * Claude's 5-hour window starts with the first message after the previous one ended, rounded down to 10 minutes
 * (checked against real limit notices: about 70 % exact, the rest ±10 min or usage from another surface).
 * ESTIMATE ONLY: it sees this machine's activity, not claude.ai or other machines, and gives a reset time, never a %.
 */
export function inferFiveHourWindow(timestamps: number[], now: number): { start: number; end: number; firstMessage: number } | null {
  let cur: { start: number; end: number; firstMessage: number } | null = null;
  for (const t of [...timestamps].sort((a, b) => a - b)) {
    if (t > now) break;
    if (!cur || t >= cur.end) {
      const start = Math.floor(t / TEN_MIN) * TEN_MIN;
      cur = { start, end: start + H5, firstMessage: t };
    }
  }
  return cur && now < cur.end ? cur : null;
}

/**
 * Adds an estimated five_hour snapshot ONLY when the official data does not know the current window
 * (no reset time, or a reset time that belongs to another window). Official data, when it arrives, wins.
 */
export function estimateClaudeSession(store: Store, accountId: string, machineId: string, now = new Date()): boolean {
  const since = new Date(now.getTime() - 48 * 3600000).toISOString();
  const ts = (
    store.db
      .prepare("SELECT timestamp FROM token_usage_events WHERE account_id = ? AND source = 'claude-transcript' AND timestamp >= ?")
      .all(accountId, since) as { timestamp: string }[]
  ).map((r) => Date.parse(r.timestamp));
  const w = inferFiveHourWindow(ts, now.getTime());
  if (!w) return false;
  // The newest REAL reading, read directly: through latestQuotas() an earlier estimate would hide it, and every pass
  // would write a new estimate over the real data.
  const official = store.latestQuota(accountId, 'five_hour', 'claude-activity-estimate');
  const knows = official && official.resetsAt && Math.abs(Date.parse(official.resetsAt) - w.end) <= 15 * 60000 && Date.parse(official.observedAt) >= w.firstMessage - 60000;
  if (knows) return false;
  store.insertQuota(machineId, {
    accountId,
    limitId: 'five_hour',
    limitLabel: '5 h',
    windowMinutes: 300,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: new Date(w.end).toISOString(),
    source: 'claude-activity-estimate',
    confidence: 'low',
    observedAt: now.toISOString(),
    status: 'estimated',
    extra: { windowStart: new Date(w.start).toISOString(), note: 'reinicio estimado por la actividad de este PC; % sin dato oficial' },
  });
  return true;
}
