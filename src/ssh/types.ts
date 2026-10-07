export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ProfileSource = 'settings' | 'sshConfig';

/** A connection as configured by the user (settings) or discovered in ~/.ssh/config. */
export interface ConnectionProfile {
  /** URI authority; must match /^[a-z0-9._-]+$/i. */
  name: string;
  host: string;
  port?: number;
  user?: string;
  /** Initial remote directory. Defaults to the remote home directory. */
  root?: string;
  identityFile?: string[];
  /** Explicit agent socket path; `false` disables agent authentication. */
  agent?: string | false;
  agentForward?: boolean;
  /** `[user@]host[:port]` or an ssh_config alias; comma-separated for multiple hops. */
  proxyJump?: string;
  keepaliveInterval?: number;
  source: ProfileSource;
}

/** Profile after ssh_config has been applied and tokens expanded. */
export interface ResolvedHost {
  profile: ConnectionProfile;
  hostName: string;
  port: number;
  user: string;
  /** Existing identity files only, absolute paths. */
  identityFiles: string[];
  /** Expanded IdentityAgent value: a path, or 'none' to disable. */
  identityAgent?: string;
  agentForward: boolean;
  proxyJump?: ResolvedHost;
  /** Directives present in ssh_config that this extension does not support. */
  unsupported: string[];
}

export type AgentSource = 'profile' | 'identityAgent' | 'env' | 'probe';

export interface AgentCandidate {
  path: string;
  source: AgentSource;
  /** Whether the path exists and is a UNIX socket. */
  isSocket: boolean;
  /** Number of identities, when the agent answered. */
  identities?: number;
  error?: string;
}

export type HostKeyVerdict = 'match' | 'unknown' | 'mismatch';

export interface ConnectionSettings {
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  readyTimeoutMs: number;
  reconnectMaxAttempts: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  operationTimeoutMs: number;
  maxConcurrentOps: number;
  /** Re-check an SFTP channel that has been idle longer than this before reusing it. */
  idleProbeAfterMs: number;
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 3,
  readyTimeoutMs: 20_000,
  reconnectMaxAttempts: 10,
  reconnectInitialDelayMs: 1_000,
  reconnectMaxDelayMs: 30_000,
  operationTimeoutMs: 30_000,
  maxConcurrentOps: 8,
  idleProbeAfterMs: 60_000,
};
