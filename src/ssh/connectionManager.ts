import * as os from 'node:os';
import type { IDisposable } from '../util/disposable';
import { DisposableStore } from '../util/disposable';
import { Emitter, type Event } from '../util/event';
import { Logger } from '../util/logger';
import { Connection, type ConnectionDeps, type StateChange } from './connection';
import type { ConnectionProfile } from './types';

const log = new Logger('manager');

export interface ProfileSource {
  loadProfiles(): Promise<ConnectionProfile[]>;
}

export interface ManagerStateChange extends StateChange {
  connection: Connection;
}

export interface ConnectionManagerOptions {
  /** Interval for the network-change watcher; 0 disables it. */
  networkWatchIntervalMs?: number;
}

/** Owns every Connection, creates them lazily by profile name and watches the network. */
export class ConnectionManager implements IDisposable {
  private profiles = new Map<string, ConnectionProfile>();
  private connections = new Map<string, Connection>();
  private readonly store = new DisposableStore();
  private readonly profilesEmitter = this.store.add(new Emitter<void>());
  private readonly stateEmitter = this.store.add(new Emitter<ManagerStateChange>());
  private networkTimer: NodeJS.Timeout | undefined;
  private networkSignature = '';

  readonly onDidChangeProfiles: Event<void> = this.profilesEmitter.event;
  readonly onDidChangeState: Event<ManagerStateChange> = this.stateEmitter.event;

  constructor(
    private readonly profileSource: ProfileSource,
    private readonly deps: ConnectionDeps,
    options: ConnectionManagerOptions = {},
  ) {
    const interval = options.networkWatchIntervalMs ?? 10_000;
    if (interval > 0) {
      this.networkSignature = networkSignature();
      this.networkTimer = setInterval(() => this.checkNetwork(), interval);
      this.networkTimer.unref?.();
    }
  }

  /**
   * Reloads profiles from settings and ssh_config. Existing connections keep
   * running and receive their updated profile so flags like sudo apply at once.
   */
  async refreshProfiles(): Promise<void> {
    const list = await this.profileSource.loadProfiles();
    this.profiles = new Map(list.map((p) => [p.name.toLowerCase(), p]));
    for (const [key, conn] of this.connections) {
      const updated = this.profiles.get(key);
      if (updated) {
        conn.updateProfile(updated);
      } else if (conn.state === 'disconnected') {
        // Profile disappeared and the connection is idle: drop it.
        conn.dispose();
        this.connections.delete(key);
      }
    }
    this.profilesEmitter.fire();
  }

  listProfiles(): ConnectionProfile[] {
    return [...this.profiles.values()];
  }

  getProfile(name: string): ConnectionProfile | undefined {
    return this.profiles.get(name.toLowerCase());
  }

  /** Existing connection, if any (does not create one). */
  get(name: string): Connection | undefined {
    return this.connections.get(name.toLowerCase());
  }

  /** Connection for a known profile, created on first use (not connected yet). */
  getOrCreate(name: string): Connection {
    const key = name.toLowerCase();
    const existing = this.connections.get(key);
    if (existing) return existing;
    const profile = this.profiles.get(key);
    if (!profile) {
      throw new Error(
        `Unknown SSH connection "${name}". Add it to sshExplorer.connections or ~/.ssh/config.`,
      );
    }
    const conn = new Connection(profile, this.deps);
    conn.onDidChangeState((change) => this.stateEmitter.fire({ ...change, connection: conn }));
    this.connections.set(key, conn);
    return conn;
  }

  /** Register an ad-hoc profile (e.g. entered in a quick pick) without persisting it. */
  addTransientProfile(profile: ConnectionProfile): void {
    this.profiles.set(profile.name.toLowerCase(), profile);
    this.profilesEmitter.fire();
  }

  connections_(): Connection[] {
    return [...this.connections.values()];
  }

  get activeConnections(): Connection[] {
    return this.connections_().filter((c) => c.state !== 'disconnected');
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.connections_().map((c) => c.disconnect()));
  }

  /** Force a liveness probe on all connected connections (e.g. after resume). */
  async probeAll(): Promise<void> {
    await Promise.all(this.connections_().map((c) => c.probe().catch(() => false)));
  }

  private checkNetwork(): void {
    const sig = networkSignature();
    if (sig === this.networkSignature) return;
    log.info('Network interfaces changed; probing connections');
    this.networkSignature = sig;
    void this.probeAll();
  }

  dispose(): void {
    if (this.networkTimer) clearInterval(this.networkTimer);
    for (const conn of this.connections.values()) conn.dispose();
    this.connections.clear();
    this.store.dispose();
  }
}

/** Stable fingerprint of the non-internal network addresses. */
export function networkSignature(): string {
  const parts: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      parts.push(`${name}:${a.address}`);
    }
  }
  return parts.sort().join('|');
}
