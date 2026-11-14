import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------- privacy ----------

/** "persona@dominio.com" -> "p***a@dominio.com". Never store the full address. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `${user[0] ?? ''}***@${domain}`;
  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Project folder name only: never store or export a full personal path. */
export function projectName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const base = path.basename(cwd.replace(/[\\/]+$/, ''));
  return base || null;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /(access|refresh|id)_token["'=:\s]+[A-Za-z0-9._-]{10,}/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/** Redacts tokens, JWTs and e-mail addresses from free text (logs, error messages, exports). */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redactado]');
  return out;
}

/** Profile ids are used inside composite keys: keep them to [a-z0-9-]. */
export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'perfil'
  );
}

// ---------- time ----------

export function toIso(v: number | string | Date | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    // Heuristic: provider epochs are seconds; anything past year 33658 in seconds is milliseconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatInZone(iso: string | null, timeZone: string, withDate = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(withDate ? { day: '2-digit', month: '2-digit', year: 'numeric' } : {}),
  };
  try {
    return new Intl.DateTimeFormat('es-EC', opts).format(d);
  } catch {
    return new Intl.DateTimeFormat('es-EC', { ...opts, timeZone: 'UTC' }).format(d) + ' UTC';
  }
}

/** "hace 3 min", "en 2 h 05 min". */
export function relative(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  let txt: string;
  if (min < 1) txt = 'menos de 1 min';
  else if (min < 60) txt = `${min} min`;
  else if (min < 60 * 48) txt = `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  else txt = `${Math.round(min / 1440)} d`;
  return diff < 0 ? `hace ${txt}` : `en ${txt}`;
}

export function windowLabel(minutes: number | null): string {
  if (!minutes) return 'ventana';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

// ---------- files ----------

/** Recursively lists files matching a predicate, tolerating unreadable directories. */
export function walk(root: string, accept: (file: string) => boolean, maxDepth = 6): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && accept(p)) out.push(p);
    }
  };
  visit(root, 0);
  return out;
}

export function exists(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * execFile that also works with npm .cmd shims on Windows without passing an args array
 * to a shell (Node DEP0190): the command line is built and quoted here instead.
 */
export function shellCommand(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { file: command, args, shell: false };
  const q = (a: string) => (a.startsWith('"') || !/[\s"&|<>^]/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  return { file: [q(command), ...args.map(q)].join(' '), args: [], shell: true };
}

/** Window name as Claude's usage view shows it: «Sesión (5 h)», «Semanal (7 días)», «Límite Fable». */
export function displayLimitLabel(label: string, windowMinutes: number | null): string {
  const scoped = label.split(' · ');
  if (scoped.length === 2 && /^(5 h|7 d)$/.test(scoped[0])) return `Límite ${scoped[1]}`;
  const base = scoped[scoped.length - 1];
  const prefix = scoped.length === 2 ? `${scoped[0]} · ` : '';
  if (base === '5 h' || (windowMinutes === 300 && scoped.length === 1)) return `${prefix}Sesión (5 h)`;
  if (base === '7 d' || (windowMinutes === 10080 && scoped.length === 1)) return `${prefix}Semanal (7 días)`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** «Se reinicia a las 14:40» (same day) or «Se reinicia jue 03/01 a las 03:00», in the display zone. */
export function resetText(iso: string | null, timeZone: string, now: Date): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('es-EC', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('es-EC', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (day(d) === day(now)) return `Se reinicia a las ${time}`;
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-EC', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `Se reinicia ${String(p.weekday).replace('.', '')} ${p.day}/${p.month} a las ${time}`;
}

/** Minutes to add to UTC to get the wall time of `timeZone` at `at` (America/Guayaquil = -300). */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(at)
        .map((x) => [x.type, x.value]),
    );
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return Math.round((wall - Math.floor(at.getTime() / 60000) * 60000) / 60000);
  } catch {
    return 0;
  }
}

/** Chart labels in the display zone: hours «14:00» (tooltip «09/11 14:00»), days «09/11». */
export function axisLabels(buckets: string[], range: '24h' | '7d' | '30d', timeZone: string): { short: string[]; long: string[] } {
  if (range !== '24h') {
    const f = (b: string) => `${b.slice(8, 10)}/${b.slice(5, 7)}`;
    return { short: buckets.map(f), long: buckets.map(f) };
  }
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('es-EC', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (b: string) => Object.fromEntries(f.formatToParts(new Date(b)).map((x) => [x.type, x.value]));
  return {
    short: buckets.map((b) => {
      const p = parts(b);
      return `${p.hour}:${p.minute}`;
    }),
    long: buckets.map((b) => {
      const p = parts(b);
      return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
    }),
  };
}
