import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildDemoStore } from '../src/core/demo';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput, type ViewModel } from '../src/core/viewmodel';
import { profile, quota, settings } from './helpers';

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.js'), 'utf8');

/** Loads media/dashboard.js in a DOM, feeds it a view model like the extension does, returns the DOM + posted messages. */
async function render(vm: ViewModel) {
  const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>', { runScripts: 'outside-only' });
  const posted: unknown[] = [];
  const w = dom.window as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => ({}), setState: () => undefined });
  dom.window.eval(SCRIPT);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', vm } }));
  await new Promise((r) => setTimeout(r, 0));
  return { doc: dom.window.document, posted, dom };
}

describe('dashboard webview', () => {
  it('renders demo data with an unmistakable banner', async () => {
    const now = new Date();
    const vm = buildViewModel(gatherInput(buildDemoStore(now), '24h', now), settings, '24h', now, true);
    const { doc, posted } = await render(vm);
    expect(posted[0]).toEqual({ type: 'ready' });
    expect(doc.querySelector('.banner.demo')?.textContent).toContain('SIMULADOS');
    expect(doc.querySelectorAll('.card')).toHaveLength(3);
    expect(doc.querySelectorAll('[role="meter"]').length).toBeGreaterThan(0);
    expect(doc.querySelector('svg')).not.toBeNull();
  });

  it('separates official quota from local consumption; no quota → "No disponible", never 0 %', async () => {
    const s = new Store(':memory:');
    const now = new Date();
    s.upsertProfile(profile('claude', 'claude-a', 'A'));
    s.upsertProfile(profile('codex', 'codex-b', 'B'));
    s.insertQuota('m1', quota('codex-b', 'codex:primary', 74, now, new Date(now.getTime() + 3600000), { limitLabel: '5 h' }));
    const vm = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now);
    const { doc } = await render(vm);
    const cards = [...doc.querySelectorAll('.card')];
    const claude = cards.find((c) => c.getAttribute('aria-label') === 'Claude · A')!;
    const codex = cards.find((c) => c.getAttribute('aria-label') === 'Codex · B')!;
    expect(claude.textContent).toContain('No disponible · solo consumo local');
    expect(claude.querySelector('[role="meter"]')).toBeNull();
    expect(claude.textContent).not.toMatch(/\b0 %/);
    expect(codex.querySelector('.bucket-label')?.textContent).toBe('Sesión (5 h)');
    expect(codex.querySelector('.bucket-val')?.textContent).toBe('74 %');
    expect(codex.querySelector('.bucket-foot > span')?.textContent).toMatch(/^Se reinicia (a las|\S+ \d{2}\/\d{2} a las) \d{2}:\d{2}$/);
    const meter = codex.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('74');
    // Fill width set through CSSOM (a style="" attribute in markup would be blocked by the CSP).
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('74%');
    expect(meter.className).toBe('bar warn');
    for (const c of cards) {
      // Local consumption lives apart from the official quota, in its own figures grid.
      const labels = [...c.querySelectorAll('.stats .stat span')].map((x) => x.textContent);
      expect(labels).toContain('tokens en 24 h');
      expect(c.querySelector('.stats [role="meter"]')).toBeNull();
    }
    expect(doc.querySelector('.reco-text')?.textContent).toMatch(/^Recomendada: Codex · B; 26 % restante/);
    expect(doc.querySelector('.banner.demo')).toBeNull();
  });

  it('treats provider data as text (no HTML injection) and buttons post only whitelisted commands', async () => {
    const s = new Store(':memory:');
    const now = new Date();
    const p = profile('codex', 'codex-x', '<img src=x onerror=alert(1)>');
    s.upsertProfile(p);
    const vm = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now);
    const { doc, posted } = await render(vm);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>');
    const btn = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Elegir siguiente cuenta')!;
    btn.click();
    expect(posted.at(-1)).toEqual({ type: 'command', command: 'aiControlCenter.chooseNext' });
    const range = [...doc.querySelectorAll('button')].find((b) => b.textContent === '7d')!;
    range.click();
    expect(posted.at(-1)).toEqual({ type: 'range', range: '7d' });
  });
});
