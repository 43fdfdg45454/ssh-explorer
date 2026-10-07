/**
 * In-process SSH server with an SFTP subsystem backed by a temporary directory.
 * Lets integration tests exercise the real ssh2 client stack (auth, host keys,
 * reconnection) in milliseconds without Docker or a system sshd.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Attributes, AuthContext, Connection as ServerConnection, FileEntry, SFTPWrapper } from 'ssh2';
import { Server, utils } from 'ssh2';
import { generateEcKeyPair, type TestKeyPair } from '../fixtures/keys';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface SftpTestServerOptions {
  /** Public key blobs accepted for publickey auth. */
  authorizedKeys?: Buffer[];
  /** user → password accepted for password auth. */
  passwords?: Record<string, string>;
  /** When set, keyboard-interactive asks one question and expects this answer. */
  keyboardAnswer?: string;
  hostKey?: TestKeyPair;
  /**
   * Remote paths (relative to the temp root, e.g. '/protected') where every
   * mutating SFTP request fails with PERMISSION_DENIED and reads of files
   * directly inside fail too. Lets tests exercise privilege fallbacks without
   * relying on real file-system permissions (tests may run as root).
   */
  readOnlyPaths?: string[];
  /** Extra environment for exec'd commands (e.g. a fake sudo on PATH). */
  execEnv?: NodeJS.ProcessEnv;
}

interface OpenFile {
  kind: 'file';
  fd: fsp.FileHandle;
}
interface OpenDir {
  kind: 'dir';
  entries: FileEntry[] | undefined;
  path: string;
}

