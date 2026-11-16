/**
 * Domain types. Every measure carries its source, observation time, confidence and status:
 * an official quota percentage is never derived from token counts, and an unknown value is null.
 */

export type Provider = 'claude' | 'codex' | 'gemini';

/** live = fresh official data; stale = official but old; unavailable = no official source; estimated = derived. */
export type DataStatus = 'live' | 'stale' | 'unavailable' | 'estimated';

export type Confidence = 'high' | 'medium' | 'low';

/** Where a measure came from. Kept as an open string union so new connectors can add sources. */
export type DataSource =
  | 'codex-app-server'
  | 'codex-rollout'
  | 'claude-statusline'
  | 'claude-transcript'
  | 'claude-otel'
  | 'claude-auth-status'
  | 'antigravity-log'
  | 'antigravity-conversation'
  | 'claude-usage-cache'
  | 'claude-mod'
  | 'claude-activity-estimate'
  | 'manual'
  | 'detection';

export interface ExecutionProfile {
  id: string;
  provider: Provider;
  alias: string;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME root for this profile; null for providers without one. */
  configDir: string | null;
  /** Optional dedicated VS Code --user-data-dir for "Abrir perfil de VS Code". */
  vscodeUserDataDir: string | null;
  authType: string | null;
  plan: string | null;
  /** Masked e-mail (m***@dominio) — never the full address, never a token. */
  identityLabel: string | null;
  /** SHA-256 of the provider account/org id: lets us detect two profiles that are the same account. */
  identityHash: string | null;
  verifiedAt: string | null;
  /** 'verified' | 'pending' | 'failed' | 'unsupported' */
  verification: string;
  verificationDetail: string | null;
  machineId: string;
  enabled: boolean;
  detectedAt: string;
  /** Where observed token counts come from for this profile, to avoid double counting. */
  tokenSource: 'transcript' | 'otel';
}

export interface QuotaSnapshot {
  accountId: string;
  limitId: string;
  /** Human label for the window, e.g. "5 h", "7 d", "codex · 5 h". */
  limitLabel: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null; // ISO UTC
  source: DataSource;
  confidence: Confidence;
  observedAt: string; // ISO UTC
  status: DataStatus;
  /** Extra provider fields worth showing (plan, credits, reached type). No secrets. */
  extra?: Record<string, unknown> | null;
}

export interface TokenUsageEvent {
  eventKey: string;
  accountId: string;
  sessionId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  timestamp: string;
  source: DataSource;
}

export interface ProviderSession {
  sessionKey: string;
  accountId: string;
  machineId: string;
  /** Project folder name only — never the full path. */
  project: string | null;
  model: string | null;
  startedAt: string;
  lastSeenAt: string;
  source: DataSource;
}

export interface CostEvent {
  eventKey: string;
  accountId: string;
  amount: number;
  currency: string;
  costBasis: 'provider_reported' | 'estimated' | 'billed';
  timestamp: string;
  source: DataSource;
}

export interface AlertRecord {
  alertKey: string;
  accountId: string | null;
  severity: 'info' | 'warning' | 'error';
  kind: 'threshold' | 'reset_soon' | 'collector_down' | 'auth' | 'stale' | 'budget';
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

export interface Settings {
  timeZone: string;
  staleMinutes: number;
  thresholds: number[];
  reservePercent: number;
  resetSoonMinutes: number;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
