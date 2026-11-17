#!/usr/bin/env node
/**
 * Blocks a commit that would publish a secret or personal data.
 *   node scripts/check-secrets.mjs          staged files (what the pre-commit hook runs)
 *   node scripts/check-secrets.mjs --all    every tracked file (manual audit)
 * Looks for: tokens and keys (GitHub, Anthropic/OpenAI, Google, AWS, Slack, JWT, private keys, long hex tokens),
 * passwords in code, credentials in URLs, real-looking e-mails, user-home paths and public IPs. A .vsix is opened and
 * every file inside it is checked too.
 * Personal terms (names, domains, other projects) are NOT listed here — that would publish them. Each clone keeps them,
 * one regex per line, in `.git/info/secret-patterns`, which git never commits.
 * Bypass for one commit, only after checking it is a false positive: git commit --no-verify
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const git = (...a) => execFileSync('git', a, { maxBuffer: 1 << 28 });
const root = git('rev-parse', '--show-toplevel').toString().trim();
const gitDir = path.resolve(root, git('rev-parse', '--git-dir').toString().trim());

const RULES = [
  ['clave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token de GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['clave Anthropic/OpenAI', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['clave de Google', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['token OAuth de Google', /\bya29\.[0-9A-Za-z_-]{20,}|\b1\/\/0[0-9A-Za-z_-]{20,}/],
  ['clave de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token de Slack', /\bxox[abposr]-[0-9A-Za-z-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['token hexadecimal', /\b[0-9a-f]{48,}\b/],
  ['credencial en URL', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s@'"]+@/i],
  ['contraseña en el código', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i],
  ['correo', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['ruta de usuario', /\b[A-Z]:[\\/]+Users[\\/]+(?!x[\\/]|alguien|persona|usuario|<)[A-Za-z0-9._-]{2,}|\/home\/(?!persona|alguien|usuario)[a-z0-9._-]{2,}/i],
  ['IP pública', /\b(?!(?:10|127|0)\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/],
];
// Synthetic or public values the rules above would flag.
const ALLOW = [
  /@(?:[a-z0-9-]+\.)*(?:ejemplo|example|dominio)\.[a-z]+/i, /@[a-z0-9.-]+\.(?:invalid|test|example)\b/i, /\bx@y\.z\b/,
  /@users\.noreply\.github\.com/, /noreply@anthropic\.com/, /sk-ant-abcdefghijklmnop/, /eyJzdWIiOiIxMjM0NTY3ODkwIn0/,
];
const SKIP_FILES = [/(^|\/)package-lock\.json$/, /^scripts\/check-secrets\.mjs$/];

const personalFile = path.join(gitDir, 'info', 'secret-patterns');
if (fs.existsSync(personalFile)) {
  for (const line of fs.readFileSync(personalFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) RULES.push(['dato personal', new RegExp(t, 'i')]);
  }
}

/** Minimal .vsix (zip) reader: central directory → stored or deflated members. */
function zipEntries(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try {
      out.push({ name, data: method === 0 ? raw : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0) });
    } catch {
      out.push({ name, data: Buffer.alloc(0) });
    }
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const findings = [];
function scan(label, buf) {
  if (/\.(png|jpe?g|gif|ico|woff2?)$/i.test(label)) return;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, rx] of RULES) {
      const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
      for (const m of line.matchAll(g)) {
        const ctx = line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        if (ALLOW.some((a) => a.test(ctx))) continue;
        const v = m[0];
        findings.push(`${label}:${i + 1}  ${name}: ${v.length > 10 ? v.slice(0, 4) + '…' + v.slice(-3) : v}`);
      }
    }
  });
}

const all = process.argv.includes('--all');
const files = (all ? git('ls-files', '-z') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter((f) => !SKIP_FILES.some((rx) => rx.test(f)));
for (const f of files) {
  let buf;
  try {
    buf = all ? fs.readFileSync(path.join(root, f)) : git('show', ':' + f);
  } catch {
    continue;
  }
  if (f.endsWith('.vsix')) for (const e of zipEntries(buf)) scan(`${f}!${e.name}`, e.data);
  else scan(f, buf);
}

if (findings.length) {
  process.stderr.write(`\nCommit detenido: ${findings.length} posible(s) secreto(s) o dato(s) personal(es):\n  ${findings.slice(0, 40).join('\n  ')}\n`);
  process.stderr.write('\nQuítalo o cámbialo por un dato ficticio (ejemplo.com, 192.0.2.x). Si es un falso positivo comprobado: git commit --no-verify\n\n');
  process.exit(1);
}
process.stdout.write(`check-secrets: ${files.length} archivo(s) revisado(s), sin secretos ni datos personales.\n`);
