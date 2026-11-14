import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Range, ViewModel } from '../core/viewmodel';

/** Commands the webview may trigger. Anything else is ignored. */
const ALLOWED_COMMANDS = new Set([
  'aiControlCenter.refresh',
  'aiControlCenter.detectTools',
  'aiControlCenter.linkProfile',
  'aiControlCenter.chooseNext',
  'aiControlCenter.export',
  'aiControlCenter.diagnostics',
  'aiControlCenter.enableClaudeQuotaCapture',
  'aiControlCenter.enableClaudeOtel',
  'aiControlCenter.manualSnapshot',
  'aiControlCenter.showDataSource',
  'aiControlCenter.openWeb',
]);

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private range: Range = '24h';

  static show(ctx: vscode.ExtensionContext, getVm: (range: Range) => ViewModel, onAck: () => void): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.push();
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('aiControlCenter.dashboard', 'AI Control Center', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    DashboardPanel.current = new DashboardPanel(ctx, panel, getVm, onAck);
    return DashboardPanel.current;
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.push();
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly getVm: (range: Range) => ViewModel,
    private readonly onAck: () => void,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard.css'));
    panel.webview.html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>AI Control Center</title>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Cargando…</p></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    panel.webview.onDidReceiveMessage((m: { type: string; range?: Range; command?: string }) => {
      if (m.type === 'ready' || m.type === 'refresh') this.push();
      else if (m.type === 'range' && m.range && ['24h', '7d', '30d'].includes(m.range)) {
        this.range = m.range;
        this.push();
      } else if (m.type === 'command' && m.command && ALLOWED_COMMANDS.has(m.command)) {
        void vscode.commands.executeCommand(m.command);
      } else if (m.type === 'ackAlerts') {
        this.onAck();
        this.push();
      }
    });
    panel.onDidDispose(() => {
      DashboardPanel.current = undefined;
    });
  }

  private push(): void {
    void this.panel.webview.postMessage({ type: 'state', vm: this.getVm(this.range) });
  }
}
