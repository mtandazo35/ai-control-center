import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Collector, newProfile, verifyProfile, type CollectorConfig } from '../src/collector';
import { buildDemoStore } from '../src/core/demo';
import { Store } from '../src/core/store';
import { redact } from '../src/core/util';
import { buildViewModel, gatherInput, statusText } from '../src/core/viewmodel';
import { FIX, settings, tmpDir } from './helpers';

/**
 * End-to-end over the real collector, store, alert and recommendation code. Only the provider
 * CLIs are replaced by test doubles (fixtures/fake-cli.js) speaking the verified wire formats.
 */
const FAKE = `"${process.execPath}" "${path.join(FIX, 'fake-cli.js')}"`;

function codexHome(tag: string, accountId: string, primaryUsed: number, secondaryUsed: number, resetsAt: number): string {
  const d = tmpDir(`codex-${tag}`);
  writeCodex(d, accountId, primaryUsed, secondaryUsed, resetsAt);
  return d;
}

function writeCodex(d: string, accountId: string, primaryUsed: number, secondaryUsed: number, resetsAt: number): void {
  const bucket = {
    limitId: 'codex',
    primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt },
    secondary: { usedPercent: secondaryUsed, windowDurationMins: 10080, resetsAt: resetsAt + 6 * 86400 },
    planType: 'pro',
  };
  fs.writeFileSync(
    path.join(d, 'fake-codex.json'),
    JSON.stringify({
      initialize: { codexHome: d },
      'account/read': { account: { type: 'chatgpt', email: `${accountId}@ejemplo.invalid`, planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: accountId } },
      'account/rateLimits/read': { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, ordinaryUsageAllowed: true, accountId },
      'account/usage/read': { summary: {}, dailyUsageBuckets: [{ startDate: new Date().toISOString().slice(0, 10), tokens: 5000 }] },
    }),
  );
}

