import * as vscode from 'vscode';
import type { ConnectionManager } from '../ssh/connectionManager';
import { ConnectionItem } from './treeItems';

/** The "Connections" view: one row per profile with live state. */
export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionItem | undefined>();
  private readonly subscriptions: { dispose(): unknown }[] = [];
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly manager: ConnectionManager) {
    this.subscriptions.push(
      manager.onDidChangeProfiles(() => this.refresh()),
      manager.onDidChangeState(() => this.refresh()),
    );
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: ConnectionItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionItem): ConnectionItem[] {
    if (element) return [];
    return this.manager.listProfiles().map((p) => new ConnectionItem(p, this.manager.get(p.name)));
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.changeEmitter.dispose();
  }
}
