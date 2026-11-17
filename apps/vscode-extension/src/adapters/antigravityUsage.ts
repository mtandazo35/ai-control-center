import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../core/store';
import type { ExecutionProfile } from '../core/types';

/**
 * Token usage of Antigravity runs, read from its own conversation stores
 * (`~/.gemini/antigravity-cli/conversations/<conversation id>.db`, SQLite).
 *
 * Verified with agy 1.5.9 (2026-11-16):
 *   - table `gen_metadata`: one row per model call (`idx` 0..n-1), `data` = protobuf. Inside field 1:
 *       1.4 = usage { 2: input tokens not served from cache, 3: output tokens (thinking included),
 *                     5: input tokens served from cache, 9: thinking tokens }
 *       1.9.10 = context { 3.2: tokens in the window, 4: window size }
 *     and field 3.28 = model id (e.g. `gemini-3.8-flash-medium`).
 *   - table `steps`: the i-th step of type 15 (model response) belongs to the i-th call; its `metadata`
 *     field 1.1 is the creation time (Unix seconds). A call with no response step (failed) takes the last time seen.
 *
 * Only those numbers and the model id are read: never the prompt, the messages or the tool calls,
 * although the same blob carries them. The format is internal and may change: anything that does not
 * decode as expected is skipped (the card then shows «—»), never guessed.
 */

export const defaultAntigravityConversationDirs = (): string[] => [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations'),
];

export interface AntigravityCall {
  index: number;
  model: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  at: string;
  contextTokens: number | null;
  contextWindow: number | null;
}

type Fields = Map<number, (number | Uint8Array)[]>;

/** Minimal protobuf reader: varint and length-delimited fields; fixed32/64 are skipped. Throws on malformed input. */
export function protoFields(b: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  const varint = (): number => {
    let r = 0;
    let mul = 1;
    for (;;) {
      if (i >= b.length) throw new Error('varint truncado');
      const x = b[i++];
      r += (x & 0x7f) * mul;
      if (x < 0x80) return r;
      mul *= 128;
      if (mul > 2 ** 63) throw new Error('varint demasiado largo');
    }
  };
  while (i < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let v: number | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 2) {
      const len = varint();
      if (i + len > b.length) throw new Error('campo truncado');
      v = b.subarray(i, i + len);
      i += len;
    } else if (wire === 1) {
      i += 8;
      continue;
    } else if (wire === 5) {
      i += 4;
      continue;
    } else throw new Error('tipo de campo desconocido');
    if (i > b.length) throw new Error('campo truncado');
    const list = out.get(field);
    if (list) list.push(v);
    else out.set(field, [v]);
  }
  return out;
}

const msg = (f: Fields | null, n: number): Fields | null => {
  const v = f?.get(n)?.[0];
  if (!(v instanceof Uint8Array)) return null;
  try {
    return protoFields(v);
  } catch {
    return null;
  }
};
const int = (f: Fields | null, n: number): number | null => {
  const v = f?.get(n)?.[0];
  return typeof v === 'number' ? v : null;
};
const text = (f: Fields | null, n: number): string | null => {
  const v = f?.get(n)?.[0];
  if (!(v instanceof Uint8Array) || v.length > 120) return null;
  const s = Buffer.from(v).toString('utf8');
  return /^[\w.\-:]+$/.test(s) ? s : null;
};

/** One `gen_metadata` row → usage numbers and model, or null when the blob is not the known shape. */
export function decodeGeneration(data: Uint8Array): Omit<AntigravityCall, 'index' | 'at'> | null {
  let root: Fields;
  try {
    root = protoFields(data);
  } catch {
    return null;
  }
  const body = msg(root, 1);
  const usage = msg(body, 4);
  const input = int(usage, 2);
  const output = int(usage, 3);
  if (input === null || output === null) return null;
  const cached = int(usage, 5) ?? 0;
  const ctx = msg(msg(body, 9), 10);
  const contextTokens = int(msg(ctx, 3), 2);
  const contextWindow = int(ctx, 4);
  return {
    model: text(msg(root, 3), 28),
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    contextTokens,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null,
  };
}

