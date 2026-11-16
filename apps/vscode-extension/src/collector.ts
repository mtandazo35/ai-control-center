import * as os from 'node:os';
import * as path from 'node:path';
import { defaultClaudeConfigDir, ingestStatuslineInbox, readClaudeAuth } from './adapters/claude';
import { codexRateLimitsToSnapshots, readCodexAccount, type CodexReadResult } from './adapters/codexAppServer';
import { ingestAntigravityLogs } from './adapters/antigravity';
import { ingestAntigravityConversations } from './adapters/antigravityUsage';
import { ingestClaudeModInbox } from './adapters/claudeMod';
import { estimateClaudeSession, ingestClaudeUsageCache } from './adapters/claudeUsage';
import { defaultCodexHome, type GeminiProduct } from './adapters/detect';
import { ingestClaudeTranscripts, ingestCodexRollouts } from './adapters/localLogs';
import { evaluateAlerts, type CollectorStatus } from './core/alerts';
import type { Store } from './core/store';
import type { AlertRecord, ExecutionProfile, Provider, Settings } from './core/types';
import { exists, redact, sha256, slug } from './core/util';

export const VERSION = '0.1.0';

export interface CollectorConfig {
  dataDir: string;
  claudeCommand: string;
  codexCommand: string;
  pollMinutes: number;
  retentionDays: number;
  settings: Settings;
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ai-control-center');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ai-control-center');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'ai-control-center');
}

