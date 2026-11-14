import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { QuotaSnapshot } from '../core/types';
import { maskEmail, redact, sha256, toIso, windowLabel } from '../core/util';

/**
 * Minimal JSON-RPC 2.0 client for `codex app-server` (newline-delimited JSON over stdio).
 * Methods and payloads verified against `codex app-server generate-json-schema` (codex-cli 0.167.0).
 */
export class JsonRpcClient {
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: { method: string; params: unknown }[] = [];

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (d: string) => this.onData(d));
    input.on('close', () => this.failAll(new Error('el proceso app-server terminó')));
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id) && !msg.method) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.message ?? 'error JSON-RPC', msg.error.code));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    }
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tiempo agotado esperando ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.output.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.output.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

// ---------- payload types (subset of the generated schema) ----------
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  individualLimit?: { limit: string; remainingPercent: number; resetsAt: number; used: string } | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
}
export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  ordinaryUsageAllowed?: boolean | null;
  accountId?: string | null;
}
export interface GetAccountResponse {
  account:
    | { type: 'chatgpt'; email: string | null; planType: string; workspaceName?: string | null }
    | { type: 'apiKey' }
    | { type: string }
    | null;
  requiresOpenaiAuth: boolean;
}
export interface GetAccountTokenUsageResponse {
  summary: Record<string, number | null>;
  dailyUsageBuckets?: { startDate: string; tokens: number }[] | null;
}

export interface CodexReadResult {
  ok: boolean;
  authProblem: boolean;
  error: string | null;
  authMode: string | null;
  plan: string | null;
  identityLabel: string | null;
  identityHash: string | null;
  codexHome: string | null;
  rateLimits: GetAccountRateLimitsResponse | null;
  rateLimitsError: string | null;
  usage: GetAccountTokenUsageResponse | null;
  observedAt: string;
}

/**
 * One read cycle against the official App Server. Read-only: `account/read` is called with
 * refreshToken=false and nothing is written by this client. The App Server reuses the session
 * stored under CODEX_HOME by Codex itself; this process never sees or stores the token.
 */
export async function readCodexOverRpc(rpc: JsonRpcClient, timeoutMs = 20000): Promise<CodexReadResult> {
  const observedAt = new Date().toISOString();
  const res: CodexReadResult = {
    ok: false,
    authProblem: false,
    error: null,
    authMode: null,
    plan: null,
    identityLabel: null,
    identityHash: null,
    codexHome: null,
    rateLimits: null,
    rateLimitsError: null,
    usage: null,
    observedAt,
  };
  const init = await rpc.request<{ codexHome?: string }>(
    'initialize',
    { clientInfo: { name: 'ai_control_center', title: 'AI Control Center', version: '0.1.0' } },
    timeoutMs,
  );
  res.codexHome = init?.codexHome ?? null;
  rpc.notify('initialized');
  const acc = await rpc.request<GetAccountResponse & { workspaceRouting?: { chatgptAccountId?: string } }>(
    'account/read',
    { refreshToken: false },
    timeoutMs,
  );
  if (!acc.account) {
    res.authProblem = true;
    res.error = acc.requiresOpenaiAuth ? 'Codex no tiene sesión iniciada en este CODEX_HOME' : 'sin cuenta';
    return res;
  }
  res.authMode = acc.account.type;
  if (acc.account.type === 'chatgpt') {
    const a = acc.account as { email: string | null; planType: string };
    res.plan = a.planType;
    res.identityLabel = maskEmail(a.email);
    const idSource = acc.workspaceRouting?.chatgptAccountId ?? a.email ?? null;
    res.identityHash = idSource ? sha256(`codex:${idSource}`) : null;
  } else if (acc.account.type === 'apiKey') {
    res.plan = 'api-key';
  }
  try {
    res.rateLimits = await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', null, timeoutMs);
    if (!res.identityHash && res.rateLimits.accountId) res.identityHash = sha256(`codex:${res.rateLimits.accountId}`);
  } catch (e) {
    // e.g. API-key auth: ChatGPT plan limits do not apply. Degraded mode, not a crash.
    res.rateLimitsError = redact((e as Error).message);
  }
  try {
    res.usage = await rpc.request<GetAccountTokenUsageResponse>('account/usage/read', null, timeoutMs);
  } catch {
    res.usage = null;
  }
  res.ok = true;
  return res;
}

