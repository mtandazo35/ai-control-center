import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import dashboardCss from 'asset:dashboard.css';
import dashboardJs from 'asset:dashboard.js';
import iconPng from 'asset:icon.png';
import webShim from 'asset:web-shim.js';
import type { Store } from './core/store';
import type { Settings } from './core/types';
import { buildViewModel, gatherInput, type Range } from './core/viewmodel';

/**
 * Local web panel (read-only). Same view model and dashboard script as the VS Code webview.
 * - Binds to 127.0.0.1 by default. Any other host (LAN, for the phone) is an explicit choice.
 * - Always requires the token stored in <dataDir>/web-token: first visit with ?token=…, then an
 *   HttpOnly SameSite=Strict cookie. Constant-time comparison.
 * - On loopback, the Host header must be localhost/127.0.0.1 (blocks DNS rebinding).
 * - GET only; nothing in the panel can change settings, sessions or accounts.
 */

export interface WebOptions {
  host: string;
  port: number;
  token: string;
  settings: () => Settings;
}

export interface WebHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

export function loadOrCreateToken(dataDir: string): string {
  const f = path.join(dataDir, 'web-token');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    /* create below */
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export const isLoopback = (h: string): boolean => h === '127.0.0.1' || h === 'localhost' || h === '::1';

const COOKIE = 'acc_token';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieToken(req: http.IncomingMessage): string | null {
  const c = req.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(c);
  return m ? m[1] : null;
}

const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AI Control Center</title>
<link rel="icon" href="/icon.png">
<link rel="stylesheet" href="/dashboard.css">
</head>
<body class="web">
<main id="app" aria-live="polite"><p class="muted">Cargando…</p></main>
<script src="/web-shim.js"></script>
<script src="/dashboard.js"></script>
</body>
</html>`;

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
};

export function startWebServer(store: Store, opts: WebOptions): Promise<WebHandle> {
  const server = http.createServer((req, res) => {
    const send = (code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
      res.end(body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'solo lectura', { allow: 'GET' });
      const url = new URL(req.url ?? '/', 'http://local');
      if (isLoopback(opts.host)) {
        const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        if (!isLoopback(hostHeader)) return send(421, 'text/plain; charset=utf-8', 'host no permitido');
      }
      const qToken = url.searchParams.get('token');
      if (qToken !== null) {
        if (!safeEqual(qToken, opts.token)) return send(401, 'text/plain; charset=utf-8', 'token inválido');
        // Move the token out of the URL (history, screenshots) into a strict cookie.
        return send(303, 'text/plain; charset=utf-8', '', {
          location: url.pathname,
          'set-cookie': `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
      }
      const ck = cookieToken(req);
      if (!ck || !safeEqual(ck, opts.token)) {
        return send(401, 'text/plain; charset=utf-8', 'Falta el token. Abre la URL con ?token=… que muestra «AI Control Center: Abrir panel web» o el agente.');
      }
      switch (url.pathname) {
        case '/':
          return send(200, 'text/html; charset=utf-8', HTML);
        case '/dashboard.js':
          return send(200, 'text/javascript; charset=utf-8', dashboardJs);
        case '/web-shim.js':
          return send(200, 'text/javascript; charset=utf-8', webShim);
        case '/dashboard.css':
          return send(200, 'text/css; charset=utf-8', dashboardCss);
        case '/icon.png':
          return send(200, 'image/png', Buffer.from(iconPng, 'base64'));
        case '/api/state': {
          const r = url.searchParams.get('range');
          const range: Range = r === '7d' || r === '30d' ? r : '24h';
          const now = new Date();
          const s = opts.settings();
          const vm = buildViewModel(gatherInput(store, range, now, s.timeZone), s, range, now, false);
          return send(200, 'application/json; charset=utf-8', JSON.stringify(vm));
        }
        default:
          return send(404, 'text/plain; charset=utf-8', 'no existe');
      }
    } catch {
      return send(500, 'text/plain; charset=utf-8', 'error interno');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      const shownHost = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
      resolve({
        url: `http://${shownHost}:${port}/?token=${opts.token}`,
        port,
        host: opts.host,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Starts the panel on `opts.port`; when that port cannot be used it takes a free one the OS picks. On Windows a fixed
 * port can be refused (EACCES) on some boots: Hyper-V/WSL reserve blocks of ports at startup, anywhere in the dynamic
 * range. `fallbackFrom` says why the configured port was not used (null when it was).
 */
export async function startWebServerWithFallback(store: Store, opts: WebOptions): Promise<WebHandle & { fallbackFrom: string | null }> {
  try {
    return { ...(await startWebServer(store, opts)), fallbackFrom: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code !== 'EACCES' && code !== 'EADDRINUSE') throw e;
    return { ...(await startWebServer(store, { ...opts, port: 0 })), fallbackFrom: code };
  }
}

/** True when a panel answers at the URL's host:port (any HTTP reply counts: 401 without the cookie is fine). */
export function panelAnswers(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const req = http.get({ host: u.hostname, port: u.port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
