import * as vscode from 'vscode';
import type { Connection } from '../ssh/connection';
import type { ConnectionProfile, ConnectionState } from '../ssh/types';

export function stateIcon(state: ConnectionState): vscode.ThemeIcon {
  switch (state) {
    case 'connected':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'connecting':
    case 'reconnecting':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    default:
      return new vscode.ThemeIcon('circle-large-outline');
  }
}

export function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return 'Failed';
    default:
      return 'Disconnected';
  }
}

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly profile: ConnectionProfile,
    readonly connection: Connection | undefined,
  ) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    const state = connection?.state ?? 'disconnected';
    const target = `${profile.user ? `${profile.user}@` : ''}${profile.host}${profile.port && profile.port !== 22 ? `:${profile.port}` : ''}`;
    this.description = target === profile.name ? undefined : target;
    this.iconPath = stateIcon(state);
    this.contextValue = `connection.${state}.${profile.source}`;
    this.command = {
      command: 'sshExplorer.browse',
      title: 'Browse',
      arguments: [this],
    };
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${profile.name}** — ${stateLabel(state)}\n\n`);
    md.appendMarkdown(`- Host: \`${target}\`\n`);
    md.appendMarkdown(`- Source: ${profile.source === 'settings' ? 'settings' : '~/.ssh/config'}\n`);
    if (profile.root) md.appendMarkdown(`- Root: \`${profile.root}\`\n`);
    if (profile.proxyJump) md.appendMarkdown(`- ProxyJump: \`${profile.proxyJump}\`\n`);
    if (connection?.lastError) md.appendMarkdown(`\n$(warning) ${connection.lastError.message}\n`);
    md.supportThemeIcons = true;
    this.tooltip = md;
  }
}
