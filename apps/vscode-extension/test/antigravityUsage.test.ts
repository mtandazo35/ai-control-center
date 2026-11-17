import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeGeneration, ingestAntigravityConversations, latestAgyConversationMs, protoFields, readAntigravityConversation, stepTime, workspaceName } from '../src/adapters/antigravityUsage';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput } from '../src/core/viewmodel';
import { profile, settings, tmpDir } from './helpers';

// Synthetic conversation stores in Antigravity's layout (SQLite + protobuf blobs). No real user data.
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const vField = (f: number, n: number): number[] => [...varint(f * 8), ...varint(n)];
const bField = (f: number, b: number[] | Uint8Array): number[] => [...varint(f * 8 + 2), ...varint(b.length), ...b];
const sField = (f: number, s: string): number[] => bField(f, [...Buffer.from(s, 'utf8')]);

function genBlob(o: { input: number; output: number; cached?: number; model?: string; ctx?: [number, number] }): Uint8Array {
  const usage = [...vField(2, o.input), ...vField(3, o.output), ...(o.cached !== undefined ? vField(5, o.cached) : []), ...vField(9, 7)];
  const ctx = o.ctx ? bField(10, [...bField(3, vField(2, o.ctx[0])), ...vField(4, o.ctx[1])]) : [];
  const body = [
    ...bField(2, sField(3, 'PROMPT SECRETO')), // conversation content lives here too: must never be read out
    ...bField(4, usage),
    ...(ctx.length ? bField(9, ctx) : []),
  ];
  const cfg = o.model ? bField(3, sField(28, o.model)) : [];
  return Uint8Array.from([...bField(1, body), ...cfg]);
}
const stepMeta = (iso: string): Uint8Array => Uint8Array.from(bField(1, vField(1, Math.floor(new Date(iso).getTime() / 1000))));

function makeConversation(dir: string, id: string, gens: Uint8Array[], responseTimes: string[]): string {
  const file = path.join(dir, id + '.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx integer, step_type integer, metadata blob, PRIMARY KEY (idx))');
  db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer, PRIMARY KEY (idx))');
  let idx = 0;
  db.prepare('INSERT INTO steps VALUES (?, 14, ?)').run(idx++, stepMeta(responseTimes[0]));
  for (const t of responseTimes) {
    db.prepare('INSERT INTO steps VALUES (?, 132, ?)').run(idx++, stepMeta(t)); // tool step
    db.prepare('INSERT INTO steps VALUES (?, 15, ?)').run(idx++, stepMeta(t)); // model response
  }
  gens.forEach((g, i) => db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(i, g, g.length));
  db.close();
  return file;
}

const ID1 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';

