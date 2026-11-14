import { Store } from './store';
import type { ExecutionProfile, Provider } from './types';

/**
 * SIMULATED data for the demo mode. Lives in an in-memory database that is thrown away:
 * it can never be written to, or mixed with, the real store. Every alias says DEMO.
 */
export function buildDemoStore(now: Date): Store {
  const s = new Store(':memory:');
  const mk = (id: string, provider: Provider, alias: string, plan: string): ExecutionProfile => ({
    id,
    provider,
    alias,
    configDir: null,
    vscodeUserDataDir: null,
    authType: 'demo',
    plan,
    identityLabel: 'demo@ejemplo.invalid',
    identityHash: null,
    verifiedAt: now.toISOString(),
    verification: 'verified',
    verificationDetail: 'DATOS SIMULADOS',
    machineId: 'demo',
    enabled: true,
    detectedAt: now.toISOString(),
    tokenSource: 'transcript',
  });
  const profiles = [
    mk('demo-claude-a', 'claude', 'DEMO A', 'max'),
    mk('demo-codex-b', 'codex', 'DEMO B', 'plus'),
    mk('demo-codex-c', 'codex', 'DEMO C', 'pro'),
  ];
  profiles.forEach((p) => s.upsertProfile(p));
  const iso = (minFromNow: number) => new Date(now.getTime() + minFromNow * 60000).toISOString();
  const q = (accountId: string, limitId: string, label: string, mins: number, used: number, resetIn: number) =>
    s.insertQuota('demo', {
      accountId,
      limitId,
      limitLabel: label,
      windowMinutes: mins,
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: iso(resetIn),
      source: 'manual',
      confidence: 'low',
      observedAt: iso(-2),
      status: 'estimated',
      extra: { demo: true },
    });
  q('demo-claude-a', 'five_hour', '5 h', 300, 42, 130);
  q('demo-claude-a', 'seven_day', '7 d', 10080, 88, 2900);
  q('demo-codex-b', 'codex:primary', '5 h', 300, 18, 200);
  q('demo-codex-b', 'codex:secondary', '7 d', 10080, 28, 6000);
  q('demo-codex-c', 'codex:primary', '5 h', 300, 96, 25);
  for (let h = 0; h < 24; h++) {
    for (const p of profiles) {
      const t = new Date(now.getTime() - h * 3600000).toISOString();
      const k = (h * 7919 + p.id.length * 104729) % 50000;
      s.upsertTokenEvent({
        eventKey: `demo:${p.id}:${h}`,
        accountId: p.id,
        sessionId: `demo-${p.id}`,
        model: 'demo-model',
        inputTokens: 2000 + k,
        outputTokens: 500 + (k % 9000),
        cachedTokens: 10000 + k * 2,
        timestamp: t,
        source: 'manual',
      });
    }
  }
  for (const p of profiles) {
    s.upsertSession({
      sessionKey: `${p.id}:demo-${p.id}`,
      accountId: p.id,
      machineId: 'demo',
      project: 'proyecto-demo',
      model: 'demo-model',
      startedAt: iso(-90),
      lastSeenAt: iso(-3),
      source: 'manual',
    });
  }
  return s;
}
