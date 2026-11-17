import type { CollectorStatus } from './alerts';
import { evaluateBucket, label, recommend, type BucketState } from './recommend';
import type { Store } from './store';
import type { AlertRecord, ExecutionProfile, Provider, QuotaSnapshot, Settings } from './types';
import { axisLabels, displayLimitLabel, formatInZone, relative, resetText, zoneOffsetMinutes } from './util';

export type Range = '24h' | '7d' | '30d';

export interface BucketView {
  limitId: string;
  label: string;
  /** «Sesión (5 h)», «Semanal (7 días)», «Límite Fable». */
  displayLabel: string;
  /** «Se reinicia a las 14:40» / «Se reinicia jue 03/01 a las 03:00»; empty when unknown. */
  resetText: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetsLocal: string;
  resetsIn: string;
  observedAt: string;
  observedLocal: string;
  age: string;
  source: string;
  confidence: string;
  state: BucketState;
  reason: string;
  extra: Record<string, unknown> | null;
}

export interface ProfileView {
  id: string;
  provider: Provider;
  providerName: string;
  alias: string;
  title: string;
  plan: string | null;
  authType: string | null;
  identityLabel: string | null;
  verification: string;
  verificationDetail: string | null;
  enabled: boolean;
  tokenSource: string;
  hasOfficialQuota: boolean;
  buckets: BucketView[];
  connectorOk: boolean | null;
  connectorError: string | null;
  tokens24h: number;
  /** Context fill of the last measured Claude session (mod feed), when known. */
  sessionContext: { percent: number | null; at: string; age: string } | null;
  /** Runs/sessions seen in the last 24 h (used for providers that record no tokens, e.g. Antigravity). */
  runs24h: number;
  /** Breakdown of tokens24h: fresh input, input served from cache (not counted in tokens24h) and output. */
  tokens24hDetail: { input: number; cached: number; output: number };
  /** Usage per model in the last 24 h, largest first. */
  models24h: { model: string; calls: number; sessions: number; tokens: number }[];
  activeSessions: number;
  lastDataLocal: string;
  /** «hace 3 min», or null when the account has no data yet. */
  lastDataAge: string | null;
}

export interface ViewModel {
  isDemo: boolean;
  generatedAt: string;
  timeZone: string;
  range: Range;
  profiles: ProfileView[];
  recommendation: {
    summary: string;
    /** classification: the recommender's code, plus 'sin-porcentaje' (no % published, but recent proof of use); classLabel: for display. */
    ranked: { id: string; title: string; classification: string; classLabel: string; rationale: string; score: number | null }[];
  };
  sessions: { title: string; project: string | null; model: string | null; startedLocal: string; lastSeenLocal: string; durationMin: number; active: boolean; tokens: number; source: string }[];
  alerts: (AlertRecord & { createdLocal: string })[];
  series: {
    buckets: string[];
    labels: string[];
    labelsLong: string[];
    /** Sessions/runs started per bucket for every account (Antigravity included: it has runs, not tokens). */
    activity: { id: string; title: string; provider: Provider; runs: number[]; minutes: number[] }[];
    accounts: { id: string; title: string; input: number[]; output: number[]; cached: number[] }[] };
  officialDaily: { id: string; title: string; days: { day: string; tokens: number }[] }[];
  costs: { id: string; title: string; total: number; currency: string; basis: string }[];
  status: { text: string; tooltip: string };
}

export const providerName = (p: Provider): string => (p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'Gemini');

const ACTIVE_MIN = 10;

export function rangeStart(range: Range, now: Date): Date {
  const h = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return new Date(now.getTime() - h * 3600000);
}

