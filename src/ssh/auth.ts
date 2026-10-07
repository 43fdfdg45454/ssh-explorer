import * as fs from 'node:fs/promises';
import type { AnyAuthMethod, AuthHandlerMiddleware, AuthenticationType, Prompt } from 'ssh2';
import { utils } from 'ssh2';
import { Logger } from '../util/logger';
import { CancelledError } from './errors';
import type { AgentCandidate, ResolvedHost } from './types';

const log = new Logger('auth');

export interface AuthPrompter {
  askPassphrase(keyPath: string, host: ResolvedHost): Promise<string | undefined>;
  askPassword(host: ResolvedHost, attempt: number): Promise<string | undefined>;
  askKeyboardInteractive(
    host: ResolvedHost,
    name: string,
    instructions: string,
    prompts: Prompt[],
  ): Promise<string[] | undefined>;
  /** Called after a successful login with a freshly entered secret. */
  askSaveSecret(kind: 'password' | 'passphrase', host: ResolvedHost): Promise<boolean>;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SaveSecretsPolicy = 'ask' | 'always' | 'never';

export type AuthStep =
  | { type: 'none' }
  | { type: 'agent'; socket: string }
  | { type: 'publickey'; keyPath: string }
  | { type: 'password' }
  | { type: 'keyboard-interactive' };

export function secretKey(kind: 'password' | 'passphrase', host: ResolvedHost, keyPath?: string): string {
  return kind === 'password'
    ? `password:${host.user}@${host.hostName}:${host.port}`
    : `passphrase:${keyPath ?? ''}`;
}

/** Secrets that worked for a connection; reused on silent reconnects. */
export interface CredentialCache {
  password?: string;
  passphrases: Map<string, string>;
  /** Successful method of the last login, tried first next time. */
  lastMethod?: AuthStep['type'];
}

export function planAuth(
  host: ResolvedHost,
  agent: AgentCandidate | undefined,
  cache?: CredentialCache,
): AuthStep[] {
  const steps: AuthStep[] = [{ type: 'none' }];
  if (
    agent?.isSocket &&
    (agent.identities === undefined || agent.identities > 0 || agent.source !== 'probe')
  ) {
    steps.push({ type: 'agent', socket: agent.path });
  }
  for (const keyPath of host.identityFiles) steps.push({ type: 'publickey', keyPath });
  steps.push({ type: 'password' }, { type: 'keyboard-interactive' });
  if (cache?.lastMethod && cache.lastMethod !== 'none') {
    const idx = steps.findIndex((s) => s.type === cache.lastMethod);
    if (idx > 1) {
      const [preferred] = steps.splice(idx, 1);
      steps.splice(1, 0, preferred!);
    }
  }
  return steps;
}

export interface AuthSessionOptions {
  host: ResolvedHost;
  steps: AuthStep[];
  prompter: AuthPrompter;
  secrets?: SecretStore;
  savePolicy: SaveSecretsPolicy;
  cache: CredentialCache;
  /** When false, no prompt is ever shown (silent reconnect); cached/stored secrets only. */
  interactive: boolean;
  maxPasswordAttempts?: number;
}

/**
 * Drives ssh2's `authHandler` through the planned steps, prompting the user as
 * needed and remembering what worked.
 */
export class AuthSession {
  private index = 0;
  private passwordAttempts = 0;
  private current: AuthStep | undefined;
  private enteredNow = new Set<string>();
  private readonly maxPasswordAttempts: number;
  /** Set when the user cancelled a prompt. */
  cancelled = false;
  lastError: Error | undefined;

  constructor(private readonly o: AuthSessionOptions) {
    this.maxPasswordAttempts = o.maxPasswordAttempts ?? 3;
  }

  get lastStep(): AuthStep | undefined {
    return this.current;
  }