/** Spawns `codex app-server` with the profile's CODEX_HOME, runs one read cycle and exits. */
export async function readCodexAccount(opts: {
  command: string;
  codexHome: string | null;
  timeoutMs?: number;
}): Promise<CodexReadResult> {
  const env = { ...process.env };
  if (opts.codexHome) env.CODEX_HOME = opts.codexHome;
  const cmd = `${quoteCmd(opts.command)} app-server`;
  const child = spawn(cmd, { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => {
    if (stderr.length < 4000) stderr += String(d);
  });
  const spawnError = new Promise<never>((_, reject) => child.on('error', (e) => reject(e)));
  try {
    const rpc = new JsonRpcClient(child.stdout, child.stdin);
    return await Promise.race([readCodexOverRpc(rpc, opts.timeoutMs ?? 20000), spawnError]);
  } catch (e) {
    const msg = redact(`${(e as Error).message}${stderr ? ` · ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`);
    return {
      ok: false,
      authProblem: /login|auth|sign/i.test(msg),
      error: msg,
      authMode: null,
      plan: null,
      identityLabel: null,
      identityHash: null,
      codexHome: opts.codexHome,
      rateLimits: null,
      rateLimitsError: null,
      usage: null,
      observedAt: new Date().toISOString(),
    };
  } finally {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500).unref?.();
  }
}

export function quoteCmd(c: string): string {
  return /\s/.test(c) && !c.startsWith('"') ? `"${c}"` : c;
}

/**
 * Normalizes every bucket returned (rateLimitsByLimitId, not only primary/secondary) into snapshots.
 * limitId = "<bucket>:<primary|secondary|individual>" so the App Server and rollout mirrors share a timeline.
 */
export function codexRateLimitsToSnapshots(
  accountId: string,
  resp: GetAccountRateLimitsResponse,
  observedAt: string,
  source: 'codex-app-server' | 'codex-rollout' = 'codex-app-server',
): QuotaSnapshot[] {
  const buckets: Record<string, RateLimitSnapshot> =
    resp.rateLimitsByLimitId && Object.keys(resp.rateLimitsByLimitId).length
      ? resp.rateLimitsByLimitId
      : { [resp.rateLimits?.limitId ?? 'codex']: resp.rateLimits };
  const out: QuotaSnapshot[] = [];
  for (const [bucketId, b] of Object.entries(buckets)) {
    if (!b) continue;
    const prefix = bucketId === 'codex' ? '' : `${b.limitName ?? bucketId} · `;
    const extra = {
      planType: b.planType ?? null,
      credits: b.credits ?? null,
      rateLimitReachedType: b.rateLimitReachedType ?? null,
      spendControlReached: b.spendControlReached ?? null,
      ordinaryUsageAllowed: resp.ordinaryUsageAllowed ?? null,
    };
    for (const slot of ['primary', 'secondary'] as const) {
      const w = b[slot];
      if (!w || typeof w.usedPercent !== 'number') continue;
      const mins = w.windowDurationMins ?? null;
      out.push({
        accountId,
        limitId: `${bucketId}:${slot}`,
        limitLabel: `${prefix}${windowLabel(mins)}`,
        windowMinutes: mins,
        usedPercent: w.usedPercent,
        remainingPercent: Math.max(0, 100 - w.usedPercent),
        resetsAt: toIso(w.resetsAt ?? null),
        source,
        confidence: source === 'codex-app-server' ? 'high' : 'medium',
        observedAt,
        status: 'live',
        extra,
      });
    }
    if (b.individualLimit && typeof b.individualLimit.remainingPercent === 'number') {
      out.push({
        accountId,
        limitId: `${bucketId}:individual`,
        limitLabel: `${prefix}límite individual`,
        windowMinutes: null,
        usedPercent: Math.max(0, 100 - b.individualLimit.remainingPercent),
        remainingPercent: b.individualLimit.remainingPercent,
        resetsAt: toIso(b.individualLimit.resetsAt),
        source,
        confidence: source === 'codex-app-server' ? 'high' : 'medium',
        observedAt,
        status: 'live',
        extra,
      });
    }
  }
  return out;
}

/** Rollout files carry the same server values in snake_case; convert to the App Server shape. */
export function rolloutRateLimitsToResponse(rl: Record<string, unknown>): GetAccountRateLimitsResponse | null {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w: unknown): RateLimitWindow | null => {
    if (!w || typeof w !== 'object') return null;
    const o = w as Record<string, unknown>;
    if (typeof o.used_percent !== 'number') return null;
    return {
      usedPercent: o.used_percent,
      windowDurationMins: typeof o.window_minutes === 'number' ? o.window_minutes : null,
      resetsAt: typeof o.resets_at === 'number' ? o.resets_at : null,
    };
  };
  const snap: RateLimitSnapshot = {
    limitId: (rl.limit_id as string) ?? 'codex',
    limitName: (rl.limit_name as string) ?? null,
    primary: win(rl.primary),
    secondary: win(rl.secondary),
    planType: (rl.plan_type as string) ?? null,
    rateLimitReachedType: (rl.rate_limit_reached_type as string) ?? null,
    spendControlReached: (rl.spend_control_reached as boolean) ?? null,
    credits: rl.credits
      ? {
          hasCredits: Boolean((rl.credits as Record<string, unknown>).has_credits),
          unlimited: Boolean((rl.credits as Record<string, unknown>).unlimited),
          balance: ((rl.credits as Record<string, unknown>).balance as string) ?? null,
        }
      : null,
  };
  if (!snap.primary && !snap.secondary) return null;
  return { rateLimits: snap, rateLimitsByLimitId: { [snap.limitId ?? 'codex']: snap } };
}