export function machineId(): string {
  return sha256(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`).slice(0, 16);
}

export function newProfile(provider: Provider, id: string, alias: string, configDir: string | null, mid: string): ExecutionProfile {
  return {
    id,
    provider,
    alias,
    configDir,
    vscodeUserDataDir: null,
    authType: null,
    plan: null,
    identityLabel: null,
    identityHash: null,
    verifiedAt: null,
    verification: 'pending',
    verificationDetail: null,
    machineId: mid,
    enabled: true,
    detectedAt: new Date().toISOString(),
    tokenSource: 'transcript',
  };
}

/** Creates the default profiles (one per installed tool) the first time; never duplicates. */
export function ensureDefaultProfiles(store: Store, mid: string, gemini: GeminiProduct | null): ExecutionProfile[] {
  const created: ExecutionProfile[] = [];
  const have = new Set(store.listProfiles().map((p) => p.id));
  const claudeDir = defaultClaudeConfigDir();
  if (!have.has('claude-default') && exists(claudeDir)) {
    const p = newProfile('claude', 'claude-default', 'principal', claudeDir, mid);
    store.upsertProfile(p);
    created.push(p);
  }
  const codexHome = defaultCodexHome();
  if (!have.has('codex-default') && exists(codexHome)) {
    const p = newProfile('codex', 'codex-default', 'principal', codexHome, mid);
    store.upsertProfile(p);
    created.push(p);
  }
  if (gemini && gemini.product !== 'none') {
    const id = `gemini-${slug(gemini.product)}`;
    const p = store.getProfile(id) ?? newProfile('gemini', id, gemini.name, null, mid);
    // Keep what the logs proved (observed) and the plan the user declared; detection only refreshes the text.
    if (p.verification !== 'observed') p.verification = 'unsupported';
    p.verificationDetail = `${gemini.versions.join(' · ')} — ${gemini.compatibility}`;
    store.upsertProfile(p);
    if (!have.has(id)) created.push(p);
  }
  return created;
}

export interface VerifyResult {
  profile: ExecutionProfile;
  ok: boolean;
  authProblem: boolean;
  message: string;
  codex?: CodexReadResult;
}

/**
 * Verifies a profile through the official tool (claude auth status / codex app-server account/read)
 * and checks that it is not the same account as another profile (isolation check).
 */
export async function verifyProfile(
  store: Store,
  cfg: CollectorConfig,
  p: ExecutionProfile,
  preRead?: CodexReadResult,
): Promise<VerifyResult> {
  const now = new Date().toISOString();
  const before = p.verification;
  let ok = false;
  let authProblem = false;
  let message = '';
  let codex: CodexReadResult | undefined;
  if (p.provider === 'claude') {
    const r = await readClaudeAuth(cfg.claudeCommand, p.configDir);
    if (!r.ok) message = `claude auth status falló: ${r.error}`;
    else if (!r.loggedIn) {
      authProblem = true;
      message = 'sin sesión iniciada en esta carpeta de configuración';
    } else {
      ok = true;
      p.authType = r.authMethod;
      p.plan = r.plan;
      p.identityLabel = r.identityLabel;
      p.identityHash = r.identityHash;
      message = `sesión ${r.authMethod ?? ''} · plan ${r.plan ?? 'desconocido'}`;
    }
  } else if (p.provider === 'codex') {
    codex = preRead ?? (await readCodexAccount({ command: cfg.codexCommand, codexHome: p.configDir }));
    if (!codex.ok) {
      authProblem = codex.authProblem;
      message = codex.error ?? 'error';
    } else {
      ok = true;
      p.authType = codex.authMode;
      p.plan = codex.plan;
      p.identityLabel = codex.identityLabel;
      p.identityHash = codex.identityHash;
      message = `sesión ${codex.authMode ?? ''} · plan ${codex.plan ?? 'desconocido'}`;
      if (codex.rateLimitsError) message += ` · cuota no disponible: ${codex.rateLimitsError}`;
    }
  } else {
    return { profile: p, ok: false, authProblem: false, message: p.verificationDetail ?? 'sin conector oficial' };
  }
  if (ok && p.identityHash) {
    const twin = store
      .listProfiles(p.provider)
      .find((o) => o.id !== p.id && o.identityHash && o.identityHash === p.identityHash);
    if (twin) message += ` · ATENCIÓN: es la misma cuenta que «${twin.alias}» (perfiles no aislados)`;
  }
  p.verification = ok ? 'verified' : 'failed';
  p.verificationDetail = redact(message);
  p.verifiedAt = now;
  store.upsertProfile(p);
  if (before !== p.verification) store.audit('verify-profile', `${p.id}: ${before} -> ${p.verification}`, now);
  return { profile: p, ok, authProblem, message, codex };
}

export interface RunResult {
  newAlerts: AlertRecord[];
  statuses: CollectorStatus[];
  ingested: Record<string, number>;
}

export class Collector {
  private runs = 0;
  private lastPrune = 0;

  constructor(
    readonly store: Store,
    public cfg: CollectorConfig,
    readonly mid: string,
    readonly holder: string,
    readonly kind: 'extension' | 'agent',
  ) {}

  /** Lease so that several windows and the agent don't all hit the providers. */
  canPoll(now = new Date()): boolean {
    return this.store.tryLease('collector', this.holder, now, this.cfg.pollMinutes * 2 * 60000);
  }

  release(): void {
    this.store.releaseLease('collector', this.holder);
  }

  async runOnce(opts: { force?: boolean } = {}): Promise<RunResult> {
    const ingested: Record<string, number> = {};
    const statuses: CollectorStatus[] = [];
    const now = () => new Date().toISOString();
    this.runs++;
    for (const p of this.store.listProfiles()) {
      if (!p.enabled) continue;
      try {
        if (p.provider === 'codex') {
          const r = await readCodexAccount({ command: this.cfg.codexCommand, codexHome: p.configDir });
          await verifyProfile(this.store, this.cfg, p, r);
          if (r.ok) {
            if (r.rateLimits) {
              let n = 0;
              for (const s of codexRateLimitsToSnapshots(p.id, r.rateLimits, r.observedAt)) if (this.store.insertQuota(this.mid, s)) n++;
              ingested[`${p.id}:quota`] = n;
            }
            for (const b of r.usage?.dailyUsageBuckets ?? []) {
              this.store.upsertDailyUsage(p.id, b.startDate, b.tokens, 'codex-app-server', r.observedAt);
            }
            statuses.push({ accountId: p.id, ok: !r.rateLimitsError, error: r.rateLimitsError, at: now() });
          } else {
            statuses.push({ accountId: p.id, ok: false, error: r.error, at: now(), authProblem: r.authProblem });
          }
          const s = await ingestCodexRollouts(this.store, p, this.mid);
          ingested[`${p.id}:rollouts`] = s.records;
        } else if (p.provider === 'gemini' && p.id === 'gemini-antigravity') {
          // No quota interface: only the server's exhaustion message and the runs recorded in Antigravity's own logs.
          const r = ingestAntigravityLogs(this.store, p, this.mid);
          ingested[`${p.id}:runs`] = r.runs;
          // Token counts per model call, from Antigravity's own conversation stores (read-only, numbers only).
          ingested[`${p.id}:calls`] = ingestAntigravityConversations(this.store, p).calls;
          // A run in Antigravity's own logs proves a signed-in session (no identity is read).
          const last = this.store.sessions('1970-01-01').find((x) => x.accountId === p.id);
          if (last && p.verification !== 'observed') {
            p.verification = 'observed';
            p.verifiedAt = last.lastSeenAt;
            this.store.upsertProfile(p);
          }
          statuses.push({ accountId: p.id, ok: true, error: null, at: now() });
        } else if (p.provider === 'claude') {
          const s = await ingestClaudeTranscripts(this.store, p, this.mid);
          ingested[`${p.id}:transcripts`] = s.records;
          ingested[`${p.id}:usage-cache`] = ingestClaudeUsageCache(this.store, p, this.mid);
          // Identity check is cheap but spawns a process: every 6th run, or on demand.
          if (opts.force || this.runs % 6 === 1) {
            const v = await verifyProfile(this.store, this.cfg, p);
            statuses.push({ accountId: p.id, ok: v.ok, error: v.ok ? null : v.message, at: now(), authProblem: v.authProblem });
          } else {
            statuses.push({ accountId: p.id, ok: p.verification !== 'failed', error: p.verification === 'failed' ? p.verificationDetail : null, at: now() });
          }
        }
      } catch (e) {
        statuses.push({ accountId: p.id, ok: false, error: redact((e as Error).message), at: now() });
      }
    }
    ingested['claude:statusline'] = await ingestStatuslineInbox(this.store, this.cfg.dataDir, this.mid);
    ingested['claude:mod'] = ingestClaudeModInbox(this.store, this.cfg.dataDir, this.mid);
    // The estimate only fills in when no official reading (mod, statusLine, cache) knows the current window.
    for (const p of this.store.listProfiles('claude')) if (p.enabled) estimateClaudeSession(this.store, p.id, this.mid);

    this.store.setSetting('collectors', JSON.stringify(statuses));
    const nowDate = new Date();
    const alerts = evaluateAlerts(this.store.listProfiles(), this.store.latestQuotas(), statuses, this.cfg.settings, nowDate);
    const newAlerts = alerts.filter((a) => this.store.raiseAlert(a));
    this.store.heartbeat(this.holder, this.kind, this.mid, VERSION, nowDate.toISOString(), JSON.stringify(ingested));
    if (Date.now() - this.lastPrune > 6 * 3600000) {
      this.lastPrune = Date.now();
      this.store.prune(new Date(Date.now() - this.cfg.retentionDays * 86400000).toISOString());
    }
    return { newAlerts, statuses, ingested };
  }

  /** Only reads local files (no provider process): used by windows that don't hold the lease. */
  async ingestLocalOnly(): Promise<void> {
    await ingestStatuslineInbox(this.store, this.cfg.dataDir, this.mid);
    ingestClaudeModInbox(this.store, this.cfg.dataDir, this.mid);
  }
}

export function readCollectorStatuses(store: Store): CollectorStatus[] {
  try {
    return JSON.parse(store.getSetting('collectors') ?? '[]') as CollectorStatus[];
  } catch {
    return [];
  }
}
