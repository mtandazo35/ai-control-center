import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIGRATIONS } from './migrations';
import type {
  AlertRecord,
  CostEvent,
  ExecutionProfile,
  Provider,
  ProviderSession,
  QuotaSnapshot,
  TokenUsageEvent,
} from './types';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Local SQLite store (node:sqlite, bundled with the VS Code runtime — no native module).
 * Shared by every VS Code window and the optional resident agent: WAL + busy_timeout,
 * idempotent upserts keyed by natural keys so two producers never duplicate a measure.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as Row | undefined;
    const current = Number(row?.v ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      });
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as Row;
    return Number(row.v ?? 0);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- machines ----------
  touchMachine(id: string, hostnameHash: string, platform: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO machines (id, hostname_hash, platform, first_seen, last_seen) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, hostnameHash, platform, at, at);
  }

  // ---------- profiles / accounts ----------
  upsertProfile(p: ExecutionProfile): void {
    this.db
      .prepare(
        `INSERT INTO provider_accounts (id, provider, alias, local_profile_id, config_dir, vscode_user_data_dir, auth_type, plan,
           identity_label, identity_hash, verification, verification_detail, verified_at, machine_id, enabled, token_source, detected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, config_dir=excluded.config_dir,
           vscode_user_data_dir=excluded.vscode_user_data_dir, auth_type=excluded.auth_type, plan=excluded.plan,
           identity_label=excluded.identity_label, identity_hash=excluded.identity_hash, verification=excluded.verification,
           verification_detail=excluded.verification_detail, verified_at=excluded.verified_at, enabled=excluded.enabled,
           token_source=excluded.token_source`,
      )
      .run(
        p.id,
        p.provider,
        p.alias,
        p.id,
        p.configDir,
        p.vscodeUserDataDir,
        p.authType,
        p.plan,
        p.identityLabel,
        p.identityHash,
        p.verification,
        p.verificationDetail,
        p.verifiedAt,
        p.machineId,
        p.enabled ? 1 : 0,
        p.tokenSource,
        p.detectedAt,
      );
  }

  deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(id);
  }

  getProfile(id: string): ExecutionProfile | undefined {
    const r = this.db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToProfile(r) : undefined;
  }

  listProfiles(provider?: Provider): ExecutionProfile[] {
    const rows = (
      provider
        ? this.db.prepare('SELECT * FROM provider_accounts WHERE provider = ? ORDER BY provider, alias').all(provider)
        : this.db.prepare('SELECT * FROM provider_accounts ORDER BY provider, alias').all()
    ) as Row[];
    return rows.map(rowToProfile);
  }

  // ---------- quotas ----------
  /** Returns true when the snapshot was new (dedup on machine+account+limit+source+observed_at). */
  insertQuota(machineId: string, q: QuotaSnapshot): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO quota_snapshots (machine_id, account_id, limit_id, limit_label, window_minutes, used_percent,
           remaining_percent, resets_at, source, confidence, observed_at, status, extra_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        machineId,
        q.accountId,
        q.limitId,
        q.limitLabel,
        q.windowMinutes,
        q.usedPercent,
        q.remainingPercent,
        q.resetsAt,
        q.source,
        q.confidence,
        q.observedAt,
        q.status,
        q.extra ? JSON.stringify(q.extra) : null,
      );
    return Number(res.changes) > 0;
  }

  /** Latest snapshot per (account, limit). Official sources outrank local mirrors at equal recency. */
  latestQuotas(): QuotaSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT q.* FROM quota_snapshots q
         JOIN (SELECT account_id, limit_id, MAX(observed_at) AS m FROM quota_snapshots GROUP BY account_id, limit_id) x
           ON x.account_id = q.account_id AND x.limit_id = q.limit_id AND x.m = q.observed_at
         ORDER BY q.account_id, q.limit_id, q.id DESC`,
      )
      .all() as Row[];
    const seen = new Set<string>();
    const out: QuotaSnapshot[] = [];
    for (const r of rows) {
      const k = `${r.account_id}|${r.limit_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(rowToQuota(r));
    }
    // Antigravity: once the official /usage reading exists, the log-based «cuota individual» (a run worked / the
    // server said exhausted) only stays when it is newer — e.g. an exhaustion seen after the last /usage reading.
    const usageAt = new Map<string, string>();
    for (const q of out) {
      if (q.source === 'antigravity-usage' && (usageAt.get(q.accountId) ?? '') < q.observedAt) usageAt.set(q.accountId, q.observedAt);
    }
    // A bucket the newest /usage reading no longer lists (agy 1.5.18 dropped «Argon») is gone, not «stale».
    const kept = out.filter(
      (q) =>
        !(q.limitId === 'agy:individual' && usageAt.has(q.accountId) && q.observedAt <= usageAt.get(q.accountId)!) &&
        !(q.source === 'antigravity-usage' && q.observedAt < (usageAt.get(q.accountId) ?? '')),
    );
    // Claude: an activity estimate (no %) never hides a recent real reading of the same window. The real one wins when
    // it was observed at most 30 min before the estimate and its reset is still ahead of the estimate.
    return kept.map((q) => {
      if (q.source !== 'claude-activity-estimate') return q;
      const real = this.latestQuota(q.accountId, q.limitId, 'claude-activity-estimate');
      if (!real || real.usedPercent === null || !real.resetsAt) return q;
      const fresh = Date.parse(q.observedAt) - Date.parse(real.observedAt) <= 30 * 60000;
      return fresh && real.resetsAt > q.observedAt ? real : q;
    });
  }

  /** Newest snapshot of one limit, optionally leaving out one source (e.g. the activity estimate). */
  latestQuota(accountId: string, limitId: string, excludeSource?: string): QuotaSnapshot | null {
    const r = this.db
      .prepare(
        `SELECT * FROM quota_snapshots WHERE account_id = ? AND limit_id = ? AND source <> ?
         ORDER BY observed_at DESC, id DESC LIMIT 1`,
      )
      .get(accountId, limitId, excludeSource ?? '') as Row | undefined;
    return r ? rowToQuota(r) : null;
  }

  quotaHistory(accountId: string, sinceIso: string): QuotaSnapshot[] {
    return (
      this.db
        .prepare('SELECT * FROM quota_snapshots WHERE account_id = ? AND observed_at >= ? ORDER BY observed_at')
        .all(accountId, sinceIso) as Row[]
    ).map(rowToQuota);
  }

  // ---------- tokens / sessions / cost ----------
  /** Upsert: a later line for the same event key (e.g. a streamed message) replaces the earlier one. */
  upsertTokenEvent(e: TokenUsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO token_usage_events (event_key, account_id, session_id, model, input_tokens, output_tokens, cached_tokens, timestamp, source)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_key) DO UPDATE SET input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
           cached_tokens=excluded.cached_tokens, model=COALESCE(excluded.model, model)`,
      )
      .run(
        e.eventKey,
        e.accountId,
        e.sessionId,
        e.model,
        e.inputTokens,
        e.outputTokens,
        e.cachedTokens,
        e.timestamp,
        e.source,
      );
  }

  upsertDailyUsage(accountId: string, day: string, tokens: number, source: string, observedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO account_daily_usage (account_id, day, tokens, source, observed_at) VALUES (?,?,?,?,?)
         ON CONFLICT(account_id, day, source) DO UPDATE SET tokens=excluded.tokens, observed_at=excluded.observed_at`,
      )
      .run(accountId, day, tokens, source, observedAt);
  }

  dailyUsage(accountId: string, sinceDay: string): { day: string; tokens: number; source: string }[] {
    return (
      this.db
        .prepare('SELECT day, tokens, source FROM account_daily_usage WHERE account_id = ? AND day >= ? ORDER BY day')
        .all(accountId, sinceDay) as Row[]
    ).map((r) => ({ day: String(r.day), tokens: Number(r.tokens), source: String(r.source) }));
  }

  upsertSession(s: ProviderSession): void {
    this.db
      .prepare(
        `INSERT INTO provider_sessions (session_key, account_id, machine_id, project, model, started_at, last_seen_at, source)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(session_key) DO UPDATE SET
           started_at = MIN(started_at, excluded.started_at),
           last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
           model = COALESCE(excluded.model, model),
           project = COALESCE(excluded.project, project)`,
      )
      .run(s.sessionKey, s.accountId, s.machineId, s.project, s.model, s.startedAt, s.lastSeenAt, s.source);
  }

  /** Fills a session's project when its source did not know it (Antigravity's logs carry no folder). */
  setSessionProject(sessionKey: string, project: string): void {
    this.db.prepare('UPDATE provider_sessions SET project = ? WHERE session_key = ? AND project IS NULL').run(project, sessionKey);
  }

  sessions(sinceIso: string): (ProviderSession & { tokens: number })[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, COALESCE((SELECT SUM(t.input_tokens + t.output_tokens) FROM token_usage_events t
             WHERE t.account_id = s.account_id AND t.session_id = substr(s.session_key, instr(s.session_key, ':') + 1)), 0) AS tokens,
           (SELECT t.model FROM token_usage_events t
             WHERE t.account_id = s.account_id AND t.session_id = substr(s.session_key, instr(s.session_key, ':') + 1)
               AND t.model IS NOT NULL ORDER BY t.timestamp DESC LIMIT 1) AS event_model
         FROM provider_sessions s WHERE s.last_seen_at >= ? ORDER BY s.last_seen_at DESC LIMIT 200`,
      )
      .all(sinceIso) as Row[];
    return rows.map((r) => ({
      sessionKey: String(r.session_key),
      accountId: String(r.account_id),
      machineId: String(r.machine_id),
      project: str(r.project),
      // A run whose log carried no model (Antigravity) takes the model of its own calls.
      model: str(r.model) ?? str(r.event_model),
      startedAt: String(r.started_at),
      lastSeenAt: String(r.last_seen_at),
      source: String(r.source) as ProviderSession['source'],
      tokens: Number(r.tokens),
    }));
  }

  upsertCost(c: CostEvent): void {
    this.db
      .prepare(
        `INSERT INTO cost_events (event_key, account_id, amount, currency, cost_basis, timestamp, source) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(event_key) DO UPDATE SET amount=excluded.amount`,
      )
      .run(c.eventKey, c.accountId, c.amount, c.currency, c.costBasis, c.timestamp, c.source);
  }

  /**
   * Token time series bucketed by hour or day, per account, from the account's chosen token source.
   * Keeps transcripts and OTel apart so the same request is never counted twice.
   */
  /** Tokens and calls per account and model since a time (same source rule as tokenSeries). */
  modelUsage(sinceIso: string): { accountId: string; model: string | null; input: number; output: number; cached: number; calls: number; sessions: number }[] {
    const rows = this.db
      .prepare(
        `SELECT t.account_id, t.model, SUM(t.input_tokens) i, SUM(t.output_tokens) o, SUM(t.cached_tokens) c, COUNT(*) n, COUNT(DISTINCT t.session_id) s
         FROM token_usage_events t JOIN provider_accounts a ON a.id = t.account_id
         WHERE t.timestamp >= ? AND (
           (a.token_source = 'otel' AND t.source = 'claude-otel') OR
           (a.token_source <> 'otel' AND t.source <> 'claude-otel'))
         GROUP BY t.account_id, t.model ORDER BY (SUM(t.input_tokens) + SUM(t.output_tokens)) DESC`,
      )
      .all(sinceIso) as Row[];
    return rows.map((r) => ({
      accountId: String(r.account_id),
      model: str(r.model),
      input: Number(r.i),
      output: Number(r.o),
      cached: Number(r.c),
      calls: Number(r.n),
      sessions: Number(r.s),
    }));
  }

  tokenSeries(
    sinceIso: string,
    bucket: 'hour' | 'day',
    offsetMinutes = 0,
  ): { accountId: string; bucket: string; input: number; output: number; cached: number }[] {
    // Hours stay UTC instants (labelled in the display zone later); days are cut at LOCAL midnight.
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';
    const shift = bucket === 'day' ? `, '${Math.trunc(Number(offsetMinutes)) || 0} minutes'` : '';
    const rows = this.db
      .prepare(
        `SELECT t.account_id, strftime('${fmt}', t.timestamp${shift}) AS b, SUM(t.input_tokens) i, SUM(t.output_tokens) o, SUM(t.cached_tokens) c
         FROM token_usage_events t JOIN provider_accounts a ON a.id = t.account_id
         WHERE t.timestamp >= ? AND (
           (a.token_source = 'otel' AND t.source = 'claude-otel') OR
           (a.token_source <> 'otel' AND t.source <> 'claude-otel'))
         GROUP BY t.account_id, b ORDER BY b`,
      )
      .all(sinceIso) as Row[];
    return rows.map((r) => ({
      accountId: String(r.account_id),
      bucket: String(r.b),
      input: Number(r.i),
      output: Number(r.o),
      cached: Number(r.c),
    }));
  }

  /** Sessions/runs started per bucket and their active minutes (all providers; Antigravity has runs, no tokens). */
  sessionSeries(
    sinceIso: string,
    bucket: 'hour' | 'day',
    offsetMinutes = 0,
  ): { accountId: string; bucket: string; runs: number; minutes: number }[] {
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';
    const shift = bucket === 'day' ? `, '${Math.trunc(Number(offsetMinutes)) || 0} minutes'` : '';
    const rows = this.db
      .prepare(
        `SELECT account_id, strftime('${fmt}', started_at${shift}) AS b, COUNT(*) n,
                SUM(MAX(0, (julianday(last_seen_at) - julianday(started_at)) * 1440)) m
         FROM provider_sessions WHERE started_at >= ? GROUP BY account_id, b ORDER BY b`,
      )
      .all(sinceIso) as Row[];
    return rows.map((r) => ({ accountId: String(r.account_id), bucket: String(r.b), runs: Number(r.n), minutes: Math.round(Number(r.m)) }));
  }

  costSeries(sinceIso: string, offsetMinutes = 0): { accountId: string; day: string; amount: number; currency: string; basis: string }[] {
    const shift = `'${Math.trunc(Number(offsetMinutes)) || 0} minutes'`;
    const rows = this.db
      .prepare(
        `SELECT account_id, strftime('%Y-%m-%d', timestamp, ${shift}) d, SUM(amount) a, currency, cost_basis FROM cost_events
         WHERE timestamp >= ? GROUP BY account_id, d, currency, cost_basis ORDER BY d`,
      )
      .all(sinceIso) as Row[];
    return rows.map((r) => ({
      accountId: String(r.account_id),
      day: String(r.d),
      amount: Number(r.a),
      currency: String(r.currency),
      basis: String(r.cost_basis),
    }));
  }

  // ---------- alerts ----------
  /** Returns true only the first time an alert key is seen (so each threshold notifies once per window). */
  raiseAlert(a: AlertRecord): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO alerts (alert_key, account_id, severity, kind, message, created_at, acknowledged) VALUES (?,?,?,?,?,?,0)`,
      )
      .run(a.alertKey, a.accountId, a.severity, a.kind, a.message, a.createdAt);
    return Number(res.changes) > 0;
  }

  alerts(limit = 100): AlertRecord[] {
    return (this.db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      alertKey: String(r.alert_key),
      accountId: str(r.account_id),
      severity: String(r.severity) as AlertRecord['severity'],
      kind: String(r.kind) as AlertRecord['kind'],
      message: String(r.message),
      createdAt: String(r.created_at),
      acknowledged: Number(r.acknowledged) === 1,
    }));
  }

  acknowledgeAlerts(): void {
    this.db.prepare('UPDATE alerts SET acknowledged = 1').run();
  }

  // ---------- recommendations / audit / heartbeats ----------
  recordRecommendation(taskType: string, candidates: unknown, selected: string | null, rationale: string, at: string): void {
    this.db
      .prepare(
        'INSERT INTO routing_recommendations (task_type, candidate_accounts, selected_account, rationale, generated_at) VALUES (?,?,?,?,?)',
      )
      .run(taskType, JSON.stringify(candidates), selected, rationale, at);
  }

  recommendations(limit = 20): { taskType: string; selected: string | null; rationale: string; generatedAt: string }[] {
    return (
      this.db.prepare('SELECT * FROM routing_recommendations ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    ).map((r) => ({
      taskType: String(r.task_type),
      selected: str(r.selected_account),
      rationale: String(r.rationale),
      generatedAt: String(r.generated_at),
    }));
  }

  audit(action: string, detail: string | null, at: string): void {
    this.db.prepare('INSERT INTO audit_logs (at, action, detail) VALUES (?,?,?)').run(at, action, detail);
  }

  auditLog(limit = 50): { at: string; action: string; detail: string | null }[] {
    return (this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      at: String(r.at),
      action: String(r.action),
      detail: str(r.detail),
    }));
  }

  heartbeat(holder: string, kind: string, machineId: string, version: string, at: string, detail: string | null): void {
    this.db
      .prepare(
        `INSERT INTO agent_heartbeats (holder, kind, machine_id, version, last_seen, detail) VALUES (?,?,?,?,?,?)
         ON CONFLICT(holder) DO UPDATE SET last_seen=excluded.last_seen, detail=excluded.detail, version=excluded.version`,
      )
      .run(holder, kind, machineId, version, at, detail);
  }

  heartbeats(): { holder: string; kind: string; lastSeen: string; detail: string | null }[] {
    return (this.db.prepare('SELECT * FROM agent_heartbeats ORDER BY last_seen DESC').all() as Row[]).map((r) => ({
      holder: String(r.holder),
      kind: String(r.kind),
      lastSeen: String(r.last_seen),
      detail: str(r.detail),
    }));
  }

  // ---------- settings ----------
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  // ---------- cursors / leases ----------
  getCursor(p: string): { offset: number; size: number; mtimeMs: number } | null {
    const r = this.db.prepare('SELECT * FROM ingest_cursors WHERE path = ?').get(p) as Row | undefined;
    return r ? { offset: Number(r.offset), size: Number(r.size), mtimeMs: Number(r.mtime_ms) } : null;
  }

  setCursor(p: string, offset: number, size: number, mtimeMs: number): void {
    this.db
      .prepare(
        `INSERT INTO ingest_cursors (path, offset, size, mtime_ms) VALUES (?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, size=excluded.size, mtime_ms=excluded.mtime_ms`,
      )
      .run(p, offset, size, mtimeMs);
  }

  /** Single-writer lease so several VS Code windows + the agent don't all poll the providers. */
  // `isDead(holder)`: true when the holder's process is gone (killed without releasing): the lease is taken at once
  // instead of waiting for it to expire.
  tryLease(name: string, holder: string, now: Date, ttlMs: number, isDead?: (holder: string) => boolean): boolean {
    return this.tx(() => {
      const r = this.db.prepare('SELECT holder, expires_at FROM leases WHERE name = ?').get(name) as Row | undefined;
      const nowIso = now.toISOString();
      if (r && String(r.holder) !== holder && String(r.expires_at) > nowIso && !isDead?.(String(r.holder))) return false;
      const exp = new Date(now.getTime() + ttlMs).toISOString();
      this.db
        .prepare(
          'INSERT INTO leases (name, holder, expires_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at',
        )
        .run(name, holder, exp);
      return true;
    });
  }

  releaseLease(name: string, holder: string): void {
    this.db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder);
  }

  // ---------- retention / export ----------
  prune(beforeIso: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM quota_snapshots WHERE observed_at < ?').run(beforeIso);
      this.db.prepare('DELETE FROM token_usage_events WHERE timestamp < ?').run(beforeIso);
      this.db.prepare('DELETE FROM cost_events WHERE timestamp < ?').run(beforeIso);
      this.db.prepare('DELETE FROM provider_sessions WHERE last_seen_at < ?').run(beforeIso);
      this.db.prepare('DELETE FROM alerts WHERE created_at < ?').run(beforeIso);
      this.db.prepare('DELETE FROM routing_recommendations WHERE generated_at < ?').run(beforeIso);
      this.db.prepare('DELETE FROM audit_logs WHERE at < ?').run(beforeIso);
      this.db.prepare('DELETE FROM account_daily_usage WHERE day < ?').run(beforeIso.slice(0, 10));
    });
  }

  dumpTable(table: string): Row[] {
    const allowed = [
      'provider_accounts',
      'quota_snapshots',
      'token_usage_events',
      'account_daily_usage',
      'provider_sessions',
      'cost_events',
      'routing_recommendations',
      'alerts',
      'audit_logs',
    ];
    if (!allowed.includes(table)) throw new Error(`tabla no exportable: ${table}`);
    return this.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  }
}

