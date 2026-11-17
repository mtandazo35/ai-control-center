import type { ExecutionProfile, Provider, QuotaSnapshot } from './types';

export type BucketState = 'live' | 'stale' | 'reset' | 'unknown';

export interface EvaluatedBucket {
  snapshot: QuotaSnapshot;
  state: BucketState;
  /** Remaining % usable for scoring — only set when state === 'live'. */
  remaining: number | null;
  reason: string;
}

/**
 * Decides whether an official quota snapshot may be trusted *now*.
 * - resets_at already passed -> 'reset': the window restarted, its new usage is unknown (not 0).
 * - older than staleMinutes  -> 'stale'.
 * - no used/remaining value  -> 'unknown'.
 */
export function evaluateBucket(q: QuotaSnapshot, now: Date, staleMinutes: number): EvaluatedBucket {
  const used = q.usedPercent;
  const remaining = q.remainingPercent ?? (used === null ? null : Math.max(0, 100 - used));
  if (q.status === 'unavailable' || (used === null && q.remainingPercent === null)) {
    const why = q.source === 'claude-activity-estimate' ? 'ventana activa; % sin dato oficial (reinicio estimado por tu actividad)' : 'sin dato oficial';
    if (q.source === 'claude-activity-estimate' && q.resetsAt && Date.parse(q.resetsAt) <= now.getTime()) {
      return { snapshot: q, state: 'reset', remaining: null, reason: 'la ventana ya se reinició; falta un dato nuevo' };
    }
    return { snapshot: q, state: 'unknown', remaining: null, reason: why };
  }
  if (q.resetsAt && new Date(q.resetsAt).getTime() <= now.getTime()) {
    return { snapshot: q, state: 'reset', remaining: null, reason: 'la ventana ya se reinició; falta un dato nuevo' };
  }
  const ageMin = (now.getTime() - new Date(q.observedAt).getTime()) / 60000;
  // An exhaustion notice (Antigravity log, Claude limit message) carries the reset time: it holds until then however old it is.
  // (Not for Codex: its reset credits can restore a window early.)
  if ((q.source === 'antigravity-log' || q.source === 'claude-transcript') && used !== null && used >= 100 && q.resetsAt) {
    return { snapshot: q, state: 'live', remaining: 0, reason: 'agotada según el servidor hasta el reinicio' };
  }
  if (ageMin > staleMinutes) {
    return { snapshot: q, state: 'stale', remaining: null, reason: `dato de hace ${Math.round(ageMin)} min` };
  }
  return { snapshot: q, state: 'live', remaining, reason: 'vigente' };
}

export interface Candidate {
  profile: ExecutionProfile;
  buckets: EvaluatedBucket[];
  /** Lowest remaining % among live buckets — the bottleneck window. */
  bottleneck: EvaluatedBucket | null;
  score: number | null;
  eligible: boolean;
  classification: 'recomendable' | 'bajo-reserva' | 'agotada' | 'sin-datos' | 'deshabilitada' | 'no-compatible';
  rationale: string;
}

export interface RecommendOptions {
  now: Date;
  staleMinutes: number;
  reservePercent: number;
  /** Restrict to providers able to do the task. Empty = any. */
  providers?: Provider[];
  /** Small tie-break bonus for staying on the provider already used for this project. */
  continuityProvider?: Provider | null;
  weights?: { remaining: number; continuity: number; partialPenalty: number; resetBonus: number };
}

const DEFAULT_WEIGHTS = { remaining: 1, continuity: 5, partialPenalty: 10, resetBonus: 5 };

/**
 * Ranks accounts by documented remaining capacity. Never compares tokens across providers and never
 * scores an account without live official data: those are listed as 'sin-datos', not as free.
 */
export function recommend(
  profiles: ExecutionProfile[],
  quotas: QuotaSnapshot[],
  opts: RecommendOptions,
): { ranked: Candidate[]; selected: Candidate | null; summary: string } {
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const candidates: Candidate[] = profiles.map((p) => {
    const buckets = quotas
      .filter((q) => q.accountId === p.id)
      .map((q) => evaluateBucket(q, opts.now, opts.staleMinutes));
    const base = { profile: p, buckets, bottleneck: null, score: null, eligible: false } as const;
    if (!p.enabled) return { ...base, classification: 'deshabilitada', rationale: 'perfil deshabilitado' };
    if (opts.providers && opts.providers.length && !opts.providers.includes(p.provider)) {
      return { ...base, classification: 'no-compatible', rationale: 'proveedor no apto para esta tarea' };
    }
    // Buckets marked `extra.scoring === false` (e.g. Claude/GPT and Argon inside Antigravity) are shown, not scored.
    const live = buckets.filter((b) => b.state === 'live' && b.snapshot.extra?.scoring !== false);
    if (live.length === 0) {
      const why = buckets.length === 0 ? 'sin cuota oficial disponible' : buckets.map((b) => `${b.snapshot.limitLabel}: ${b.reason}`).join('; ');
      return { ...base, classification: 'sin-datos', rationale: why };
    }
    const bottleneck = live.reduce((a, b) => ((b.remaining ?? 0) < (a.remaining ?? 0) ? b : a));
    const rem = bottleneck.remaining ?? 0;
    const partial = buckets.some((b) => b.state !== 'live' && b.snapshot.extra?.scoring !== false);
    if (rem <= 0) {
      return {
        ...base,
        bottleneck,
        classification: 'agotada',
        rationale: `${bottleneck.snapshot.limitLabel} agotada`,
      };
    }
    if (rem < opts.reservePercent) {
      return {
        ...base,
        bottleneck,
        classification: 'bajo-reserva',
        rationale: `${bottleneck.snapshot.limitLabel}: ${fmt(rem)} % restante, bajo la reserva de ${opts.reservePercent} %`,
      };
    }
    // A bottleneck window that resets within the hour is less of a constraint.
    const resetSoon =
      bottleneck.snapshot.resetsAt &&
      new Date(bottleneck.snapshot.resetsAt).getTime() - opts.now.getTime() < 60 * 60000;
    let score = rem * w.remaining;
    if (partial) score -= w.partialPenalty;
    if (resetSoon) score += w.resetBonus;
    if (opts.continuityProvider && opts.continuityProvider === p.provider) score += w.continuity;
    const parts = [`${fmt(rem)} % restante en ${bottleneck.snapshot.limitLabel} (ventana más cargada)`];
    if (partial) parts.push('alguna ventana sin dato vigente');
    if (resetSoon) parts.push('esa ventana se reinicia en menos de 1 h');
    return { ...base, bottleneck, score, eligible: true, classification: 'recomendable', rationale: parts.join('; ') };
  });

  const ranked = [...candidates].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });
  const selected = ranked.find((c) => c.eligible) ?? null;
  let summary: string;
  if (!selected) {
    summary = 'Sin recomendación: ninguna cuenta tiene cuota oficial vigente por encima de la reserva.';
  } else {
    const others = ranked
      .filter((c) => c !== selected && c.bottleneck && c.classification !== 'recomendable')
      .slice(0, 2)
      .map((c) => `${label(c.profile)}: ${c.rationale}`);
    summary = `Recomendada: ${label(selected.profile)}; ${selected.rationale}` + (others.length ? `. ${others.join('. ')}` : '');
  }
  return { ranked, selected, summary };
}

export function label(p: ExecutionProfile): string {
  const prov = p.provider === 'claude' ? 'Claude' : p.provider === 'codex' ? 'Codex' : 'Gemini';
  return `${prov} · ${p.alias}`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
