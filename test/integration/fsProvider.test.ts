import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshFileSystemProvider } from '../../src/fs/sshFileSystemProvider';
import { buildSshUri } from '../../src/fs/uri';
import { ConnectionManager } from '../../src/ssh/connectionManager';
import { generateEcKeyPair } from '../fixtures/keys';
import { createHarness, waitForState, writeTempKey } from './harness';
import { SftpTestServer } from './sftpTestServer';

const clientKey = generateEcKeyPair();
let server: SftpTestServer;
let manager: ConnectionManager;
let provider: SshFileSystemProvider;
let events: vscode.FileChangeEvent[];
const uri = (p: string) => buildSshUri('test', p);
const dec = new TextDecoder();
const enc = new TextEncoder();

beforeEach(async () => {
  server = new SftpTestServer({ authorizedKeys: [clientKey.publicBlob] });
  await server.start();
  const keyFile = writeTempKey(clientKey.privatePem);
  const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
  manager = new ConnectionManager({ loadProfiles: async () => [h.profile] }, h.deps, {
    networkWatchIntervalMs: 0,
  });
  await manager.refreshProfiles();
  provider = new SshFileSystemProvider(manager, { atomicWrites: () => 'auto', watchPollIntervalMs: () => 0 });
  events = [];
  provider.onDidChangeFile((e) => events.push(...e));
  await fs.mkdir(path.join(server.root, 'dir/sub'), { recursive: true });
  await fs.writeFile(path.join(server.root, 'dir/a.txt'), 'alpha');
  await fs.writeFile(path.join(server.root, 'dir/sub/b.txt'), 'beta');
  await fs.symlink('a.txt', path.join(server.root, 'dir/link'));
});

afterEach(async () => {
  provider.dispose();
  manager.dispose();
  await server.close();
});

