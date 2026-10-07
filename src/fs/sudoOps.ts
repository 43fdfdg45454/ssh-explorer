/**
 * File operations executed as root through `sudo` on an exec channel. Used as
 * a fallback when SFTP (which runs as the login user) reports Permission
 * denied. Requires a POSIX shell and GNU coreutils/findutils on the server.
 */
import * as vscode from 'vscode';
import type { ExecResult } from '../ssh/connection';
import type { SudoRunner } from '../ssh/sudo';
import { errorMessage } from '../util/logger';

export interface RemoteStat {
  /** st_mode including the file type bits. */
  mode: number;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function fail(result: ExecResult, uri: vscode.Uri): never {
  const text = result.stderr.trim();
  if (/No such file or directory|cannot (stat|access)|not found/i.test(text)) {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  if (/Permission denied|Operation not permitted/i.test(text)) {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  if (/File exists/i.test(text)) throw vscode.FileSystemError.FileExists(uri);
  if (/Is a directory/i.test(text)) throw vscode.FileSystemError.FileIsADirectory(uri);
  if (/Not a directory/i.test(text)) throw vscode.FileSystemError.FileNotADirectory(uri);
  throw new vscode.FileSystemError(
    `${uri.toString()}: ${text || `command exited with ${result.code ?? 'signal'}`}`,
  );
}

function parseStat(text: string): RemoteStat {
  const [modeHex, size, mtime] = text.trim().split(/\s+/);
  const mode = Number.parseInt(modeHex ?? '', 16);
  if (!Number.isFinite(mode)) throw new Error(`Unexpected stat output: ${text}`);
  return { mode, size: Number.parseInt(size ?? '0', 10), mtime: Number.parseInt(mtime ?? '0', 10) };
}

export function fileTypeOf(mode: number): vscode.FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return vscode.FileType.Directory;
    case S_IFLNK:
      return vscode.FileType.SymbolicLink;
    case S_IFREG:
      return vscode.FileType.File;
    default:
      return vscode.FileType.Unknown;
  }
}

/** lstat semantics (`follow` false) or stat semantics (`follow` true). */
export async function stat(
  sudo: SudoRunner,
  uri: vscode.Uri,
  path: string,
  follow = false,
): Promise<RemoteStat> {
  const argv = ['stat', ...(follow ? ['-L'] : []), '-c', '%f %s %Y', '--', path];
  const result = await sudo.run(argv);
  if (result.code !== 0) fail(result, uri);
  return parseStat(result.stdout.toString('utf8'));
}

export async function exists(
  sudo: SudoRunner,
  uri: vscode.Uri,
  path: string,
): Promise<RemoteStat | undefined> {
  try {
    return await stat(sudo, uri, path);
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

/** Directory listing with types; symlinks report the target's type too. */
export async function readdir(
  sudo: SudoRunner,
  uri: vscode.Uri,
  path: string,
): Promise<[string, vscode.FileType][]> {
  const result = await sudo.run([
    'find',
    path,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-printf',
    '%y\t%Y\t%f\\0',
  ]);
  if (result.code !== 0 && result.stdout.length === 0) fail(result, uri);
  const entries: [string, vscode.FileType][] = [];
  for (const record of result.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const [type, targetType, ...nameParts] = record.split('\t');
    const name = nameParts.join('\t');
    if (!name) continue;
    const base = (t: string | undefined): vscode.FileType =>
      t === 'd'
        ? vscode.FileType.Directory
        : t === 'f'
          ? vscode.FileType.File
          : t === 'l'
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.Unknown;
    let fileType = base(type);
    if (type === 'l') {
      const target = base(targetType);
      fileType =
        (target === vscode.FileType.SymbolicLink || target === vscode.FileType.Unknown ? 0 : target) |
        vscode.FileType.SymbolicLink;
    }
    entries.push([name, fileType]);
  }
  return entries;
}

export async function readFile(sudo: SudoRunner, uri: vscode.Uri, path: string): Promise<Buffer> {
  const result = await sudo.run(['cat', '--', path]);
  if (result.code !== 0) fail(result, uri);
  return result.stdout;
}

/** Copies `tempPath` (uploaded via SFTP) over `path`, keeping the target's owner and mode when it exists. */
export async function installFile(
  sudo: SudoRunner,
  uri: vscode.Uri,
  tempPath: string,
  path: string,
): Promise<void> {
  const result = await sudo.run(['cp', '--', tempPath, path]);
  if (result.code !== 0) fail(result, uri);
}

export async function mkdir(sudo: SudoRunner, uri: vscode.Uri, path: string): Promise<void> {
  const result = await sudo.run(['mkdir', '--', path]);
  if (result.code !== 0) fail(result, uri);
}

export async function remove(
  sudo: SudoRunner,
  uri: vscode.Uri,
  path: string,
  recursive: boolean,
  isDirectory: boolean,
): Promise<void> {
  const argv = recursive
    ? ['rm', '-rf', '--', path]
    : isDirectory
      ? ['rmdir', '--', path]
      : ['rm', '-f', '--', path];
  const result = await sudo.run(argv);
  if (result.code !== 0) {
    if (/Directory not empty/i.test(result.stderr)) {
      throw new vscode.FileSystemError(`Directory not empty: ${uri.toString()}`);
    }
    fail(result, uri);
  }
}

export async function rename(sudo: SudoRunner, uri: vscode.Uri, from: string, to: string): Promise<void> {
  const result = await sudo.run(['mv', '-fT', '--', from, to]);
  if (result.code !== 0) fail(result, uri);
}

export async function copy(sudo: SudoRunner, uri: vscode.Uri, from: string, to: string): Promise<void> {
  const result = await sudo.run(['cp', '-aT', '--', from, to]);
  if (result.code !== 0) fail(result, uri);
}

export function describeSudoError(err: unknown): string {
  return errorMessage(err);
}
