import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cycle, evaluateAlerts } from '../src/core/alerts';
import { tailJsonl } from '../src/core/jsonl';
import { evaluateBucket, recommend } from '../src/core/recommend';
import { Store } from '../src/core/store';
import { formatInZone, maskEmail, projectName, redact, relative, toIso } from '../src/core/util';
import { memStore, minutes, profile, quota, settings, tmpDir } from './helpers';

const NOW = new Date('2030-01-01T17:00:00.000Z');

describe('store', () => {
  it('migrates once and reports the schema version', () => {
    const dir = tmpDir('store');
    const f = path.join(dir, 'db.sqlite');
    const a = new Store(f);
    expect(a.schemaVersion()).toBe(1);
    a.close();
    const b = new Store(f);
    expect(b.schemaVersion()).toBe(1);
    b.close();
  });

  it('dedups quota snapshots on machine+account+limit+source+observed_at', () => {
    const s = memStore();
    s.upsertProfile(profile('codex', 'codex-a'));
    const q = quota('codex-a', 'codex:primary', 40, NOW, minutes(NOW, 60));
    expect(s.insertQuota('m1', q)).toBe(true);
    expect(s.insertQuota('m1', q)).toBe(false);
    expect(s.insertQuota('m2', q)).toBe(true); // another machine is another producer
    expect(s.latestQuotas()).toHaveLength(1);
  });

  it('latestQuotas returns the newest snapshot per limit, null stays null', () => {
    const s = memStore();
    s.upsertProfile(profile('codex', 'codex-a'));
    s.insertQuota('m1', quota('codex-a', 'codex:primary', 40, minutes(NOW, -10), null));
    s.insertQuota('m1', quota('codex-a', 'codex:primary', 55, NOW, null));
    s.insertQuota('m1', quota('codex-a', 'codex:secondary', null, NOW, null));
    const l = s.latestQuotas();
    expect(l.find((q) => q.limitId === 'codex:primary')?.usedPercent).toBe(55);
    expect(l.find((q) => q.limitId === 'codex:secondary')?.usedPercent).toBeNull();
  });

  it('single-writer lease: second holder is refused until expiry', () => {
    const s = memStore();
    expect(s.tryLease('collector', 'A', NOW, 60000)).toBe(true);
    expect(s.tryLease('collector', 'B', minutes(NOW, 0.5), 60000)).toBe(false);
    expect(s.tryLease('collector', 'A', minutes(NOW, 0.5), 60000)).toBe(true);
    expect(s.tryLease('collector', 'B', minutes(NOW, 2), 60000)).toBe(true);
  });

  it('prune applies the retention window', () => {
    const s = memStore();
    s.upsertProfile(profile('codex', 'codex-a'));
    s.insertQuota('m1', quota('codex-a', 'x', 1, minutes(NOW, -60 * 24 * 100), null));
    s.insertQuota('m1', quota('codex-a', 'x', 2, NOW, null));
    s.prune(minutes(NOW, -60 * 24 * 90).toISOString());
    expect(s.quotaHistory('codex-a', '2000-01-01')).toHaveLength(1);
  });

  it('deleting a profile cascades its history', () => {
    const s = memStore();
    s.upsertProfile(profile('codex', 'codex-a'));
    s.insertQuota('m1', quota('codex-a', 'x', 1, NOW, null));
    s.deleteProfile('codex-a');
    expect(s.latestQuotas()).toHaveLength(0);
  });
});

describe('incremental JSONL', () => {
  it('reads only appended bytes and leaves a partial last line for later', async () => {
    const s = memStore();
    const f = path.join(tmpDir('jsonl'), 'a.jsonl');
    fs.writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":');
    const seen: number[] = [];
    await tailJsonl(s, f, () => true, (r) => seen.push(r.n as number));
    expect(seen).toEqual([1, 2]);
    fs.appendFileSync(f, '3}\n{"n":4}\n');
    await tailJsonl(s, f, () => true, (r) => seen.push(r.n as number));
    expect(seen).toEqual([1, 2, 3, 4]);
    await tailJsonl(s, f, () => true, (r) => seen.push(r.n as number));
    expect(seen).toEqual([1, 2, 3, 4]); // unchanged file: nothing re-read
  });

  it('restarts from zero when the file shrank (rotation)', async () => {
    const s = memStore();
    const f = path.join(tmpDir('jsonl'), 'b.jsonl');
    fs.writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const seen: number[] = [];
    await tailJsonl(s, f, () => true, (r) => seen.push(r.n as number));
    fs.writeFileSync(f, '{"n":9}\n');
    const r = await tailJsonl(s, f, () => true, (x) => seen.push(x.n as number));
    expect(r.reset).toBe(true);
    expect(seen).toEqual([1, 2, 9]);
  });

  it('prefilter skips lines without parsing them; malformed lines never throw', async () => {
    const s = memStore();
    const f = path.join(tmpDir('jsonl'), 'c.jsonl');
    fs.writeFileSync(f, '{"keep":1}\nnot json at all {"keep"\n{"drop":1}\n');
    const seen: unknown[] = [];
    await tailJsonl(s, f, (l) => l.includes('keep'), (r) => seen.push(r));
    expect(seen).toEqual([{ keep: 1 }]);
  });
});