/** Builds every bucket label between start and now, so empty hours/days show as 0 rather than vanish. */
export function bucketAxis(range: Range, now: Date, offsetMinutes = 0): string[] {
  const out: string[] = [];
  if (range === '24h') {
    const t = new Date(now);
    t.setUTCMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) out.push(new Date(t.getTime() - i * 3600000).toISOString().replace('.000Z', 'Z'));
  } else {
    const days = range === '7d' ? 7 : 30;
    // Local calendar days of the display zone.
    for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() + offsetMinutes * 60000 - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

export interface BuildInput {
  profiles: ExecutionProfile[];
  quotas: QuotaSnapshot[];
  alerts: AlertRecord[];
  collectors: CollectorStatus[];
  sessions: ReturnType<Store['sessions']>;
  tokenSeries: ReturnType<Store['tokenSeries']>;
  costSeries: ReturnType<Store['costSeries']>;
  sessionSeries: ReturnType<Store['sessionSeries']>;
  officialDaily: Record<string, { day: string; tokens: number }[]>;
  tokens24h: Record<string, number>;
  tokens24hDetail?: Record<string, { input: number; cached: number; output: number }>;
  models24h?: Record<string, { model: string; calls: number; sessions: number; tokens: number }[]>;
  sessionContext: Record<string, { percent: number | null; at: string }>;
  /** Display-zone offset used for the day buckets (minutes). */
  offsetMinutes: number;
}

export function gatherInput(store: Store, range: Range, now: Date, timeZone = 'America/Guayaquil'): BuildInput {
  const profiles = store.listProfiles();
  const offsetMinutes = zoneOffsetMinutes(timeZone, now);
  const start = rangeStart(range, now).toISOString();
  const day0 = start.slice(0, 10);
  const officialDaily: BuildInput['officialDaily'] = {};
  for (const p of profiles) if (p.provider === 'codex') officialDaily[p.id] = store.dailyUsage(p.id, day0);
  const tokens24h: Record<string, number> = {};
  const tokens24hDetail: NonNullable<BuildInput['tokens24hDetail']> = {};
  const models24h: NonNullable<BuildInput['models24h']> = {};
  for (const r of store.modelUsage(new Date(now.getTime() - 86400000).toISOString())) {
    tokens24h[r.accountId] = (tokens24h[r.accountId] ?? 0) + r.input + r.output;
    const d = (tokens24hDetail[r.accountId] ??= { input: 0, cached: 0, output: 0 });
    d.input += r.input;
    d.cached += r.cached;
    d.output += r.output;
    (models24h[r.accountId] ??= []).push({ model: r.model ?? 'modelo desconocido', calls: r.calls, sessions: r.sessions, tokens: r.input + r.output });
  }
  const sessionContext: BuildInput['sessionContext'] = {};
  for (const p of profiles) {
    const raw = p.provider === 'claude' || p.provider === 'gemini' ? store.getSetting(`${p.provider}-context:${p.id}`) : null;
    if (raw) {
      try {
        const c = JSON.parse(raw) as { percent: number | null; at: string };
        sessionContext[p.id] = { percent: c.percent, at: c.at };
      } catch {
        /* ignore */
      }
    }
  }
  let collectors: CollectorStatus[] = [];
  try {
    collectors = JSON.parse(store.getSetting('collectors') ?? '[]') as CollectorStatus[];
  } catch {
    collectors = [];
  }
  return {
    profiles,
    quotas: store.latestQuotas(),
    alerts: store.alerts(50),
    collectors,
    sessions: store.sessions(new Date(now.getTime() - 7 * 86400000).toISOString()),
    tokenSeries: store.tokenSeries(start, range === '24h' ? 'hour' : 'day', offsetMinutes),
    costSeries: store.costSeries(start, offsetMinutes),
    sessionSeries: store.sessionSeries(start, range === '24h' ? 'hour' : 'day', offsetMinutes),
    offsetMinutes,
    officialDaily,
    tokens24h,
    tokens24hDetail,
    models24h,
    sessionContext,
  };
}

export function buildViewModel(input: BuildInput, settings: Settings, range: Range, now: Date, isDemo = false): ViewModel {
  const tz = settings.timeZone;
  const byId = new Map(input.profiles.map((p) => [p.id, p]));
  const title = (id: string) => {
    const p = byId.get(id);
    return p ? label(p) : id;
  };
  const activeByAcc: Record<string, number> = {};
  const runsByAcc: Record<string, number> = {};
  const sessions = input.sessions.map((s) => {
    const active = now.getTime() - new Date(s.lastSeenAt).getTime() < ACTIVE_MIN * 60000;
    if (active) activeByAcc[s.accountId] = (activeByAcc[s.accountId] ?? 0) + 1;
    if (now.getTime() - new Date(s.lastSeenAt).getTime() < 86400000) runsByAcc[s.accountId] = (runsByAcc[s.accountId] ?? 0) + 1;
    return {
      title: title(s.accountId),
      project: s.project,
      model: s.model,
      startedLocal: formatInZone(s.startedAt, tz),
      lastSeenLocal: formatInZone(s.lastSeenAt, tz),
      durationMin: Math.max(0, Math.round((new Date(s.lastSeenAt).getTime() - new Date(s.startedAt).getTime()) / 60000)),
      active,
      tokens: s.tokens,
      source: s.source,
    };
  });

  const profiles: ProfileView[] = input.profiles.map((p) => {
    const ord = (q: QuotaSnapshot) => (typeof q.extra?.order === 'number' ? q.extra.order : 0);
    const qs = input.quotas.filter((q) => q.accountId === p.id).sort((a, b) => ord(a) - ord(b));
    const buckets = qs.map((q): BucketView => {
      const ev = evaluateBucket(q, now, settings.staleMinutes);
      return {
        limitId: q.limitId,
        label: q.limitLabel,
        displayLabel: displayLimitLabel(q.limitLabel, q.windowMinutes),
        resetText: resetText(q.resetsAt, tz, now) + (q.source === 'claude-activity-estimate' && q.resetsAt ? ' (estimado)' : ''),
        usedPercent: q.usedPercent,
        remainingPercent: q.remainingPercent,
        resetsAt: q.resetsAt,
        resetsLocal: formatInZone(q.resetsAt, tz),
        resetsIn: relative(q.resetsAt, now),
        observedAt: q.observedAt,
        observedLocal: formatInZone(q.observedAt, tz),
        age: relative(q.observedAt, now),
        source: q.source,
        confidence: q.confidence,
        state: ev.state,
        reason: ev.reason,
        extra: q.extra ?? null,
      };
    });
    const col = input.collectors.find((c) => c.accountId === p.id);
    const last = qs.map((q) => q.observedAt).sort().pop() ?? null;
    return {
      id: p.id,
      provider: p.provider,
      providerName: providerName(p.provider),
      alias: p.alias,
      title: label(p),
      plan: p.plan,
      authType: p.authType,
      identityLabel: p.identityLabel,
      verification: p.verification,
      verificationDetail: p.verificationDetail,
      enabled: p.enabled,
      tokenSource: p.tokenSource,
      hasOfficialQuota: buckets.length > 0,
      buckets,
      connectorOk: col ? col.ok : null,
      connectorError: col?.error ?? null,
      tokens24h: input.tokens24h[p.id] ?? 0,
      runs24h: runsByAcc[p.id] ?? 0,
      tokens24hDetail: input.tokens24hDetail?.[p.id] ?? { input: 0, cached: 0, output: 0 },
      models24h: input.models24h?.[p.id] ?? [],
      sessionContext: input.sessionContext[p.id] ? { ...input.sessionContext[p.id], age: relative(input.sessionContext[p.id].at, now) } : null,
      activeSessions: activeByAcc[p.id] ?? 0,
      lastDataLocal: last ? `${formatInZone(last, tz)} (${relative(last, now)})` : 'sin datos',
      lastDataAge: last ? relative(last, now) : null,
    };
  });

  const rec = recommend(input.profiles, input.quotas, {
    now,
    staleMinutes: settings.staleMinutes,
    reservePercent: settings.reservePercent,
  });

  const axis = bucketAxis(range, now, input.offsetMinutes);
  const labels = axisLabels(axis, range, tz);
  const accounts = input.profiles
    .filter((p) => input.tokenSeries.some((r) => r.accountId === p.id))
    .map((p) => {
      const rows = input.tokenSeries.filter((r) => r.accountId === p.id);
      const pick = (k: 'input' | 'output' | 'cached') =>
        axis.map((b) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + r[k], 0));
      return { id: p.id, title: label(p), input: pick('input'), output: pick('output'), cached: pick('cached') };
    });

  const activity = input.profiles
    .filter((p) => input.sessionSeries.some((r) => r.accountId === p.id))
    .map((p) => {
      const rows = input.sessionSeries.filter((r) => r.accountId === p.id);
      return {
        id: p.id,
        title: label(p),
        provider: p.provider,
        runs: axis.map((b) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + r.runs, 0)),
        minutes: axis.map((b) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + r.minutes, 0)),
      };
    });

  const costMap = new Map<string, { id: string; title: string; total: number; currency: string; basis: string }>();
  for (const c of input.costSeries) {
    const k = `${c.accountId}|${c.currency}|${c.basis}`;
    const cur = costMap.get(k) ?? { id: c.accountId, title: title(c.accountId), total: 0, currency: c.currency, basis: c.basis };
    cur.total += c.amount;
    costMap.set(k, cur);
  }

  return {
    isDemo,
    generatedAt: now.toISOString(),
    timeZone: tz,
    range,
    profiles,
    recommendation: {
      summary: rec.summary,
      ranked: rec.ranked.map((c) => {
        const view = profiles.find((p) => p.id === c.profile.id);
        const usage = c.classification === 'sin-datos' && view ? usageWithoutPercent(c.profile, view, input.quotas, tz, now) : null;
        const classification = usage ? 'sin-porcentaje' : c.classification;
        return {
          id: c.profile.id,
          title: label(c.profile),
          classification,
          classLabel: CLASS_LABEL[classification] ?? classification,
          rationale: usage ?? c.rationale,
          score: c.score,
        };
      }),
    },
    sessions,
    alerts: input.alerts.map((a) => ({ ...a, createdLocal: formatInZone(a.createdAt, tz) })),
    series: { buckets: axis, labels: labels.short, labelsLong: labels.long, activity, accounts },
    officialDaily: Object.entries(input.officialDaily).map(([id, days]) => ({ id, title: title(id), days })),
    costs: [...costMap.values()],
    status: statusText(profiles, isDemo),
  };
}

