import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildStatuslineCommand,
  ingestStatuslineInbox,
  installClaudeOtel,
  installStatuslineCapture,
  parseClaudeAuthStatus,
  revertClaudeOtel,
  revertStatuslineCapture,
  statuslineInboxPath,
} from '../src/adapters/claude';
import {
  codexRateLimitsToSnapshots,
  JsonRpcClient,
  readCodexOverRpc,
  type GetAccountRateLimitsResponse,
} from '../src/adapters/codexAppServer';
import { classifyGemini, detectTools } from '../src/adapters/detect';
import { applyClaudeTranscriptRecord, applyCodexRolloutRecord, ingestClaudeTranscripts, ingestCodexRollouts } from '../src/adapters/localLogs';
import { ingestOtlpMetrics, startOtlpReceiver } from '../src/adapters/otlp';
import { FIX, memStore, profile, tmpDir } from './helpers';

const RATE = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-rate-limits.json'), 'utf8')) as GetAccountRateLimitsResponse;

/** In-process fake App Server speaking newline-delimited JSON-RPC, scripted per method. */
function fakeAppServer(handlers: Record<string, (params: unknown) => unknown>) {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const seen: { method: string; params: unknown }[] = [];
  let buf = '';
  fromClient.setEncoding('utf8');
  fromClient.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push({ method: msg.method, params: msg.params });
      if (msg.id === undefined) continue;
      const h = handlers[msg.method];
      if (!h) {
        toClient.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }) + '\n');
        continue;
      }
      try {
        toClient.write(JSON.stringify({ id: msg.id, result: h(msg.params) }) + '\n');
      } catch (e) {
        toClient.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: (e as Error).message } }) + '\n');
      }
    }
  });
  return { rpc: new JsonRpcClient(toClient, fromClient), seen, toClient };
}

describe('Codex App Server adapter', () => {
  it('reads account, all rate-limit buckets and daily usage — read-only (refreshToken=false)', async () => {
    const { rpc, seen, toClient } = fakeAppServer({
      initialize: () => ({ codexHome: 'C:\\x\\.codex' }),
      'account/read': () => ({ account: { type: 'chatgpt', email: 'persona@ejemplo.com', planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: 'acct-1' } }),
      'account/rateLimits/read': () => RATE,
      'account/usage/read': () => ({ summary: { lifetimeTokens: 10 }, dailyUsageBuckets: [{ startDate: '2026-11-08', tokens: 1234 }] }),
    });
    toClient.write(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\n');
    const r = await readCodexOverRpc(rpc, 2000);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe('pro');
    expect(r.identityLabel).toBe('p***a@ejemplo.com');
    expect(r.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain('persona@ejemplo.com');
    expect(seen.find((s) => s.method === 'account/read')?.params).toEqual({ refreshToken: false });
    expect(seen.map((s) => s.method)).not.toContain('account/logout');
    expect(r.usage?.dailyUsageBuckets?.[0].tokens).toBe(1234);
    expect(rpc.notifications.map((n) => n.method)).toContain('account/updated');
  });

  it('keeps every bucket of rateLimitsByLimitId, incl. individual limits', () => {
    const snaps = codexRateLimitsToSnapshots('codex-a', RATE, '2030-01-01T04:00:00.000Z');
    expect(snaps.map((s) => s.limitId).sort()).toEqual(['codex:primary', 'codex:secondary', 'codex_other:individual', 'codex_other:primary']);
    const p = snaps.find((s) => s.limitId === 'codex:primary')!;
    expect(p).toMatchObject({ usedPercent: 40, remainingPercent: 60, windowMinutes: 300, limitLabel: '5 h', resetsAt: '2030-01-01T05:00:00.000Z', source: 'codex-app-server', confidence: 'high' });
    expect(snaps.find((s) => s.limitId === 'codex:secondary')?.limitLabel).toBe('7 d');
    expect(snaps.find((s) => s.limitId === 'codex_other:individual')).toMatchObject({ remainingPercent: 40, usedPercent: 60 });
    expect(snaps.find((s) => s.limitId === 'codex_other:primary')?.limitLabel).toBe('Modelo rápido · 5 h');
  });

  it('API-key auth: degraded mode with an actionable error, no invented quota', async () => {
    const { rpc } = fakeAppServer({
      initialize: () => ({}),
      'account/read': () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: false }),
      'account/rateLimits/read': () => {
        throw new Error('rate limits require ChatGPT authentication');
      },
      'account/usage/read': () => {
        throw new Error('not available');
      },
    });
    const r = await readCodexOverRpc(rpc, 2000);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe('api-key');
    expect(r.rateLimits).toBeNull();
    expect(r.rateLimitsError).toContain('ChatGPT');
  });

  it('signed-out CODEX_HOME is reported as an auth problem', async () => {
    const { rpc } = fakeAppServer({ initialize: () => ({}), 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) });
    const r = await readCodexOverRpc(rpc, 2000);
    expect(r.ok).toBe(false);
    expect(r.authProblem).toBe(true);
  });

  it('rollouts: cumulative token_count re-emitted is not double counted; prompts are not stored', async () => {
    const dir = tmpDir('codex');
    const day = path.join(dir, 'sessions', '2026', '11', '09');
    fs.mkdirSync(day, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'codex-rollout.jsonl'), path.join(day, 'rollout-2030-01-01T10-00-00-11111111-2222-4333-8444-555555555555.jsonl'));
    const s = memStore();
    const p = profile('codex', 'codex-a', 'A', dir);
    s.upsertProfile(p);
    await ingestCodexRollouts(s, p, 'm1');
    await ingestCodexRollouts(s, p, 'm1'); // second pass: nothing new
    const ev = s.dumpTable('token_usage_events');
    expect(ev).toHaveLength(2);
    const tot = ev.reduce((a, r) => a + Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cached_tokens), 0);
    expect(tot).toBe(1100 + 2200);
    expect(ev[0].model).toBe('gpt-demo');
    const sess = s.dumpTable('provider_sessions');
    expect(sess[0]).toMatchObject({ project: 'api-demo', session_key: 'codex-a:11111111-2222-4333-8444-555555555555' });
    const latest = s.latestQuotas().find((q) => q.limitId === 'codex:primary')!;
    expect(latest).toMatchObject({ usedPercent: 52, source: 'codex-rollout', confidence: 'medium' });
    const dump = JSON.stringify([ev, sess, s.dumpTable('quota_snapshots')]);
    expect(dump).not.toContain('PRIVADO');
    expect(dump).not.toContain('/home/persona');
  });

  it('rollout record without info or rate limits is ignored', () => {
    const s = memStore();
    s.upsertProfile(profile('codex', 'codex-a'));
    expect(applyCodexRolloutRecord(s, 'codex-a', 'm1', { sessionId: 'x', model: null }, { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })).toBe(false);
  });
});

