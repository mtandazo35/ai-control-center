// AI Control Center — dashboard webview. Builds the DOM with textContent only (no innerHTML of data).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let filterProvider = saved.filterProvider || 'all';
  let vm = null;
  let showAllSessions = false;

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const cmd = (command) => () => vscode.postMessage({ type: 'command', command });
  // Web panel (read-only): actions that need VS Code are not rendered.
  const WEB = !!window.ACC_WEB;
  const act = (label, command) => (WEB ? null : h('button', { onclick: cmd(command) }, label));
  const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n));
  const SOURCE = {
    'codex-app-server': 'Codex App Server (oficial)',
    'codex-rollout': 'rollout local de Codex (valor del servidor)',
    'claude-statusline': 'statusLine de Claude Code (oficial)',
    'claude-transcript': 'aviso de límite de Claude Code',
    'claude-otel': 'OpenTelemetry local',
    'claude-activity-estimate': 'estimado por la actividad de este PC',
    'claude-mod': 'Claude Code (mod oficial, en vivo)',
    'claude-usage-cache': 'caché de uso de Claude Code (/usage; no documentada)',
    'antigravity-log': 'registros locales de Antigravity (aviso del servidor)',
    'antigravity-conversation': 'conversaciones locales de Antigravity',
    manual: 'registro manual',
  };
  const VERIF = { verified: 'sesión verificada', observed: 'sesión vista en registros', failed: 'sesión con error', pending: 'pendiente', unsupported: 'sin conector' };
  const STATE = { live: 'vigente', stale: 'desactualizado', reset: 'reiniciada', unknown: 'sin dato' };
  const PROVIDER = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  /** 221656 → «153 d 22 h»; 125 → «2 h 05 min». */
  const fmtDur = (min) => {
    if (min < 60) return min + ' min';
    if (min < 1440) return Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') + ' min';
    return Math.floor(min / 1440) + ' d ' + Math.floor((min % 1440) / 60) + ' h';
  };
  /** The window that limits an account now: the known one with the least left. */
  function bottleneck(p) {
    const known = p.buckets.filter((b) => b.usedPercent !== null && (b.state === 'live' || b.state === 'stale'));
    if (!known.length) return { b: p.buckets.find((x) => x.resetText) || null, left: null };
    const b = known.reduce((a, x) => (100 - x.usedPercent < 100 - a.usedPercent ? x : a));
    return { b, left: Math.max(0, Math.round(100 - b.usedPercent)) };
  }

  function bar(b) {
    const used = b.usedPercent;
    const live = b.state === 'live';
    const known = used !== null && (live || b.state === 'stale');
    // Same reading as Claude's usage view: name and % on one line, thin bar, reset time below.
    // Provider colour while there is room; amber from 70 %, red from 95 %.
    const sev = used >= 95 ? 'crit' : used >= 70 ? 'warn' : '';
    const cls = known ? 'bar ' + sev : 'bar off';
    const fill = h('span', null);
    // Width through CSSOM: the CSP (style-src without 'unsafe-inline') blocks style="" attributes.
    fill.style.width = (known ? Math.min(100, used) : 0) + '%';
    const reset = b.resetText || (used === 0 ? 'Sin ventana activa' : 'Reinicio desconocido');
    return h('div', { class: 'bucket', title: 'Fuente: ' + (SOURCE[b.source] || b.source) + ' · confianza ' + b.confidence + ' · ' + b.reason }, [
      h('div', { class: 'bucket-head' }, [
        h('span', { class: 'bucket-label' }, b.displayLabel || b.label),
        h('span', { class: 'bucket-val' + (sev ? ' ' + sev : '') }, known ? used + ' %' : STATE[b.state]),
      ]),
      h('div', { class: cls, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': known ? used : null, 'aria-label': (b.displayLabel || b.label) + ' usado' }, [fill]),
      h('div', { class: 'bucket-foot' }, [
        h('span', null, reset),
        // An old reading says how old it is, on the right, so the reset time stays readable.
        known && !live ? h('span', { class: 'age' }, 'dato ' + b.age) : null,
      ]),
      known ? null : h('div', { class: 'meta' }, b.reason),
    ]);
  }

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  /** One figure of the «measured on this PC» grid: value on top, what it is below. */
  const stat = (value, label, title) => h('div', { class: 'stat', title: title || null }, [h('strong', null, value), h('span', null, label)]);

  function card(p) {
    const warnings = [];
    const ex = (p.buckets.find((b) => b.extra) || {}).extra;
    if (ex && ex.rateLimitReachedType) warnings.push('Límite alcanzado: ' + ex.rateLimitReachedType);
    if (ex && ex.ordinaryUsageAllowed === false) warnings.push('El uso incluido en el plan no está permitido ahora');
    const vOk = p.verification === 'verified' || p.verification === 'observed';
    const gem = p.provider === 'gemini';
    const ctx = p.sessionContext && p.sessionContext.percent !== null ? p.sessionContext : null;
    const det = p.tokens24hDetail || { input: 0, cached: 0, output: 0 };
    const tokTitle = 'Entrada nueva ' + fmtTok(det.input) + ' · salida ' + fmtTok(det.output) + ' · entrada en caché ' + fmtTok(det.cached) + ' (no suma)';
    // Antigravity: tokens come from its conversation stores; if none decoded (older agy, other format) say so.
    const gemTok = gem && !(p.models24h || []).length;
    const stats = [
      gemTok
        ? stat('—', 'tokens en 24 h', 'No se pudieron leer tokens de las conversaciones locales de Antigravity')
        : stat(fmtTok(p.tokens24h), 'tokens en 24 h', tokTitle),
      // Always four cells per card (2 × 2), so every card's grid has the same shape: a missing figure shows «—».
      p.provider === 'claude' || gem ? stat(ctx ? ctx.percent + ' %' : '—', gem ? 'contexto de la última ejecución' : 'contexto de la sesión', ctx ? 'Medido ' + ctx.age : 'Sin medida reciente') : null,
      p.provider === 'codex' ? stat(ex && ex.credits ? (ex.credits.unlimited ? 'ilimitados' : String(ex.credits.balance ?? '—')) : '—', 'créditos') : null,
      gem
        ? stat(String(p.runs24h), p.runs24h === 1 ? 'ejecución en 24 h' : 'ejecuciones en 24 h')
        : stat(String(p.activeSessions), p.activeSessions === 1 ? 'sesión activa' : 'sesiones activas'),
      stat(p.lastDataAge ? p.lastDataAge.replace(/^hace /, '') : '—', p.lastDataAge ? 'desde el último dato' : 'sin datos aún', p.lastDataLocal),
    ].filter(Boolean);
    return h('section', { class: 'card ' + p.provider + (p.enabled ? '' : ' disabled'), 'aria-label': p.title }, [
      h('header', null, [
        h('div', { class: 'card-title' }, [
          h('i', { class: 'dot ' + p.provider }),
          h('h3', null, PROVIDER[p.provider] || p.providerName),
          h('span', { class: 'alias', title: p.alias }, p.alias),
          h('span', { class: 'plan' + (p.plan ? '' : ' unknown') }, p.plan ? cap(p.plan) : 'Plan desconocido'),
        ]),
        h('div', { class: 'card-sub' }, [
          p.identityLabel ? h('span', null, p.identityLabel) : null,
          h('span', { class: 'verif ' + (vOk ? 'ok' : p.verification === 'failed' ? 'crit' : '') }, VERIF[p.verification] || p.verification),
          p.authType ? h('span', null, p.authType) : null,
        ]),
      ]),
      p.hasOfficialQuota
        ? h('div', { class: 'buckets' }, p.buckets.map(bar))
        : h('div', { class: 'empty' }, [
            h('strong', null, 'No disponible · solo consumo local. '),
            p.provider === 'claude'
              ? h('span', null, [
                  'Claude Code solo entrega la cuota a su statusLine. ',
                  WEB
                    ? h('span', null, 'Se habilita desde VS Code (comando «Claude: habilitar captura de cuota»).')
                    : h('button', { class: 'link', onclick: cmd('aiControlCenter.enableClaudeQuotaCapture') }, 'Habilitar captura (con respaldo)'),
                ])
              : p.provider === 'gemini'
                ? h('span', null, p.verificationDetail || '')
                : h('span', null, p.connectorError || 'Sin respuesta del conector.'),
          ]),
      warnings.length ? h('div', { class: 'warn-line' }, warnings.join('. ')) : null,
      gem && (p.models24h || []).length
        ? h('ul', { class: 'models', 'aria-label': 'Uso por modelo en 24 h' }, p.models24h.map((m) =>
            h('li', null, [
              h('span', { class: 'model-name', title: m.model }, m.model),
              h('span', { class: 'model-use' }, (m.sessions === 1 ? '1 ejecución' : m.sessions + ' ejecuciones') + ' · ' + fmtTok(m.tokens) + ' tokens'),
            ])))
        : null,
      h('div', { class: 'stats', 'aria-label': 'Medido en este PC' }, stats),
      p.connectorOk === false ? h('div', { class: 'error' }, 'Recolector: ' + (p.connectorError || 'error')) : null,
    ]);
  }

  // Provider colour per account, the same in gauges, cards and charts; a second account of a provider is lighter.
  const colorOf = (id) => {
    const p = vm.profiles.find((x) => x.id === id);
    if (!p) return '';
    const nth = vm.profiles.filter((x) => x.provider === p.provider).indexOf(p);
    return p.provider + (nth > 0 ? ' alt' : '');
  };

  function chart(series, accounts, opts) {
    if (!accounts.length) return h('p', { class: 'muted' }, opts.empty);
    const W = 640, H = 130, pad = 34;
    const n = series.buckets.length;
    const totals = series.buckets.map((_, i) => accounts.reduce((a, acc) => a + opts.value(acc, i), 0));
    const max = Math.max(1, ...totals);
    const bw = (W - pad) / n;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 22));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.aria + ' por ' + (vm.range === '24h' ? 'hora' : 'día'));
    accounts.forEach((acc, ai) => {
      const prev = series.buckets.map((_, i) => accounts.slice(0, ai).reduce((a, x) => a + opts.value(x, i), 0));
      series.buckets.forEach((_, i) => {
        const v = opts.value(acc, i);
        if (!v) return;
        const y0 = H - (prev[i] / max) * (H - 10);
        const hgt = (v / max) * (H - 10);
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', String(pad + i * bw + 1));
        r.setAttribute('y', String(y0 - hgt));
        r.setAttribute('width', String(Math.max(1, bw - 2)));
        r.setAttribute('height', String(hgt));
        r.setAttribute('class', 'series ' + colorOf(acc.id));
        const t = document.createElementNS(NS, 'title');
        t.textContent = acc.title + ' · ' + (series.labelsLong ? series.labelsLong[i] : series.buckets[i]) + ' · ' + opts.tip(acc, i, v);
        r.appendChild(t);
        svg.appendChild(r);
      });
    });
    [10, H / 2 + 5].forEach((y) => {
      const g = document.createElementNS(NS, 'line');
      g.setAttribute('x1', String(pad));
      g.setAttribute('x2', String(W));
      g.setAttribute('y1', String(y));
      g.setAttribute('y2', String(y));
      g.setAttribute('class', 'grid');
      svg.insertBefore(g, svg.firstChild);
    });
    const lbl = document.createElementNS(NS, 'text');
    lbl.setAttribute('x', '0');
    lbl.setAttribute('y', '12');
    lbl.setAttribute('class', 'axis');
    lbl.textContent = opts.fmt(max);
    svg.appendChild(lbl);
    [0, Math.floor(n / 2), n - 1].forEach((i) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(pad + i * bw));
      t.setAttribute('y', String(H + 16));
      t.setAttribute('class', 'axis');
      t.textContent = series.labels ? series.labels[i] : series.buckets[i];
      svg.appendChild(t);
    });
    const legend = h('div', { class: 'legend' }, accounts.map((a) => h('span', null, [h('i', { class: 'sw ' + colorOf(a.id) }), a.title + (opts.legendNote ? opts.legendNote(a) : '')])));
    return h('div', null, [svg, legend]);
  }

  function tokenChart(series) {
    return chart(series, series.accounts, {
      empty: 'Sin consumo local registrado en el rango.',
      aria: 'Tokens de entrada + salida',
      value: (acc, i) => acc.input[i] + acc.output[i],
      fmt: fmtTok,
      tip: (acc, i, v) => fmtTok(v) + ' tokens (entrada ' + fmtTok(acc.input[i]) + ', salida ' + fmtTok(acc.output[i]) + ', caché ' + fmtTok(acc.cached[i]) + ')',
    });
  }

  function activityChart(series) {
    return chart(series, series.activity || [], {
      empty: 'Sin sesiones ni ejecuciones en el rango.',
      aria: 'Sesiones y ejecuciones iniciadas',
      value: (acc, i) => acc.runs[i],
      fmt: (v) => String(v),
      tip: (acc, i, v) => v + (v === 1 ? ' sesión o ejecución' : ' sesiones o ejecuciones') + ' · ' + acc.minutes[i] + ' min de actividad',
    });
  }

  function table(headers, rows) {
    return h('div', { class: 'scroll' }, h('table', null, [
      h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))),
    ]));
  }

  function render() {
    if (!vm) return;
    const profiles = vm.profiles.filter((p) => filterProvider === 'all' || p.provider === filterProvider);
    const nodes = [];
    if (vm.isDemo) nodes.push(h('div', { class: 'banner demo', role: 'alert' }, 'MODO DEMO — todos los valores de esta pantalla son SIMULADOS. Desactiva aiControlCenter.demoMode para ver tus datos reales.'));
    nodes.push(h('header', { class: 'top' }, [
      h('h1', null, 'AI Control Center'),
      h('span', { class: 'muted' }, 'Actualizado a las ' + new Date(vm.generatedAt).toLocaleTimeString('es-EC', { timeZone: vm.timeZone, hour: '2-digit', minute: '2-digit', hour12: false })),
      h('div', { class: 'actions' }, [
        h('button', { onclick: () => vscode.postMessage({ type: 'refresh' }) }, 'Recargar vista'),
        act('Actualizar datos', 'aiControlCenter.refresh'),
        act('Elegir siguiente cuenta', 'aiControlCenter.chooseNext'),
        act('Vincular perfil', 'aiControlCenter.linkProfile'),
        act('Exportar', 'aiControlCenter.export'),
        act('Diagnóstico', 'aiControlCenter.diagnostics'),
        act('Abrir en navegador', 'aiControlCenter.openWeb'),
        WEB ? h('span', { class: 'readonly' }, 'panel web · solo lectura') : null,
      ]),
    ]));

    // Hero: what is left in each account, in recommendation order. The one bold element of the page.
    const order = vm.recommendation.ranked.map((r) => r.id);
    const ranked = [...vm.profiles].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    nodes.push(h('section', { class: 'avail', 'aria-label': 'Disponible ahora' }, [
      h('h2', null, 'Disponible ahora'),
      h('p', { class: 'reco-text' }, vm.recommendation.summary),
      ...ranked.map((p) => {
        const { b, left } = bottleneck(p);
        const fill = h('span', null);
        fill.style.width = (left === null ? 0 : left) + '%';
        const tone = left === null ? '' : left === 0 ? ' empty' : left < 15 ? ' low' : '';
        const figure =
          left === null
            ? h('span', { class: 'gauge-big none' }, 'sin dato')
            : left === 0
              ? h('span', { class: 'gauge-big out' }, 'agotada')
              : h('span', null, [h('span', { class: 'gauge-big' }, left + ' %'), h('span', { class: 'gauge-unit' }, 'libre')]);
        const when = b
          ? (b.displayLabel || b.label) + (b.resetText ? ' · ' + b.resetText.replace(/^Se reinicia/, 'se recarga') : '') + (b.state === 'stale' ? ' · dato ' + b.age : '')
          : 'sin cuota oficial';
        return h('div', { class: 'gauge-row' }, [
          h('div', { class: 'gauge-name' }, [h('i', { class: 'dot ' + p.provider }), h('strong', null, PROVIDER[p.provider] || p.provider), h('span', { class: 'alias' }, p.alias)]),
          h('div', { class: 'gauge ' + p.provider + tone, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': left === null ? null : left, 'aria-label': p.title + ': cuota libre' }, [fill]),
          h('div', { class: 'gauge-figure' }, figure),
          h('div', { class: 'gauge-when' }, when),
        ]);
      }),
      h('p', { class: 'note' }, 'Cada barra muestra lo que queda en la ventana más cargada de la cuenta. Las cuentas sin dato oficial no se dan por libres, y nada cambia de cuenta por su cuenta.'),
    ]));

    nodes.push(h('div', { class: 'filters', role: 'group', 'aria-label': 'Filtrar por proveedor' }, ['all', 'claude', 'codex', 'gemini'].map((f) =>
      h('button', { class: filterProvider === f ? 'chip on' : 'chip', 'aria-pressed': filterProvider === f ? 'true' : 'false', onclick: () => { filterProvider = f; vscode.setState({ filterProvider }); render(); } }, f === 'all' ? 'Todos' : f[0].toUpperCase() + f.slice(1)))));

    if (!vm.profiles.length) {
      nodes.push(h('section', { class: 'empty' }, [
        h('h2', null, 'Configura tus herramientas'),
        h('p', null, 'Claude Code: se leen tus transcripts locales (solo contadores). La cuota 5 h / 7 d requiere habilitar la captura statusLine.'),
        h('p', null, 'Codex: se consulta el App Server oficial con tu sesión existente (account/rateLimits/read).'),
        h('p', null, 'Gemini: se detecta el producto exacto; sin interfaz oficial de cuota se muestra «No disponible».'),
        act('Detectar herramientas', 'aiControlCenter.detectTools'),
      ]));
    }

    nodes.push(h('h2', null, 'Detalle por cuenta'));
    nodes.push(h('div', { class: 'cards' }, profiles.map(card)));

    nodes.push(h('section', null, [
      h('h2', null, 'Comparación por capacidad documentada'),
      table(['Cuenta', 'Clasificación', 'Motivo'], vm.recommendation.ranked
        .filter((r) => filterProvider === 'all' || r.id.startsWith(filterProvider) || (vm.profiles.find((p) => p.id === r.id) || {}).provider === filterProvider)
        .map((r) => [r.title, r.classification, r.rationale])),
    ]));

    nodes.push(h('section', null, [
      h('h2', null, 'Consumo medido en este PC'),
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Rango' }, ['24h', '7d', '30d'].map((r) =>
        h('button', { class: vm.range === r ? 'chip on' : 'chip', 'aria-pressed': vm.range === r ? 'true' : 'false', onclick: () => vscode.postMessage({ type: 'range', range: r }) }, r))),
      h('div', { class: 'charts' }, [
        h('figure', { class: 'chart-box' }, [h('h3', null, 'Tokens'), h('p', { class: 'muted' }, 'Entrada y salida por ' + (vm.range === '24h' ? 'hora' : 'día') + '. No es cuota.'), tokenChart(vm.series)]),
        h('figure', { class: 'chart-box' }, [h('h3', null, 'Actividad'), h('p', { class: 'muted' }, 'Sesiones y ejecuciones iniciadas, Antigravity incluido.'), activityChart(vm.series)]),
      ]),
      h('div', { class: 'subgrid' }, [
      vm.officialDaily.length
        ? h('div', null, [
            h('h3', null, 'Tokens diarios reportados por Codex (account/usage/read)'),
            table(['Cuenta', 'Día', 'Tokens'], vm.officialDaily.flatMap((a) => a.days.slice(-10).reverse().map((d) => [a.title, d.day, fmtTok(d.tokens)]))),
          ])
        : null,
      vm.costs.length
        ? h('div', null, [
            h('h3', null, 'Costos (separados de la cuota)'),
            table(['Cuenta', 'Monto', 'Base'], vm.costs.map((c) => [c.title, c.total.toFixed(2) + ' ' + c.currency, c.basis === 'estimated' ? 'estimado por la herramienta (no facturado)' : c.basis])),
          ])
        : null,
      ]),
    ]));

    const sessions = vm.sessions.filter((s) => filterProvider === 'all' || s.title.toLowerCase().startsWith(filterProvider));
    const shown = showAllSessions ? sessions : sessions.slice(0, 12);
    nodes.push(h('section', null, [
      h('h2', null, 'Sesiones de los últimos 7 días'),
      sessions.length
        ? h('div', null, [
            table(['Cuenta', 'Proyecto', 'Modelo', 'Última actividad', 'Duración', 'Tokens', 'Estado'],
              shown.map((s) => [s.title, s.project || '—', s.model || '—', s.lastSeenLocal, fmtDur(s.durationMin), fmtTok(s.tokens), s.active ? h('span', { class: 'state-on' }, 'activa') : 'inactiva'])),
            sessions.length > 12
              ? h('button', { class: 'more', onclick: () => { showAllSessions = !showAllSessions; render(); } }, showAllSessions ? 'Mostrar solo las 12 más recientes' : 'Mostrar las ' + sessions.length + ' sesiones')
              : null,
          ])
        : h('p', { class: 'muted' }, 'Sin sesiones registradas.'),
    ]));

    nodes.push(h('section', null, [
      h('h2', null, 'Alertas'),
      vm.alerts.length
        ? h('div', null, [
            WEB ? null : h('button', { onclick: () => vscode.postMessage({ type: 'ackAlerts' }) }, 'Marcar todas como vistas'),
            h('ul', { class: 'alerts' }, vm.alerts.slice(0, 20).map((a) => h('li', { class: a.severity + (a.acknowledged ? ' ack' : '') }, [h('time', null, a.createdLocal), a.message]))),
          ])
        : h('p', { class: 'muted' }, 'Sin alertas.'),
    ]));

    app.replaceChildren(...nodes.filter(Boolean));
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      vm = e.data.vm;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
