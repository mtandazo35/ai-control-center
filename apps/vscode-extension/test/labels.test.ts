import { describe, expect, it } from 'vitest';
import { displayLimitLabel, resetText } from '../src/core/util';

describe("labels like Claude's usage view", () => {
  it('window names', () => {
    expect(displayLimitLabel('5 h', 300)).toBe('Sesión (5 h)');
    expect(displayLimitLabel('7 d', 10080)).toBe('Semanal (7 días)');
    expect(displayLimitLabel('7 d · Fable', 10080)).toBe('Límite Fable');
    expect(displayLimitLabel('Modelo rápido · 5 h', 300)).toBe('Modelo rápido · Sesión (5 h)');
    expect(displayLimitLabel('cuota individual', null)).toBe('Cuota individual');
  });

  it('reset text in America/Guayaquil: same day → only the time; otherwise weekday and date', () => {
    const now = new Date('2030-01-01T17:00:00Z'); // 12:00 local
    expect(resetText('2030-01-01T19:40:00Z', 'America/Guayaquil', now)).toBe('Se reinicia a las 14:40');
    expect(resetText('2030-01-03T08:00:00Z', 'America/Guayaquil', now)).toBe('Se reinicia jue 03/01 a las 03:00');
    expect(resetText(null, 'America/Guayaquil', now)).toBe('');
  });
});

describe('charts in the display zone (America/Guayaquil), never UTC', () => {
  it('offset and axis labels', async () => {
    const { zoneOffsetMinutes, axisLabels } = await import('../src/core/util');
    expect(zoneOffsetMinutes('America/Guayaquil', new Date('2030-01-01T12:00:00Z'))).toBe(-300);
    expect(zoneOffsetMinutes('UTC', new Date('2030-01-01T12:00:00Z'))).toBe(0);
    const l = axisLabels(['2030-01-01T19:00:00Z', '2030-01-02T02:00:00Z'], '24h', 'America/Guayaquil');
    expect(l.short).toEqual(['14:00', '21:00']);
    expect(l.long).toEqual(['01/01 14:00', '01/01 21:00']);
    expect(axisLabels(['2030-01-09'], '7d', 'America/Guayaquil').short).toEqual(['09/01']);
  });

  it('an event at 22:00 local counts on its local day, not the next UTC day', async () => {
    const { Store } = await import('../src/core/store');
    const { buildViewModel, gatherInput } = await import('../src/core/viewmodel');
    const { profile, settings } = await import('./helpers');
    const s = new Store(':memory:');
    s.upsertProfile(profile('codex', 'codex-a', 'A'));
    s.upsertTokenEvent({ eventKey: 'e1', accountId: 'codex-a', sessionId: 's', model: 'm', inputTokens: 100, outputTokens: 0, cachedTokens: 0, timestamp: '2030-01-02T03:00:00.000Z', source: 'codex-rollout' });
    const now = new Date('2030-01-02T15:00:00Z'); // 10:00 local, 2 Jan
    const vm = buildViewModel(gatherInput(s, '7d', now, 'America/Guayaquil'), settings, '7d', now);
    const i = vm.series.buckets.indexOf('2030-01-01');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(vm.series.accounts[0].input[i]).toBe(100);
    expect(vm.series.labels.join(' ')).not.toContain('UTC');
    const vm24 = buildViewModel(gatherInput(s, '24h', now, 'America/Guayaquil'), settings, '24h', now);
    expect(vm24.series.labels.at(-1)).toBe('10:00');
  });
});