describe('Claude adapters', () => {
  it('parses `claude auth status` and masks identity', () => {
    const out = `{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "email": "persona@ejemplo.com",\n  "orgId": "org-1",\n  "subscriptionType": "team",\n  "configDirectory": "C:\\\\Users\\\\x\\\\.claude"\n}`;
    const r = parseClaudeAuthStatus(out);
    expect(r).toMatchObject({ ok: true, loggedIn: true, authMethod: 'claude.ai', plan: 'team', identityLabel: 'p***a@ejemplo.com' });
    expect(r.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseClaudeAuthStatus('{"loggedIn": false}').loggedIn).toBe(false);
    expect(parseClaudeAuthStatus('Error').ok).toBe(false);
  });

  it('transcripts: one event per API message (last line wins), synthetic skipped, no content stored', async () => {
    const dir = tmpDir('claude');
    fs.mkdirSync(path.join(dir, 'projects', 'C--demo'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'claude-transcript.jsonl'), path.join(dir, 'projects', 'C--demo', 's-1.jsonl'));
    const s = memStore();
    const p = profile('claude', 'claude-a', 'A', dir);
    s.upsertProfile(p);
    await ingestClaudeTranscripts(s, p, 'm1');
    const ev = s.dumpTable('token_usage_events');
    expect(ev).toHaveLength(2);
    const a = ev.find((e) => e.event_key === 'claude:claude-a:msg_A')!;
    expect(a).toMatchObject({ input_tokens: 10, output_tokens: 250, cached_tokens: 3000, model: 'claude-opus-5-5' });
    expect(s.dumpTable('provider_sessions')[0]).toMatchObject({ project: 'demo-app' });
    const dump = JSON.stringify([ev, s.dumpTable('provider_sessions')]);
    expect(dump).not.toMatch(/PRIVAD|persona/);
    expect(applyClaudeTranscriptRecord(s, 'claude-a', 'm1', { type: 'user' })).toBe(false);
  });

  it('statusLine capture: wraps the existing statusLine with backup, and reverts exactly', () => {
    const cfgDir = tmpDir('cfg');
    const dataDir = tmpDir('data');
    const settingsPath = path.join(cfgDir, 'settings.json');
    const original = { model: 'opus', statusLine: { type: 'command', command: 'echo MI-BARRA', padding: 1 }, hooks: { Stop: [] } };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const p = profile('claude', 'claude-a', 'A', cfgDir);
    const rec = installStatuslineCapture({ profile: p, dataDir, nodePath: process.execPath, wrapperSource: path.join(__dirname, '..', 'resources', 'statusline-capture.js') });
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.hooks).toEqual({ Stop: [] });
    expect(after.statusLine.padding).toBe(1);
    expect(after.statusLine.command).toContain('statusline-capture.js');
    expect(after.statusLine.command).toContain('--wrap ' + Buffer.from('echo MI-BARRA').toString('base64'));
    expect(fs.existsSync(rec.backup!)).toBe(true);
    expect(() => installStatuslineCapture({ profile: p, dataDir, nodePath: process.execPath, wrapperSource: path.join(__dirname, '..', 'resources', 'statusline-capture.js') })).toThrow(/ya está instalada/);
    expect(revertStatuslineCapture(rec).reverted).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(original);
  });

  it('statusLine revert refuses to touch a statusLine edited afterwards; no previous statusLine → key removed', () => {
    const cfgDir = tmpDir('cfg');
    const dataDir = tmpDir('data');
    const settingsPath = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{"model":"x"}');
    const p = profile('claude', 'claude-a', 'A', cfgDir);
    const wrapper = path.join(__dirname, '..', 'resources', 'statusline-capture.js');
    const rec = installStatuslineCapture({ profile: p, dataDir, nodePath: process.execPath, wrapperSource: wrapper });
    const edited = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    edited.statusLine.command = 'echo editado-por-el-usuario';
    fs.writeFileSync(settingsPath, JSON.stringify(edited));
    expect(revertStatuslineCapture(rec).reverted).toBe(false);
    edited.statusLine.command = rec.installedCommand;
    fs.writeFileSync(settingsPath, JSON.stringify(edited));
    expect(revertStatuslineCapture(rec).reverted).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'x' });
  });

  it('the real wrapper script records only rate limits + metadata, and keeps the original output', async () => {
    const dataDir = tmpDir('data');
    const wrapper = path.join(__dirname, '..', 'resources', 'statusline-capture.js');
    const inbox = statuslineInboxPath(dataDir);
    const input = fs.readFileSync(path.join(FIX, 'statusline-input.json'), 'utf8');
    const prev = `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdout.write('BARRA-ORIGINAL')"`;
    const cmd = buildStatuslineCommand(process.execPath, wrapper, 'claude-a', inbox, prev);
    const r = spawnSync(cmd, { input, shell: true, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('BARRA-ORIGINAL');
    const line = JSON.parse(fs.readFileSync(inbox, 'utf8').trim());
    expect(line).toMatchObject({ profile: 'claude-a', sessionId: 'sl-session-1', project: 'web-demo', costUsd: 1.25, model: 'claude-opus-5-5' });
    expect(JSON.stringify(line)).not.toMatch(/transcript|persona/);
    // Without a previous statusLine it prints real values only.
    const r2 = spawnSync(buildStatuslineCommand(process.execPath, wrapper, 'claude-a', inbox, null), { input, shell: true, encoding: 'utf8' });
    expect(r2.stdout).toBe('Opus 5.5 · 5h 42% · 7d 18%');
    // Garbage input never breaks the Claude status bar.
    const r3 = spawnSync(buildStatuslineCommand(process.execPath, wrapper, 'claude-a', inbox, null), { input: 'no-json', shell: true, encoding: 'utf8' });
    expect(r3.status).toBe(0);
    // Ingestion: snapshots for 5 h and 7 d, session and estimated cost.
    const s = memStore();
    s.upsertProfile(profile('claude', 'claude-a', 'A'));
    expect(await ingestStatuslineInbox(s, dataDir, 'm1')).toBe(4); // two captures × two windows
    const q = s.latestQuotas();
    expect(q.find((x) => x.limitId === 'five_hour')).toMatchObject({ usedPercent: 42, windowMinutes: 300, source: 'claude-statusline' });
    expect(q.find((x) => x.limitId === 'seven_day')).toMatchObject({ usedPercent: 18, windowMinutes: 10080 });
    expect(s.dumpTable('cost_events')[0]).toMatchObject({ amount: 1.25, cost_basis: 'estimated' });
  });

  it('OTel env: refuses to overwrite user telemetry, reverts only what it added', () => {
    const cfgDir = tmpDir('cfg');
    const dataDir = tmpDir('data');
    const settingsPath = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { FOO: '1', OTEL_METRICS_EXPORTER: 'console' } }));
    const p = profile('claude', 'claude-a', 'A', cfgDir);
    expect(() => installClaudeOtel({ profile: p, dataDir, port: 4318 })).toThrow(/no se sobrescribe/);
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { FOO: '1' } }));
    const rec = installClaudeOtel({ profile: p, dataDir, port: 4999 });
    const env = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env;
    expect(env).toMatchObject({ FOO: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_RESOURCE_ATTRIBUTES: 'acc.profile=claude-a', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4999/v1/metrics' });
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOGS_EXPORTER).toBeUndefined();
    revertClaudeOtel(rec);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ env: { FOO: '1' } });
  });
});

