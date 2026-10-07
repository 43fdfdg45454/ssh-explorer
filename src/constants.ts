export const SCHEME = 'ssh';
export const EXTENSION_ID = 'sshExplorer';
export const CONFIG_SECTION = 'sshExplorer';
export const VIEW_ID = 'sshExplorer.connections';
export const VIEW_CONTAINER_ID = 'sshExplorer';

export const Commands = {
  refresh: 'sshExplorer.refresh',
  addConnection: 'sshExplorer.addConnection',
  editConnection: 'sshExplorer.editConnection',
  removeConnection: 'sshExplorer.removeConnection',
  connect: 'sshExplorer.connect',
  disconnect: 'sshExplorer.disconnect',
  reconnect: 'sshExplorer.reconnect',
  openRootInWorkspace: 'sshExplorer.openRootInWorkspace',
  openFolderInWorkspace: 'sshExplorer.openFolderInWorkspace',
  openFile: 'sshExplorer.openFile',
  copyUri: 'sshExplorer.copyUri',
  toggleSudo: 'sshExplorer.toggleSudo',
  diagnoseAgent: 'sshExplorer.diagnoseAgent',
  showLogs: 'sshExplorer.showLogs',
  clearSavedSecrets: 'sshExplorer.clearSavedSecrets',
  statusBarMenu: 'sshExplorer.statusBarMenu',
} as const;

/** Name pattern for connection profiles (used as the URI authority). */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
