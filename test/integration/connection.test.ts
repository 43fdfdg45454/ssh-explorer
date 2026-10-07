import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Connection } from '../../src/ssh/connection';
import { ConnectionUnavailableError, HostKeyError } from '../../src/ssh/errors';
import { fingerprintSha256 } from '../../src/ssh/knownHosts';
import { FakeAgent } from '../fixtures/fakeAgent';
import { generateEcKeyPair } from '../fixtures/keys';
import { createHarness, waitForState, writeTempKey } from './harness';
import { SftpTestServer } from './sftpTestServer';

const clientKey = generateEcKeyPair();
let server: SftpTestServer;
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  server = new SftpTestServer({ authorizedKeys: [clientKey.publicBlob], passwords: { tester: 'secret' } });
  await server.start();
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await server.close();
});

function listRoot(conn: Connection): Promise<string[]> {
  return conn.withSftp(
    (sftp) =>
      new Promise<string[]>((resolve, reject) =>
        sftp.readdir('/', (err, list) => (err ? reject(err) : resolve(list.map((e) => e.filename).sort()))),
      ),
    { idempotent: true },
  );
}

describe('Connection', () => {
  it('authenticates with an identity file and lists the remote directory', async () => {
    await fs.writeFile(path.join(server.root, 'hello.txt'), 'hi');
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());

    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(await listRoot(conn)).toEqual(['hello.txt']);
    expect(h.knownHosts.check('127.0.0.1', server.port, server.hostKey.publicBlob).verdict).toBe('match');
    expect(await fs.readFile(h.knownHostsFile, 'utf8')).toContain(
      `[127.0.0.1]:${server.port} ecdsa-sha2-nistp256`,
    );
  });

  it('authenticates through an SSH agent socket', async () => {
    const agent = new FakeAgent([clientKey.privatePem]);
    await agent.start();
    cleanups.push(() => agent.close());
    const h = createHarness(server, { agentSocket: agent.socketPath, hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());

    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(agent.signRequests).toBeGreaterThan(0);
    expect(h.prompts.password).toBe(0);
  });

  it('asks for a password, retries after a wrong one and caches it for reconnects', async () => {
    const h = createHarness(server, { passwords: ['wrong', 'secret'], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());

    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(h.prompts.password).toBe(2);

    server.kill();
    await waitForState(conn, 'reconnecting');
    await waitForState(conn, 'connected');
    // Silent reconnect: no new prompt, cached password reused.
    expect(h.prompts.password).toBe(2);
    expect(server.authCount).toBe(2);
  });

  it('supports keyboard-interactive', async () => {
    await server.close();
    server = new SftpTestServer({ keyboardAnswer: '123456' });
    await server.start();
    const h = createHarness(server, { keyboardAnswers: [['123456']], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(h.prompts.keyboard).toBe(1);
  });

  it('fails without retrying when authentication is rejected', async () => {
    const h = createHarness(server, { passwords: ['nope', 'nope', 'nope'], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await expect(conn.connect()).rejects.toThrow(/authentication/i);
    expect(conn.state).toBe('failed');
    await expect(conn.getSftp(200)).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('fails when the user cancels the password prompt', async () => {
    const h = createHarness(server, { passwords: [], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await expect(conn.connect()).rejects.toThrow();
    expect(conn.state).toBe('failed');
    expect(h.prompts.password).toBe(1);
  });

  it('reconnects after the transport drops and serves operations issued meanwhile', async () => {
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();
    const states: string[] = [];
    conn.onDidChangeState((c) => states.push(c.state));

    server.kill();
    await waitForState(conn, 'reconnecting');
    // Issued during the gap: must wait for the new channel, not fail.
    const pending = listRoot(conn);
    await fs.writeFile(path.join(server.root, 'after.txt'), 'x');
    await waitForState(conn, 'connected');
    expect(await pending).toEqual(['after.txt']);
    expect(states).toEqual(['reconnecting', 'connected']);
    expect(server.authCount).toBe(2);
  });

  it('keeps retrying with backoff while the server is unreachable, then recovers', async () => {
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();

    server.acceptConnections = false;
    server.kill();
    await waitForState(conn, 'reconnecting');
    await new Promise((r) => setTimeout(r, 300));
    expect(conn.state).toBe('reconnecting');
    expect(conn.reconnectAttempt).toBeGreaterThanOrEqual(2);
    server.acceptConnections = true;
    await waitForState(conn, 'connected', 5_000);
  });

  it('gives up after the configured number of attempts', async () => {
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, {
      identityFiles: [keyFile],
      hostKeyPolicy: 'accept-new',
      settings: { reconnectMaxAttempts: 2, reconnectInitialDelayMs: 10, reconnectMaxDelayMs: 20 },
    });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();
    server.acceptConnections = false;
    server.kill();
    await waitForState(conn, 'failed', 5_000);
    expect(conn.lastError?.message).toMatch(/gave up after 2/i);
  });

  it('reopens the SFTP subsystem when only the channel dies', async () => {
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();
    expect(server.sftpOpenCount).toBe(1);

    server.dropSftpChannels();
    await new Promise((r) => setTimeout(r, 100));
    expect(await listRoot(conn)).toEqual([]);
    expect(conn.state).toBe('connected');
    expect(server.sftpOpenCount).toBe(2);
    expect(server.authCount).toBe(1);
  });

  it('manual disconnect stops auto-reconnect', async () => {
    const keyFile = writeTempKey(clientKey.privatePem);
    const h = createHarness(server, { identityFiles: [keyFile], hostKeyPolicy: 'accept-new' });
    const conn = new Connection(h.profile, h.deps);
    cleanups.push(() => conn.dispose());
    await conn.connect();
    await conn.disconnect();
    expect(conn.state).toBe('disconnected');
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.state).toBe('disconnected');
    await conn.connect();
    expect(conn.state).toBe('connected');
  });

  describe('host keys', () => {
    it('asks on first use and remembers the key', async () => {
      const keyFile = writeTempKey(clientKey.privatePem);
      const h = createHarness(server, {
        identityFiles: [keyFile],
        hostKeyPolicy: 'ask',
        unknownHostDecision: 'save',
      });
      const conn = new Connection(h.profile, h.deps);
      cleanups.push(() => conn.dispose());
      await conn.connect();
      expect(h.prompts.unknownHost).toBe(1);
      await conn.disconnect();
      await conn.connect();
      expect(h.prompts.unknownHost).toBe(1);
    });

    it('accepts once without saving', async () => {
      const keyFile = writeTempKey(clientKey.privatePem);
      const h = createHarness(server, {
        identityFiles: [keyFile],
        hostKeyPolicy: 'ask',
        unknownHostDecision: 'once',
      });
      const conn = new Connection(h.profile, h.deps);
      cleanups.push(() => conn.dispose());
      await conn.connect();
      expect(h.knownHosts.size).toBe(0);
    });

    it('refuses unknown hosts under strict policy and the user rejection', async () => {
      const keyFile = writeTempKey(clientKey.privatePem);
      for (const opts of [
        { hostKeyPolicy: 'yes' as const },
        { hostKeyPolicy: 'ask' as const, unknownHostDecision: 'reject' as const },
      ]) {
        const h = createHarness(server, { identityFiles: [keyFile], ...opts });
        const conn = new Connection(h.profile, h.deps);
        cleanups.push(() => conn.dispose());
        await expect(conn.connect()).rejects.toBeInstanceOf(HostKeyError);
        expect(conn.state).toBe('failed');
      }
    });

    it('refuses a changed host key', async () => {
      const keyFile = writeTempKey(clientKey.privatePem);
      const other = generateEcKeyPair();
      const h = createHarness(server, {
        identityFiles: [keyFile],
        knownHostsText: `[127.0.0.1]:${server.port} ecdsa-sha2-nistp256 ${other.publicBlob.toString('base64')}`,
      });
      const conn = new Connection(h.profile, h.deps);
      cleanups.push(() => conn.dispose());
      const error = await conn.connect().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostKeyError);
      expect((error as HostKeyError).details.verdict).toBe('mismatch');
      expect((error as HostKeyError).message).toContain(fingerprintSha256(server.hostKey.publicBlob));
      expect(h.prompts.unknownHost).toBe(0);
    });
  });
});
