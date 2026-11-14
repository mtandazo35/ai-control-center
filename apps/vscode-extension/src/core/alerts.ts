import { evaluateBucket, label } from './recommend';
import type { AlertRecord, ExecutionProfile, QuotaSnapshot, Settings } from './types';
import { formatInZone, relative } from './util';

export interface CollectorStatus {
  accountId: string;
  ok: boolean;
  error: string | null;
  at: string;
  /** True when the failure means the session is signed out / expired (detected without reading credentials). */
  authProblem?: boolean;
}

/** Window cycle id: resets_at rounded to 10 min (two sources may differ by a second for the same window). */
export function cycle(resetsAt: string | null): string {
  return resetsAt ? String(Math.round(new Date(resetsAt).getTime() / 600000)) : 'na';
}

/**
 * Pure alert evaluation. Keys are stable per window cycle (they include resets_at), so the store's
 * INSERT OR IGNORE notifies each threshold once per window and again after the window resets.
 */
export function evaluateAlerts(
  profiles: ExecutionProfile[],
  quotas: QuotaSnapshot[],
  collectors: CollectorStatus[],
  settings: Settings,
  now: Date,
): AlertRecord[] {
  const out: AlertRecord[] = [];
  const at = now.toISOString();
  const thresholds = [...settings.thresholds].sort((a, b) => b - a);
  const byId = new Map(profiles.map((p) => [p.id, p]));

  for (const q of quotas) {
    const p = byId.get(q.accountId);
    if (!p || !p.enabled) continue;
    const ev = evaluateBucket(q, now, settings.staleMinutes);
    const name = `${label(p)} · ${q.limitLabel}`;
    if (ev.state === 'live' && q.usedPercent !== null) {
      const crossed = thresholds.find((t) => q.usedPercent! >= t);
      if (crossed !== undefined) {
        out.push({
          alertKey: `thr:${p.id}:${q.limitId}:${crossed}:${cycle(q.resetsAt)}`,
          accountId: p.id,
          severity: crossed >= 95 ? 'error' : 'warning',
          kind: 'threshold',
          message: `${name}: ${q.usedPercent} % usado (umbral ${crossed} %). Reinicia ${formatInZone(q.resetsAt, settings.timeZone)}.`,
          createdAt: at,
          acknowledged: false,
        });
      }
      if (q.resetsAt && q.usedPercent >= 85) {
        const ms = new Date(q.resetsAt).getTime() - now.getTime();
        if (ms > 0 && ms <= settings.resetSoonMinutes * 60000) {
          out.push({
            alertKey: `reset:${p.id}:${q.limitId}:${cycle(q.resetsAt)}`,
            accountId: p.id,
            severity: 'info',
            kind: 'reset_soon',
            message: `${name} se reinicia ${relative(q.resetsAt, now)} (${formatInZone(q.resetsAt, settings.timeZone, false)}).`,
            createdAt: at,
            acknowledged: false,
          });
        }
      }
    } else if (ev.state === 'stale') {
      out.push({
        alertKey: `stale:${p.id}:${q.limitId}:${q.observedAt}`,
        accountId: p.id,
        severity: 'warning',
        kind: 'stale',
        message: `${name}: dato desactualizado (último ${formatInZone(q.observedAt, settings.timeZone)}).`,
        createdAt: at,
        acknowledged: false,
      });
    }
  }

  const hourBucket = at.slice(0, 13);
  for (const c of collectors) {
    if (c.ok) continue;
    const p = byId.get(c.accountId);
    if (!p || !p.enabled) continue;
    out.push({
      alertKey: `${c.authProblem ? 'auth' : 'col'}:${p.id}:${hourBucket}`,
      accountId: p.id,
      severity: 'error',
      kind: c.authProblem ? 'auth' : 'collector_down',
      message: c.authProblem
        ? `${label(p)}: la sesión no está iniciada o expiró. Inicia sesión desde la herramienta oficial.`
        : `${label(p)}: el recolector falló — ${c.error ?? 'error desconocido'}`,
      createdAt: at,
      acknowledged: false,
    });
  }
  return out;
}
