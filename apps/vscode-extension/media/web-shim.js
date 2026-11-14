// Browser shim for the local web panel: provides the acquireVsCodeApi() that dashboard.js expects,
// backed by GET /api/state. Read-only: actions that need VS Code are hidden (window.ACC_WEB).
(function () {
  'use strict';
  window.ACC_WEB = true;
  let range = '24h';
  let state = {};
  try {
    state = JSON.parse(window.localStorage.getItem('acc-state') || '{}');
  } catch (_) {
    state = {};
  }

  function load() {
    return window
      .fetch('/api/state?range=' + encodeURIComponent(range), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (vm) {
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', vm: vm } }));
      })
      .catch(function (e) {
        const app = document.getElementById('app');
        if (app && !app.querySelector('.card')) app.textContent = 'No se pudo cargar: ' + e.message;
      });
  }

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        if (!m) return;
        if (m.type === 'ready' || m.type === 'refresh') load();
        else if (m.type === 'range') {
          range = m.range;
          load();
        }
      },
      getState: function () {
        return state;
      },
      setState: function (s) {
        state = s;
        try {
          window.localStorage.setItem('acc-state', JSON.stringify(s));
        } catch (_) {
          /* storage blocked: the filter just isn't remembered */
        }
      },
    };
  };
  // Live updates without reloading the page.
  window.setInterval(load, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });
})();
