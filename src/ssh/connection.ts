import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { Deferred, TimeoutError, withTimeout } from '../util/deferred';
import type { IDisposable } from '../util/disposable';
import { Emitter, type Event } from '../util/event';
import { errorMessage, Logger } from '../util/logger';
import { Semaphore } from '../util/semaphore';
import type { AgentResolver } from './agentResolver';
import {
  AuthSession,
  planAuth,
  type AuthPrompter,
  type CredentialCache,
  type SaveSecretsPolicy,
  type SecretStore,
} from './auth';
import { backoffDelay } from './backoff';
import { ConnectionUnavailableError, classifyError, isTransportError } from './errors';
import { createHostVerifier, type HostKeyPolicy, type HostKeyPrompter } from './hostVerifier';
import type { KnownHosts } from './knownHosts';
import { openJumpChain, type JumpChain } from './proxyJump';
import { SudoRunner, type SudoPrompter } from './sudo';
import type { ConnectionProfile, ConnectionSettings, ConnectionState, ResolvedHost } from './types';

export interface ConnectionDeps {
  /** Re-run on every attempt so config edits are picked up. */
  resolveHost(profile: ConnectionProfile): Promise<ResolvedHost>;
  agentResolver: AgentResolver;
  knownHosts: KnownHosts;
  knownHostsWriteFile(): string;
  hashNewKnownHosts(): boolean;
  hostKeyPolicy(): HostKeyPolicy;
  hostKeyPrompter: HostKeyPrompter;
  authPrompter: AuthPrompter;
  secrets?: SecretStore;
  saveSecretsPolicy(): SaveSecretsPolicy;
  settings(): ConnectionSettings;
  sudoPrompter: SudoPrompter;
  /** Privilege escalation binary (normally `sudo`). */
  sudoCommand(): string;
}

export interface StateChange {
  state: ConnectionState;
  previous: ConnectionState;
  error?: Error;
}

export interface ExecOptions {
  /** Bytes written to the command's stdin before it is closed. */
  stdin?: Buffer;
  timeoutMs?: number;
  /** Abort if stdout grows beyond this many bytes (default 256 MiB). */
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  /** Exit code, or null when the command was killed by a signal. */
  code: number | null;
  signal?: string;
}

export interface WithSftpOptions {
  /** Retry once on a fresh channel when the transport died mid-operation. */
  idempotent?: boolean;
  timeoutMs?: number;
}

/**
 * One SSH connection with an SFTP channel. Reconnects automatically after
 * transport failures; operations issued while reconnecting wait for the new
 * channel instead of failing.
 */
export class Connection implements IDisposable {
  private _state: ConnectionState = 'disconnected';
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;
  private sftpOpening: Promise<SFTPWrapper> | undefined;
  private jump: JumpChain | undefined;
  private connectPromise: Promise<void> | undefined;
  private waiters: Deferred<SFTPWrapper>[] = [];
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private manualDisconnect = false;
  private disposed = false;
  private lastActivity = 0;
  private resolvedHost: ResolvedHost | undefined;
  private readonly semaphore: Semaphore;
  private readonly credentials: CredentialCache = { passphrases: new Map() };
  private readonly stateEmitter = new Emitter<StateChange>();
  private readonly log: Logger;

  lastError: Error | undefined;
  readonly onDidChangeState: Event<StateChange> = this.stateEmitter.event;
  /** Runs commands as root over this connection (used when profile.sudo is enabled). */
  readonly sudo: SudoRunner;

  constructor(
    readonly profile: ConnectionProfile,
    private readonly deps: ConnectionDeps,
  ) {
    this.log = new Logger(`conn:${profile.name}`);
    this.semaphore = new Semaphore(deps.settings().maxConcurrentOps);
    this.sudo = new SudoRunner(this, {
      prompter: deps.sudoPrompter,
      secrets: deps.secrets,
      saveSecretsPolicy: () => deps.saveSecretsPolicy(),
      command: () => deps.sudoCommand(),
    });
  }

