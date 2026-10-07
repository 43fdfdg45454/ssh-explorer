import * as fs from 'node:fs/promises';
import { createAgent } from 'ssh2';
import { expandPath, xdgRuntimeDir } from '../platform/paths';
import { withTimeout } from '../util/deferred';
import { Logger } from '../util/logger';
import type { AgentCandidate, ResolvedHost } from './types';

const log = new Logger('agent');

/** Well-known agent socket locations, checked when nothing else is configured. */
export const DEFAULT_PROBE_PATHS = [
  '/run/flatpak/ssh-auth',
  '${XDG_RUNTIME_DIR}/ssh-auth',
  '${XDG_RUNTIME_DIR}/keyring/ssh',
  '${XDG_RUNTIME_DIR}/gcr/ssh',
  '${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent.ssh',
  '~/.1password/agent.sock',
];

export interface AgentResolverOptions {
  env?: NodeJS.ProcessEnv;
  probePaths?: string[];
  /** Test seam: returns true when `p` is a UNIX socket. */
  isSocket?: (p: string) => Promise<boolean>;
  /** Test seam: counts identities; undefined = skip the check. */
  countIdentities?: (socketPath: string) => Promise<number>;
  identityTimeoutMs?: number;
}

async function defaultIsSocket(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isSocket();
  } catch {
    return false;
  }
}

function defaultCountIdentities(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const agent = createAgent(socketPath);
      agent.getIdentities((err, keys) => {
        if (err) reject(err);
        else resolve(keys?.length ?? 0);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Finds the SSH agent socket to use for a host. Precedence:
 *   1. profile.agent (explicit path; `false` disables the agent)
 *   2. IdentityAgent from ssh_config (`none` disables)
 *   3. $SSH_AUTH_SOCK
 *   4. well-known socket locations (Flatpak forward, gnome-keyring, gcr, gpg-agent, 1Password)
 */
export class AgentResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly probePaths: string[];
  private readonly isSocket: (p: string) => Promise<boolean>;
  private readonly countIdentities: (p: string) => Promise<number>;
  private readonly identityTimeoutMs: number;

  constructor(options: AgentResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.probePaths = options.probePaths ?? DEFAULT_PROBE_PATHS;
    this.isSocket = options.isSocket ?? defaultIsSocket;
    this.countIdentities = options.countIdentities ?? defaultCountIdentities;
    this.identityTimeoutMs = options.identityTimeoutMs ?? 2000;
  }

  /** Candidates in precedence order for `host`, including ones that do not exist. */
  async candidates(host: ResolvedHost | undefined): Promise<AgentCandidate[]> {
    const list: AgentCandidate[] = [];
    const seen = new Set<string>();
    const push = async (raw: string | undefined, source: AgentCandidate['source']) => {
      if (!raw) return;
      const p = this.expand(raw);
      if (!p || seen.has(p)) return;
      seen.add(p);
      list.push({ path: p, source, isSocket: await this.isSocket(p) });
    };

    if (host?.profile.agent === false || host?.identityAgent === 'none') {
      return list;
    }
    if (typeof host?.profile.agent === 'string') await push(host.profile.agent, 'profile');
    if (host?.identityAgent) await push(host.identityAgent, 'identityAgent');
    await push(this.env.SSH_AUTH_SOCK, 'env');
    for (const probe of this.probePaths) await push(probe, 'probe');
    return list;
  }

  /** First candidate that is a socket and (when it answers) exposes an agent. */
  async resolve(host: ResolvedHost | undefined): Promise<AgentCandidate | undefined> {
    const list = await this.candidates(host);
    for (const candidate of list) {
      if (!candidate.isSocket) continue;
      try {
        candidate.identities = await withTimeout(
          this.countIdentities(candidate.path),
          this.identityTimeoutMs,
          `Agent at ${candidate.path} did not answer`,
        );
        log.debug(`Using agent ${candidate.path} (${candidate.source}, ${candidate.identities} identities)`);
        return candidate;
      } catch (err) {
        candidate.error = err instanceof Error ? err.message : String(err);
        log.debug(`Agent ${candidate.path} rejected: ${candidate.error}`);
        if (candidate.source === 'profile' || candidate.source === 'identityAgent') {
          // Explicitly configured sockets are authoritative: do not fall through silently.
          return candidate;
        }
      }
    }
    return undefined;
  }

  /** Full diagnostic report: every candidate with its status. */
  async diagnose(host?: ResolvedHost): Promise<AgentCandidate[]> {
    const list = await this.candidates(host);
    for (const candidate of list) {
      if (!candidate.isSocket) continue;
      try {
        candidate.identities = await withTimeout(
          this.countIdentities(candidate.path),
          this.identityTimeoutMs,
        );
      } catch (err) {
        candidate.error = err instanceof Error ? err.message : String(err);
      }
    }
    return list;
  }

  private expand(raw: string): string | undefined {
    const env = { ...this.env };
    if (!env.XDG_RUNTIME_DIR) {
      const dir = xdgRuntimeDir();
      if (dir) env.XDG_RUNTIME_DIR = dir;
    }
    const expanded = expandPath(raw, env);
    // Unresolvable variables leave an empty segment; skip such paths.
    if (!expanded || expanded.startsWith('/') === false) return undefined;
    return expanded;
  }
}