describe('OTLP receiver', () => {
  const body = fs.readFileSync(path.join(FIX, 'otlp-metrics.json'), 'utf8');

  it('ingests attributed points, drops unattributed ones', () => {
    const s = memStore();
    s.upsertProfile(profile('claude', 'claude-default'));
    const r = ingestOtlpMetrics(s, JSON.parse(body), new Set(['claude-default']), 'm1');
    expect(r).toMatchObject({ points: 5, stored: 4, unattributed: 1 });
    const ev = s.dumpTable('token_usage_events');
    expect(ev.reduce((a, e) => a + Number(e.input_tokens), 0)).toBe(120);
    expect(ev.reduce((a, e) => a + Number(e.cached_tokens), 0)).toBe(5000);
    expect(s.dumpTable('cost_events')[0]).toMatchObject({ amount: 0.42, cost_basis: 'estimated' });
    // Same delta export delivered twice (retry) → no double count.
    ingestOtlpMetrics(s, JSON.parse(body), new Set(['claude-default']), 'm1');
    expect(s.dumpTable('token_usage_events')).toHaveLength(3);
  });

  it('cumulative series keep the latest total only', () => {
    const s = memStore();
    s.upsertProfile(profile('claude', 'claude-default'));
    const mk = (v: number, t: string) => ({
      resourceMetrics: [{ resource: { attributes: [{ key: 'acc.profile', value: { stringValue: 'claude-default' } }] }, scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 2, dataPoints: [{ attributes: [{ key: 'type', value: { stringValue: 'output' } }, { key: 'session.id', value: { stringValue: 's' } }], timeUnixNano: t, asInt: String(v) }] } }] }] }],
    });
    ingestOtlpMetrics(s, mk(100, '1893456030000000000'), new Set(['claude-default']), 'm1');
    ingestOtlpMetrics(s, mk(250, '1893456060000000000'), new Set(['claude-default']), 'm1');
    const ev = s.dumpTable('token_usage_events');
    expect(ev).toHaveLength(1);
    expect(ev[0].output_tokens).toBe(250);
  });

  it('HTTP: JSON on 127.0.0.1 accepted, protobuf rejected with 415, logs discarded', async () => {
    const s = memStore();
    s.upsertProfile(profile('claude', 'claude-default'));
    let notified = 0;
    const srv = await startOtlpReceiver(s, 0, () => new Set(['claude-default']), 'm1', () => notified++);
    const post = (p: string, ctype: string, data: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'POST', headers: { 'content-type': ctype } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(data);
      });
    expect(await post('/v1/metrics', 'application/json', body)).toBe(200);
    expect(await post('/v1/metrics', 'application/x-protobuf', 'x')).toBe(415);
    expect(await post('/v1/logs', 'application/json', '{"resourceLogs":[{"body":"PROMPT"}]}')).toBe(200);
    expect(await post('/v1/metrics', 'application/json', '{bad')).toBe(400);
    expect(notified).toBe(1);
    expect(s.dumpTable('provider_sessions')[0]).toMatchObject({ session_key: 'claude-default:otel-s1' });
    expect(JSON.stringify(s.dumpTable('token_usage_events'))).not.toContain('PROMPT');
    await srv.close();
  });
});

