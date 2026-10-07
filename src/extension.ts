import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands, showConnectionError } from './commands';
import { SettingsAndSshConfigProfiles } from './config/connectionProfiles';
import { Settings } from './config/settings';
import { SCHEME, VIEW_ID } from './constants';
import { SshFileSystemProvider } from './fs/sshFileSystemProvider';
import { isFlatpak } from './platform/flatpak';
import { AgentResolver } from './ssh/agentResolver';
import type { ConnectionDeps } from './ssh/connection';
import { ConnectionManager } from './ssh/connectionManager';
import { KnownHosts } from './ssh/knownHosts';
import { SshConfigLoader } from './ssh/sshConfigLoader';
import { ConnectionsTreeProvider } from './ui/connectionsTreeProvider';
import { VsCodeAuthPrompter, VsCodeHostKeyPrompter } from './ui/prompts';
import { VsCodeSecretStore } from './ui/secrets';
import { StatusBar } from './ui/statusBar';
import { Logger, setLogSink } from './util/logger';

let manager: ConnectionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('SSH Explorer', { log: true });
  context.subscriptions.push(output);
  setLogSink(output);
  const log = new Logger('extension');
  log.info(`Activating (${isFlatpak() ? 'Flatpak' : 'native'}, node ${process.version})`);

  const settings = new Settings();
  const sshConfig = new SshConfigLoader({ configPath: settings.sshConfigPath() });
  const knownHosts = new KnownHosts();
  const extensionKnownHosts = path.join(context.globalStorageUri.fsPath, 'known_hosts');
  const loadKnownHosts = () => knownHosts.load([settings.knownHostsPath(), extensionKnownHosts]);
  await loadKnownHosts();

  const agentResolver = () =>
    new AgentResolver({
      probePaths: settings.agentSocket()
        ? [settings.agentSocket()!, ...settings.agentProbePaths()]
        : settings.agentProbePaths(),
    });
  let currentAgentResolver = agentResolver();

  const secrets = new VsCodeSecretStore(context.secrets, context.globalState);
  const deps: ConnectionDeps = {
    resolveHost: (profile) => sshConfig.resolve(profile),
    get agentResolver() {
      return currentAgentResolver;
    },
    knownHosts,
    knownHostsWriteFile: () =>
      settings.knownHostsWriteTo() === 'extension' ? extensionKnownHosts : settings.knownHostsPath(),
    hashNewKnownHosts: () => settings.knownHostsHashNewEntries(),
    hostKeyPolicy: () => settings.strictHostKeyChecking(),
    hostKeyPrompter: new VsCodeHostKeyPrompter(),
    authPrompter: new VsCodeAuthPrompter(),
    secrets,
    saveSecretsPolicy: () => settings.saveSecrets(),
    settings: () => settings.connectionSettings(),
  };

  const profiles = new SettingsAndSshConfigProfiles(settings, sshConfig);
  manager = new ConnectionManager(profiles, deps, {
    networkWatchIntervalMs: settings.networkChangeDetection() ? 10_000 : 0,
  });
  context.subscriptions.push(manager);
  await manager.refreshProfiles();

  const provider = new SshFileSystemProvider(manager, {
    atomicWrites: () => settings.atomicWrites(),
    watchPollIntervalMs: () => settings.watchPollIntervalMs(),
  });
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );

  const tree = new ConnectionsTreeProvider(manager);
  context.subscriptions.push(tree);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree, showCollapseAll: false });
  context.subscriptions.push(view);
  context.subscriptions.push(new StatusBar(manager));

  const commandDeps = { manager, settings, agentResolver: currentAgentResolver, sshConfig, secrets, output };
  registerCommands(context, commandDeps);

  // Surface permanent failures (auth, host key, retries exhausted) once per transition.
  context.subscriptions.push(
    manager.onDidChangeState(({ connection, state, previous }) => {
      if (state === 'failed' && previous !== 'failed') {
        showConnectionError(connection, { ...commandDeps, agentResolver: currentAgentResolver });
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!settings.affects(e)) return;
      log.debug('Configuration changed; reloading');
      currentAgentResolver = agentResolver();
      commandDeps.agentResolver = currentAgentResolver;
      await loadKnownHosts();
      await manager?.refreshProfiles();
      provider.refreshSettings();
    }),
  );

  // Reload known_hosts when the user edits it elsewhere (TOFU writes from the terminal).
  const khWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(settings.knownHostsPath())),
      path.basename(settings.knownHostsPath()),
    ),
  );
  khWatcher.onDidChange(() => void loadKnownHosts());
  khWatcher.onDidCreate(() => void loadKnownHosts());
  context.subscriptions.push(khWatcher);

  const remoteFolders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === SCHEME);
  if (remoteFolders.length > 0) {
    log.info(`Workspace has ${remoteFolders.length} ssh:// folder(s); connections open on first access`);
  }
}

export async function deactivate(): Promise<void> {
  await manager?.disconnectAll();
  manager = undefined;
}
