import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateClaudeSession, inferFiveHourWindow, ingestClaudeUsageCache, parseLimitNotice, usageCacheToSnapshots } from '../src/adapters/claudeUsage';
import { applyClaudeTranscriptRecord } from '../src/adapters/localLogs';
import { evaluateBucket } from '../src/core/recommend';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput } from '../src/core/viewmodel';
import { profile, settings, tmpDir } from './helpers';

/** Shape of `cachedUsageUtilization` as written by Claude Code 2.1.319 (values anonymized). */
const CACHE = {
  fetchedAtMs: Date.UTC(2030, 0, 8, 13, 35, 10),
  accountUuid: '00000000-0000-4000-8000-00000000abcd',
  utilization: {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 64, resets_at: '2030-01-10T08:00:00.374858+00:00' },
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null, scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 64, severity: 'normal', resets_at: '2030-01-10T08:00:00.374858+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 9, severity: 'normal', resets_at: '2030-01-10T08:00:00.375006+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    ],
  },
};

describe('Claude usage cache (/usage data cached by Claude Code)', () => {
  it('maps every limit, sharing ids with the statusLine capture', () => {
    const s = usageCacheToSnapshots('claude-a', CACHE);
    expect(s.map((x) => [x.limitId, x.limitLabel, x.usedPercent, x.resetsAt])).toEqual([
      ['five_hour', '5 h', 0, null],
      ['seven_day', '7 d', 64, '2030-01-10T08:00:00.374Z'],
      ['seven_day:fable', '7 d · Fable', 9, '2030-01-10T08:00:00.375Z'],
    ]);
    expect(s[1]).toMatchObject({ source: 'claude-usage-cache', observedAt: '2030-01-08T13:35:10.000Z', remainingPercent: 36, extra: { severity: 'normal' } });
  });

  it('older shape without limits[]; malformed or missing cache gives nothing', () => {
    const old = usageCacheToSnapshots('a', { fetchedAtMs: CACHE.fetchedAtMs, utilization: { five_hour: { utilization: 40, resets_at: null }, seven_day: { utilization: 10, resets_at: null } } });
    expect(old.map((x) => [x.limitId, x.usedPercent])).toEqual([['five_hour', 40], ['seven_day', 10]]);
    expect(usageCacheToSnapshots('a', null)).toEqual([]);
    expect(usageCacheToSnapshots('a', { utilization: {} })).toEqual([]);
    expect(usageCacheToSnapshots('a', { fetchedAtMs: 1, utilization: { limits: [{ kind: 'x' }] } })).toEqual([]);
  });

  it('reads only cachedUsageUtilization from the state file; idempotent', () => {
    const dir = tmpDir('claude-state');
    const f = path.join(dir, '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ oauthAccount: { emailAddress: 'persona@ejemplo.invalid' }, projects: { 'C:/secreto': {} }, cachedUsageUtilization: CACHE }));
    const s = new Store(':memory:');
    const p = profile('claude', 'claude-a', 'A', dir);
    s.upsertProfile(p);
    expect(ingestClaudeUsageCache(s, p, 'm1', f)).toBe(3);
    expect(ingestClaudeUsageCache(s, p, 'm1', f)).toBe(0);
    const dump = JSON.stringify(s.dumpTable('quota_snapshots'));
    expect(dump).not.toMatch(/persona|secreto|abcd/);
    expect(ingestClaudeUsageCache(s, p, 'm1', path.join(dir, 'no-existe.json'))).toBe(0);
  });
});

describe('Claude limit notice in the transcript', () => {
  // Synthetic notices in Claude Code's real format (America/Guayaquil = UTC-5).
  it.each([
    ["You've hit your 5-hour limit · resets 4:30pm (America/Guayaquil)", '2030-01-07T20:55:00.000Z', 'five_hour', '2030-01-07T21:30:00.000Z'],
    ["You've hit your 5-hour limit · resets 11:20am (America/Guayaquil)", '2030-01-07T16:13:00.000Z', 'five_hour', '2030-01-07T16:20:00.000Z'],
    ["You've hit your session limit · resets 2:20am (America/Guayaquil)", '2030-01-11T03:42:00.000Z', 'five_hour', '2030-01-11T07:20:00.000Z'],
    ["You've hit your session limit · resets 1pm (America/Guayaquil)", '2030-01-22T16:43:00.000Z', 'five_hour', '2030-01-22T18:00:00.000Z'],
    ["You've hit your session limit · resets 11:30pm (America/Guayaquil)", '2030-01-15T02:44:00.000Z', 'five_hour', '2030-01-15T04:30:00.000Z'],
    ["You've hit your weekly limit · resets Jan 12, 3am (America/Guayaquil)", '2030-01-10T15:00:00.000Z', 'seven_day', '2030-01-12T08:00:00.000Z'],
  ])('%s', (text, at, limitId, resetsAt) => {
    expect(parseLimitNotice(text, at)).toMatchObject({ limitId, resetsAt });
  });

  it('ignores other text', () => {
    expect(parseLimitNotice('API Error: overloaded', '2030-01-07T20:55:00.000Z')).toBeNull();
  });

  it('a notice stores «100 % until reset», valid until then; a newer cache read replaces it', () => {
    const s = new Store(':memory:');
    s.upsertProfile(profile('claude', 'claude-a', 'A'));
    const rec = {
      type: 'assistant',
      timestamp: '2030-01-07T20:55:00.000Z',
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { id: 'x', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 4:30pm (America/Guayaquil)" }], usage: { input_tokens: 0, output_tokens: 0 } },
    };
    expect(applyClaudeTranscriptRecord(s, 'claude-a', 'm1', rec)).toBe(true);
    expect(s.dumpTable('token_usage_events')).toHaveLength(0); // not API usage
    const q = s.latestQuotas()[0];
    expect(q).toMatchObject({ limitId: 'five_hour', usedPercent: 100, resetsAt: '2030-01-07T21:30:00.000Z', source: 'claude-transcript' });
    expect(evaluateBucket(q, new Date('2030-01-07T21:25:00Z'), 30).state).toBe('live'); // 30 min later, still exhausted
    expect(evaluateBucket(q, new Date('2030-01-07T21:31:00Z'), 30).state).toBe('reset');

    const later = { ...CACHE, fetchedAtMs: Date.UTC(2030, 0, 7, 22, 0) };
    for (const x of usageCacheToSnapshots('claude-a', later)) s.insertQuota('m1', x);
    expect(s.latestQuotas().find((x) => x.limitId === 'five_hour')).toMatchObject({ usedPercent: 0, source: 'claude-usage-cache' });

    // The card now has official numbers: Claude no longer shows «No disponible».
    const now = new Date(Date.UTC(2030, 0, 7, 22, 10));
    const pv = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now).profiles[0];
    expect(pv.hasOfficialQuota).toBe(true);
    expect(pv.buckets.find((b) => b.limitId === 'seven_day')).toMatchObject({ usedPercent: 64, state: 'live' });
  });
});

describe('Claude 5-hour window estimated from local activity (reset time only, never a %)', () => {
  const at = (iso: string) => Date.parse(iso);
  it('first answer at 08:35 local → window 08:30-13:30', () => {
    const ts = ['2030-01-08T13:35:31Z', '2030-01-08T14:10:00Z', '2030-01-08T18:00:00Z'].map(at);
    const w = inferFiveHourWindow(ts, at('2030-01-08T18:20:00Z'))!;
    expect(new Date(w.start).toISOString()).toBe('2030-01-08T13:30:00.000Z');
    expect(new Date(w.end).toISOString()).toBe('2030-01-08T18:30:00.000Z');
    expect(inferFiveHourWindow(ts, at('2030-01-08T18:31:00Z'))).toBeNull(); // window over, no new activity
  });

  it('a message after the window ended opens the next one', () => {
    const ts = ['2030-01-05T15:08:00Z', '2030-01-05T20:08:30Z', '2030-01-05T21:00:00Z'].map(at);
    const w = inferFiveHourWindow(ts, at('2030-01-05T21:30:00Z'))!;
    expect(new Date(w.start).toISOString()).toBe('2030-01-05T20:00:00.000Z');
  });

  function storeWithActivity() {
    const s = new Store(':memory:');
    s.upsertProfile(profile('claude', 'claude-a', 'A'));
    for (const [i, t] of ['2030-01-08T13:35:31Z', '2030-01-08T15:00:00Z'].entries()) {
      s.upsertTokenEvent({ eventKey: `e${i}`, accountId: 'claude-a', sessionId: 's', model: 'm', inputTokens: 1, outputTokens: 1, cachedTokens: 0, timestamp: t, source: 'claude-transcript' });
    }
    return s;
  }

  it('the official cache from before the window (0 %, no reset) is replaced by «no data · resets 13:30 (estimated)»', () => {
    const s = storeWithActivity();
    for (const x of usageCacheToSnapshots('claude-a', CACHE)) s.insertQuota('m1', x); // 08:35:10 local, five_hour 0 %, no reset
    const now = new Date('2030-01-08T18:10:00Z');
    expect(estimateClaudeSession(s, 'claude-a', 'm1', now)).toBe(true);
    const b = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now).profiles[0].buckets.find((x) => x.limitId === 'five_hour')!;
    expect(b.usedPercent).toBeNull(); // never the stale 0 %
    expect(b.state).toBe('unknown');
    expect(b.resetText).toBe('Se reinicia a las 13:30 (estimado)');
    expect(b.source).toBe('claude-activity-estimate');
  });

  it('no estimate when official data already knows the window; newer official data wins', () => {
    const s = storeWithActivity();
    const official = { ...usageCacheToSnapshots('claude-a', CACHE)[0], usedPercent: 30, remainingPercent: 70, resetsAt: '2030-01-08T18:30:00.000Z', observedAt: '2030-01-08T17:50:00.000Z', source: 'claude-statusline' as const };
    s.insertQuota('m1', official);
    expect(estimateClaudeSession(s, 'claude-a', 'm1', new Date('2030-01-08T18:10:00Z'))).toBe(false);
    expect(s.latestQuotas().find((q) => q.limitId === 'five_hour')?.usedPercent).toBe(30);
  });

  it('an earlier estimate does not hide later real readings, and no new estimate is written over them', () => {
    const s = storeWithActivity();
    const base = usageCacheToSnapshots('claude-a', CACHE)[0];
    // An estimate from before the real data arrived (no %).
    s.insertQuota('m1', { ...base, usedPercent: null, remainingPercent: null, resetsAt: '2030-01-08T18:30:00.000Z', observedAt: '2030-01-08T17:40:00.000Z', source: 'claude-activity-estimate', status: 'estimated', confidence: 'low' });
    // The real reading of the same window (the mod), observed a bit later.
    s.insertQuota('m1', { ...base, usedPercent: 81, remainingPercent: 19, resetsAt: '2030-01-08T18:30:00.000Z', observedAt: '2030-01-08T17:46:00.000Z', source: 'claude-mod' });
    const now = new Date('2030-01-08T17:50:00Z');
    expect(estimateClaudeSession(s, 'claude-a', 'm1', now)).toBe(false);
    expect(s.latestQuotas().find((q) => q.limitId === 'five_hour')).toMatchObject({ usedPercent: 81, source: 'claude-mod' });

    // Even if an estimate is newer (written in the same pass), a fresh real reading of that window is what is shown.
    s.insertQuota('m1', { ...base, usedPercent: null, remainingPercent: null, resetsAt: '2030-01-08T18:30:00.000Z', observedAt: '2030-01-08T17:51:00.000Z', source: 'claude-activity-estimate', status: 'estimated', confidence: 'low' });
    const b = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now).profiles[0].buckets.find((x) => x.limitId === 'five_hour')!;
    expect(b).toMatchObject({ usedPercent: 81, source: 'claude-mod' });
  });
});
