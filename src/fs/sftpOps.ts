import type { Attributes, FileEntry, InputAttributes, SFTPWrapper, Stats } from 'ssh2';

/** Promise wrappers around the callback-style SFTPWrapper API. */

export function stat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st))));
}

export function lstat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.lstat(p, (err, st) => (err ? reject(err) : resolve(st))));
}

export function readdir(sftp: SFTPWrapper, p: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) =>
    sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))),
  );
}

export function realpath(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs))));
}

export function mkdir(sftp: SFTPWrapper, p: string, attrs?: InputAttributes): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve());
    if (attrs) sftp.mkdir(p, attrs, cb);
    else sftp.mkdir(p, cb);
  });
}

export function rmdir(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rmdir(p, (err) => (err ? reject(err) : resolve())));
}

export function unlink(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.unlink(p, (err) => (err ? reject(err) : resolve())));
}

export function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
}

/** True when the server advertises posix-rename@openssh.com (atomic overwrite). */
export function supportsPosixRename(sftp: SFTPWrapper): boolean {
  const ext = (sftp as unknown as { _extensions?: Record<string, unknown> })._extensions;
  return Boolean(ext && 'posix-rename@openssh.com' in ext);
}

export function posixRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve())),
  );
}

export function setstat(sftp: SFTPWrapper, p: string, attrs: InputAttributes): Promise<void> {
  return new Promise((resolve, reject) => sftp.setstat(p, attrs, (err) => (err ? reject(err) : resolve())));
}

export function readFile(sftp: SFTPWrapper, p: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.readFile(p, (err, data) => (err ? reject(err) : resolve(data))),
  );
}

export function writeFile(sftp: SFTPWrapper, p: string, data: Buffer, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve());
    if (mode !== undefined) sftp.writeFile(p, data, { mode }, cb);
    else sftp.writeFile(p, data, cb);
  });
}

/** Creates `p` exclusively (fails when it already exists) and closes it. */
export function createExclusive(sftp: SFTPWrapper, p: string, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null | undefined, handle: Buffer) => {
      if (err) return reject(err);
      sftp.close(handle, (closeErr) => (closeErr ? reject(closeErr) : resolve()));
    };
    if (mode !== undefined) sftp.open(p, 'wx', mode, cb);
    else sftp.open(p, 'wx', cb);
  });
}

/** Server-to-server copy of a single file through the client, streaming in chunks. */
export function copyFile(sftp: SFTPWrapper, from: string, to: string, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = sftp.createReadStream(from);
    const writeStream = sftp.createWriteStream(to, mode !== undefined ? { mode } : {});
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) {
        readStream.destroy();
        writeStream.destroy();
        reject(err);
      } else {
        resolve();
      }
    };
    readStream.on('error', finish);
    writeStream.on('error', finish);
    writeStream.on('close', () => finish());
    readStream.pipe(writeStream);
  });
}

export function existsStat(sftp: SFTPWrapper, p: string): Promise<Stats | undefined> {
  return lstat(sftp, p).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 2) return undefined;
    throw err;
  });
}

export type { Attributes };

export function readlink(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) =>
    sftp.readlink(p, (err, target) => (err ? reject(err) : resolve(target))),
  );
}

export function symlink(sftp: SFTPWrapper, target: string, linkPath: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.symlink(target, linkPath, (err) => (err ? reject(err) : resolve())),
  );
}