/** Status bar: real percentages only. Without live official data: "AI: N cuentas · M sin datos". */
export function statusText(profiles: ProfileView[], isDemo: boolean): { text: string; tooltip: string } {
  const enabled = profiles.filter((p) => p.enabled && p.provider !== 'gemini');
  const parts: string[] = [];
  const tips: string[] = [];
  let noData = 0;
  for (const p of enabled) {
    const live = p.buckets.filter((b) => b.state === 'live' && b.usedPercent !== null);
    if (!live.length) {
      noData++;
      tips.push(`${p.title}: sin cuota oficial vigente`);
      continue;
    }
    const top = live.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
    parts.push(`${p.providerName}${enabled.filter((x) => x.provider === p.provider).length > 1 ? ` ${p.alias}` : ''} ${top.label.replace(' ', '')} ${Math.round(top.usedPercent!)}%`);
    tips.push(`${p.title}: ${live.map((b) => `${b.label} ${b.usedPercent}% (reinicia ${b.resetsLocal}; fuente ${b.source}, ${b.age})`).join(' · ')}`);
  }
  const prefix = isDemo ? 'AI DEMO' : 'AI';
  let text: string;
  if (parts.length) text = `${prefix}: ${parts.join(' · ')}${noData ? ` · ${noData} sin datos` : ''}`;
  else text = `${prefix}: ${enabled.length} cuenta${enabled.length === 1 ? '' : 's'} · ${noData} sin datos`;
  return { text, tooltip: (isDemo ? 'DATOS SIMULADOS (modo demo)\n' : '') + (tips.join('\n') || 'Sin perfiles') };
}

