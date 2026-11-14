import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { exists, shellCommand } from '../core/util';
import { defaultClaudeConfigDir } from './claude';

export interface ExtensionInfo {
  id: string;
  version: string;
  displayName?: string;
}

export interface ToolFinding {
  key: string;
  provider: 'claude' | 'codex' | 'gemini';
  kind: 'cli' | 'extension' | 'config';
  name: string;
  version: string | null;
  found: boolean;
  detail: string;
}

export interface GeminiProduct {
  product: 'antigravity' | 'gemini-code-assist' | 'gemini-cli' | 'none';
  name: string;
  versions: string[];
  compatibility: string;
  quota: 'unavailable';
}

export const defaultCodexHome = (): string =>
  process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex');

export function cliVersion(command: string, args: string[] = ['--version'], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const sc = shellCommand(command, args);
    execFile(sc.file, sc.args, { timeout: timeoutMs, windowsHide: true, shell: sc.shell }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split(/\r?\n/).find((l) => l.trim());
      resolve(line ? line.trim().slice(0, 120) : null);
    });
  });
}

const EXT = {
  claude: 'anthropic.claude-code',
  codex: 'openai.chatgpt',
  geminiCodeAssist: 'google.geminicodeassist',
  antigravity: 'google.google-antigravity',
};

export async function detectTools(
  extensions: ExtensionInfo[],
  commands: { claude: string; codex: string },
  versionOf: (cmd: string, args?: string[]) => Promise<string | null> = cliVersion,
): Promise<{ findings: ToolFinding[]; gemini: GeminiProduct }> {
  const ext = (id: string) => extensions.find((e) => e.id.toLowerCase() === id);
  const [claudeV, codexV, geminiV, agyV] = await Promise.all([
    versionOf(commands.claude),
    versionOf(commands.codex),
    versionOf('gemini'),
    versionOf('agy'),
  ]);
  const claudeDir = defaultClaudeConfigDir();
  const codexHome = defaultCodexHome();
  const f: ToolFinding[] = [
    { key: 'claude-cli', provider: 'claude', kind: 'cli', name: 'Claude Code CLI', version: claudeV, found: !!claudeV, detail: commands.claude },
    { key: 'claude-ext', provider: 'claude', kind: 'extension', name: 'Claude Code for VS Code', version: ext(EXT.claude)?.version ?? null, found: !!ext(EXT.claude), detail: EXT.claude },
    { key: 'claude-config', provider: 'claude', kind: 'config', name: 'Carpeta de configuración Claude', version: null, found: exists(claudeDir), detail: claudeDir },
    { key: 'codex-cli', provider: 'codex', kind: 'cli', name: 'Codex CLI (app-server)', version: codexV, found: !!codexV, detail: commands.codex },
    { key: 'codex-ext', provider: 'codex', kind: 'extension', name: 'Codex – OpenAI', version: ext(EXT.codex)?.version ?? null, found: !!ext(EXT.codex), detail: EXT.codex },
    { key: 'codex-home', provider: 'codex', kind: 'config', name: 'CODEX_HOME', version: null, found: exists(codexHome), detail: codexHome },
    { key: 'gemini-cli', provider: 'gemini', kind: 'cli', name: 'Gemini CLI', version: geminiV, found: !!geminiV, detail: 'gemini' },
    { key: 'gemini-code-assist', provider: 'gemini', kind: 'extension', name: 'Gemini Code Assist', version: ext(EXT.geminiCodeAssist)?.version ?? null, found: !!ext(EXT.geminiCodeAssist), detail: EXT.geminiCodeAssist },
    { key: 'antigravity-ext', provider: 'gemini', kind: 'extension', name: 'Google Antigravity (VS Code)', version: ext(EXT.antigravity)?.version ?? null, found: !!ext(EXT.antigravity), detail: EXT.antigravity },
    { key: 'antigravity-cli', provider: 'gemini', kind: 'cli', name: 'Antigravity CLI (agy)', version: agyV, found: !!agyV, detail: 'agy' },
  ];
  return { findings: f, gemini: classifyGemini(f) };
}

/**
 * "Gemini" is not one product. Each one has a different (or no) official usage interface.
 * Decision table verified on 2026-11-09 — see docs/provider-capabilities.md.
 */
export function classifyGemini(f: ToolFinding[]): GeminiProduct {
  const get = (k: string) => f.find((x) => x.key === k);
  const ag = [get('antigravity-ext'), get('antigravity-cli')].filter((x) => x?.found) as ToolFinding[];
  if (ag.length) {
    return {
      product: 'antigravity',
      name: 'Google Antigravity',
      versions: ag.map((x) => `${x.name} ${x.version ?? ''}`.trim()),
      compatibility:
        'Antigravity no publica el % de cuota ni tokens. Se leen sus registros locales: ejecuciones (modelo, duración, pasos) y el aviso del servidor cuando la cuota se agota, con su hora de reinicio.',
      quota: 'unavailable',
    };
  }
  const gca = get('gemini-code-assist');
  if (gca?.found) {
    return {
      product: 'gemini-code-assist',
      name: 'Gemini Code Assist',
      versions: [`${gca.name} ${gca.version ?? ''}`.trim()],
      compatibility:
        'Cuentas personales / Google AI Pro / Ultra: integración no compatible con este método de acceso desde 2026-06-18. Standard/Enterprise: la extensión no expone métricas públicas → «No disponible».',
      quota: 'unavailable',
    };
  }
  const cli = get('gemini-cli');
  if (cli?.found) {
    return {
      product: 'gemini-cli',
      name: 'Gemini CLI',
      versions: [`${cli.name} ${cli.version ?? ''}`.trim()],
      compatibility:
        'Gemini CLI tiene OpenTelemetry opt-in (tokens/solicitudes), que no equivale a cuota de suscripción. Conector no implementado: no había CLI instalado para verificarlo.',
      quota: 'unavailable',
    };
  }
  return { product: 'none', name: 'Ningún producto Gemini detectado', versions: [], compatibility: '—', quota: 'unavailable' };
}
