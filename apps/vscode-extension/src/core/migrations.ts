/**
 * SQLite schema, versioned. Each entry runs once, in order, inside a transaction.
 * Quota columns are nullable on purpose: unknown is NULL, never 0.
 * No column ever holds a token, cookie, password or prompt.
 */
export const MIGRATIONS: string[] = [
  /* 1 — base schema */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    hostname_hash TEXT NOT NULL,
    platform TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE provider_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex','gemini')),
    alias TEXT NOT NULL,
    local_profile_id TEXT NOT NULL,
    config_dir TEXT,
    vscode_user_data_dir TEXT,
    auth_type TEXT,
    plan TEXT,
    identity_label TEXT,
    identity_hash TEXT,
    verification TEXT NOT NULL DEFAULT 'pending',
    verification_detail TEXT,
    verified_at TEXT,
    machine_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    token_source TEXT NOT NULL DEFAULT 'transcript',
    detected_at TEXT NOT NULL
  );
  CREATE TABLE quota_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    limit_id TEXT NOT NULL,
    limit_label TEXT NOT NULL,
    window_minutes INTEGER,
    used_percent REAL,
    remaining_percent REAL,
    resets_at TEXT,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    extra_json TEXT,
    UNIQUE (machine_id, account_id, limit_id, source, observed_at)
  );
  CREATE INDEX ix_quota_account_time ON quota_snapshots(account_id, observed_at);
  CREATE TABLE token_usage_events (
    event_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    session_id TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX ix_tokens_account_time ON token_usage_events(account_id, timestamp);
  CREATE TABLE account_daily_usage (
    account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, day, source)
  );
  CREATE TABLE provider_sessions (
    session_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL,
    project TEXT,
    model TEXT,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX ix_sessions_account_seen ON provider_sessions(account_id, last_seen_at);
  CREATE TABLE cost_events (
    event_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    cost_basis TEXT NOT NULL CHECK (cost_basis IN ('provider_reported','estimated','billed')),
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX ix_cost_account_time ON cost_events(account_id, timestamp);
  CREATE TABLE routing_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    candidate_accounts TEXT NOT NULL,
    selected_account TEXT,
    rationale TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );
  CREATE TABLE alerts (
    alert_key TEXT PRIMARY KEY,
    account_id TEXT,
    severity TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_alerts_time ON alerts(created_at);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE agent_heartbeats (
    holder TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    version TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE ingest_cursors (
    path TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL
  );
  CREATE TABLE leases (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
];
