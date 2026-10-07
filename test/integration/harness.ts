import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentResolver } from '../../src/ssh/agentResolver';
import type { AuthPrompter } from '../../src/ssh/auth';
import type { ConnectionDeps } from '../../src/ssh/connection';
import type { HostKeyPrompter, HostKeyPolicy, UnknownHostDecision } from '../../src/ssh/hostVerifier';
import { KnownHosts } from '../../src/ssh/knownHosts';
import {
  DEFAULT_CONNECTION_SETTINGS,
  type ConnectionProfile,
  type ConnectionSettings,
  type ResolvedHost,
} from '../../src/ssh/types';
import { setLogSink } from '../../src/util/logger';
import type { SftpTestServer } from './sftpTestServer';

if (process.env.SSH_EXPLORER_TEST_LOG) {
  const out =
    (level: string) =>
    (message: string | Error, ...args: unknown[]) =>
      console.log(
        `${new Date().toISOString()} ${level} ${message instanceof Error ? message.message : message}`,
        ...args,
      );
  setLogSink({
    trace: out('TRACE'),
    debug: out('DEBUG'),
    info: out('INFO'),
    warn: out('WARN'),
    error: out('ERROR'),
  });
}

export const FAST_SETTINGS: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  keepaliveIntervalMs: 0,
  readyTimeoutMs: 5_000,
  reconnectMaxAttempts: 5,
  reconnectInitialDelayMs: 50,
  reconnectMaxDelayMs: 200,
  operationTimeoutMs: 5_000,
  idleProbeAfterMs: 60_000,
};

export interface HarnessOptions {
  identityFiles?: string[];
  agentSocket?: string | false;
  passwords?: string[];
  keyboardAnswers?: string[][];
  hostKeyPolicy?: HostKeyPolicy;
  unknownHostDecision?: UnknownHostDecision;
  knownHostsText?: string;
  settings?: Partial<ConnectionSettings>;
  user?: string;
  sudo?: boolean;
  sudoPasswords?: string[];
}

export interface Harness {
  deps: ConnectionDeps;
  profile: ConnectionProfile;
  knownHosts: KnownHosts;
  knownHostsFile: string;
  prompts: {
    passphrase: number;
    password: number;
    keyboard: number;
    unknownHost: number;
    save: number;
    sudo: number;
  };
  secrets: Map<string, string>;
}

/** Wires Connection dependencies against a test server with scripted prompts. */
export function createHarness(server: SftpTestServer, o: HarnessOptions = {}): Harness {
  const prompts = { passphrase: 0, password: 0, keyboard: 0, unknownHost: 0, save: 0, sudo: 0 };
  const sudoPasswords = [...(o.sudoPasswords ?? [])];
  const passwords = [...(o.passwords ?? [])];
  const keyboardAnswers = [...(o.keyboardAnswers ?? [])];
  const secrets = new Map<string, string>();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-explorer-kh-'));
  const knownHostsFile = path.join(dir, 'known_hosts');
  const knownHosts = new KnownHosts();
  if (o.knownHostsText !== undefined) knownHosts.loadFromText(o.knownHostsText, knownHostsFile);

  const profile: ConnectionProfile = {
    name: 'test',
    host: '127.0.0.1',
    port: server.port,
    user: o.user ?? 'tester',
    identityFile: o.identityFiles ?? [],
    agent: o.agentSocket ?? false,
    sudo: o.sudo,
    source: 'settings',
  };

  const authPrompter: AuthPrompter = {
    askPassphrase: async () => {
      prompts.passphrase++;
      return undefined;
    },
    askPassword: async () => {
      prompts.password++;
      return passwords.shift();
    },
    askKeyboardInteractive: async () => {
      prompts.keyboard++;
      return keyboardAnswers.shift();
    },
    askSaveSecret: async () => {
      prompts.save++;
      return true;
    },
  };
  const hostKeyPrompter: HostKeyPrompter = {
    confirmUnknownHost: async () => {
      prompts.unknownHost++;
      return o.unknownHostDecision ?? 'save';
    },
  };

  const deps: ConnectionDeps = {
    resolveHost: async (p): Promise<ResolvedHost> => ({
      profile: p,
      hostName: p.host,
      port: p.port ?? 22,
      user: p.user ?? 'tester',
      identityFiles: p.identityFile ?? [],
      agentForward: false,
      unsupported: [],
    }),
    agentResolver: new AgentResolver({ env: {}, probePaths: [] }),
    knownHosts,
    knownHostsWriteFile: () => knownHostsFile,
    hashNewKnownHosts: () => false,
    hostKeyPolicy: () => o.hostKeyPolicy ?? 'ask',
    hostKeyPrompter,
    authPrompter,
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    saveSecretsPolicy: () => 'never',
    settings: () => ({ ...FAST_SETTINGS, ...o.settings }),
    sudoPrompter: {
      askSudoPassword: async () => {
        prompts.sudo++;
        return sudoPasswords.shift();
      },
      askSaveSudoPassword: async () => false,
    },
    sudoCommand: () => 'sudo',
  };
  return { deps, profile, knownHosts, knownHostsFile, prompts, secrets };
}

export function writeTempKey(pem: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-explorer-key-'));
  const file = path.join(dir, 'id_test');
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return file;
}

export function waitForState(
  conn: { state: string; onDidChangeState: (l: (c: { state: string }) => void) => { dispose(): unknown } },
  state: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (conn.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`Timed out waiting for state ${state} (current ${conn.state})`));
    }, timeoutMs);
    const sub = conn.onDidChangeState((c) => {
      if (c.state === state) {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  });
}