export const CLASS_LABEL: Record<string, string> = {
  recomendable: 'Recomendable',
  'bajo-reserva': 'Bajo la reserva',
  agotada: 'Agotada',
  'sin-datos': 'Sin datos',
  'sin-porcentaje': 'Sin porcentaje',
  deshabilitada: 'Deshabilitada',
  'no-compatible': 'No compatible',
};

/**
 * Antigravity publishes no quota %, but its logs prove the last run finished (so there WAS quota then) and its
 * conversations give the tokens. Says what is known instead of «sin dato oficial». Never makes the account
 * eligible: the recommender still does not score it. Null when there is no such proof.
 */
function usageWithoutPercent(p: ExecutionProfile, view: ProfileView, quotas: QuotaSnapshot[], tz: string, now: Date): string | null {
  if (p.provider !== 'gemini') return null;
  const ok = quotas
    .filter((q) => q.accountId === p.id && q.source === 'antigravity-log' && q.status === 'unavailable')
    .map((q) => q.observedAt)
    .sort()
    .pop();
  if (!ok && view.tokens24h === 0) return null;
  const parts = ['Antigravity no publica el %'];
  if (ok) parts.push(`la última ejecución (${whenLocal(ok, tz, now)}) terminó bien`);
  if (view.tokens24h > 0) parts.push(`${fmtTokens(view.tokens24h)} tokens en 24 h`);
  return parts.join('; ');
}

function whenLocal(iso: string, tz: string, now: Date): string {
  const sameDay = formatInZone(iso, tz).slice(0, 10) === formatInZone(now.toISOString(), tz).slice(0, 10);
  return sameDay ? 'hoy ' + formatInZone(iso, tz, false) : formatInZone(iso, tz);
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
}
