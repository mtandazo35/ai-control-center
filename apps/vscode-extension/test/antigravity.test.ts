import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { glogTime, ingestAntigravityLogs, parseAntigravityLog, parseResetsIn } from '../src/adapters/antigravity';
import { evaluateAlerts } from '../src/core/alerts';
import { recommend } from '../src/core/recommend';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput } from '../src/core/viewmodel';
import { FIX, profile, settings, tmpDir } from './helpers';

// Synthetic logs in Antigravity's real format (glog, local time). No real user data.
const DIR = path.join(FIX, 'agy');
const local = (mo: number, d: number, h: number, mi: number, s: number, ms = 0) => new Date(2030, mo - 1, d, h, mi, s, ms).toISOString();
const RESET_MS = 120 * 3600 * 1000;

describe('Antigravity logs (no quota interface: only runs and the server exhaustion message)', () => {
  it('parses glog time with the year from the file name, and "Resets in"', () => {
    expect(glogTime(2030, 1, '01', '15', '13', '01', '44', '769438')).toBe(local(1, 15, 13, 1, 44, 769));
    expect(glogTime(2029, 12, '01', '02', '00', '00', '00', '0')).toBe(new Date(2030, 0, 2).toISOString()); // year rollover
    expect(parseResetsIn('… Resets in 101h20m5s.')).toBe(((101 * 60 + 20) * 60 + 5) * 1000);
    expect(parseResetsIn('Resets in 45m')).toBe(45 * 60000);
    expect(parseResetsIn('sin dato')).toBeNull();
  });

  it('a normal run: model, conversation, steps and duration', () => {
    const f = path.join(DIR, 'cli-20300115_122040.log');
    const r = parseAntigravityLog(f, fs.readFileSync(f, 'utf8'))!;
    expect(r).toMatchObject({ model: 'gemini-4-argon-high', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', printMode: true, steps: 171, exhausted: null, failed: false });
    expect(r.startedAt).toBe(local(1, 15, 12, 20, 40, 413));
    expect(r.endedAt).toBe(local(1, 15, 12, 57, 57, 0));
  });

  it('an exhausted run: reset time = message time + "Resets in"', () => {
    const f = path.join(DIR, 'cli-20300115_125837.log');
    const r = parseAntigravityLog(f, fs.readFileSync(f, 'utf8'))!;
    expect(r.model).toBe('gemini-3.8-flash-low');
    expect(r.failed).toBe(true);
    expect(r.exhausted?.message).toBe('Individual quota reached.');
    expect(r.exhausted?.resetsAt).toBe(new Date(new Date(local(1, 15, 13, 1, 44, 769)).getTime() + RESET_MS).toISOString());
  });

  it('ingests into the store: sessions, exhausted quota, alert and recommendation; idempotent; no content', () => {
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    const first = ingestAntigravityLogs(s, p, 'm1', [DIR, path.join(tmpDir('nodir'), 'missing')]);
    expect(first).toEqual({ files: 2, runs: 2, exhaustions: 1 });
    expect(ingestAntigravityLogs(s, p, 'm1', [DIR])).toEqual({ files: 2, runs: 0, exhaustions: 0 }); // unchanged files skipped

    const q = s.latestQuotas().find((x) => x.limitId === 'agy:individual')!;
    expect(q).toMatchObject({ usedPercent: 100, remainingPercent: 0, source: 'antigravity-log', limitLabel: 'cuota individual' });
    expect(s.dumpTable('provider_sessions').map((x) => x.model).sort()).toEqual(['gemini-3.8-flash-low', 'gemini-4-argon-high']);
    expect(JSON.stringify([s.dumpTable('provider_sessions'), s.dumpTable('quota_snapshots')])).not.toContain('PROMPT');

    const now = new Date(local(1, 15, 13, 5, 0));
    const rec = recommend(s.listProfiles(), s.latestQuotas(), { now, staleMinutes: 30, reservePercent: 10 });
    expect(rec.ranked[0].classification).toBe('agotada');
    expect(evaluateAlerts(s.listProfiles(), s.latestQuotas(), [], settings, now).find((a) => a.kind === 'threshold')?.severity).toBe('error');

    const vm = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now);
    expect(vm.profiles[0].runs24h).toBe(2);
    // Antigravity has no tokens, but its runs appear in the activity chart (same axis, local time).
    const act = vm.series.activity.find((a) => a.id === 'gemini-antigravity')!;
    expect(act.provider).toBe('gemini');
    expect(act.runs.reduce((a, b) => a + b, 0)).toBe(2);
    expect(act.minutes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(37); // the 12:20-12:57 run
    expect(vm.series.accounts.find((a) => a.id === 'gemini-antigravity')).toBeUndefined(); // never in the token chart
    expect(vm.profiles[0].buckets[0]).toMatchObject({ usedPercent: 100, source: 'antigravity-log' });

    // Hours later the exhaustion still holds (not «stale»): it is valid until the server's reset time.
    const hoursLater = new Date(now.getTime() + 20 * 3600000);
    expect(buildViewModel(gatherInput(s, '24h', hoursLater), settings, '24h', hoursLater).profiles[0].buckets[0].state).toBe('live');
    expect(evaluateAlerts(s.listProfiles(), s.latestQuotas(), [], settings, hoursLater).some((a) => a.kind === 'stale')).toBe(false);

    // After the reset time the window is «reiniciada», never assumed to be 0 % used.
    const later = new Date(new Date(q.resetsAt!).getTime() + 60000);
    expect(buildViewModel(gatherInput(s, '24h', later), settings, '24h', later).profiles[0].buckets[0].state).toBe('reset');
  });

  it('a later successful run means quota was back, but the percentage stays unknown', () => {
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'G');
    s.upsertProfile(p);
    const dir = tmpDir('agy');
    fs.copyFileSync(path.join(DIR, 'cli-20300115_125837.log'), path.join(dir, 'cli-20300115_125837.log'));
    fs.writeFileSync(
      path.join(dir, 'cli-20300122_090000.log'),
      'I0122 09:00:00.000000       1 printmode.go:208] Print mode: starting (promptLength=10, model="gemini-3.8-flash-medium", conversationID="")\n' +
        'I0122 09:05:00.000000       1 server.go:2723] Tool confirmation for conversation 11111111-2222-4333-8444-555555555555 step 4 (approved=true)\n',
    );
    ingestAntigravityLogs(s, p, 'm1', [dir]);
    const q = s.latestQuotas().find((x) => x.limitId === 'agy:individual')!;
    expect(q.usedPercent).toBeNull();
    expect(q.status).toBe('unavailable');
  });
});