function rowToProfile(r: Row): ExecutionProfile {
  return {
    id: String(r.id),
    provider: String(r.provider) as Provider,
    alias: String(r.alias),
    configDir: str(r.config_dir),
    vscodeUserDataDir: str(r.vscode_user_data_dir),
    authType: str(r.auth_type),
    plan: str(r.plan),
    identityLabel: str(r.identity_label),
    identityHash: str(r.identity_hash),
    verification: String(r.verification),
    verificationDetail: str(r.verification_detail),
    verifiedAt: str(r.verified_at),
    machineId: String(r.machine_id),
    enabled: Number(r.enabled) === 1,
    detectedAt: String(r.detected_at),
    tokenSource: String(r.token_source) === 'otel' ? 'otel' : 'transcript',
  };
}

function rowToQuota(r: Row): QuotaSnapshot {
  return {
    accountId: String(r.account_id),
    limitId: String(r.limit_id),
    limitLabel: String(r.limit_label),
    windowMinutes: num(r.window_minutes),
    usedPercent: num(r.used_percent),
    remainingPercent: num(r.remaining_percent),
    resetsAt: str(r.resets_at),
    source: String(r.source) as QuotaSnapshot['source'],
    confidence: String(r.confidence) as QuotaSnapshot['confidence'],
    observedAt: String(r.observed_at),
    status: String(r.status) as QuotaSnapshot['status'],
    extra: r.extra_json ? (JSON.parse(String(r.extra_json)) as Record<string, unknown>) : null,
  };
}
