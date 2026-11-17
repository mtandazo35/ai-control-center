import { describe, expect, it } from 'vitest';
import { agyUsageToSnapshots, shouldReadAgyUsage } from '../src/adapters/antigravityQuota';
import { recommend } from '../src/core/recommend';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput } from '../src/core/viewmodel';
import { profile, settings } from './helpers';

// Same shape as `agy -p "/usage" --output-format json` (agy 1.5.x). Synthetic values, no user data.
const usage = (geminiFiveH: number, otherFiveH = 1) => ({
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9953414797782898, reset_time: '2030-01-21T16:27:26Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: geminiFiveH, reset_time: '2030-01-15T17:00:00Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2030-01-22T16:12:05Z' },
            { id: '3p-5h', window: '5h', remaining_fraction: otherFiveH, reset_time: '2030-01-15T17:12:05Z' },
          ],
        },
        { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2030-01-22T16:12:05Z' }] },
      ],
    },
  },
});

const NOW = new Date('2030-01-15T13:00:00Z');
const AT = NOW.toISOString();

describe('Antigravity official quota (agy -p "/usage" --output-format json)', () => {
  it('maps every bucket: remaining fraction → %, window, reset time, group label, scoring only for Gemini', () => {
    const s = agyUsageToSnapshots('gemini-antigravity', usage(0.9899333119392395), AT);
    expect(s.map((q) => [q.limitId, q.limitLabel, q.windowMinutes, q.remainingPercent, q.usedPercent, q.extra?.scoring])).toEqual([
      ['agy:gemini-weekly', 'Gemini · 7 d', 10080, 99.53, 0.47, true],
      ['agy:gemini-5h', 'Gemini · 5 h', 300, 98.99, 1.01, true],
      ['agy:3p-weekly', 'Claude y GPT · 7 d', 10080, 100, 0, false],
      ['agy:3p-5h', 'Claude y GPT · 5 h', 300, 100, 0, false],
      ['agy:gemini-argon-wtu-weekly', 'Argon · 7 d', 10080, 100, 0, false],
    ]);
    expect(s[1]).toMatchObject({ source: 'antigravity-usage', confidence: 'high', status: 'live', resetsAt: '2030-01-15T17:00:00.000Z' });
  });

  it('an unknown or failed payload gives no snapshot (never a guessed %)', () => {
    expect(agyUsageToSnapshots('g', null, AT)).toEqual([]);
    expect(agyUsageToSnapshots('g', { status: 'ERROR' }, AT)).toEqual([]);
    expect(agyUsageToSnapshots('g', { status: 'SUCCESS', command: { name: 'model', data: {} } }, AT)).toEqual([]);
    const bad = usage(0.5);
    bad.command.data.groups[0].buckets[1] = { id: 'gemini-5h', name: 'x', window: '5h', remaining_fraction: 'mucho' as unknown as number, reset_time: '' };
    expect(agyUsageToSnapshots('g', bad, AT).find((q) => q.limitId === 'agy:gemini-5h')).toBeUndefined();
  });

  it('only the Gemini group decides the account: an exhausted Claude/GPT group inside agy does not', () => {
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    for (const q of agyUsageToSnapshots(p.id, usage(0.8, 0), AT)) s.insertQuota('m1', q);
    const rec = recommend(s.listProfiles(), s.latestQuotas(), { now: NOW, staleMinutes: 30, reservePercent: 10 });
    expect(rec.ranked[0]).toMatchObject({ classification: 'recomendable', eligible: true });
    expect(rec.ranked[0].rationale).toBe('80 % restante en Gemini · 5 h (ventana más cargada)');
    expect(agyUsageToSnapshots(p.id, usage(0.9997796416282654), AT)[1]).toMatchObject({ usedPercent: 0.02, remainingPercent: 99.98 });
    const fine = new Store(':memory:');
    fine.upsertProfile(p);
    for (const q of agyUsageToSnapshots(p.id, usage(0.9997796416282654), AT)) fine.insertQuota('m1', q);
    // Two-decimal data reads as «99,5 %», never «99.53» or «100.0».
    expect(recommend(fine.listProfiles(), fine.latestQuotas(), { now: NOW, staleMinutes: 30, reservePercent: 10 }).ranked[0].rationale).toBe('99,5 % restante en Gemini · 7 d (ventana más cargada)');

    const low = new Store(':memory:');
    low.upsertProfile(p);
    for (const q of agyUsageToSnapshots(p.id, usage(0.05), AT)) low.insertQuota('m1', q);
    expect(recommend(low.listProfiles(), low.latestQuotas(), { now: NOW, staleMinutes: 30, reservePercent: 10 }).ranked[0].classification).toBe('bajo-reserva');
  });

  it('supersedes the log-based «cuota individual» unless the log is newer; card bars ordered Gemini first', () => {
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    const logQuota = (observedAt: string, usedPercent: number | null) =>
      s.insertQuota('m1', {
        accountId: p.id,
        limitId: 'agy:individual',
        limitLabel: 'cuota individual',
        windowMinutes: null,
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        resetsAt: usedPercent === null ? null : '2030-01-20T00:00:00Z',
        source: 'antigravity-log',
        confidence: 'medium',
        observedAt,
        status: usedPercent === null ? 'unavailable' : 'live',
        extra: null,
      });
    logQuota('2030-01-15T12:00:00.000Z', null);
    for (const q of agyUsageToSnapshots(p.id, usage(0.99), AT)) s.insertQuota('m1', q);
    expect(s.latestQuotas().some((q) => q.limitId === 'agy:individual')).toBe(false);

    const vm = buildViewModel(gatherInput(s, '24h', NOW), settings, '24h', NOW);
    const card = vm.profiles[0];
    expect(card.buckets.map((b) => b.displayLabel)).toEqual([
      'Gemini · Sesión (5 h)',
      'Gemini · Semanal (7 días)',
      'Claude y GPT · Sesión (5 h)',
      'Claude y GPT · Semanal (7 días)',
      'Argon · Semanal (7 días)',
    ]);
    expect(card.buckets[0]).toMatchObject({ usedPercent: 1, state: 'live', source: 'antigravity-usage' });
    expect(vm.recommendation.ranked[0]).toMatchObject({ classification: 'recomendable', classLabel: 'Recomendable' });

    // An exhaustion seen in the logs AFTER the last /usage reading is kept (and wins the recommendation).
    logQuota('2030-01-15T13:30:00.000Z', 100);
    expect(s.latestQuotas().find((q) => q.limitId === 'agy:individual')).toMatchObject({ usedPercent: 100 });
  });

  it('a run with no model in its log shows the model of its own calls in the sessions table', () => {
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    s.upsertSession({ sessionKey: `${p.id}:conv-a`, accountId: p.id, machineId: 'm1', project: null, model: null, startedAt: AT, lastSeenAt: AT, source: 'antigravity-log' });
    s.upsertSession({ sessionKey: `${p.id}:conv-b`, accountId: p.id, machineId: 'm1', project: null, model: 'modelo-del-log', startedAt: AT, lastSeenAt: AT, source: 'antigravity-log' });
    for (const [conv, model] of [['conv-a', 'modelo-a'], ['conv-b', 'modelo-b']]) {
      s.upsertTokenEvent({ eventKey: `agy:${conv}:0`, accountId: p.id, sessionId: conv, model, inputTokens: 10, outputTokens: 5, cachedTokens: 0, timestamp: AT, source: 'antigravity-conversation' });
    }
    const byKey = Object.fromEntries(s.sessions('2030-01-01T00:00:00Z').map((x) => [x.sessionKey, x.model]));
    expect(byKey[`${p.id}:conv-a`]).toBe('modelo-a');
    expect(byKey[`${p.id}:conv-b`]).toBe('modelo-del-log');
  });

  it('/usage runs every 15 min, at once after new model calls, or on demand (each call leaves a log file in agy)', () => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60000);
    expect(shouldReadAgyUsage(null, NOW, 0)).toBe(true);
    expect(shouldReadAgyUsage(AT, at(5), 0)).toBe(false);
    expect(shouldReadAgyUsage(AT, at(10), 0)).toBe(false);
    expect(shouldReadAgyUsage(AT, at(15), 0)).toBe(true);
    // the third 5-min collection landing a few seconds early still reads
    expect(shouldReadAgyUsage(AT, new Date(at(15).getTime() - 10000), 0)).toBe(true);
    expect(shouldReadAgyUsage(AT, at(5), 3)).toBe(true);
    expect(shouldReadAgyUsage(AT, at(5), 0, true)).toBe(true);
    expect(shouldReadAgyUsage('basura', at(1), 0)).toBe(true);
  });
});