/** Creation time (ISO) of a step from its `metadata` blob, or null. */
export function stepTime(meta: Uint8Array | null): string | null {
  if (!meta) return null;
  try {
    const secs = int(msg(protoFields(meta), 1), 1);
    return secs && secs > 1e9 ? new Date(secs * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const RESPONSE_STEP = 15;

/** Reads one conversation store (read-only). Calls that do not decode are left out. */
export function readAntigravityConversation(file: string): AntigravityCall[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const times = (db.prepare('SELECT metadata FROM steps WHERE step_type = ? ORDER BY idx').all(RESPONSE_STEP) as { metadata: Uint8Array | null }[]).map((r) =>
      stepTime(r.metadata),
    );
    const lastSeen = (db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').all() as { metadata: Uint8Array | null }[]).map((r) => stepTime(r.metadata))[0] ?? null;
    const calls: AntigravityCall[] = [];
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as { idx: number; data: Uint8Array | null }[]) {
      if (!row.data) continue;
      const g = decodeGeneration(row.data);
      const at = times[Number(row.idx)] ?? lastSeen;
      if (!g || !at) continue;
      calls.push({ index: Number(row.idx), at, ...g });
    }
    // Some calls (e.g. the one the server refused) carry no model id: a conversation runs on one model,
    // so they take the nearest known one of the same conversation.
    const known = calls.find((c) => c.model)?.model ?? null;
    let prev: string | null = known;
    for (const c of calls) {
      if (c.model) prev = c.model;
      else c.model = prev;
    }
    return calls;
  } finally {
    db.close();
  }
}

/**
 * Newest write time (ms) of a conversation store: `<id>.db`, or `<id>.pb` — the encrypted form some runs are saved in,
 * whose tokens cannot be read but which still proves fresh use. The `-wal`/`-shm` files are left out: opening a store
 * read-only touches them.
 */
export function latestAgyConversationMs(dirs: string[] = defaultAntigravityConversationDirs()): number {
  let latest = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.(db|pb)$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        latest = Math.max(latest, fs.statSync(path.join(dir, n)).mtimeMs);
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return latest;
}

/**
 * Folder the conversation ran in, from `trajectory_metadata_blob` (field 7, or 1.1): a `file:///…` URI. Only its last
 * segment is kept (e.g. «mi-proyecto»), never the full path, so no user name reaches the database. Null when absent.
 */
export function workspaceName(data: Uint8Array | null): string | null {
  if (!data) return null;
  try {
    const f = protoFields(data);
    const top = f.get(7)?.find((x) => x instanceof Uint8Array) as Uint8Array | undefined;
    const nested = f.get(1)?.find((x) => x instanceof Uint8Array) as Uint8Array | undefined;
    const raw = top ?? (nested ? (protoFields(nested).get(1)?.find((x) => x instanceof Uint8Array) as Uint8Array | undefined) : undefined);
    if (!raw) return null;
    const uri = Buffer.from(raw).toString('utf8');
    if (!/^file:\/\//i.test(uri)) return null;
    const p = decodeURIComponent(uri.replace(/^file:\/\/\/?/i, '')).replace(/[\\/]+$/, '');
    const name = p.split(/[\\/]/).pop() ?? '';
    return name && !/^[A-Za-z]:$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function readAntigravityWorkspace(file: string): string | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const r = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data: Uint8Array | null } | undefined;
    return workspaceName(r?.data ?? null);
  } catch {
    return null; // older store without the table
  } finally {
    db.close();
  }
}

/**
 * Writes one token event per model call (idempotent: the key is conversation + call index) and keeps the
 * context fill of the most recent call. Unchanged stores (same size + mtime of the .db and its -wal) are skipped.
 */
export function ingestAntigravityConversations(
  store: Store,
  profile: ExecutionProfile,
  dirs: string[] = defaultAntigravityConversationDirs(),
  now: Date = new Date(),
  maxAgeDays = 35,
): { files: number; calls: number; errors: number } {
  const out = { files: 0, calls: 0, errors: 0 };
  const oldest = now.getTime() - maxAgeDays * 86400000;
  let latest: { at: string; tokens: number; window: number; conversation: string } | null = null;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.db$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      let size = 0;
      let mtimeMs = 0;
      try {
        for (const f of [file, file + '-wal']) {
          if (!fs.existsSync(f)) continue;
          const st = fs.statSync(f);
          size += st.size;
          mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        }
      } catch {
        continue;
      }
      if (mtimeMs < oldest) continue;
      out.files++;
      // v2: calls without a model id take the conversation's model. v3: also the working folder (session project).
      const cursorKey = 'agy-conv:v3:' + file;
      const cur = store.getCursor(cursorKey);
      if (cur && cur.size === size && cur.mtimeMs === mtimeMs) continue;
      const conversation = n.slice(0, -3);
      let calls: AntigravityCall[];
      try {
        calls = readAntigravityConversation(file);
      } catch {
        out.errors++;
        continue; // locked or unknown format: retried on the next pass (cursor not advanced)
      }
      for (const c of calls) {
        store.upsertTokenEvent({
          eventKey: `agy:${profile.id}:${conversation}:${c.index}`,
          accountId: profile.id,
          sessionId: conversation,
          model: c.model,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          cachedTokens: c.cachedTokens,
          timestamp: c.at,
          source: 'antigravity-conversation',
        });
        out.calls++;
        if (c.contextTokens !== null && c.contextWindow && (!latest || c.at > latest.at)) {
          latest = { at: c.at, tokens: c.contextTokens, window: c.contextWindow, conversation };
        }
      }
      const project = readAntigravityWorkspace(file);
      if (project) store.setSessionProject(`${profile.id}:${conversation}`, project);
      store.setCursor(cursorKey, size, size, mtimeMs);
    }
  }
  if (latest) {
    const key = `gemini-context:${profile.id}`;
    const prev = store.getSetting(key);
    let prevAt = '';
    try {
      prevAt = prev ? String((JSON.parse(prev) as { at?: string }).at ?? '') : '';
    } catch {
      prevAt = '';
    }
    if (latest.at >= prevAt) {
      store.setSetting(
        key,
        JSON.stringify({ at: latest.at, sessionId: latest.conversation, percent: Math.round((latest.tokens / latest.window) * 100), tokens: latest.tokens, window: latest.window }),
      );
    }
  }
  return out;
}
