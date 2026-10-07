import type { SFTPWrapper, Stats } from 'ssh2';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../ssh/connectionManager';
import type { Connection } from '../ssh/connection';
import { CancelledError } from '../ssh/errors';
import { SudoError, type SudoRunner } from '../ssh/sudo';
import { Logger, errorMessage } from '../util/logger';
import { toFileSystemError } from './errors';
import * as ops from './sftpOps';
import * as sudoOps from './sudoOps';
import { buildSshUri, parseSshUri, remoteBasename, remoteDirname, remoteJoin } from './uri';
import { PollingWatcher } from './watcher';

const log = new Logger('fs');

export type AtomicWritesMode = 'auto' | 'always' | 'never';

export interface FsSettings {
  atomicWrites(): AtomicWritesMode;
  watchPollIntervalMs(): number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function typeFromMode(mode: number): vscode.FileType {
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

function toFileStat(st: Stats, linkTarget?: Stats): vscode.FileStat {
  const base = linkTarget ?? st;
  let type = typeFromMode(base.mode);
  if (linkTarget || typeFromMode(st.mode) === vscode.FileType.SymbolicLink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return {
    type,
    ctime: (base.atime ?? 0) * 1000,
    mtime: (base.mtime ?? 0) * 1000,
    size: base.size ?? 0,
  };
}

function toFileStatFromRemote(st: sudoOps.RemoteStat, linkTarget?: sudoOps.RemoteStat): vscode.FileStat {
  const base = linkTarget ?? st;
  let type = typeFromMode(base.mode);
  if (linkTarget || typeFromMode(st.mode) === vscode.FileType.SymbolicLink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return { type, ctime: base.mtime * 1000, mtime: base.mtime * 1000, size: base.size };
}

function isPermissionDenied(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === 'NoPermissions';
}

/**
 * Exposes remote directories as `ssh://<connection>/path` so the built-in
 * Explorer, editors and most extensions work on them unchanged. Operations run
 * over SFTP as the login user; when a profile enables `sudo`, operations that
 * SFTP refuses with Permission denied are retried as root through sudo.
 */
export class SshFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly watcher: PollingWatcher;
  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly settings: FsSettings,
  ) {
    this.watcher = new PollingWatcher(
      (events) => this.changeEmitter.fire(events),
      () => this.settings.watchPollIntervalMs(),
    );
  }

  /** Re-read settings (poll interval). */
  refreshSettings(): void {
    this.watcher.refresh();
  }

  private connection(uri: vscode.Uri): { conn: Connection; path: string } {
    const { name, path } = parseSshUri(uri);
    let conn: Connection;
    try {
      conn = this.manager.getOrCreate(name);
    } catch (err) {
      throw vscode.FileSystemError.Unavailable(errorMessage(err));
    }
    return { conn, path };
  }

  private async read<T>(uri: vscode.Uri, fn: (sftp: SFTPWrapper, path: string) => Promise<T>): Promise<T> {
    const { conn, path } = this.connection(uri);
    try {
      return await conn.withSftp((sftp) => fn(sftp, path), { idempotent: true });
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  private async write<T>(
    uri: vscode.Uri,
    fn: (sftp: SFTPWrapper, path: string) => Promise<T>,
    hint?: 'exists' | 'notEmpty',
  ): Promise<T> {
    const { conn, path } = this.connection(uri);
    try {
      return await conn.withSftp((sftp) => fn(sftp, path), { idempotent: false });
    } catch (err) {
      throw toFileSystemError(err, uri, hint);
    }
  }

  /** Runs the SFTP implementation and, on Permission denied with sudo enabled, the root implementation. */
  private async privileged<T>(
    uri: vscode.Uri,
    viaSftp: () => Promise<T>,
    viaSudo: (sudo: SudoRunner, conn: Connection, path: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await viaSftp();
    } catch (err) {
      const { conn, path } = this.connection(uri);
      if (!isPermissionDenied(err)) throw err;
      if (!conn.profile.sudo) {
        log.info(`${uri.toString()}: permission denied over SFTP and sudo mode is off for ${conn.name}`);
        throw vscode.FileSystemError.NoPermissions(
          `${uri.toString()} — enable Sudo Mode on connection "${conn.name}" to work on files owned by root`,
        );
      }
      log.info(`${uri.toString()}: permission denied over SFTP; retrying as root with sudo`);
      try {
        return await viaSudo(conn.sudo, conn, path);
      } catch (sudoErr) {
        log.warn(`${uri.toString()}: sudo fallback failed: ${errorMessage(sudoErr)}`);
        if (sudoErr instanceof vscode.FileSystemError) throw sudoErr;
        if (sudoErr instanceof SudoError || sudoErr instanceof CancelledError) {
          throw vscode.FileSystemError.NoPermissions(`${uri.toString()} (sudo: ${sudoErr.message})`);
        }
        throw toFileSystemError(sudoErr, uri);
      }
    }
  }

  // ---- vscode.FileSystemProvider ------------------------------------------

  watch(uri: vscode.Uri): vscode.Disposable {
    return this.watcher.watch({
      uri,
      stat: async () => {
        try {
          return await this.stat(uri);
        } catch (err) {
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
          throw err;
        }
      },
    });
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.privileged(
      uri,
      () =>
        this.read(uri, async (sftp, path) => {
          const st = await ops.lstat(sftp, path);
          if (typeFromMode(st.mode) !== vscode.FileType.SymbolicLink) return toFileStat(st);
          try {
            return toFileStat(st, await ops.stat(sftp, path));
          } catch {
            return toFileStat(st); // dangling link
          }
        }),
      async (sudo, _conn, path) => {
        const st = await sudoOps.stat(sudo, uri, path);
        if (typeFromMode(st.mode) !== vscode.FileType.SymbolicLink) return toFileStatFromRemote(st);
        try {
          return toFileStatFromRemote(st, await sudoOps.stat(sudo, uri, path, true));
        } catch {
          return toFileStatFromRemote(st);
        }
      },
    );
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.privileged(
      uri,
      () =>
        this.read(uri, async (sftp, path) => {
          const entries = await ops.readdir(sftp, path);
          const result: [string, vscode.FileType][] = [];
          for (const entry of entries) {
            if (entry.filename === '.' || entry.filename === '..') continue;
            let type = typeFromMode(entry.attrs.mode);
            if (type === vscode.FileType.SymbolicLink) {
              try {
                const target = await ops.stat(sftp, remoteJoin(path, entry.filename));
                type = typeFromMode(target.mode) | vscode.FileType.SymbolicLink;
              } catch {
                // dangling symlink: leave as SymbolicLink
              }
            }
            result.push([entry.filename, type]);
          }
          return result;
        }),
      (sudo, _conn, path) => sudoOps.readdir(sudo, uri, path),
    );
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.privileged(
      uri,
      () =>
        this.write(
          uri,
          async (sftp, path) => {
            if (await ops.existsStat(sftp, path)) throw vscode.FileSystemError.FileExists(uri);
            await ops.mkdir(sftp, path);
          },
          'exists',
        ),
      async (sudo, _conn, path) => {
        if (await sudoOps.exists(sudo, uri, path)) throw vscode.FileSystemError.FileExists(uri);
        await sudoOps.mkdir(sudo, uri, path);
      },
    );
    this.fire(vscode.FileChangeType.Created, uri, true);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.privileged(
      uri,
      () =>
        this.read(uri, async (sftp, path) => {
          const st = await ops.stat(sftp, path);
          if (typeFromMode(st.mode) === vscode.FileType.Directory) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
          }
          return new Uint8Array(await ops.readFile(sftp, path));
        }),
      async (sudo, _conn, path) => {
        const st = await sudoOps.stat(sudo, uri, path, true);
        if (typeFromMode(st.mode) === vscode.FileType.Directory) {
          throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        return new Uint8Array(await sudoOps.readFile(sudo, uri, path));
      },
    );
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const data = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    let created = false;
    await this.privileged(
      uri,
      () =>
        this.write(uri, async (sftp, path) => {
          const existing = await ops.existsStat(sftp, path);
          if (existing && typeFromMode(existing.mode) === vscode.FileType.Directory) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
          }
          if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
          if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
          if (!existing) {
            const parent = await ops.existsStat(sftp, remoteDirname(path));
            if (!parent) {
              throw vscode.FileSystemError.FileNotFound(buildSshUri(uri.authority, remoteDirname(path)));
            }
            created = true;
          }
          const mode = existing ? existing.mode & 0o7777 : undefined;
          const atomic = this.settings.atomicWrites();
          const canAtomic = atomic === 'always' || (atomic === 'auto' && ops.supportsPosixRename(sftp));
          if (existing && canAtomic) {
            await this.writeAtomically(sftp, path, data, mode);
          } else {
            await ops.writeFile(sftp, path, data, mode);
          }
        }),
      async (sudo, conn, path) => {
        const existing = await sudoOps.exists(sudo, uri, path);
        if (existing && typeFromMode(existing.mode) === vscode.FileType.Directory) {
          throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
        if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
        if (!existing) {
          const parent = await sudoOps.exists(sudo, uri, remoteDirname(path));
          if (!parent) {
            throw vscode.FileSystemError.FileNotFound(buildSshUri(uri.authority, remoteDirname(path)));
          }
          created = true;
        }
        // Upload as the login user to a private temp file, then let root copy it over the target
        // (cp keeps the target's owner and permissions).
        const temp = await this.uploadTemp(conn, uri, data);
        try {
          await sudoOps.installFile(sudo, uri, temp, path);
        } finally {
          await conn.withSftp((sftp) => ops.unlink(sftp, temp)).catch(() => undefined);
        }
      },
    );
    this.fire(created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri, created);
  }

  private async uploadTemp(conn: Connection, uri: vscode.Uri, data: Buffer): Promise<string> {
    try {
      return await conn.withSftp(async (sftp) => {
        const home = await ops.realpath(sftp, '.');
        const temp = remoteJoin(home, `.ssh-explorer-${process.pid}-${Date.now().toString(36)}.tmp`);
        await ops.writeFile(sftp, temp, data, 0o600);
        return temp;
      });
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /** Writes to a sibling temp file, then renames it over the target so readers never see a partial file. */
  private async writeAtomically(
    sftp: SFTPWrapper,
    path: string,
    data: Buffer,
    mode: number | undefined,
  ): Promise<void> {
    const dir = remoteDirname(path);
    const tmp = remoteJoin(
      dir,
      `.${remoteBasename(path)}.ssh-explorer-${process.pid}-${Date.now().toString(36)}.tmp`,
    );
    try {
      await ops.writeFile(sftp, tmp, data, mode);
      if (mode !== undefined) await ops.setstat(sftp, tmp, { mode }).catch(() => undefined);
      if (ops.supportsPosixRename(sftp)) {
        await ops.posixRename(sftp, tmp, path);
      } else {
        await ops.unlink(sftp, path);
        await ops.rename(sftp, tmp, path);
      }
    } catch (err) {
      await ops.unlink(sftp, tmp).catch(() => undefined);
      log.warn(`Atomic write of ${path} failed (${errorMessage(err)}); falling back to direct write`);
      await ops.writeFile(sftp, path, data, mode);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.privileged(
      uri,
      () =>
        this.write(
          uri,
          async (sftp, path) => {
            const st = await ops.lstat(sftp, path);
            if (typeFromMode(st.mode) === vscode.FileType.Directory) {
              if (options.recursive) await this.deleteTree(sftp, path);
              else await ops.rmdir(sftp, path);
            } else {
              await ops.unlink(sftp, path);
            }
          },
          'notEmpty',
        ),
      async (sudo, _conn, path) => {
        const st = await sudoOps.stat(sudo, uri, path);
        await sudoOps.remove(
          sudo,
          uri,
          path,
          options.recursive,
          typeFromMode(st.mode) === vscode.FileType.Directory,
        );
      },
    );
    this.fire(vscode.FileChangeType.Deleted, uri, true);
  }

  private async deleteTree(sftp: SFTPWrapper, path: string): Promise<void> {
    const entries = await ops.readdir(sftp, path);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      const child = remoteJoin(path, entry.filename);
      if (typeFromMode(entry.attrs.mode) === vscode.FileType.Directory) await this.deleteTree(sftp, child);
      else await ops.unlink(sftp, child);
    }
    await ops.rmdir(sftp, path);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority.toLowerCase() !== newUri.authority.toLowerCase()) {
      throw new vscode.FileSystemError('Cannot rename across SSH connections; copy instead.');
    }
    const target = parseSshUri(newUri).path;
    await this.privileged(
      oldUri,
      () =>
        this.write(
          oldUri,
          async (sftp, path) => {
            const existing = await ops.existsStat(sftp, target);
            if (existing) {
              if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
              if (
                ops.supportsPosixRename(sftp) &&
                typeFromMode(existing.mode) !== vscode.FileType.Directory
              ) {
                await ops.posixRename(sftp, path, target);
                return;
              }
              if (typeFromMode(existing.mode) === vscode.FileType.Directory) {
                await this.deleteTree(sftp, target);
              } else await ops.unlink(sftp, target);
            }
            await ops.rename(sftp, path, target);
          },
          'exists',
        ),
      async (sudo, _conn, path) => {
        const existing = await sudoOps.exists(sudo, newUri, target);
        if (existing) {
          if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
          if (typeFromMode(existing.mode) === vscode.FileType.Directory) {
            await sudoOps.remove(sudo, newUri, target, true, true);
          }
        }
        await sudoOps.rename(sudo, oldUri, path, target);
      },
    );
    this.changeEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
      {
        type: vscode.FileChangeType.Changed,
        uri: buildSshUri(oldUri.authority, remoteDirname(parseSshUri(oldUri).path)),
      },
      { type: vscode.FileChangeType.Changed, uri: buildSshUri(newUri.authority, remoteDirname(target)) },
    ]);
  }

  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (source.authority.toLowerCase() !== destination.authority.toLowerCase()) {
      throw new vscode.FileSystemError('Copying between different SSH connections is not supported.');
    }
    const target = parseSshUri(destination).path;
    await this.privileged(
      source,
      () =>
        this.write(
          source,
          async (sftp, path) => {
            const existing = await ops.existsStat(sftp, target);
            if (existing) {
              if (!options.overwrite) throw vscode.FileSystemError.FileExists(destination);
              if (typeFromMode(existing.mode) === vscode.FileType.Directory) {
                await this.deleteTree(sftp, target);
              } else await ops.unlink(sftp, target);
            }
            await this.copyTree(sftp, path, target);
          },
          'exists',
        ),
      async (sudo, _conn, path) => {
        const existing = await sudoOps.exists(sudo, destination, target);
        if (existing) {
          if (!options.overwrite) throw vscode.FileSystemError.FileExists(destination);
          await sudoOps.remove(
            sudo,
            destination,
            target,
            true,
            typeFromMode(existing.mode) === vscode.FileType.Directory,
          );
        }
        await sudoOps.copy(sudo, source, path, target);
      },
    );
    this.fire(vscode.FileChangeType.Created, destination, true);
  }

  private async copyTree(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
    const st = await ops.lstat(sftp, from);
    if (typeFromMode(st.mode) === vscode.FileType.SymbolicLink) {
      // Recreate the link itself (also works for dangling links).
      await ops.symlink(sftp, await ops.readlink(sftp, from), to);
      return;
    }
    if (typeFromMode(st.mode) === vscode.FileType.Directory) {
      await ops.mkdir(sftp, to, { mode: st.mode & 0o7777 });
      for (const entry of await ops.readdir(sftp, from)) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        await this.copyTree(sftp, remoteJoin(from, entry.filename), remoteJoin(to, entry.filename));
      }
    } else {
      await ops.copyFile(sftp, from, to, st.mode & 0o7777);
    }
  }

  private fire(type: vscode.FileChangeType, uri: vscode.Uri, parentChanged: boolean): void {
    const events: vscode.FileChangeEvent[] = [{ type, uri }];
    if (parentChanged) {
      const parent = remoteDirname(parseSshUri(uri).path);
      events.push({ type: vscode.FileChangeType.Changed, uri: buildSshUri(uri.authority, parent) });
    }
    this.changeEmitter.fire(events);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changeEmitter.dispose();
  }
}