describe('Antigravity conversation stores: tokens per model call (numbers only)', () => {
  it('decodes protobuf varints and nested messages; rejects malformed input', () => {
    const f = protoFields(Uint8Array.from([...vField(1, 300), ...sField(2, 'x')]));
    expect(f.get(1)).toEqual([300]);
    expect(() => protoFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow();
    expect(stepTime(stepMeta('2030-01-15T12:00:00Z'))).toBe('2030-01-15T12:00:00.000Z');
    expect(stepTime(null)).toBeNull();
  });

  it('reads usage, context and model; unknown shapes give null instead of a guess', () => {
    expect(decodeGeneration(genBlob({ input: 1000, output: 200, cached: 5000, model: 'gemini-3.8-flash-medium', ctx: [64000, 256000] }))).toEqual({
      model: 'gemini-3.8-flash-medium',
      inputTokens: 1000,
      cachedTokens: 5000,
      outputTokens: 200,
      contextTokens: 64000,
      contextWindow: 256000,
    });
    expect(decodeGeneration(Uint8Array.from(bField(1, sField(3, 'otra cosa'))))).toBeNull();
    expect(decodeGeneration(Uint8Array.from([0xff, 0xff]))).toBeNull();
  });

  it('times each call by its response step; a call with no response takes the last time seen', () => {
    const dir = tmpDir('agy-conv-a');
    const f = makeConversation(dir, ID1, [genBlob({ input: 10, output: 1 }), genBlob({ input: 20, output: 2, model: 'gemini-3.8-flash-low' }), genBlob({ input: 30, output: 3 })], [
      '2030-01-15T12:00:00Z',
      '2030-01-15T12:05:00Z',
    ]);
    const calls = readAntigravityConversation(f);
    expect(calls.map((c) => [c.index, c.at])).toEqual([
      [0, '2030-01-15T12:00:00.000Z'],
      [1, '2030-01-15T12:05:00.000Z'],
      [2, '2030-01-15T12:05:00.000Z'],
    ]);
    // Calls without a model id take the conversation's known model (never «desconocido» when one is known).
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-low', 'gemini-3.8-flash-low']);
  });

  it('ingests into the store: tokens, per-model breakdown, context; idempotent; no content stored', () => {
    const dir = tmpDir('agy-conv-b');
    makeConversation(
      dir,
      ID1,
      [
        genBlob({ input: 10000, output: 300, cached: 0, model: 'gemini-3.8-flash-medium', ctx: [10000, 256000] }),
        genBlob({ input: 2000, output: 2200, cached: 10000, model: 'gemini-3.8-flash-medium', ctx: [64000, 256000] }),
      ],
      ['2030-01-15T12:00:00Z', '2030-01-15T12:01:00Z'],
    );
    makeConversation(dir, ID2, [genBlob({ input: 500, output: 100, model: 'gemini-3.8-flash-low', ctx: [8000, 256000] })], ['2030-01-15T11:00:00Z']);
    fs.writeFileSync(path.join(dir, 'no-es-conversacion.db'), 'x'); // ignored by name
    const now = new Date('2030-01-15T13:00:00Z');
    for (const id of [ID1, ID2]) fs.utimesSync(path.join(dir, id + '.db'), now, now); // stores written «today»

    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    expect(ingestAntigravityConversations(s, p, [dir, path.join(dir, 'falta')], now)).toEqual({ files: 2, calls: 3, errors: 0 });
    expect(ingestAntigravityConversations(s, p, [dir], now)).toEqual({ files: 2, calls: 0, errors: 0 }); // unchanged: skipped

    const ev = s.dumpTable('token_usage_events');
    expect(ev).toHaveLength(3);
    expect(JSON.stringify(ev)).not.toContain('PROMPT');
    expect(JSON.parse(s.getSetting('gemini-context:gemini-antigravity')!)).toMatchObject({ percent: 25, tokens: 64000, window: 256000, at: '2030-01-15T12:01:00.000Z' });

    const vm = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now);
    const g = vm.profiles.find((x) => x.id === 'gemini-antigravity')!;
    expect(g.tokens24h).toBe(10000 + 300 + 2000 + 2200 + 500 + 100); // cache reads are not counted, like Codex
    expect(g.tokens24hDetail).toEqual({ input: 12500, cached: 10000, output: 2600 });
    expect(g.models24h).toEqual([
      { model: 'gemini-3.8-flash-medium', calls: 2, sessions: 1, tokens: 14500 },
      { model: 'gemini-3.8-flash-low', calls: 1, sessions: 1, tokens: 600 },
    ]);
    expect(g.sessionContext).toMatchObject({ percent: 25 });
    // Gemini now has tokens: it joins the token chart.
    expect(vm.series.accounts.some((a) => a.id === 'gemini-antigravity')).toBe(true);

    // Comparison table: says what is known instead of «sin datos», but the account is still never scored as free.
    const row = vm.recommendation.ranked.find((r) => r.id === 'gemini-antigravity')!;
    expect(row).toMatchObject({ classification: 'sin-porcentaje', classLabel: 'Sin porcentaje', score: null });
    expect(row.rationale).toBe('Antigravity no publica el %; 15 k tokens en 24 h');

    // With a finished run in the logs, the rationale also says when (local time, «hoy» on the same day).
    s.insertQuota('m1', {
      accountId: 'gemini-antigravity',
      limitId: 'agy:individual',
      limitLabel: 'cuota individual',
      windowMinutes: null,
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      source: 'antigravity-log',
      confidence: 'medium',
      observedAt: '2030-01-15T12:01:00.000Z',
      status: 'unavailable',
      extra: null,
    });
    const vm2 = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now);
    expect(vm2.recommendation.ranked.find((r) => r.id === 'gemini-antigravity')!.rationale).toBe(
      'Antigravity no publica el %; la última ejecución (hoy 07:01) terminó bien; 15 k tokens en 24 h',
    );
  });

  it('old stores are not opened; a store that is not SQLite counts as an error and is retried', () => {
    const dir = tmpDir('agy-conv-c');
    const f = makeConversation(dir, ID1, [genBlob({ input: 1, output: 1 })], ['2020-01-01T00:00:00Z']);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(f, old, old);
    fs.writeFileSync(path.join(dir, ID2 + '.db'), 'no es sqlite');
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    expect(ingestAntigravityConversations(s, p, [dir], new Date())).toEqual({ files: 1, calls: 0, errors: 1 });
  });

  it('session project = last segment of the folder agy ran in (never the full path); none when absent', () => {
    const meta = (uri: string, field = 7) => Uint8Array.from(field === 7 ? sField(7, uri) : bField(1, sField(1, uri)));
    expect(workspaceName(meta('file:///C:/Users/alguien/proyectos/mi%20repo'))).toBe('mi repo');
    expect(workspaceName(meta('file:///home/alguien/trabajo/api/', 1))).toBe('api');
    expect(workspaceName(meta('file:///C:/'))).toBeNull();
    expect(workspaceName(meta('https://example.com/x'))).toBeNull();
    expect(workspaceName(null)).toBeNull();

    const dir = tmpDir('agy-conv-p');
    const file = makeConversation(dir, ID1, [genBlob({ input: 10, output: 5, model: 'm' })], ['2030-01-15T12:00:00Z']);
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id))");
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(meta('file:///C:/Users/alguien/proyectos/api-demo'));
    db.close();
    const s = new Store(':memory:');
    const p = profile('gemini', 'gemini-antigravity', 'Google Antigravity');
    s.upsertProfile(p);
    s.upsertSession({ sessionKey: `${p.id}:${ID1}`, accountId: p.id, machineId: 'm1', project: null, model: 'm', startedAt: '2030-01-15T12:00:00Z', lastSeenAt: '2030-01-15T12:00:00Z', source: 'antigravity-log' });
    const now = new Date('2030-01-15T13:00:00Z');
    fs.utimesSync(file, now, now);
    ingestAntigravityConversations(s, p, [dir], now);
    const row = s.sessions('2030-01-01T00:00:00Z').find((x) => x.sessionKey === `${p.id}:${ID1}`);
    expect(row?.project).toBe('api-demo');
    expect(JSON.stringify(s.sessions('2030-01-01T00:00:00Z'))).not.toContain('alguien');
  });

  it('fresh use = newest conversation store, also the encrypted .pb form; -wal/-shm (touched by reading) do not count', () => {
    const dir = tmpDir('agy-conv-fresh');
    const old = new Date('2030-01-15T10:00:00Z');
    const fresh = new Date('2030-01-15T12:30:00Z');
    const later = new Date('2030-01-15T13:00:00Z');
    const db = makeConversation(dir, ID1, [genBlob({ input: 10, output: 5, model: 'm' })], ['2030-01-15T10:00:00Z']);
    fs.utimesSync(db, old, old);
    expect(latestAgyConversationMs([dir])).toBe(old.getTime());
    fs.writeFileSync(path.join(dir, ID1 + '.db-wal'), 'x');
    fs.utimesSync(path.join(dir, ID1 + '.db-wal'), later, later);
    expect(latestAgyConversationMs([dir])).toBe(old.getTime());
    const pb = path.join(dir, ID2 + '.pb');
    fs.writeFileSync(pb, Buffer.from([0xb9, 0x71, 0x9c]));
    fs.utimesSync(pb, fresh, fresh);
    expect(latestAgyConversationMs([dir])).toBe(fresh.getTime());
    expect(latestAgyConversationMs([path.join(dir, 'no-existe')])).toBe(0);
  });
});
