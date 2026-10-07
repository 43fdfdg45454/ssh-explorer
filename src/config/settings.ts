import * as vscode from 'vscode';
import { CONFIG_SECTION, PROFILE_NAME_PATTERN } from '../constants';
import type { AtomicWritesMode } from '../fs/sshFileSystemProvider';
import { expandPath, sshDir } from '../platform/paths';
import { DEFAULT_PROBE_PATHS } from '../ssh/agentResolver';
import type { SaveSecretsPolicy } from '../ssh/auth';
import type { HostKeyPolicy } from '../ssh/hostVerifier';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionProfile, type ConnectionSettings } from '../ssh/types';
import * as path from 'node:path';

/** Raw shape of one entry in `sshExplorer.connections`. */
export interface ConnectionSetting {
  name: string;
  host: string;
  port?: number;
  user?: string;
  root?: string;
  identityFile?: string[] | string;
  agent?: string | boolean;
  agentForward?: boolean;
  proxyJump?: string;
  keepaliveInterval?: number;
  sudo?: boolean;
}

/** Typed, lazily-read access to the extension's configuration. */
export class Settings {
  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  connections(): ConnectionProfile[] {
    const raw = this.cfg.get<ConnectionSetting[]>('connections', []);
    const out: ConnectionProfile[] = [];
    for (const c of raw) {
      if (!c || typeof c.name !== 'string' || typeof c.host !== 'string') continue;
      if (!PROFILE_NAME_PATTERN.test(c.name)) continue;
      out.push({
        name: c.name,
        host: c.host,
        port: typeof c.port === 'number' ? c.port : undefined,
        user: c.user || undefined,
        root: c.root || undefined,
        identityFile: Array.isArray(c.identityFile)
          ? c.identityFile
          : c.identityFile
            ? [c.identityFile]
            : undefined,
        agent: c.agent === false ? false : typeof c.agent === 'string' && c.agent ? c.agent : undefined,
        agentForward: c.agentForward,
        proxyJump: c.proxyJump || undefined,
        keepaliveInterval: typeof c.keepaliveInterval === 'number' ? c.keepaliveInterval : undefined,
        sudo: c.sudo === true,
        source: 'settings',
      });
    }
    return out;
  }

  async saveConnections(list: ConnectionSetting[]): Promise<void> {
    await this.cfg.update('connections', list, vscode.ConfigurationTarget.Global);
  }

  rawConnections(): ConnectionSetting[] {
    return this.cfg.get<ConnectionSetting[]>('connections', []);
  }

  sshConfigEnabled(): boolean {
    return this.cfg.get<boolean>('sshConfig.enabled', true);
  }

  sshConfigPath(): string {
    return expandPath(this.cfg.get<string>('sshConfig.path', '') || path.join(sshDir(), 'config'));
  }

  knownHostsPath(): string {
    return expandPath(this.cfg.get<string>('knownHosts.path', '') || path.join(sshDir(), 'known_hosts'));
  }

  knownHostsWriteTo(): 'userKnownHosts' | 'extension' {
    return this.cfg.get<'userKnownHosts' | 'extension'>('knownHosts.writeTo', 'userKnownHosts');
  }

  knownHostsHashNewEntries(): boolean {
    return this.cfg.get<boolean>('knownHosts.hashNewEntries', true);
  }

  strictHostKeyChecking(): HostKeyPolicy {
    return this.cfg.get<HostKeyPolicy>('strictHostKeyChecking', 'ask');
  }

  agentProbePaths(): string[] {
    return this.cfg.get<string[]>('agent.probePaths', DEFAULT_PROBE_PATHS);
  }

  agentSocket(): string | undefined {
    return this.cfg.get<string>('agent.socket', '') || undefined;
  }

  sudoCommand(): string {
    return this.cfg.get<string>('sudo.command', '') || 'sudo';
  }

  saveSecrets(): SaveSecretsPolicy {
    return this.cfg.get<SaveSecretsPolicy>('auth.saveSecrets', 'ask');
  }

  atomicWrites(): AtomicWritesMode {
    return this.cfg.get<AtomicWritesMode>('atomicWrites', 'auto');
  }

  watchPollIntervalMs(): number {
    return Math.max(0, this.cfg.get<number>('watch.pollIntervalSeconds', 0)) * 1000;
  }

  networkChangeDetection(): boolean {
    return this.cfg.get<boolean>('networkChangeDetection', true);
  }

  connectionSettings(): ConnectionSettings {
    const d = DEFAULT_CONNECTION_SETTINGS;
    const seconds = (key: string, fallbackMs: number) => {
      const v = this.cfg.get<number>(key);
      return typeof v === 'number' && v >= 0 ? v * 1000 : fallbackMs;
    };
    return {
      keepaliveIntervalMs: seconds('keepaliveIntervalSeconds', d.keepaliveIntervalMs),
      keepaliveCountMax: d.keepaliveCountMax,
      readyTimeoutMs: seconds('connectTimeoutSeconds', d.readyTimeoutMs),
      reconnectMaxAttempts: this.cfg.get<number>('reconnect.maxAttempts', d.reconnectMaxAttempts),
      reconnectInitialDelayMs: d.reconnectInitialDelayMs,
      reconnectMaxDelayMs: seconds('reconnect.maxDelaySeconds', d.reconnectMaxDelayMs),
      operationTimeoutMs: seconds('operationTimeoutSeconds', d.operationTimeoutMs),
      maxConcurrentOps: Math.max(1, this.cfg.get<number>('maxConcurrentOps', d.maxConcurrentOps)),
      idleProbeAfterMs: d.idleProbeAfterMs,
    };
  }

  affects(e: vscode.ConfigurationChangeEvent): boolean {
    return e.affectsConfiguration(CONFIG_SECTION);
  }
}