describe('quota evaluation', () => {
  it('live, stale, reset and unknown states', () => {
    expect(evaluateBucket(quota('a', 'x', 40, minutes(NOW, -5), minutes(NOW, 60)), NOW, 30).state).toBe('live');
    expect(evaluateBucket(quota('a', 'x', 40, minutes(NOW, -45), minutes(NOW, 60)), NOW, 30).state).toBe('stale');
    const reset = evaluateBucket(quota('a', 'x', 99, minutes(NOW, -5), minutes(NOW, -1)), NOW, 30);
    expect(reset.state).toBe('reset');
    expect(reset.remaining).toBeNull(); // a reset window is unknown, NOT 100 % free
    expect(evaluateBucket(quota('a', 'x', null, NOW, null), NOW, 30).state).toBe('unknown');
  });
});

describe('recommendation engine', () => {
  const profiles = [profile('claude', 'claude-a', 'A'), profile('codex', 'codex-b', 'B'), profile('codex', 'codex-c', 'C'), profile('gemini', 'gemini-x', 'G')];

  it('uses the most loaded window as bottleneck across heterogeneous quotas', () => {
    const quotas = [
      quota('claude-a', 'five_hour', 20, NOW, minutes(NOW, 120)),
      quota('claude-a', 'seven_day', 90, NOW, minutes(NOW, 5000)), // weekly is the bottleneck → 10 % left
      quota('codex-b', 'codex:primary', 28, NOW, minutes(NOW, 200)),
      quota('codex-b', 'codex:secondary', 40, NOW, minutes(NOW, 6000)),
    ];
    const r = recommend(profiles, quotas, { now: NOW, staleMinutes: 30, reservePercent: 10 });
    expect(r.selected?.profile.id).toBe('codex-b');
    expect(r.selected?.rationale).toContain('60 % restante');
    const a = r.ranked.find((c) => c.profile.id === 'claude-a')!;
    expect(a.bottleneck?.snapshot.limitId).toBe('seven_day');
    expect(r.summary).toMatch(/^Recomendada: Codex · B/);
  });

  it('never scores accounts without official data as free', () => {
    const r = recommend(profiles, [], { now: NOW, staleMinutes: 30, reservePercent: 10 });
    expect(r.selected).toBeNull();
    expect(r.ranked.every((c) => c.classification === 'sin-datos' && c.score === null)).toBe(true);
    expect(r.summary).toMatch(/Sin recomendación/);
  });

  it('stale snapshots and reset windows are not scored', () => {
    const quotas = [
      quota('codex-b', 'codex:primary', 10, minutes(NOW, -120), minutes(NOW, 60)), // stale
      quota('codex-c', 'codex:primary', 10, minutes(NOW, -5), minutes(NOW, -1)), // window reset
    ];
    const r = recommend(profiles, quotas, { now: NOW, staleMinutes: 30, reservePercent: 10 });
    expect(r.selected).toBeNull();
    expect(r.ranked.find((c) => c.profile.id === 'codex-c')?.rationale).toContain('reinició');
  });

  it('respects the reserve, exhausted windows, disabled profiles and provider filter', () => {
    const p = profiles.map((x) => ({ ...x }));
    p.find((x) => x.id === 'claude-a')!.enabled = false;
    const quotas = [
      quota('claude-a', 'five_hour', 0, NOW, minutes(NOW, 60)),
      quota('codex-b', 'codex:primary', 95, NOW, minutes(NOW, 60)),
      quota('codex-c', 'codex:primary', 100, NOW, minutes(NOW, 60)),
    ];
    const r = recommend(p, quotas, { now: NOW, staleMinutes: 30, reservePercent: 10 });
    const cls = Object.fromEntries(r.ranked.map((c) => [c.profile.id, c.classification]));
    expect(cls).toMatchObject({ 'claude-a': 'deshabilitada', 'codex-b': 'bajo-reserva', 'codex-c': 'agotada', 'gemini-x': 'sin-datos' });
    const only = recommend(profiles, [quota('claude-a', 'five_hour', 10, NOW, minutes(NOW, 60))], { now: NOW, staleMinutes: 30, reservePercent: 10, providers: ['codex'] });
    expect(only.selected).toBeNull();
  });

  it('partial data lowers the score; continuity breaks ties', () => {
    const quotas = [
      quota('codex-b', 'codex:primary', 50, NOW, minutes(NOW, 200)),
      quota('codex-b', 'codex:secondary', null, NOW, null),
      quota('codex-c', 'codex:primary', 50, NOW, minutes(NOW, 200)),
    ];
    const r = recommend(profiles, quotas, { now: NOW, staleMinutes: 30, reservePercent: 10 });
    expect(r.selected?.profile.id).toBe('codex-c');
  });
});

