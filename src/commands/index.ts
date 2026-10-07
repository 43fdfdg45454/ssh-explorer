import * as vscode from 'vscode';
import type { Settings } from '../config/settings';
import { Commands } from '../constants';
import * as ops from '../fs/sftpOps';
import { buildSshUri, normalizeRemotePath } from '../fs/uri';
import { isFlatpak, runOnHost, sshAuthOverrideCommand } from '../platform/flatpak';
import type { AgentResolver } from '../ssh/agentResolver';
import type { Connection } from '../ssh/connection';
import type { ConnectionManager } from '../ssh/connectionManager';
import type { SshConfigLoader } from '../ssh/sshConfigLoader';
import type { ConnectionProfile } from '../ssh/types';
import { errorMessage, Logger } from '../util/logger';
import { browseRemote } from '../ui/remoteBrowser';
import { editProfileInteractively } from '../ui/profileEditor';
import type { VsCodeSecretStore } from '../ui/secrets';
import { ConnectionItem, stateLabel } from '../ui/treeItems';

const log = new Logger('commands');

export interface CommandDeps {
  manager: ConnectionManager;
  settings: Settings;
  agentResolver: AgentResolver;
  sshConfig: SshConfigLoader;
  secrets: VsCodeSecretStore;
  output: vscode.LogOutputChannel;
}

