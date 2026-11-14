import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newProfile } from '../src/collector';
import { Store } from '../src/core/store';
import type { ExecutionProfile, Provider, QuotaSnapshot, Settings } from '../src/core/types';

export const FIX = path.join(__dirname, 'fixtures');

export function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `acc-${tag}-`));
}

export function memStore(): Store {
  return new Store(':memory:');
}

export function profile(provider: Provider, id: string, alias = id, configDir: string | null = null): ExecutionProfile {
  const p = newProfile(provider, id, alias, configDir, 'm1');
  p.verification = 'verified';
  return p;
}

export const settings: Settings = {
  timeZone: 'America/Guayaquil',
  staleMinutes: 30,
  thresholds: [70, 85, 95],
  reservePercent: 10,
  resetSoonMinutes: 15,
};

export function quota(accountId: string, limitId: string, used: number | null, observedAt: Date, resetsAt: Date | null, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    accountId,
    limitId,
    limitLabel: limitId,
    windowMinutes: 300,
    usedPercent: used,
    remainingPercent: used === null ? null : 100 - used,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    source: 'codex-app-server',
    confidence: 'high',
    observedAt: observedAt.toISOString(),
    status: used === null ? 'unavailable' : 'live',
    ...extra,
  };
}

export const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60000);