  get name(): string {
    return this.profile.name;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get host(): ResolvedHost | undefined {
    return this.resolvedHost;
  }

  get reconnectAttempt(): number {
    return this.attempt;
  }

  /** Connects (or returns the in-flight attempt). Resolves when the SFTP channel is ready. */
  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new ConnectionUnavailableError('Connection disposed', this.name));
    }
    if (this._state === 'connected' && this.sftp) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    if (this._state !== 'reconnecting') {
      this.attempt = 0;
      this.setState('connecting');
    }
    this.connectPromise = this.attemptConnect()
      .then(() => undefined)
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  /** User-initiated: stops auto-reconnect and closes the transport. */
  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.attempt = 0;
    const wasConnecting = this.connectPromise;
    this.teardown();
    this.rejectWaiters(new ConnectionUnavailableError('Disconnected', this.name));
    this.setState('disconnected');
    await wasConnecting?.catch(() => undefined);
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Returns a live SFTP channel, waiting through (re)connection. Rejects with
   * ConnectionUnavailableError when the connection failed permanently or the wait times out.
   */
  async getSftp(timeoutMs: number = this.deps.settings().operationTimeoutMs): Promise<SFTPWrapper> {
    if (this.disposed) throw new ConnectionUnavailableError('Connection disposed', this.name);
    if (this._state === 'connected' && this.client) {
      if (this.sftp) {
        if (
          Date.now() - this.lastActivity > this.deps.settings().idleProbeAfterMs &&
          !(await this.probeSftp(this.sftp))
        ) {
          this.log.info('Idle SFTP channel is unresponsive; reopening');
          this.dropSftp();
        } else {
          this.touch();
          return this.sftp;
        }
      }
      if (!this.sftp) {
        try {
          return await this.openSftp(this.client);
        } catch (err) {
          this.log.warn(`Cannot reopen SFTP channel: ${errorMessage(err)}; reconnecting`);
          this.handleTransportLoss(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    if (this._state === 'failed') {
      throw new ConnectionUnavailableError(
        `Connection ${this.name} failed: ${this.lastError?.message ?? 'unknown error'}`,
        this.name,
        this.lastError,
      );
    }
    if (this._state === 'disconnected') {
      void this.connect().catch(() => undefined);
    }
    const waiter = new Deferred<SFTPWrapper>();
    this.waiters.push(waiter);
    try {
      return await withTimeout(waiter.promise, timeoutMs, `Timed out waiting for connection ${this.name}`);
    } catch (err) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      if (err instanceof TimeoutError) {
        throw new ConnectionUnavailableError(err.message, this.name, this.lastError);
      }
      throw err;
    }
  }

  /** Runs `fn` with a live channel under the concurrency limit. */
  async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>, options: WithSftpOptions = {}): Promise<T> {
    return this.semaphore.run(async () => {
      const first = await this.getSftp(options.timeoutMs);
      try {
        const result = await fn(first);
        this.touch();
        return result;
      } catch (err) {
        if (!isTransportError(err)) throw err;
        this.log.debug(`Transport error during operation: ${errorMessage(err)}`);
        if (this.sftp === first) this.dropSftp();
        if (!options.idempotent) throw err;
        const second = await this.getSftp(options.timeoutMs);
        const result = await fn(second);
        this.touch();
        return result;
      }
    });
  }

  /**
   * Runs a command on the remote host over an exec channel of this SSH session
   * (same connection the SFTP channel uses; no new authentication). Waits for
   * (re)connection like getSftp and counts against the concurrency limit.
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.semaphore.run(async () => {
      await this.getSftp(options.timeoutMs);
      const client = this.client;
      if (!client) throw new ConnectionUnavailableError('Not connected', this.name);
      return withTimeout(
        new Promise<ExecResult>((resolve, reject) => {
          client.exec(command, (err, channel) => {
            if (err) {
              reject(err);
              return;
            }
            const out: Buffer[] = [];
            const errChunks: Buffer[] = [];
            let outBytes = 0;
            const limit = options.maxOutputBytes ?? 256 * 1024 * 1024;
            let code: number | null = null;
            let signal: string | undefined;
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              if (error) reject(error);
              else {
                resolve({
                  stdout: Buffer.concat(out),
                  stderr: Buffer.concat(errChunks).toString('utf8'),
                  code,
                  signal,
                });
              }
            };
            channel.on('data', (chunk: Buffer) => {
              outBytes += chunk.length;
              if (outBytes > limit) {
                channel.close();
                finish(new Error(`Command output exceeded ${limit} bytes`));
                return;
              }
              out.push(chunk);
            });
            channel.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
            channel.on('exit', (c: number | null, sig?: string) => {
              code = c;
              signal = sig;
            });
            channel.on('close', () => finish());
            channel.on('error', (e: Error) => finish(e));
            if (options.stdin && options.stdin.length > 0) channel.end(options.stdin);
            else channel.end();
          });
        }),
        options.timeoutMs ?? this.deps.settings().operationTimeoutMs,
        `Remote command timed out: ${command.slice(0, 80)}`,
      );
    });
  }

  /** Cheap liveness check; forces an immediate reconnect when it fails. Used after network changes. */
  async probe(): Promise<boolean> {
    if (this._state !== 'connected' || !this.sftp) return this._state === 'connected';
    const alive = await this.probeSftp(this.sftp);
    if (!alive) {
      this.log.info('Liveness probe failed; reconnecting now');
      this.attempt = 0;
      this.handleTransportLoss(new Error('Liveness probe failed'));
    }
    return alive;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.disconnect();
    this.stateEmitter.dispose();
  }

  // ---- internals -----------------------------------------------------------

  private async attemptConnect(): Promise<void> {
    const settings = this.deps.settings();
    this.semaphore.setLimit(settings.maxConcurrentOps);
    try {
      const host = await this.deps.resolveHost(this.profile);
      this.resolvedHost = host;
      const config = await this.buildConfig(host, this.attempt === 0);
      if (host.proxyJump) {
        this.jump = await openJumpChain(host, (hop) => this.buildConfig(hop, this.attempt === 0));
        config.sock = this.jump.sock;
      }
      const client = new Client();
      this.client = client;
      await this.handshake(client, config);
      if (this.client !== client) return; // disconnected meanwhile
      this.wireClientEvents(client);
      await this.openSftp(client);
      await this.pendingAuth?.commitSuccess();
      this.pendingAuth = undefined;
      this.attempt = 0;
      this.lastError = undefined;
      this.setState('connected');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.teardown();
      if (this.manualDisconnect) {
        this.setState('disconnected');
        throw error;
      }
      const kind = classifyError(error);
      this.lastError =
        this.hostKeyError ??
        (this.pendingAuth?.lastError && kind === 'auth' ? this.pendingAuth.lastError : error);
      this.pendingAuth = undefined;
      if (kind === 'auth' || kind === 'hostkey' || kind === 'cancelled') {
        this.fail(this.lastError);
        throw this.lastError;
      }
      // Transport-level failure: surface it to the caller and keep retrying in the background.
      this.scheduleReconnect(error);
      throw error;
    }
  }

  private pendingAuth: AuthSession | undefined;
  private hostKeyError: Error | undefined;

  private async buildConfig(host: ResolvedHost, interactive: boolean): Promise<ConnectConfig> {
    const settings = this.deps.settings();
    const agent = await this.deps.agentResolver.resolve(host);
    if (agent) {
      this.log.info(
        `Agent: ${agent.path} (${agent.source}${agent.identities !== undefined ? `, ${agent.identities} identities` : ''})`,
      );
    } else this.log.info('No SSH agent available');

    const isTarget = host === this.resolvedHost;
    const session = new AuthSession({
      host,
      steps: planAuth(host, agent, isTarget ? this.credentials : undefined),
      prompter: this.deps.authPrompter,
      secrets: this.deps.secrets,
      savePolicy: this.deps.saveSecretsPolicy(),
      cache: isTarget ? this.credentials : { passphrases: new Map() },
      interactive,
    });
    if (isTarget) this.pendingAuth = session;

    const verification = createHostVerifier(host, {
      knownHosts: this.deps.knownHosts,
      writeFile: this.deps.knownHostsWriteFile(),
      hashNewEntries: this.deps.hashNewKnownHosts(),
      policy: this.deps.hostKeyPolicy(),
      prompter: this.deps.hostKeyPrompter,
    });
    this.hostKeyError = undefined;
    const verifier: ConnectConfig['hostVerifier'] = (key: Buffer, cb: (ok: boolean) => void) => {
      verification.verifier(key, (ok) => {
        if (!ok && isTarget) this.hostKeyError = verification.error;
        cb(ok);
      });
    };

    return {
      host: host.hostName,
      port: host.port,
      username: host.user,
      agent: agent?.path,
      agentForward: host.agentForward && Boolean(agent),
      authHandler: session.handler,
      hostVerifier: verifier,
      keepaliveInterval: this.profile.keepaliveInterval ?? settings.keepaliveIntervalMs,
      keepaliveCountMax: settings.keepaliveCountMax,
      readyTimeout: settings.readyTimeoutMs,
      tryKeyboard: true,
    };
  }

  private handshake(client: Client, config: ConnectConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        client.off('ready', onReady);
        reject(err);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      this.log.info(
        `Connecting to ${config.username ?? ''}@${config.host ?? ''}:${config.port ?? 22}${config.sock ? ' via jump host' : ''}`,
      );
      try {
        client.connect(config);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private wireClientEvents(client: Client): void {
    client.on('error', (err) => {
      if (this.client !== client) return;
      this.log.warn(`Transport error: ${err.message}`);
      this.lastError = err;
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.log.info('Transport closed');
      this.handleTransportLoss(this.lastError ?? new Error('Connection closed'));
    });
    client.on('end', () => {
      if (this.client !== client) return;
      this.log.debug('Transport ended');
    });
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp);
    if (this.sftpOpening) return this.sftpOpening;
    this.sftpOpening = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        if (this.client !== client) {
          sftp.end();
          reject(new ConnectionUnavailableError('Connection changed while opening SFTP', this.name));
          return;
        }
        this.sftp = sftp;
        this.touch();
        const onGone = (reason: string) => {
          if (this.sftp !== sftp) return;
          this.log.info(`SFTP channel ${reason}`);
          this.sftp = undefined;
        };
        sftp.on('close', () => onGone('closed'));
        sftp.on('end', () => onGone('ended'));
        sftp.on('error', (e: Error) => this.log.debug(`SFTP channel error: ${e.message}`));
        this.log.debug('SFTP channel open');
        this.resolveWaiters(sftp);
        resolve(sftp);
      });
    }).finally(() => {
      this.sftpOpening = undefined;
    });
    return this.sftpOpening;
  }

  private probeSftp(sftp: SFTPWrapper): Promise<boolean> {
    return withTimeout(
      new Promise<boolean>((resolve) => {
        try {
          sftp.realpath('.', (err) => resolve(!err || !isTransportError(err)));
        } catch {
          resolve(false);
        }
      }),
      5_000,
    ).catch(() => false);
  }

  private dropSftp(): void {
    const sftp = this.sftp;
    this.sftp = undefined;
    try {
      sftp?.end();
    } catch {
      // ignore
    }
  }

  private handleTransportLoss(error: Error): void {
    if (this.disposed || this.manualDisconnect) return;
    if (this._state !== 'connected' && this._state !== 'reconnecting') return;
    this.teardown();
    this.scheduleReconnect(error);
  }

  private scheduleReconnect(error: Error): void {
    if (this.disposed || this.manualDisconnect) return;
    const settings = this.deps.settings();
    this.attempt++;
    this.lastError = error;
    if (this.attempt > settings.reconnectMaxAttempts) {
      this.fail(
        new Error(`Gave up after ${settings.reconnectMaxAttempts} reconnection attempts: ${error.message}`),
      );
      return;
    }
    const delay =
      this.attempt === 1 && this._state === 'connected'
        ? 0
        : backoffDelay(this.attempt, {
            initialMs: settings.reconnectInitialDelayMs,
            maxMs: settings.reconnectMaxDelayMs,
          });
    this.setState('reconnecting', error);
    this.log.info(
      `Reconnect attempt ${this.attempt}/${settings.reconnectMaxAttempts} in ${delay} ms (${error.message})`,
    );
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed || this.manualDisconnect) return;
      if (this.connectPromise) return;
      this.connectPromise = this.attemptConnect()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.connectPromise = undefined;
        });
    }, delay);
  }

  private fail(error: Error): void {
    this.lastError = error;
    this.teardown();
    this.rejectWaiters(
      new ConnectionUnavailableError(`Connection ${this.name} failed: ${error.message}`, this.name, error),
    );
    this.setState('failed', error);
  }

  private teardown(): void {
    this.clearReconnectTimer();
    const client = this.client;
    this.client = undefined;
    this.dropSftp();
    if (client) {
      try {
        client.removeAllListeners();
        // Late socket errors (e.g. ECONNRESET after a kill) must not become unhandled exceptions.
        client.on('error', () => undefined);
        client.end();
      } catch {
        // ignore
      }
    }
    try {
      this.jump?.close();
    } catch {
      // ignore
    }
    this.jump = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private resolveWaiters(sftp: SFTPWrapper): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve(sftp);
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(error);
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private setState(state: ConnectionState, error?: Error): void {
    if (this._state === state && !error) return;
    const previous = this._state;
    this._state = state;
    this.log.debug(`State ${previous} -> ${state}`);
    this.stateEmitter.fire({ state, previous, error });
  }
}
