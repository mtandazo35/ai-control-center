import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QuotaSnapshot } from '../core/types';
import { shellCommand } from '../core/util';

/**
 * Official Antigravity quota, from the CLI's own read-only command:
 *   agy -p "/usage" --output-format json
 * Since agy 1.5.x, read-only slash commands in print mode answer WITHOUT starting an agent turn or spending quota
 * (agy changelog; verified 2026-11-17: `num_turns: 0`, all usage counters 0) and force a reload from the server.
 * Shape (only these fields are read):
 *   { status: "SUCCESS", command: { name: "usage", data: { groups: [ { name, buckets: [
 *       { id: "gemini-5h", name, window: "5h" | "weekly", remaining_fraction: 0.99, reset_time: "…Z" } ] } ] } } }
 * The argument is passed straight to the executable (no shell): a POSIX shell layer such as Git Bash would rewrite
 * "/usage" into a Windows path and turn it into a prompt for the model.
 */

export interface AgyUsageBucket {
  id: string;
  name?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}
export interface AgyUsageGroup {
  name?: string;
  buckets?: AgyUsageBucket[];
}

/** Candidate locations of the agy binary, most specific first; `agy` on PATH last. */
export function agyCandidates(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  if (process.env.AGY_PATH) out.push(process.env.AGY_PATH);
  if (process.platform === 'win32') {
    out.push(path.join(home, '.gemini', 'bin', 'agy.exe'));
    const winget = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(winget)) if (d.startsWith('Google.AntigravityCLI_')) out.push(path.join(winget, d, 'agy.exe'));
    } catch {
      /* no WinGet folder */
    }
  } else {
    out.push(path.join(home, '.gemini', 'bin', 'agy'), path.join(home, '.local', 'bin', 'agy'));
  }
  return out;
}

export function runAgyUsage(timeoutMs = 30000): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const args = ['-p', '/usage', '--output-format', 'json'];
  const bin = agyCandidates().find((f) => fs.existsSync(f));
  const sc = bin ? { file: bin, args, shell: false } : shellCommand('agy', args);
  return new Promise((resolve) => {
    execFile(sc.file, sc.args, { timeout: timeoutMs, windowsHide: true, shell: sc.shell, maxBuffer: 1 << 20, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ ok: false, error: /ENOENT|not recognized|no se reconoce/i.test(String(err.message)) ? 'agy no encontrado' : 'agy /usage falló' });
        return;
      }
      try {
        resolve({ ok: true, json: JSON.parse(String(stdout)) });
      } catch {
        resolve({ ok: false, error: 'agy /usage: respuesta no es JSON' });
      }
    });
  });
}

/** Short group names for the card: «Gemini», «Claude y GPT», «Argon». */
function groupLabel(name: string): { label: string; key: string; scoring: boolean; order: number } {
  const n = name.toLowerCase();
  if (n.includes('argon')) return { label: 'Argon', key: 'argon', scoring: false, order: 3 };
  if (n.includes('claude') || n.includes('gpt')) return { label: 'Claude y GPT', key: 'otros', scoring: false, order: 2 };
  if (n.includes('gemini')) return { label: 'Gemini', key: 'gemini', scoring: true, order: 1 };
  return { label: name, key: name, scoring: false, order: 4 };
}

/**
 * Turns the /usage payload into quota snapshots. Only the Gemini group decides whether the account is free
 * (`extra.scoring`); Claude/GPT inside agy and Argon are shown but not scored.
 * Returns [] when the payload is not the known shape (never a guessed percentage).
 */
export function agyUsageToSnapshots(accountId: string, json: unknown, observedAt: string): QuotaSnapshot[] {
  const root = json as { status?: string; command?: { name?: string; data?: { groups?: AgyUsageGroup[] } } } | null;
  if (!root || root.status !== 'SUCCESS' || root.command?.name !== 'usage') return [];
  const out: QuotaSnapshot[] = [];
  for (const g of root.command.data?.groups ?? []) {
    if (!g || typeof g.name !== 'string') continue;
    const gl = groupLabel(g.name);
    for (const b of g.buckets ?? []) {
      if (!b || typeof b.id !== 'string' || typeof b.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue;
      const frac = Math.min(1, Math.max(0, b.remaining_fraction));
      const weekly = b.window === 'weekly';
      const fiveH = b.window === '5h';
      if (!weekly && !fiveH) continue;
      // Two decimals: a light use (0.02 %) must not round to «0 % usado».
      const remaining = Math.round(frac * 10000) / 100;
      const reset = b.reset_time && !Number.isNaN(Date.parse(b.reset_time)) ? new Date(b.reset_time).toISOString() : null;
      out.push({
        accountId,
        limitId: `agy:${b.id}`,
        limitLabel: `${gl.label} · ${fiveH ? '5 h' : '7 d'}`,
        windowMinutes: fiveH ? 300 : 10080,
        usedPercent: Math.round((100 - remaining) * 100) / 100,
        remainingPercent: remaining,
        resetsAt: reset,
        source: 'antigravity-usage',
        confidence: 'high',
        observedAt,
        status: 'live',
        extra: { group: gl.key, scoring: gl.scoring, order: gl.order * 10 + (fiveH ? 0 : 1) },
      });
    }
  }
  return out;
}