type Target = ConnectionItem | Connection | string | undefined;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { manager, settings } = deps;

  const resolveProfile = async (
    target: Target,
    placeHolder: string,
  ): Promise<ConnectionProfile | undefined> => {
    if (target instanceof ConnectionItem) return target.profile;
    if (typeof target === 'string') return manager.getProfile(target);
    if (target && 'profile' in target) return target.profile;
    const profiles = manager.listProfiles();
    if (profiles.length === 0) {
      const add = await vscode.window.showInformationMessage(
        'No SSH connections configured yet.',
        'Add connection',
      );
      if (add) await vscode.commands.executeCommand(Commands.addConnection);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      profiles.map((p) => ({
        label: p.name,
        description: `${p.user ? `${p.user}@` : ''}${p.host}`,
        detail: manager.get(p.name) ? stateLabel(manager.get(p.name)!.state) : undefined,
        profile: p,
      })),
      { placeHolder },
    );
    return pick?.profile;
  };

  const connectTo = async (profile: ConnectionProfile): Promise<Connection | undefined> => {
    const conn = manager.getOrCreate(profile.name);
    if (conn.state === 'connected') return conn;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `SSH Explorer: connecting to ${profile.name}…`,
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => void conn.disconnect());
          await conn.connect();
        },
      );
      return conn;
    } catch {
      if (conn.state !== 'disconnected') showConnectionError(conn, deps);
      return undefined;
    }
  };

  const rootOf = async (conn: Connection): Promise<string> => {
    const configured = conn.profile.root;
    return conn.withSftp(async (sftp) => {
      if (configured && configured !== '~') {
        return ops.realpath(sftp, configured.startsWith('~/') ? `.${configured.slice(1)}` : configured);
      }
      return ops.realpath(sftp, '.');
    });
  };

  const addFolderToWorkspace = (conn: Connection, remotePath: string) => {
    const uri = buildSshUri(conn.name, remotePath);
    const existing = (vscode.workspace.workspaceFolders ?? []).find(
      (f) => f.uri.toString() === uri.toString(),
    );
    if (existing) {
      void vscode.window.showInformationMessage(`${uri.toString()} is already in the workspace.`);
      return;
    }
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    const name =
      remotePath === '/'
        ? conn.name
        : `${conn.name}: ${remotePath.split('/').filter(Boolean).pop() ?? remotePath}`;
    if (!vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name })) {
      void vscode.window.showErrorMessage('SSH Explorer: could not add the folder to the workspace.');
    }
  };

  const register = (id: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (err) {
          log.error(err instanceof Error ? err : String(err));
          void vscode.window.showErrorMessage(`SSH Explorer: ${errorMessage(err)}`);
          return undefined;
        }
      }),
    );
  };

  register(Commands.refresh, async () => {
    await manager.refreshProfiles();
  });

  register(Commands.connect, async (target) => {
    const profile = await resolveProfile(target as Target, 'Connect to…');
    if (profile) await connectTo(profile);
  });

  register(Commands.disconnect, async (target) => {
    const profile = await resolveProfile(target as Target, 'Disconnect…');
    if (profile) await manager.get(profile.name)?.disconnect();
  });

  register(Commands.reconnect, async (target) => {
    const profile = await resolveProfile(target as Target, 'Reconnect…');
    if (!profile) return;
    const conn = manager.getOrCreate(profile.name);
    await conn.disconnect();
    await connectTo(profile);
  });

  register(Commands.openRootInWorkspace, async (target) => {
    const profile = await resolveProfile(target as Target, 'Add the root folder of…');
    if (!profile) return;
    const conn = await connectTo(profile);
    if (!conn) return;
    addFolderToWorkspace(conn, await rootOf(conn));
  });

  register(Commands.openFolderInWorkspace, async (target) => {
    const profile = await resolveProfile(target as Target, 'Browse a folder on…');
    if (!profile) return;
    const conn = await connectTo(profile);
    if (!conn) return;
    const picked = await browseRemote(conn, await rootOf(conn), 'folder');
    if (picked) addFolderToWorkspace(conn, picked.path);
  });

  register(Commands.openFile, async (target) => {
    const profile = await resolveProfile(target as Target, 'Open a file on…');
    if (!profile) return;
    const conn = await connectTo(profile);
    if (!conn) return;
    const picked = await browseRemote(conn, await rootOf(conn), 'file');
    if (picked) await vscode.commands.executeCommand('vscode.open', buildSshUri(conn.name, picked.path));
  });

  register('sshExplorer.browse', async (target) => {
    const profile = await resolveProfile(target as Target, 'Browse…');
    if (!profile) return;
    const conn = await connectTo(profile);
    if (!conn) return;
    const picked = await browseRemote(conn, await rootOf(conn), 'any');
    if (!picked) return;
    if (picked.kind === 'file') {
      await vscode.commands.executeCommand('vscode.open', buildSshUri(conn.name, picked.path));
    } else addFolderToWorkspace(conn, picked.path);
  });

  register(Commands.copyUri, async (target) => {
    const profile = await resolveProfile(target as Target, 'Copy URI of…');
    if (!profile) return;
    const uri = buildSshUri(profile.name, normalizeRemotePath(profile.root ?? '/'));
    await vscode.env.clipboard.writeText(uri.toString());
    void vscode.window.setStatusBarMessage(`Copied ${uri.toString()}`, 3000);
  });

  register(Commands.toggleSudo, async (target) => {
    const profile = await resolveProfile(target as Target, 'Toggle sudo mode for…');
    if (!profile) return;
    const raw = settings.rawConnections();
    const idx = raw.findIndex((c) => c.name.toLowerCase() === profile.name.toLowerCase());
    const enable = !profile.sudo;
    if (idx >= 0) {
      raw[idx] = { ...raw[idx]!, sudo: enable };
    } else {
      // ssh_config host: create a saved profile with the same name so the flag has somewhere to live.
      raw.push({ name: profile.name, host: profile.host, sudo: enable });
    }
    await settings.saveConnections(raw);
    await manager.refreshProfiles();
    void vscode.window.showInformationMessage(
      enable
        ? `SSH Explorer: sudo mode enabled for ${profile.name}. Operations denied by the server are retried as root.`
        : `SSH Explorer: sudo mode disabled for ${profile.name}.`,
    );
  });

  register(Commands.addConnection, async () => {
    const created = await editProfileInteractively(settings);
    if (!created) return;
    await settings.saveConnections([...settings.rawConnections(), created]);
    await manager.refreshProfiles();
  });

  register(Commands.editConnection, async (target) => {
    const profile = await resolveProfile(target as Target, 'Edit…');
    if (!profile) return;
    if (profile.source === 'sshConfig') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(deps.sshConfig.configPath));
      const editor = await vscode.window.showTextDocument(doc);
      const line = doc
        .getText()
        .split('\n')
        .findIndex((l) => new RegExp(`^\\s*Host\\s+.*\\b${profile.host}\\b`).test(l));
      if (line >= 0) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return;
    }
    const raw = settings.rawConnections();
    const idx = raw.findIndex((c) => c.name.toLowerCase() === profile.name.toLowerCase());
    if (idx < 0) return;
    const edited = await editProfileInteractively(settings, raw[idx]);
    if (!edited) return;
    raw[idx] = edited;
    await settings.saveConnections(raw);
    await manager.get(profile.name)?.disconnect();
    await manager.refreshProfiles();
  });

  register(Commands.removeConnection, async (target) => {
    const profile = await resolveProfile(target as Target, 'Remove…');
    if (!profile || profile.source !== 'settings') return;
    const ok = await vscode.window.showWarningMessage(
      `Remove connection "${profile.name}"?`,
      { modal: true },
      'Remove',
    );
    if (ok !== 'Remove') return;
    await manager.get(profile.name)?.disconnect();
    await settings.saveConnections(
      settings.rawConnections().filter((c) => c.name.toLowerCase() !== profile.name.toLowerCase()),
    );
    await manager.refreshProfiles();
  });

  register(Commands.showLogs, () => deps.output.show(true));

  register(Commands.clearSavedSecrets, async () => {
    const n = await deps.secrets.clearAll();
    void vscode.window.showInformationMessage(`SSH Explorer: removed ${n} saved secret(s).`);
  });

  register(Commands.diagnoseAgent, async () => {
    await diagnoseAgent(deps);
  });

  register(Commands.statusBarMenu, async () => {
    const items = manager.activeConnections.map((c) => ({
      label: `$(remote) ${c.name}`,
      description: stateLabel(c.state),
      detail: c.lastError?.message,
      conn: c,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'SSH connections' });
    if (!pick) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) Browse', id: 'browse' },
        { label: '$(refresh) Reconnect', id: 'reconnect' },
        { label: '$(debug-disconnect) Disconnect', id: 'disconnect' },
        { label: '$(output) Show logs', id: 'logs' },
      ],
      { placeHolder: pick.conn.name },
    );
    switch (action?.id) {
      case 'browse':
        await vscode.commands.executeCommand('sshExplorer.browse', pick.conn.name);
        break;
      case 'reconnect':
        await vscode.commands.executeCommand(Commands.reconnect, pick.conn.name);
        break;
      case 'disconnect':
        await pick.conn.disconnect();
        break;
      case 'logs':
        deps.output.show(true);
        break;
    }
  });
}

