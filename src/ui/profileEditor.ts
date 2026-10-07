import * as vscode from 'vscode';
import type { ConnectionSetting, Settings } from '../config/settings';
import { PROFILE_NAME_PATTERN } from '../constants';

/** Multi-step input for adding or editing a saved connection. */
export async function editProfileInteractively(
  settings: Settings,
  existing?: ConnectionSetting,
): Promise<ConnectionSetting | undefined> {
  const taken = new Set(settings.rawConnections().map((c) => c.name.toLowerCase()));
  const title = existing ? `Edit connection ${existing.name}` : 'Add SSH connection';

  const name = await vscode.window.showInputBox({
    title,
    prompt: 'Name (used in ssh://<name>/ URIs)',
    value: existing?.name ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!PROFILE_NAME_PATTERN.test(v)) return 'Use letters, digits, dots, dashes or underscores only';
      if (taken.has(v.toLowerCase()) && v.toLowerCase() !== existing?.name.toLowerCase()) {
        return 'A connection with this name exists';
      }
      return undefined;
    },
  });
  if (name === undefined) return undefined;

  const hostInput = await vscode.window.showInputBox({
    title,
    prompt: 'Host, as [user@]hostname[:port] or an alias from ~/.ssh/config',
    value: existing
      ? `${existing.user ? `${existing.user}@` : ''}${existing.host}${existing.port && existing.port !== 22 ? `:${existing.port}` : ''}`
      : '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Host is required'),
  });
  if (hostInput === undefined) return undefined;
  const { host, user, port } = parseHostInput(hostInput.trim());

  const root = await vscode.window.showInputBox({
    title,
    prompt: 'Initial remote directory (leave empty for the home directory)',
    value: existing?.root ?? '',
    ignoreFocusOut: true,
  });
  if (root === undefined) return undefined;

  const result: ConnectionSetting = { ...existing, name, host };
  if (user) result.user = user;
  else delete result.user;
  if (port) result.port = port;
  else delete result.port;
  if (root.trim()) result.root = root.trim();
  else delete result.root;
  return result;
}

export function parseHostInput(input: string): { host: string; user?: string; port?: number } {
  let rest = input;
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at) || undefined;
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  const m = /^(.*):(\d+)$/.exec(rest);
  if (m && !rest.includes(':', rest.indexOf(':') + 1)) {
    rest = m[1]!;
    port = Number.parseInt(m[2]!, 10);
  }
  return { host: rest, user, port };
}
