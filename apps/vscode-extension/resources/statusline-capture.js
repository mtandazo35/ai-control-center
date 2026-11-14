#!/usr/bin/env node
/*
 * AI Control Center — Claude Code statusLine capture wrapper.
 *
 * Claude Code runs this as the statusLine command and pipes its session JSON to stdin.
 * 1. Appends ONE line with rate_limits (+ session id, model, project folder name, cost) to the inbox.
 *    Nothing else from the JSON is kept: no transcript path, no prompt, no token.
 * 2. If the user already had a statusLine (--wrap <base64>), runs it with the same stdin and prints
 *    its output unchanged. Otherwise prints a short line with the real values.
 * It never fails: any error ends with exit code 0 so the Claude status bar keeps working.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pickShell() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return true; // cmd.exe
}

function main(raw) {
  const profile = arg('--profile');
  const inbox = arg('--inbox');
  const wrap = arg('--wrap');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (_) {}

  if (data && profile && inbox) {
    try {
      const cwd = (data.workspace && data.workspace.current_dir) || data.cwd || null;
      const line = {
        profile,
        observedAt: new Date().toISOString(),
        sessionId: data.session_id || null,
        model: (data.model && (data.model.id || data.model.display_name)) || null,
        project: cwd ? path.basename(String(cwd).replace(/[\\/]+$/, '')) : null,
        version: data.version || null,
        costUsd: data.cost && typeof data.cost.total_cost_usd === 'number' ? data.cost.total_cost_usd : null,
        rateLimits: data.rate_limits || null,
      };
      fs.mkdirSync(path.dirname(inbox), { recursive: true });
      fs.appendFileSync(inbox, JSON.stringify(line) + '\n');
    } catch (_) {}
  }

  if (wrap) {
    try {
      const cmd = Buffer.from(wrap, 'base64').toString('utf8');
      const r = spawnSync(cmd, { input: raw, shell: pickShell(), encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.stdout) process.stdout.write(r.stdout);
    } catch (_) {}
    return;
  }

  // No previous statusLine: a minimal line with real values only.
  const parts = [];
  try {
    if (data && data.model && data.model.display_name) parts.push(data.model.display_name);
    const rl = (data && data.rate_limits) || {};
    if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') parts.push('5h ' + Math.round(rl.five_hour.used_percentage) + '%');
    if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') parts.push('7d ' + Math.round(rl.seven_day.used_percentage) + '%');
  } catch (_) {}
  process.stdout.write(parts.join(' · '));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    main(raw);
  } catch (_) {}
  process.exitCode = 0;
});