/** Shows a connection failure with the most useful next step. */
export function showConnectionError(conn: Connection, deps: CommandDeps): void {
  const message = conn.lastError?.message ?? 'unknown error';
  const actions = ['Retry', 'Show logs'];
  if (/agent|authentication/i.test(message)) actions.splice(1, 0, 'Diagnose agent');
  void vscode.window
    .showErrorMessage(`SSH Explorer: ${conn.name}: ${message}`, ...actions)
    .then(async (choice) => {
      if (choice === 'Retry') await vscode.commands.executeCommand(Commands.reconnect, conn.name);
      else if (choice === 'Show logs') deps.output.show(true);
      else if (choice === 'Diagnose agent') await vscode.commands.executeCommand(Commands.diagnoseAgent);
    });
}

async function diagnoseAgent(deps: CommandDeps): Promise<void> {
  const out = deps.output;
  out.show(true);
  out.info('--- SSH agent diagnosis ---');
  out.info(`Environment: ${isFlatpak() ? 'Flatpak sandbox' : 'native'}`);
  out.info(`SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK ?? '(unset)'}`);
  out.info(`XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? '(unset)'}`);
  const report = await deps.agentResolver.diagnose();
  let usable = 0;
  for (const c of report) {
    const status = !c.isSocket
      ? 'not found'
      : c.error
        ? `socket, but no answer: ${c.error}`
        : `OK, ${c.identities ?? 0} identit${c.identities === 1 ? 'y' : 'ies'}`;
    if (c.isSocket && !c.error) usable++;
    out.info(`  [${c.source}] ${c.path} — ${status}`);
  }
  if (isFlatpak()) {
    try {
      const host = await runOnHost('ssh-add', ['-L'], 5000);
      const lines = host.stdout.trim().split('\n').filter(Boolean);
      out.info(
        `Host agent (ssh-add -L via flatpak-spawn): ${host.code === 0 ? `${lines.length} identit${lines.length === 1 ? 'y' : 'ies'}` : host.stderr.trim() || `exit ${host.code}`}`,
      );
    } catch (err) {
      out.warn(`Could not query the host agent: ${errorMessage(err)}`);
    }
  }
  if (usable > 0) {
    void vscode.window.showInformationMessage(
      `SSH Explorer: ${usable} usable agent socket(s) found. Details in the output channel.`,
    );
    return;
  }
  const actions = isFlatpak() ? ['Copy flatpak override command'] : [];
  const choice = await vscode.window.showWarningMessage(
    isFlatpak()
      ? 'No SSH agent socket is reachable from the sandbox. Grant the ssh-auth socket to VSCodium and restart it.'
      : 'No SSH agent socket is reachable. Start ssh-agent (or your keyring/1Password agent) and make sure SSH_AUTH_SOCK is set.',
    ...actions,
  );
  if (choice === 'Copy flatpak override command') {
    await vscode.env.clipboard.writeText(sshAuthOverrideCommand());
    void vscode.window.showInformationMessage(`Copied: ${sshAuthOverrideCommand()}`);
  }
}
