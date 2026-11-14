import * as vscode from 'vscode';
import type { ProfileView, ViewModel } from '../core/viewmodel';

type Node =
  | { kind: 'profile'; p: ProfileView }
  | { kind: 'info'; label: string; description?: string; tooltip?: string; icon: string; color?: string }
  | { kind: 'alert'; label: string; description: string; severity: string };

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));

function bucketIcon(state: string, used: number | null): { icon: string; color?: string } {
  if (state !== 'live') return { icon: 'circle-slash', color: 'disabledForeground' };
  if ((used ?? 0) >= 95) return { icon: 'error', color: 'errorForeground' };
  if ((used ?? 0) >= 70) return { icon: 'warning', color: 'editorWarning.foreground' };
  return { icon: 'pass', color: 'testing.iconPassed' };
}

export class AccountsTree implements vscode.TreeDataProvider<Node> {
  private vm: ViewModel | null = null;
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  update(vm: ViewModel): void {
    this.vm = vm;
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!this.vm) return [];
    if (!node) {
      const rows: Node[] = [];
      if (this.vm.isDemo) rows.push({ kind: 'info', label: 'MODO DEMO — datos simulados', icon: 'beaker', color: 'editorWarning.foreground' });
      return rows.concat(this.vm.profiles.map((p) => ({ kind: 'profile', p }) as Node));
    }
    if (node.kind !== 'profile') return [];
    const p = node.p;
    const out: Node[] = [];
    if (!p.hasOfficialQuota) {
      out.push({
        kind: 'info',
        label: 'Cuota oficial: No disponible',
        description: p.provider === 'claude' ? 'solo consumo local · habilita la captura statusLine' : 'solo consumo local',
        icon: 'circle-slash',
        color: 'disabledForeground',
      });
    }
    for (const b of p.buckets) {
      const ic = bucketIcon(b.state, b.usedPercent);
      out.push({
        kind: 'info',
        label: `${b.label}: ${b.state === 'live' ? `${b.usedPercent} % usado` : b.state === 'reset' ? 'reiniciada · sin dato nuevo' : b.state === 'stale' ? `${b.usedPercent} % (desactualizado)` : 'No disponible'}`,
        description: b.resetsAt ? `reinicia ${b.resetsLocal}` : '',
        tooltip: `Fuente: ${b.source} · confianza ${b.confidence}\nObservado: ${b.observedLocal} (${b.age})\nReinicio: ${b.resetsLocal} (${b.resetsIn})\nEstado: ${b.reason}`,
        icon: ic.icon,
        color: ic.color,
      });
    }
    if (p.provider === 'gemini') out.push({ kind: 'info', label: `Ejecuciones 24 h: ${p.runs24h}`, description: 'Antigravity no registra tokens', icon: 'graph' });
    else out.push({ kind: 'info', label: `Consumo local 24 h: ${fmtTok(p.tokens24h)} tokens`, description: `fuente ${p.tokenSource === 'otel' ? 'OTel' : p.provider === 'codex' ? 'rollouts' : 'transcripts'}`, icon: 'graph' });
    out.push({ kind: 'info', label: `Sesiones activas: ${p.activeSessions}`, icon: 'debug-start' });
    out.push({
      kind: 'info',
      label: `Verificación: ${p.verification}`,
      description: p.verificationDetail ?? '',
      tooltip: p.verificationDetail ?? '',
      icon: p.verification === 'verified' ? 'verified' : p.verification === 'unsupported' ? 'info' : 'question',
    });
    if (p.connectorOk === false) out.push({ kind: 'info', label: 'Recolector con error', description: p.connectorError ?? '', tooltip: p.connectorError ?? '', icon: 'error', color: 'errorForeground' });
    return out;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'profile') {
      const p = node.p;
      const item = new vscode.TreeItem(p.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = [p.plan ? `plan ${p.plan}` : null, p.identityLabel, p.enabled ? null : 'deshabilitado'].filter(Boolean).join(' · ');
      item.tooltip = `${p.title}\nÚltimo dato: ${p.lastDataLocal}\n${p.verificationDetail ?? ''}`;
      item.contextValue = `profile-${p.provider}`;
      item.iconPath = new vscode.ThemeIcon(p.provider === 'claude' ? 'sparkle' : p.provider === 'codex' ? 'hubot' : 'globe');
      item.id = `profile:${p.id}`;
      return item;
    }
    if (node.kind === 'alert') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.description;
      item.tooltip = `${node.label}\n${node.description}`;
      item.iconPath = new vscode.ThemeIcon(node.severity === 'error' ? 'error' : node.severity === 'warning' ? 'warning' : 'info');
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.description = node.description;
    item.tooltip = node.tooltip ?? node.label;
    item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
    return item;
  }
}

export class AlertsTree implements vscode.TreeDataProvider<Node> {
  private vm: ViewModel | null = null;
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  update(vm: ViewModel): void {
    this.vm = vm;
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node || !this.vm) return [];
    if (!this.vm.alerts.length) return [{ kind: 'info', label: 'Sin alertas', icon: 'check' }];
    return this.vm.alerts.slice(0, 30).map((a) => ({ kind: 'alert', label: a.message, description: a.createdLocal, severity: a.severity }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return new AccountsTree().getTreeItem(node);
  }
}