describe('end to end: multiple accounts, updates, history, alerts, recommendation, no secret leaks', () => {
  it('runs the collector against two Codex homes and one Claude profile', async () => {
    const dataDir = tmpDir('e2e-data');
    const store = new Store(path.join(dataDir, 'db.sqlite'));
    const soon = Math.floor(Date.now() / 1000) + 3 * 3600;
    const homeB = codexHome('b', 'acct-B', 30, 20, soon);
    const homeC = codexHome('c', 'acct-C', 91, 50, soon);
    const claudeDir = tmpDir('claude');
    fs.mkdirSync(path.join(claudeDir, 'projects', 'p'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'claude-transcript.jsonl'), path.join(claudeDir, 'projects', 'p', 's-1.jsonl'));
    fs.writeFileSync(path.join(claudeDir, 'fake-auth.json'), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'persona@ejemplo.invalid', orgId: 'org-1', subscriptionType: 'team' }));

    store.upsertProfile(newProfile('codex', 'codex-b', 'B', homeB, 'm1'));
    store.upsertProfile(newProfile('codex', 'codex-c', 'C', homeC, 'm1'));
    store.upsertProfile(newProfile('claude', 'claude-a', 'A', claudeDir, 'm1'));
    const cfg: CollectorConfig = { dataDir, claudeCommand: FAKE, codexCommand: FAKE, pollMinutes: 5, retentionDays: 90, settings };
    const col = new Collector(store, cfg, 'm1', 'test', 'extension');

    // ---- first run
    const r1 = await col.runOnce({ force: true });
    expect(r1.statuses.every((s) => s.ok)).toBe(true);
    const profiles = Object.fromEntries(store.listProfiles().map((p) => [p.id, p]));
    expect(profiles['codex-b']).toMatchObject({ verification: 'verified', plan: 'pro', identityLabel: 'a***B@ejemplo.invalid' });
    expect(profiles['claude-a']).toMatchObject({ verification: 'verified', plan: 'team', authType: 'claude.ai' });
    expect(r1.newAlerts.map((a) => a.message).join()).toContain('Codex · C · 5 h: 91 %');

    // ---- recommendation: B has the most remaining capacity; Claude has no official quota → not scored
    const now = new Date();
    let vm = buildViewModel(gatherInput(store, '24h', now), settings, '24h', now);
    expect(vm.recommendation.summary).toMatch(/^Recomendada: Codex · B; 70 % restante en 5 h/);
    expect(vm.recommendation.ranked.find((c) => c.id === 'claude-a')?.classification).toBe('sin-datos');
    expect(vm.profiles.find((p) => p.id === 'claude-a')?.hasOfficialQuota).toBe(false);
    expect(vm.profiles.find((p) => p.id === 'claude-a')?.tokens24h).toBeGreaterThanOrEqual(0);
    expect(vm.status.text).toMatch(/^AI: Codex B 5h 30% · Codex C 5h 91% · 1 sin datos$/);
    expect(vm.officialDaily.find((d) => d.id === 'codex-b')?.days[0].tokens).toBe(5000);

    // ---- update: B gets busier; a new snapshot is stored, history grows, UI reflects it
    writeCodex(homeB, 'acct-B', 88, 40, soon);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await col.runOnce({ force: true });
    expect(r2.newAlerts.some((a) => a.message.includes('Codex · B · 5 h: 88 %'))).toBe(true);
    const r3 = await col.runOnce({ force: true });
    expect(r3.newAlerts.filter((a) => a.kind === 'threshold')).toHaveLength(0); // already notified in this window
    expect(store.quotaHistory('codex-b', '2000-01-01').filter((q) => q.limitId === 'codex:primary').length).toBeGreaterThanOrEqual(3);
    vm = buildViewModel(gatherInput(store, '24h', new Date()), settings, '24h', new Date());
    expect(vm.recommendation.summary).toMatch(/^Recomendada: Codex · B; 12 % restante/);

    // ---- isolation check: a third profile pointing at the same account is flagged
    const homeB2 = codexHome('b2', 'acct-B', 88, 40, soon);
    const twin = newProfile('codex', 'codex-b2', 'B bis', homeB2, 'm1');
    store.upsertProfile(twin);
    const v = await verifyProfile(store, cfg, twin);
    expect(v.message).toContain('misma cuenta que «B»');

    // ---- signed-out profile → auth alert, never a fake number
    fs.writeFileSync(path.join(claudeDir, 'fake-auth.json'), JSON.stringify({ loggedIn: false }));
    const r4 = await col.runOnce({ force: true });
    expect(r4.statuses.find((s) => s.accountId === 'claude-a')).toMatchObject({ ok: false, authProblem: true });
    expect(store.alerts().some((a) => a.kind === 'auth' && a.accountId === 'claude-a')).toBe(true);

    // ---- no secret / personal data anywhere in the database
    for (const t of ['provider_accounts', 'quota_snapshots', 'token_usage_events', 'provider_sessions', 'alerts', 'audit_logs', 'cost_events', 'account_daily_usage']) {
      for (const row of store.dumpTable(t)) {
        const { identity_label: _masked, config_dir: _dir, ...rest } = row;
        const txt = JSON.stringify(rest);
        expect(redact(txt), `fuga en ${t}`).toBe(txt);
        expect(txt).not.toMatch(/PRIVAD|persona@|acct-B@/);
      }
    }
    store.close();
  }, 60000);

  it('demo data is labelled and never touches the real store', () => {
    const real = new Store(':memory:');
    const now = new Date();
    const demo = buildDemoStore(now);
    const vm = buildViewModel(gatherInput(demo, '24h', now), settings, '24h', now, true);
    expect(vm.isDemo).toBe(true);
    expect(vm.status.text.startsWith('AI DEMO:')).toBe(true);
    expect(vm.status.tooltip).toContain('SIMULADOS');
    expect(vm.profiles.every((p) => p.alias.startsWith('DEMO'))).toBe(true);
    expect(real.listProfiles()).toHaveLength(0);
    expect(real.latestQuotas()).toHaveLength(0);
  });

  it('status bar never invents a percentage', () => {
    const s = statusText(
      [
        { id: 'a', provider: 'claude', providerName: 'Claude', alias: 'A', title: 'Claude · A', plan: null, authType: null, identityLabel: null, verification: 'verified', verificationDetail: null, enabled: true, tokenSource: 'transcript', hasOfficialQuota: false, buckets: [], connectorOk: true, connectorError: null, tokens24h: 999999, runs24h: 0, sessionContext: null, activeSessions: 2, lastDataLocal: '', lastDataAge: null, tokens24hDetail: { input: 0, cached: 0, output: 0 }, models24h: [] },
        { id: 'b', provider: 'codex', providerName: 'Codex', alias: 'B', title: 'Codex · B', plan: null, authType: null, identityLabel: null, verification: 'verified', verificationDetail: null, enabled: true, tokenSource: 'transcript', hasOfficialQuota: true, buckets: [{ limitId: 'x', label: '5 h', displayLabel: 'Sesión (5 h)', resetText: '', usedPercent: 50, remainingPercent: 50, resetsAt: null, resetsLocal: '', resetsIn: '', observedAt: '', observedLocal: '', age: '', source: 'codex-app-server', confidence: 'high', state: 'stale', reason: '', extra: null }], connectorOk: true, connectorError: null, tokens24h: 0, runs24h: 0, sessionContext: null, activeSessions: 0, lastDataLocal: '', lastDataAge: null, tokens24hDetail: { input: 0, cached: 0, output: 0 }, models24h: [] },
      ],
      false,
    );
    expect(s.text).toBe('AI: 2 cuentas · 2 sin datos');
  });
});