describe('tool detection and Gemini product classification', () => {
  const ext = (id: string, version: string) => ({ id, version });
  it('classifies Antigravity, Code Assist, Gemini CLI and none — quota is always unavailable', async () => {
    const v = (map: Record<string, string | null>) => async (cmd: string) => map[cmd] ?? null;
    const ag = await detectTools([ext('google.google-antigravity', '1.11.0')], { claude: 'claude', codex: 'codex' }, v({ agy: '1.5.3', claude: '2.1.300 (Claude Code)', codex: 'codex-cli 0.167.0' }));
    expect(ag.gemini.product).toBe('antigravity');
    expect(ag.gemini.versions.join()).toContain('1.11.0');
    expect(ag.findings.find((f) => f.key === 'codex-cli')?.version).toBe('codex-cli 0.167.0');
    const gca = await detectTools([ext('Google.geminicodeassist', '2.0.0')], { claude: 'c', codex: 'x' }, v({}));
    expect(gca.gemini.product).toBe('gemini-code-assist');
    expect(gca.gemini.compatibility).toContain('2026-06-18');
    expect(classifyGemini([{ key: 'gemini-cli', provider: 'gemini', kind: 'cli', name: 'Gemini CLI', version: '1.0', found: true, detail: '' }]).product).toBe('gemini-cli');
    const none = await detectTools([], { claude: 'c', codex: 'x' }, v({}));
    expect(none.gemini.product).toBe('none');
    for (const r of [ag, gca, none]) expect(r.gemini.quota).toBe('unavailable');
  });
});
