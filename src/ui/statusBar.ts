import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { ConnectionManager } from '../ssh/connectionManager';
import { stateLabel } from './treeItems';

/** Compact connection summary in the status bar; click for actions. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: { dispose(): unknown }[] = [];

  constructor(private readonly manager: ConnectionManager) {
    this.item = vscode.window.createStatusBarItem('sshExplorer.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'SSH Explorer';
    this.item.command = Commands.statusBarMenu;
    this.subscriptions.push(
      manager.onDidChangeState(() => this.update()),
      manager.onDidChangeProfiles(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const active = this.manager.activeConnections;
    if (active.length === 0) {
      this.item.hide();
      return;
    }
    const connected = active.filter((c) => c.state === 'connected').length;
    const busy = active.filter((c) => c.state === 'connecting' || c.state === 'reconnecting');
    const failed = active.filter((c) => c.state === 'failed');
    let icon = '$(remote)';
    if (busy.length > 0) icon = '$(sync~spin)';
    else if (failed.length > 0) icon = '$(warning)';
    this.item.text = `${icon} SSH: ${active.length === 1 ? active[0]!.name : `${connected}/${active.length}`}`;
    if (active.length === 1) this.item.text += ` (${stateLabel(active[0]!.state).replace('…', '')})`;
    this.item.tooltip = active
      .map((c) => `${c.name}: ${stateLabel(c.state)}${c.lastError ? ` – ${c.lastError.message}` : ''}`)
      .join('\n');
    this.item.backgroundColor =
      failed.length > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }
}
