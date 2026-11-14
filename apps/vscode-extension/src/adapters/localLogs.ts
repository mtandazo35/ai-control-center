import * as path from 'node:path';
import { tailJsonl } from '../core/jsonl';
import type { Store } from '../core/store';
import type { ExecutionProfile } from '../core/types';
import { projectName, toIso, walk } from '../core/util';
import { noticeToSnapshot, parseLimitNotice } from './claudeUsage';
import { codexRateLimitsToSnapshots, rolloutRateLimitsToResponse } from './codexAppServer';

/**
 * Local consumption readers. They read *metadata only* (usage counters, model, session id,
 * project folder name). Prompt and tool content is filtered before parsing and never stored.
 */

export interface IngestStats {
  files: number;
  records: number;
  bytes: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------------- Claude Code transcripts ----------------

/** <configDir>/projects/<project>/<session>.jsonl (and subagent transcripts below it). */
export async function ingestClaudeTranscripts(store: Store, profile: ExecutionProfile, machineId: string): Promise<IngestStats> {
  const stats: IngestStats = { files: 0, records: 0, bytes: 0 };
  if (!profile.configDir) return stats;
  const root = path.join(profile.configDir, 'projects');
  const files = walk(root, (f) => f.endsWith('.jsonl'), 4);
  // Parser v2 also reads the limit notices: re-read every transcript once (idempotent upserts) to recover old ones.
  const verKey = `parser:claude-transcripts:${profile.id}`;
  if (store.getSetting(verKey) !== '2') {
    store.db.prepare('DELETE FROM ingest_cursors WHERE path LIKE ?').run(`${root}%`);
    store.setSetting(verKey, '2');
  }
  for (const f of files) {
    stats.files++;
    const r = await tailJsonl(
      store,
      f,
      (line) => line.includes('"type":"assistant"') && (line.includes('"usage"') || line.includes('hit your')),
      (rec) => {
        if (applyClaudeTranscriptRecord(store, profile.id, machineId, rec)) stats.records++;
      },
    );
    stats.bytes += r.bytesRead;
  }
  return stats;
}

export function applyClaudeTranscriptRecord(
  store: Store,
  accountId: string,
  machineId: string,
  rec: Record<string, unknown>,
): boolean {
  if (rec.type !== 'assistant') return false;
  const msg = rec.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!msg) return false;
  const ts = toIso(rec.timestamp as string) ?? new Date().toISOString();
  if (msg.model === '<synthetic>') {
    // Synthetic messages are not API usage; the only one that matters is the limit notice.
    const content = msg.content;
    const text = Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join(' ')
      : typeof content === 'string' ? content : '';
    const n = text.includes('hit your') ? parseLimitNotice(text, ts) : null;
    if (!n) return false;
    store.insertQuota(machineId, noticeToSnapshot(accountId, n, ts));
    return true;
  }
  const model = typeof msg.model === 'string' ? msg.model : null;
  if (!model || !usage || typeof msg.id !== 'string') return false;
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null;
  // One API message is written as several lines (one per content block) with the same id:
  // the event key is the message id, and the last line wins (upsert).
  store.upsertTokenEvent({
    eventKey: `claude:${accountId}:${msg.id}`,
    accountId,
    sessionId,
    model,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cachedTokens: num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    timestamp: ts,
    source: 'claude-transcript',
  });
  if (sessionId) {
    store.upsertSession({
      sessionKey: `${accountId}:${sessionId}`,
      accountId,
      machineId,
      project: projectName(rec.cwd as string),
      model,
      startedAt: ts,
      lastSeenAt: ts,
      source: 'claude-transcript',
    });
  }
  return true;
}

// ---------------- Codex rollouts ----------------

const ROLLOUT_RE = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl */
export async function ingestCodexRollouts(store: Store, profile: ExecutionProfile, machineId: string): Promise<IngestStats> {
  const stats: IngestStats = { files: 0, records: 0, bytes: 0 };
  if (!profile.configDir) return stats;
  const root = path.join(profile.configDir, 'sessions');
  const files = walk(root, (f) => /rollout-.*\.jsonl$/.test(f), 5);
  for (const f of files) {
    stats.files++;
    const sessionId = ROLLOUT_RE.exec(path.basename(f))?.[1] ?? path.basename(f, '.jsonl');
    const ctx: RolloutContext = { sessionId, model: null };
    const r = await tailJsonl(
      store,
      f,
      (line) =>
        line.includes('"token_count"') || line.includes('"session_meta"') || line.includes('"turn_context"'),
      (rec) => {
        if (applyCodexRolloutRecord(store, profile.id, machineId, ctx, rec)) stats.records++;
      },
    );
    stats.bytes += r.bytesRead;
  }
  return stats;
}

export interface RolloutContext {
  sessionId: string;
  model: string | null;
}

export function applyCodexRolloutRecord(
  store: Store,
  accountId: string,
  machineId: string,
  ctx: RolloutContext,
  rec: Record<string, unknown>,
): boolean {
  const payload = (rec.payload ?? {}) as Record<string, unknown>;
  const ts = toIso(rec.timestamp as string) ?? new Date().toISOString();
  const sessionKey = `${accountId}:${ctx.sessionId}`;
  if (rec.type === 'session_meta') {
    store.upsertSession({
      sessionKey,
      accountId,
      machineId,
      project: projectName(payload.cwd as string),
      model: null,
      startedAt: toIso(payload.timestamp as string) ?? ts,
      lastSeenAt: ts,
      source: 'codex-rollout',
    });
    return true;
  }
  if (rec.type === 'turn_context') {
    if (typeof payload.model === 'string') ctx.model = payload.model;
    return false;
  }
  if (payload.type !== 'token_count') return false;
  const info = payload.info as Record<string, unknown> | null;
  let used = false;
  if (info) {
    const total = info.total_token_usage as Record<string, unknown> | undefined;
    const last = info.last_token_usage as Record<string, unknown> | undefined;
    if (total && last && typeof total.total_tokens === 'number') {
      // total_token_usage is cumulative: it identifies the event; last_token_usage is the increment.
      // A re-emitted token_count with the same cumulative total maps to the same key (no double count).
      const cached = num(last.cached_input_tokens);
      store.upsertTokenEvent({
        eventKey: `codex:${accountId}:${ctx.sessionId}:${total.total_tokens}`,
        accountId,
        sessionId: ctx.sessionId,
        model: ctx.model,
        inputTokens: Math.max(0, num(last.input_tokens) - cached),
        outputTokens: num(last.output_tokens),
        cachedTokens: cached,
        timestamp: ts,
        source: 'codex-rollout',
      });
      store.upsertSession({
        sessionKey,
        accountId,
        machineId,
        project: null,
        model: ctx.model,
        startedAt: ts,
        lastSeenAt: ts,
        source: 'codex-rollout',
      });
      used = true;
    }
  }
  const rl = rolloutRateLimitsToResponse(payload.rate_limits as Record<string, unknown>);
  if (rl) {
    for (const s of codexRateLimitsToSnapshots(accountId, rl, ts, 'codex-rollout')) store.insertQuota(machineId, s);
    used = true;
  }
  return used;
}
