import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store';
import { loadOrCreateToken, startWebServer, type WebHandle } from '../src/web';
import { profile, quota, settings, tmpDir } from './helpers';

function get(port: number, p: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('local web panel', () => {
  let store: Store;
  let web: WebHandle;
  let token: string;
  let cookie: string;

  beforeAll(async () => {
    const dir = tmpDir('web');
    token = loadOrCreateToken(dir);
    expect(loadOrCreateToken(dir)).toBe(token); // stable across windows / agent
    expect(fs.readFileSync(path.join(dir, 'web-token'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    store = new Store(':memory:');
    const now = new Date();
    store.upsertProfile(profile('codex', 'codex-b', 'B'));
    store.upsertProfile(profile('claude', 'claude-a', 'A'));
    store.insertQuota('m1', quota('codex-b', 'codex:primary', 74, now, new Date(now.getTime() + 3600000), { limitLabel: '5 h' }));
    web = await startWebServer(store, { host: '127.0.0.1', port: 0, token, settings: () => settings });
  });
  afterAll(async () => {
    await web.close();
    store.close();
  });

  it('requires the token; ?token sets a strict HttpOnly cookie and removes it from the URL', async () => {
    expect((await get(web.port, '/')).status).toBe(401);
    expect((await get(web.port, '/api/state')).status).toBe(401);
    expect((await get(web.port, '/?token=' + 'f'.repeat(64))).status).toBe(401);
    const r = await get(web.port, `/?token=${token}`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    cookie = sc.split(';')[0];
    expect(web.url).toBe(`http://127.0.0.1:${web.port}/?token=${token}`);
  });

  it('serves the page, assets and live state with security headers', async () => {
    const page = await get(web.port, '/', { cookie });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.body).toContain('/web-shim.js');
    for (const a of ['/dashboard.js', '/dashboard.css', '/web-shim.js']) expect((await get(web.port, a, { cookie })).status).toBe(200);
    const icon = await get(web.port, '/icon.png', { cookie });
    expect(icon.headers['content-type']).toBe('image/png');
    const st = await get(web.port, '/api/state?range=7d', { cookie });
    const vm = JSON.parse(st.body);
    expect(vm.range).toBe('7d');
    expect(vm.isDemo).toBe(false);
    expect(vm.profiles.find((p: { id: string }) => p.id === 'codex-b').buckets[0].usedPercent).toBe(74);
    expect(vm.recommendation.summary).toMatch(/^Recomendada: Codex · B/);
  });

  it('is read-only and rejects foreign Host headers (DNS rebinding)', async () => {
    expect((await get(web.port, '/api/state', { cookie }, 'POST')).status).toBe(405);
    expect((await get(web.port, '/api/state', { cookie }, 'DELETE')).status).toBe(405);
    expect((await get(web.port, '/', { cookie, host: 'evil.example:80' })).status).toBe(421);
    expect((await get(web.port, '/nada', { cookie })).status).toBe(404);
  });

  it('the browser page renders the dashboard through the shim, without VS Code-only actions', async () => {
    const shim = (await get(web.port, '/web-shim.js', { cookie })).body;
    const dash = (await get(web.port, '/dashboard.js', { cookie })).body;
    const state = (await get(web.port, '/api/state', { cookie })).body;
    const dom = new JSDOM('<!doctype html><body class="web"><main id="app"></main></body>', { runScripts: 'outside-only', url: `http://127.0.0.1:${web.port}/` });
    const w = dom.window as unknown as Record<string, unknown>;
    const fetched: string[] = [];
    w.fetch = (u: string) => {
      fetched.push(u);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(state)) });
    };
    dom.window.eval(shim);
    dom.window.eval(dash);
    await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(fetched[0]).toBe('/api/state?range=24h');
    expect(doc.querySelectorAll('.card')).toHaveLength(2);
    expect(doc.body.textContent).toContain('panel web · solo lectura');
    const labels = [...doc.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Recargar vista');
    expect(labels).not.toContain('Elegir siguiente cuenta');
    expect(labels).not.toContain('Habilitar captura (con respaldo)');
    expect(doc.body.textContent).toContain('Se habilita desde VS Code');
    ([...doc.querySelectorAll('button')].find((b) => b.textContent === '30d') as HTMLButtonElement).click();
    expect(fetched.at(-1)).toBe('/api/state?range=30d');
    dom.window.close();
  });
});