describe('SshFileSystemProvider', () => {
  it('connects lazily and lists directories with types', async () => {
    const entries = await provider.readDirectory(uri('/dir'));
    expect(entries.sort()).toEqual([
      ['a.txt', vscode.FileType.File],
      ['link', vscode.FileType.File | vscode.FileType.SymbolicLink],
      ['sub', vscode.FileType.Directory],
    ]);
    expect(manager.get('test')?.state).toBe('connected');
  });

  it('stats files, directories and symlinks', async () => {
    const file = await provider.stat(uri('/dir/a.txt'));
    expect(file.type).toBe(vscode.FileType.File);
    expect(file.size).toBe(5);
    expect(file.mtime).toBeGreaterThan(0);
    expect((await provider.stat(uri('/dir'))).type).toBe(vscode.FileType.Directory);
    expect((await provider.stat(uri('/dir/link'))).type).toBe(
      vscode.FileType.File | vscode.FileType.SymbolicLink,
    );
    await expect(provider.stat(uri('/nope'))).rejects.toMatchObject({ code: 'FileNotFound' });
  });

  it('reads and writes files honouring create/overwrite flags', async () => {
    expect(dec.decode(await provider.readFile(uri('/dir/a.txt')))).toBe('alpha');
    await expect(provider.readFile(uri('/dir'))).rejects.toMatchObject({ code: 'FileIsADirectory' });

    await provider.writeFile(uri('/dir/a.txt'), enc.encode('ALPHA'), { create: false, overwrite: true });
    expect(await fs.readFile(path.join(server.root, 'dir/a.txt'), 'utf8')).toBe('ALPHA');

    await expect(
      provider.writeFile(uri('/dir/a.txt'), enc.encode('x'), { create: true, overwrite: false }),
    ).rejects.toMatchObject({ code: 'FileExists' });
    await expect(
      provider.writeFile(uri('/dir/new.txt'), enc.encode('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'FileNotFound' });
    await expect(
      provider.writeFile(uri('/missing/new.txt'), enc.encode('x'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'FileNotFound' });

    events.length = 0;
    await provider.writeFile(uri('/dir/new.txt'), enc.encode('new'), { create: true, overwrite: true });
    expect(await fs.readFile(path.join(server.root, 'dir/new.txt'), 'utf8')).toBe('new');
    expect(events.map((e) => [e.type, e.uri.path])).toEqual([
      [vscode.FileChangeType.Created, '/dir/new.txt'],
      [vscode.FileChangeType.Changed, '/dir'],
    ]);
  });

  it('preserves the file mode when overwriting', async () => {
    const local = path.join(server.root, 'dir/a.txt');
    await fs.chmod(local, 0o640);
    await provider.writeFile(uri('/dir/a.txt'), enc.encode('ALPHA'), { create: false, overwrite: true });
    expect((await fs.stat(local)).mode & 0o777).toBe(0o640);
    expect(await fs.readdir(path.join(server.root, 'dir'))).not.toContainEqual(
      expect.stringContaining('.tmp'),
    );
  });

  it('round-trips a multi-megabyte file', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await provider.writeFile(uri('/big.bin'), big, { create: true, overwrite: true });
    const back = Buffer.from(await provider.readFile(uri('/big.bin')));
    expect(back.equals(big)).toBe(true);
  });

  it('creates and deletes directories', async () => {
    await provider.createDirectory(uri('/dir/made'));
    expect((await fs.stat(path.join(server.root, 'dir/made'))).isDirectory()).toBe(true);
    await expect(provider.createDirectory(uri('/dir/made'))).rejects.toMatchObject({ code: 'FileExists' });

    await expect(provider.delete(uri('/dir'), { recursive: false })).rejects.toBeInstanceOf(
      vscode.FileSystemError,
    );
    await provider.delete(uri('/dir/made'), { recursive: false });
    await provider.delete(uri('/dir'), { recursive: true });
    await expect(fs.access(path.join(server.root, 'dir'))).rejects.toThrow();
    expect(events.some((e) => e.type === vscode.FileChangeType.Deleted && e.uri.path === '/dir')).toBe(true);
  });

  it('renames and copies files and directories', async () => {
    await provider.rename(uri('/dir/a.txt'), uri('/dir/renamed.txt'), { overwrite: false });
    expect(await fs.readFile(path.join(server.root, 'dir/renamed.txt'), 'utf8')).toBe('alpha');

    await expect(
      provider.rename(uri('/dir/renamed.txt'), uri('/dir/sub/b.txt'), { overwrite: false }),
    ).rejects.toMatchObject({
      code: 'FileExists',
    });
    await provider.rename(uri('/dir/renamed.txt'), uri('/dir/sub/b.txt'), { overwrite: true });
    expect(await fs.readFile(path.join(server.root, 'dir/sub/b.txt'), 'utf8')).toBe('alpha');

    await provider.copy(uri('/dir'), uri('/copy'), { overwrite: false });
    expect(await fs.readFile(path.join(server.root, 'copy/sub/b.txt'), 'utf8')).toBe('alpha');
    await expect(provider.copy(uri('/dir'), uri('/copy'), { overwrite: false })).rejects.toMatchObject({
      code: 'FileExists',
    });
    await provider.rename(uri('/copy'), uri('/dir'), { overwrite: true });
    expect(await fs.readFile(path.join(server.root, 'dir/sub/b.txt'), 'utf8')).toBe('alpha');
  });

  it('waits for reconnection instead of failing operations issued during an outage', async () => {
    await provider.readDirectory(uri('/'));
    const conn = manager.get('test')!;
    server.kill();
    await waitForState(conn, 'reconnecting');
    const write = provider.writeFile(uri('/during.txt'), enc.encode('saved'), {
      create: true,
      overwrite: true,
    });
    await waitForState(conn, 'connected');
    await write;
    expect(await fs.readFile(path.join(server.root, 'during.txt'), 'utf8')).toBe('saved');
  });

  it('reports Unavailable for unknown connections and after permanent failure', async () => {
    await expect(provider.stat(buildSshUri('ghost', '/'))).rejects.toMatchObject({ code: 'Unavailable' });
    const conn = manager.get('test') ?? manager.getOrCreate('test');
    await conn.connect();
    server.acceptConnections = false;
    server.kill();
    await waitForState(conn, 'failed', 10_000);
    await expect(provider.readDirectory(uri('/'))).rejects.toMatchObject({ code: 'Unavailable' });
  });
});
