import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshFileSystemProvider } from '../../src/fs/sshFileSystemProvider';
import { buildSshUri } from '../../src/fs/uri';
import { ConnectionManager } from '../../src/ssh/connectionManager';
import { shellJoin, shellQuote } from '../../src/ssh/sudo';
import { fakeSudoLog, installFakeSudo } from '../fixtures/fakeSudo';
import { generateEcKeyPair } from '../fixtures/keys';
import { createHarness, writeTempKey, type HarnessOptions } from './harness';
import { SftpTestServer } from './sftpTestServer';

const clientKey = generateEcKeyPair();
const enc = new TextEncoder();
const dec = new TextDecoder();
let server: SftpTestServer;
let sudoDir: string;
let manager: ConnectionManager;
let provider: SshFileSystemProvider;
let prompts: ReturnType<typeof createHarness>['prompts'];
const uri = (p: string) => buildSshUri('test', p);

async function setup(serverEnv: NodeJS.ProcessEnv, harness: Partial<HarnessOptions> = {}) {
  const fake = installFakeSudo();
  sudoDir = fake.dir;
  server = new SftpTestServer({
    authorizedKeys: [clientKey.publicBlob],
    readOnlyPaths: ['/protected'],
    execEnv: { ...fake.env, ...serverEnv },
  });
  await server.start();
  await fs.mkdir(path.join(server.root, 'protected/private'), { recursive: true });
  await fs.writeFile(path.join(server.root, 'protected/docker-compose.yml'), 'version: "3"\n');
  await fs.writeFile(path.join(server.root, 'protected/secret.env'), 'TOKEN=1\n');
  await fs.mkdir(path.join(server.root, 'open'));
  const keyFile = writeTempKey(clientKey.privatePem);
  const h = createHarness(server, {
    identityFiles: [keyFile],
    hostKeyPolicy: 'accept-new',
    sudo: true,
    ...harness,
  });
  prompts = h.prompts;
  manager = new ConnectionManager({ loadProfiles: async () => [h.profile] }, h.deps, {
    networkWatchIntervalMs: 0,
  });
  await manager.refreshProfiles();
  provider = new SshFileSystemProvider(manager, { atomicWrites: () => 'auto', watchPollIntervalMs: () => 0 });
}

afterEach(async () => {
  provider?.dispose();
  manager?.dispose();
  await server?.close();
});

describe('sudo mode', () => {
  describe('with NOPASSWD sudo', () => {
    beforeEach(() => setup({ FAKE_SUDO_NOPASSWD: '1' }));

    it('writes a root-owned file through sudo after SFTP is denied', async () => {
      await provider.writeFile(uri('/protected/docker-compose.yml'), enc.encode('version: "3.9"\n'), {
        create: false,
        overwrite: true,
      });
      expect(await fs.readFile(path.join(server.root, 'protected/docker-compose.yml'), 'utf8')).toBe(
        'version: "3.9"\n',
      );
      expect(prompts.sudo).toBe(0);
      const log = fakeSudoLog(sudoDir);
      expect(
        log.some((l) =>
          /^fake-sudo n cp -- .*\.ssh-explorer-.*\.tmp .*protected\/docker-compose\.yml$/.test(l),
        ),
      ).toBe(true);
      // The temp upload is cleaned up.
      const home = await fs.readdir(server.root);
      expect(home.filter((n) => n.includes('.ssh-explorer-'))).toEqual([]);
    });

    it('creates, reads, renames, copies and deletes inside a protected directory', async () => {
      await provider.createDirectory(uri('/protected/newdir'));
      expect((await fs.stat(path.join(server.root, 'protected/newdir'))).isDirectory()).toBe(true);
      await expect(provider.createDirectory(uri('/protected/newdir'))).rejects.toMatchObject({
        code: 'FileExists',
      });

      await provider.writeFile(uri('/protected/newdir/a.txt'), enc.encode('A'), {
        create: true,
        overwrite: true,
      });
      expect(dec.decode(await provider.readFile(uri('/protected/secret.env')))).toBe('TOKEN=1\n');

      await provider.rename(uri('/protected/newdir/a.txt'), uri('/protected/newdir/b.txt'), {
        overwrite: false,
      });
      await expect(
        provider.rename(uri('/protected/newdir/b.txt'), uri('/protected/docker-compose.yml'), {
          overwrite: false,
        }),
      ).rejects.toMatchObject({ code: 'FileExists' });
      await provider.copy(uri('/protected/newdir'), uri('/protected/copied'), { overwrite: false });
      expect(await fs.readFile(path.join(server.root, 'protected/copied/b.txt'), 'utf8')).toBe('A');

      await expect(provider.delete(uri('/protected/newdir'), { recursive: false })).rejects.toBeInstanceOf(
        vscode.FileSystemError,
      );
      await provider.delete(uri('/protected/newdir'), { recursive: true });
      await provider.delete(uri('/protected/copied'), { recursive: true });
      await expect(fs.access(path.join(server.root, 'protected/newdir'))).rejects.toThrow();
    });

    it('does not use sudo when SFTP succeeds', async () => {
      await provider.writeFile(uri('/open/x.txt'), enc.encode('x'), { create: true, overwrite: true });
      expect(fakeSudoLog(sudoDir)).toEqual([]);
    });

    it('maps missing files and directories to FileNotFound through sudo', async () => {
      await expect(
        provider.writeFile(uri('/protected/missing/x.txt'), enc.encode('x'), {
          create: true,
          overwrite: true,
        }),
      ).rejects.toMatchObject({ code: 'FileNotFound' });
    });
  });

  describe('with a sudo password', () => {
    it('asks once, retries a wrong password and reuses the good one', async () => {
      await setup({ FAKE_SUDO_PASSWORD: 'hunter2' }, { sudoPasswords: ['wrong', 'hunter2'] });
      await provider.writeFile(uri('/protected/docker-compose.yml'), enc.encode('a\n'), {
        create: false,
        overwrite: true,
      });
      expect(prompts.sudo).toBe(2);
      await provider.writeFile(uri('/protected/docker-compose.yml'), enc.encode('b\n'), {
        create: false,
        overwrite: true,
      });
      expect(prompts.sudo).toBe(2);
      expect(await fs.readFile(path.join(server.root, 'protected/docker-compose.yml'), 'utf8')).toBe('b\n');
      const log = fakeSudoLog(sudoDir);
      expect(log[0]).toMatch(/^fake-sudo n /); // tried passwordless first
      expect(log.filter((l) => l.startsWith('fake-sudo S')).length).toBeGreaterThanOrEqual(2);
    });

    it('fails with NoPermissions when the prompt is cancelled', async () => {
      await setup({ FAKE_SUDO_PASSWORD: 'hunter2' }, { sudoPasswords: [] });
      await expect(
        provider.writeFile(uri('/protected/docker-compose.yml'), enc.encode('a\n'), {
          create: false,
          overwrite: true,
        }),
      ).rejects.toMatchObject({ code: 'NoPermissions' });
      expect(prompts.sudo).toBe(1);
    });
  });

  it('keeps reporting NoPermissions when sudo mode is off', async () => {
    await setup({ FAKE_SUDO_NOPASSWD: '1' }, { sudo: false });
    await expect(
      provider.writeFile(uri('/protected/docker-compose.yml'), enc.encode('a\n'), {
        create: false,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(fakeSudoLog(sudoDir)).toEqual([]);
  });
});

describe('shell quoting', () => {
  it('quotes arbitrary arguments safely', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellJoin(['cp', '--', '/a b', "/c'd"])).toBe(`'cp' '--' '/a b' '/c'\\''d'`);
  });
});
