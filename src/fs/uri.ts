import * as posix from 'node:path/posix';
import * as vscode from 'vscode';
import { SCHEME } from '../constants';

export interface SshLocation {
  /** Connection profile name (URI authority). */
  name: string;
  /** Absolute, normalised remote path. */
  path: string;
}

/** Normalises a remote path: posix, absolute, no trailing slash (except root). */
export function normalizeRemotePath(p: string): string {
  let out = posix.normalize(p.startsWith('/') ? p : '/' + p);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function parseSshUri(uri: vscode.Uri): SshLocation {
  if (uri.scheme !== SCHEME) throw new Error(`Not an ${SCHEME} URI: ${uri.toString()}`);
  if (!uri.authority) throw new Error(`Missing connection name in ${uri.toString()}`);
  return { name: uri.authority, path: normalizeRemotePath(uri.path || '/') };
}

export function buildSshUri(name: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: name, path: normalizeRemotePath(remotePath) });
}

export function remoteBasename(p: string): string {
  return posix.basename(p);
}

export function remoteDirname(p: string): string {
  return posix.dirname(p);
}

export function remoteJoin(...parts: string[]): string {
  return normalizeRemotePath(posix.join(...parts));
}