function toAttrs(st: fs.Stats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function statusFor(err: unknown): number {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'EBADF':
    case 'ELOOP':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    case 'ENOSYS':
      return STATUS_CODE.OP_UNSUPPORTED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

function longname(name: string, st: fs.Stats): string {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  return `${type}rw-r--r--    1 user     user     ${String(st.size).padStart(8)} Jan  1 00:00 ${name}`;
}

export class SftpTestServer {
  readonly hostKey: TestKeyPair;
  readonly root: string;
  private server: Server | undefined;
  private sockets = new Set<net.Socket>();
  private sftpChannels = new Set<SFTPWrapper>();
  private _port = 0;
  /** Number of successful SSH authentications. */
  authCount = 0;
  /** Number of SFTP channels ever opened. */
  sftpOpenCount = 0;
  /** Commands received over exec channels, in order. */
  execCommands: string[] = [];
  acceptConnections = true;

  constructor(private readonly options: SftpTestServerOptions = {}) {
    this.hostKey = options.hostKey ?? generateEcKeyPair();
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-explorer-test-'));
  }

  get port(): number {
    return this._port;
  }

  /** Absolute path inside the temp root for a remote path. */
  local(remotePath: string): string {
    const normalized = path.posix.normalize('/' + remotePath.replace(/^\.?\/?/, ''));
    return path.join(this.root, normalized);
  }

  async start(): Promise<void> {
    const server = new Server({ hostKeys: [this.hostKey.privatePem] }, (client, info) => {
      void info;
      this.handleClient(client);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;
    this._port = address.port;
    // Track raw sockets so tests can simulate network drops (ssh2 keeps the net.Server in _srv).
    const netServer = (server as unknown as { _srv: net.Server })._srv;
    netServer.on('connection', (socket: net.Socket) => {
      if (!this.acceptConnections) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Destroys every client socket without closing the listener (simulates a network drop). */
  kill(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.sftpChannels.clear();
  }

  /** Ends every SFTP channel but keeps the SSH connections alive. */
  dropSftpChannels(): void {
    for (const ch of this.sftpChannels) ch.end();
    this.sftpChannels.clear();
  }

  async close(): Promise<void> {
    this.kill();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await fsp.rm(this.root, { recursive: true, force: true });
  }

  private handleClient(client: ServerConnection): void {
    const METHODS: ('publickey' | 'password' | 'keyboard-interactive')[] = [];
    if (this.options.authorizedKeys?.length) METHODS.push('publickey');
    if (this.options.passwords) METHODS.push('password');
    if (this.options.keyboardAnswer !== undefined) METHODS.push('keyboard-interactive');
    client.on('authentication', (rawCtx: AuthContext) => {
      // Like OpenSSH, always advertise the full method list on failure.
      const ctx = rawCtx;
      const originalReject = ctx.reject.bind(ctx);
      ctx.reject = (methods?: typeof METHODS, partial?: boolean) =>
        originalReject(methods ?? METHODS, partial);
      switch (ctx.method) {
        case 'none':
          ctx.reject();
          return;
        case 'publickey': {
          const ok = (this.options.authorizedKeys ?? []).some((k) => k.equals(ctx.key.data));
          if (!ok) return ctx.reject();
          if (ctx.signature && ctx.blob) {
            const parsed = utils.parseKey(ctx.key.data);
            if (parsed instanceof Error || !parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
              return ctx.reject();
            }
          }
          ctx.accept();
          return;
        }
        case 'password': {
          const expected = this.options.passwords?.[ctx.username];
          if (expected !== undefined && expected === ctx.password) ctx.accept();
          else ctx.reject();
          return;
        }
        case 'keyboard-interactive': {
          if (this.options.keyboardAnswer === undefined) return ctx.reject();
          ctx.prompt([{ prompt: 'Token: ', echo: false }], 'Second factor', '', (answers) => {
            if (answers[0] === this.options.keyboardAnswer) ctx.accept();
            else ctx.reject();
          });
          return;
        }
        default:
          ctx.reject();
      }
    });
    client.on('ready', () => {
      this.authCount++;
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec();
          this.execCommands.push(info.command);
          // Commands quote every path ('/x'); map remote absolute paths onto the temp root.
          const command = info.command.replace(/'\//g, `'${this.root}/`);
          const child = spawn('sh', ['-c', command], {
            cwd: this.root,
            env: { ...process.env, ...this.options.execEnv, LC_ALL: 'C' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          channel.pipe(child.stdin);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          child.on('close', (code, signal) => {
            if (code === null) channel.exit(signal ?? 'SIGTERM');
            else channel.exit(code);
            channel.end();
          });
          child.on('error', () => {
            channel.exit(127);
            channel.end();
          });
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          this.sftpOpenCount++;
          this.sftpChannels.add(sftp);
          sftp.on('close', () => this.sftpChannels.delete(sftp));
          this.serveSftp(sftp);
        });
      });
    });
    client.on('error', () => undefined);
  }

  private serveSftp(sftp: SFTPWrapper): void {
    const handles = new Map<number, OpenFile | OpenDir>();
    let nextHandle = 1;
    const newHandle = (entry: OpenFile | OpenDir): Buffer => {
      const id = nextHandle++;
      handles.set(id, entry);
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(id, 0);
      return buf;
    };
    const lookup = (handle: Buffer) => handles.get(handle.readUInt32BE(0));
    const fail = (reqId: number, err: unknown) => sftp.status(reqId, statusFor(err), (err as Error)?.message);
    const ok = (reqId: number) => sftp.status(reqId, STATUS_CODE.OK);
    const readOnly = (this.options.readOnlyPaths ?? []).map((p) => path.posix.normalize(p));
    const isProtected = (remote: string): boolean => {
      const norm = path.posix.normalize(remote.startsWith('/') ? remote : '/' + remote);
      return readOnly.some((ro) => norm === ro || norm.startsWith(ro + '/'));
    };
    const denied = (reqId: number) => sftp.status(reqId, STATUS_CODE.PERMISSION_DENIED, 'Permission denied');

    sftp.on('REALPATH', (reqId, p) => {
      const abs = path.posix.normalize(p === '.' || p === '' ? '/' : p.startsWith('/') ? p : '/' + p);
      fsp
        .stat(this.local(abs))
        .then((st) => sftp.name(reqId, [{ filename: abs, longname: longname(abs, st), attrs: toAttrs(st) }]))
        .catch(() => sftp.name(reqId, [{ filename: abs, longname: abs, attrs: {} as Attributes }]));
    });
    const statLike = (fn: typeof fsp.stat) => (reqId: number, p: string) => {
      fn(this.local(p))
        .then((st) => sftp.attrs(reqId, toAttrs(st)))
        .catch((err: unknown) => fail(reqId, err));
    };
    sftp.on('STAT', statLike(fsp.stat));
    sftp.on('LSTAT', statLike(fsp.lstat));
    sftp.on('FSTAT', (reqId, handle) => {
      const h = lookup(handle);
      if (!h || h.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      h.fd
        .stat()
        .then((st) => sftp.attrs(reqId, toAttrs(st)))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('OPENDIR', (reqId, p) => {
      const local = this.local(p);
      fsp
        .stat(local)
        .then((st) => {
          if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
          sftp.handle(reqId, newHandle({ kind: 'dir', entries: undefined, path: local }));
        })
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('READDIR', (reqId, handle) => {
      const h = lookup(handle);
      if (!h || h.kind !== 'dir') return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      if (h.entries) {
        if (h.entries.length === 0) return sftp.status(reqId, STATUS_CODE.EOF);
        const batch = h.entries.splice(0, 50);
        return sftp.name(reqId, batch);
      }
      fsp
        .readdir(h.path)
        .then(async (names) => {
          const entries: FileEntry[] = [];
          for (const name of names) {
            const st = await fsp.lstat(path.join(h.path, name));
            entries.push({ filename: name, longname: longname(name, st), attrs: toAttrs(st) });
          }
          h.entries = entries;
          if (entries.length === 0) return sftp.status(reqId, STATUS_CODE.EOF);
          sftp.name(reqId, h.entries.splice(0, 50));
        })
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('OPEN', (reqId, filename, flags, attrs) => {
      const flagStr = flagsToString(flags);
      if (!flagStr) return sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED);
      if (isProtected(filename) && (flagStr !== 'r' || /secret/.test(filename))) return denied(reqId);
      fsp
        .open(this.local(filename), flagStr, attrs.mode || 0o644)
        .then((fd) => sftp.handle(reqId, newHandle({ kind: 'file', fd })))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('READ', (reqId, handle, offset, len) => {
      const h = lookup(handle);
      if (!h || h.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      const buf = Buffer.alloc(len);
      h.fd
        .read(buf, 0, len, offset)
        .then(({ bytesRead }) => {
          if (bytesRead === 0) return sftp.status(reqId, STATUS_CODE.EOF);
          sftp.data(reqId, buf.subarray(0, bytesRead));
        })
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('WRITE', (reqId, handle, offset, data) => {
      const h = lookup(handle);
      if (!h || h.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      h.fd
        .write(data, 0, data.length, offset)
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('CLOSE', (reqId, handle) => {
      const id = handle.readUInt32BE(0);
      const h = handles.get(id);
      handles.delete(id);
      if (!h) return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      if (h.kind === 'file') {
        h.fd
          .close()
          .then(() => ok(reqId))
          .catch((err: unknown) => fail(reqId, err));
      } else {
        ok(reqId);
      }
    });
    sftp.on('MKDIR', (reqId, p, attrs) => {
      if (isProtected(p)) return denied(reqId);
      fsp
        .mkdir(this.local(p), { mode: attrs.mode || 0o755 })
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('RMDIR', (reqId, p) => {
      if (isProtected(p)) return denied(reqId);
      fsp
        .rmdir(this.local(p))
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('REMOVE', (reqId, p) => {
      if (isProtected(p)) return denied(reqId);
      fsp
        .unlink(this.local(p))
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('RENAME', (reqId, oldPath, newPath) => {
      if (isProtected(oldPath) || isProtected(newPath)) return denied(reqId);
      // OpenSSH semantics: plain RENAME refuses to overwrite.
      fsp.access(this.local(newPath)).then(
        () => sftp.status(reqId, STATUS_CODE.FAILURE, 'target exists'),
        () =>
          fsp
            .rename(this.local(oldPath), this.local(newPath))
            .then(() => ok(reqId))
            .catch((err: unknown) => fail(reqId, err)),
      );
    });
    sftp.on('SETSTAT', (reqId, p, attrs) => {
      if (isProtected(p)) return denied(reqId);
      this.applyAttrs(this.local(p), attrs)
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('FSETSTAT', (reqId, handle, attrs) => {
      const h = lookup(handle);
      if (!h || h.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE, 'bad handle');
      const promises: Promise<unknown>[] = [];
      if (attrs.mode !== undefined) promises.push(h.fd.chmod(attrs.mode));
      if (attrs.size !== undefined) promises.push(h.fd.truncate(attrs.size));
      Promise.all(promises)
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('READLINK', (reqId, p) => {
      fsp
        .readlink(this.local(p))
        .then((target) => sftp.name(reqId, [{ filename: target, longname: target, attrs: {} as Attributes }]))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('SYMLINK', (reqId, targetPath, linkPath) => {
      fsp
        .symlink(targetPath, this.local(linkPath))
        .then(() => ok(reqId))
        .catch((err: unknown) => fail(reqId, err));
    });
    sftp.on('EXTENDED', (reqId, extName, extData) => {
      if (extName === 'posix-rename@openssh.com') {
        const len1 = extData.readUInt32BE(0);
        const oldPath = extData.subarray(4, 4 + len1).toString('utf8');
        const len2 = extData.readUInt32BE(4 + len1);
        const newPath = extData.subarray(8 + len1, 8 + len1 + len2).toString('utf8');
        if (isProtected(oldPath) || isProtected(newPath)) return denied(reqId);
        fsp
          .rename(this.local(oldPath), this.local(newPath))
          .then(() => ok(reqId))
          .catch((err: unknown) => fail(reqId, err));
        return;
      }
      sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED);
    });
  }

  private async applyAttrs(local: string, attrs: Attributes): Promise<void> {
    if (attrs.mode !== undefined) await fsp.chmod(local, attrs.mode & 0o7777);
    if (attrs.size !== undefined) await fsp.truncate(local, attrs.size);
    if (attrs.atime !== undefined && attrs.mtime !== undefined) {
      await fsp.utimes(local, attrs.atime, attrs.mtime);
    }
  }
}