  /** The ssh2 middleware. */
  readonly handler: AuthHandlerMiddleware = (authsLeft, _partialSuccess, next) => {
    void this.nextMethod(authsLeft)
      .then((method) => {
        if (method === false) {
          (next as unknown as (m: false) => void)(false);
        } else {
          next(method);
        }
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Authentication aborted: ${this.lastError.message}`);
        (next as unknown as (m: false) => void)(false);
      });
  };

  private async nextMethod(authsLeft: AuthenticationType[] | null): Promise<AnyAuthMethod | false> {
    // Some servers answer a failure with an empty method list; treat that as "unknown", not "nothing".
    const allowed = authsLeft && authsLeft.length > 0 ? new Set<AuthenticationType>(authsLeft) : undefined;
    const username = this.o.host.user;

    while (this.index < this.o.steps.length) {
      const step = this.o.steps[this.index]!;
      // Password gets several tries before moving on; everything else is tried once.
      if (step.type !== 'password' || this.passwordAttempts >= this.maxPasswordAttempts) this.index++;
      else this.passwordAttempts++;

      if (step.type === 'password' && this.passwordAttempts > this.maxPasswordAttempts) continue;
      const wire: AuthenticationType = step.type === 'agent' ? 'publickey' : step.type;
      if (allowed && step.type !== 'none' && !allowed.has(wire)) {
        log.debug(`Skipping ${step.type}: server does not offer it`);
        continue;
      }
      this.current = step;

      switch (step.type) {
        case 'none':
          return { type: 'none', username };
        case 'agent':
          log.debug(`Trying agent ${step.socket}`);
          return { type: 'agent', username, agent: step.socket };
        case 'publickey': {
          const method = await this.publicKeyMethod(step.keyPath, username);
          if (method) return method;
          continue;
        }
        case 'password': {
          const password = await this.password();
          if (password === undefined) {
            if (this.cancelled) return false;
            this.index++;
            continue;
          }
          return { type: 'password', username, password };
        }
        case 'keyboard-interactive': {
          if (!this.o.interactive) continue;
          return {
            type: 'keyboard-interactive',
            username,
            prompt: (name, instructions, _lang, prompts, finish) => {
              this.o.prompter
                .askKeyboardInteractive(this.o.host, name, instructions, prompts)
                .then((answers) => {
                  if (!answers) {
                    this.cancelled = true;
                    finish([]);
                  } else {
                    finish(answers);
                  }
                })
                .catch(() => finish([]));
            },
          };
        }
      }
    }
    return false;
  }

  private async publicKeyMethod(keyPath: string, username: string): Promise<AnyAuthMethod | undefined> {
    let data: Buffer;
    try {
      data = await fs.readFile(keyPath);
    } catch (err) {
      log.debug(`Cannot read ${keyPath}: ${String(err)}`);
      return undefined;
    }
    let parsed = utils.parseKey(data);
    if (parsed instanceof Error) {
      if (!/encrypted|passphrase/i.test(parsed.message)) {
        log.debug(`Skipping ${keyPath}: ${parsed.message}`);
        return undefined;
      }
      const passphrase = await this.passphrase(keyPath);
      if (passphrase === undefined) return undefined;
      parsed = utils.parseKey(data, passphrase);
      if (parsed instanceof Error) {
        log.debug(`Wrong passphrase for ${keyPath}`);
        this.o.cache.passphrases.delete(keyPath);
        await this.o.secrets?.delete(secretKey('passphrase', this.o.host, keyPath));
        return undefined;
      }
      this.o.cache.passphrases.set(keyPath, passphrase);
    }
    log.debug(`Trying key ${keyPath}`);
    return { type: 'publickey', username, key: parsed };
  }

  private async passphrase(keyPath: string): Promise<string | undefined> {
    const cached = this.o.cache.passphrases.get(keyPath);
    if (cached !== undefined) return cached;
    const stored = await this.o.secrets?.get(secretKey('passphrase', this.o.host, keyPath));
    if (stored !== undefined) return stored;
    if (!this.o.interactive) return undefined;
    const entered = await this.o.prompter.askPassphrase(keyPath, this.o.host);
    if (entered === undefined) {
      this.cancelled = true;
      throw new CancelledError();
    }
    this.enteredNow.add(secretKey('passphrase', this.o.host, keyPath));
    return entered;
  }

  private async password(): Promise<string | undefined> {
    if (this.passwordAttempts === 1) {
      if (this.o.cache.password !== undefined) return this.o.cache.password;
      const stored = await this.o.secrets?.get(secretKey('password', this.o.host));
      if (stored !== undefined) {
        this.o.cache.password = stored;
        return stored;
      }
    } else {
      // A previous attempt failed: forget what we tried.
      this.o.cache.password = undefined;
      await this.o.secrets?.delete(secretKey('password', this.o.host));
    }
    if (!this.o.interactive) return undefined;
    const entered = await this.o.prompter.askPassword(this.o.host, this.passwordAttempts);
    if (entered === undefined) {
      this.cancelled = true;
      return undefined;
    }
    this.o.cache.password = entered;
    this.enteredNow.add(secretKey('password', this.o.host));
    return entered;
  }

  /** Call once the connection is ready: records the method and persists secrets per policy. */
  async commitSuccess(): Promise<void> {
    const step = this.current;
    if (!step) return;
    this.o.cache.lastMethod = step.type;
    if (!this.o.secrets || this.o.savePolicy === 'never') return;
    for (const key of this.enteredNow) {
      const kind = key.startsWith('password:') ? 'password' : 'passphrase';
      const value =
        kind === 'password'
          ? this.o.cache.password
          : this.o.cache.passphrases.get(key.slice('passphrase:'.length));
      if (value === undefined) continue;
      const save = this.o.savePolicy === 'always' || (await this.o.prompter.askSaveSecret(kind, this.o.host));
      if (save) await this.o.secrets.store(key, value);
    }
    this.enteredNow.clear();
  }
}
