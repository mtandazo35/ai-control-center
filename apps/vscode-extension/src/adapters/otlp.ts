import * as http from 'node:http';
import type { Store } from '../core/store';
import { toIso } from '../core/util';

/**
 * Local OTLP/HTTP (JSON) receiver for Claude Code metrics. Binds to 127.0.0.1 only.
 * Attribution: the resource attribute `acc.profile` (set by "habilitar telemetría") names the
 * execution profile. Data points without it are counted and dropped — never guessed.
 */

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type KeyValue = { key: string; value: AnyValue };
interface NumberDataPoint {
  attributes?: KeyValue[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: string | number;
}
interface Metric {
  name: string;
  sum?: { dataPoints?: NumberDataPoint[]; aggregationTemporality?: number | string; isMonotonic?: boolean };
  gauge?: { dataPoints?: NumberDataPoint[] };
}
export interface OtlpMetricsRequest {
  resourceMetrics?: { resource?: { attributes?: KeyValue[] }; scopeMetrics?: { metrics?: Metric[] }[] }[];
}

export interface OtlpIngestResult {
  points: number;
  stored: number;
  unattributed: number;
  sessions: Set<string>;
}

function attrs(list: KeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list ?? []) {
    const v = kv.value ?? {};
    out[kv.key] = String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '');
  }
  return out;
}

function value(dp: NumberDataPoint): number {
  if (typeof dp.asDouble === 'number') return dp.asDouble;
  if (dp.asInt !== undefined) return Number(dp.asInt);
  return 0;
}

const nanoToIso = (n: string | undefined): string | null => (n ? toIso(Number(BigInt(n) / 1000000n)) : null);

/** DELTA = 1, CUMULATIVE = 2 (OTLP enum; JSON may carry the name). */
function isCumulative(t: number | string | undefined): boolean {
  return t === 2 || t === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
}

export function ingestOtlpMetrics(
  store: Store,
  req: OtlpMetricsRequest,
  knownProfiles: Set<string>,
  machineId: string,
): OtlpIngestResult {
  const res: OtlpIngestResult = { points: 0, stored: 0, unattributed: 0, sessions: new Set() };
  for (const rm of req.resourceMetrics ?? []) {
    const rattrs = attrs(rm.resource?.attributes);
    const profile = rattrs['acc.profile'];
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const dps = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
        const cumulative = isCumulative(m.sum?.aggregationTemporality);
        for (const dp of dps) {
          res.points++;
          if (!profile || !knownProfiles.has(profile)) {
            res.unattributed++;
            continue;
          }
          const a = attrs(dp.attributes);
          const ts = nanoToIso(dp.timeUnixNano) ?? new Date().toISOString();
          const session = a['session.id'] || null;
          const model = a['model'] || null;
          const v = value(dp);
          // Cumulative series: one key per series, latest total replaces the previous (no double count).
          // Delta series: one key per export interval.
          const seriesKey = `${profile}:${session ?? '-'}:${model ?? '-'}:${a['type'] ?? '-'}`;
          const key = cumulative ? `otel:${m.name}:${seriesKey}` : `otel:${m.name}:${seriesKey}:${dp.timeUnixNano ?? ts}`;
          if (m.name === 'claude_code.token.usage') {
            const type = a['type'];
            store.upsertTokenEvent({
              eventKey: key,
              accountId: profile,
              sessionId: session,
              model,
              inputTokens: type === 'input' ? v : 0,
              outputTokens: type === 'output' ? v : 0,
              cachedTokens: type === 'cacheRead' || type === 'cacheCreation' ? v : 0,
              timestamp: ts,
              source: 'claude-otel',
            });
            res.stored++;
          } else if (m.name === 'claude_code.cost.usage') {
            store.upsertCost({
              eventKey: key,
              accountId: profile,
              amount: v,
              currency: 'USD',
              costBasis: 'estimated',
              timestamp: ts,
              source: 'claude-otel',
            });
            res.stored++;
          }
          if (session) {
            res.sessions.add(session);
            store.upsertSession({
              sessionKey: `${profile}:${session}`,
              accountId: profile,
              machineId,
              project: null,
              model,
              startedAt: nanoToIso(dp.startTimeUnixNano) ?? ts,
              lastSeenAt: ts,
              source: 'claude-otel',
            });
          }
        }
      }
    }
  }
  return res;
}

export interface OtlpServerHandle {
  port: number;
  close(): Promise<void>;
  stats: { requests: number; points: number; unattributed: number; rejected: number; lastAt: string | null };
}

const MAX_BODY = 8 * 1024 * 1024;

export function startOtlpReceiver(
  store: Store,
  port: number,
  knownProfiles: () => Set<string>,
  machineId: string,
  onIngest: (r: OtlpIngestResult) => void,
): Promise<OtlpServerHandle> {
  const stats: OtlpServerHandle['stats'] = { requests: 0, points: 0, unattributed: 0, rejected: 0, lastAt: null };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url) {
      res.writeHead(404).end();
      return;
    }
    const url = req.url.split('?')[0];
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.includes('json')) {
      stats.rejected++;
      res.writeHead(415, { 'content-type': 'text/plain' }).end('solo OTLP/HTTP JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)');
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      stats.requests++;
      stats.lastAt = new Date().toISOString();
      try {
        if (url === '/v1/metrics') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpMetricsRequest;
          const r = ingestOtlpMetrics(store, body, knownProfiles(), machineId);
          stats.points += r.points;
          stats.unattributed += r.unattributed;
          onIngest(r);
        }
        // /v1/logs and /v1/traces are accepted and discarded: they can carry prompt text.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch {
        stats.rejected++;
        res.writeHead(400).end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        stats,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