describe('alerts', () => {
  const ps = [profile('codex', 'codex-b', 'B')];
  it('one alert for the highest crossed threshold, keyed per window cycle', () => {
    const q = quota('codex-b', 'codex:primary', 90, NOW, minutes(NOW, 120));
    const a = evaluateAlerts(ps, [q], [], settings, NOW).filter((x) => x.kind === 'threshold');
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain('umbral 85 %');
    const s = memStore();
    s.upsertProfile(ps[0]);
    expect(s.raiseAlert(a[0])).toBe(true);
    expect(s.raiseAlert(a[0])).toBe(false); // same window: notified once
    // Same window seen 1 s apart from another source → same cycle key.
    expect(cycle(minutes(NOW, 120).toISOString())).toBe(cycle(new Date(minutes(NOW, 120).getTime() + 1000).toISOString()));
    // Next window (new resets_at) → new alert.
    const next = evaluateAlerts(ps, [quota('codex-b', 'codex:primary', 90, minutes(NOW, 300), minutes(NOW, 420))], [], settings, minutes(NOW, 300));
    expect(s.raiseAlert(next.find((x) => x.kind === 'threshold')!)).toBe(true);
  });

  it('reset soon, stale data, collector down and expired session', () => {
    const quotas = [
      quota('codex-b', 'codex:primary', 88, NOW, minutes(NOW, 10)),
      quota('codex-b', 'codex:secondary', 10, minutes(NOW, -90), minutes(NOW, 5000)),
    ];
    const a = evaluateAlerts(ps, quotas, [{ accountId: 'codex-b', ok: false, error: 'boom', at: NOW.toISOString(), authProblem: true }], settings, NOW);
    const kinds = a.map((x) => x.kind).sort();
    expect(kinds).toEqual(['auth', 'reset_soon', 'stale', 'threshold']);
    expect(a.find((x) => x.kind === 'reset_soon')?.message).toContain('12:10'); // 17:10 UTC = 12:10 Guayaquil
  });
});

describe('time zone and privacy helpers', () => {
  it('stores UTC, displays America/Guayaquil (UTC-5, no DST)', () => {
    expect(formatInZone('2030-01-01T19:51:38.000Z', 'America/Guayaquil')).toContain('14:51');
    expect(formatInZone('2026-07-01T00:30:00.000Z', 'America/Guayaquil')).toContain('30/06/2026');
    expect(formatInZone(null, 'America/Guayaquil')).toBe('—');
    expect(formatInZone('2030-01-01T19:51:38.000Z', 'Zona/Inexistente')).toContain('UTC');
  });
  it('epoch seconds vs ms and relative text', () => {
    expect(toIso(1893474000)).toBe('2030-01-01T05:00:00.000Z');
    expect(toIso(1893474000000)).toBe('2030-01-01T05:00:00.000Z');
    expect(relative(minutes(NOW, 125).toISOString(), NOW)).toBe('en 2 h 05 min');
    expect(relative(minutes(NOW, -3).toISOString(), NOW)).toBe('hace 3 min');
  });
  it('masks e-mails, keeps project names only, redacts secrets', () => {
    expect(maskEmail('persona@ejemplo.com')).toBe('p***a@ejemplo.com');
    expect(projectName('C:\\Users\\persona\\proyectos\\demo-app\\')).toBe('demo-app');
    const r = redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij sk-ant-abcdefghijklmnop x@y.com');
    expect(r).not.toMatch(/eyJ|sk-ant|x@y/);
  });
});
