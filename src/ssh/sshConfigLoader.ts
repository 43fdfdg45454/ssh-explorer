import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import SSHConfig from 'ssh-config';
import { expandTilde, homeDir, sshDir } from '../platform/paths';
import { Logger } from '../util/logger';
import type { ConnectionProfile, ResolvedHost } from './types';

const log = new Logger('ssh-config');

/** Directives we can neither honour nor safely ignore (they change how the connection is made). */
const UNSUPPORTED_IMPORTANT = new Set([
  'proxycommand',
  'certificatefile',
  'proxyusefdpass',
  'bindaddress',
  'bindinterface',
]);

const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519_sk', 'id_rsa', 'id_dsa'];

export interface SshConfigLoaderOptions {
  configPath?: string;
  /** Test seam: existence check for identity files. */
  exists?: (p: string) => Promise<boolean>;
  readFile?: (p: string) => Promise<string>;
  readDir?: (p: string) => Promise<string[]>;
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and queries the OpenSSH client configuration. `Include` directives are
 * inlined before parsing (relative paths resolve against ~/.ssh, simple glob
 * patterns in the file name are supported). `Match exec` is never executed.
 */
export class SshConfigLoader {
  private config: SSHConfig = SSHConfig.parse('');
  private hostAliases: string[] = [];
  private readonly exists: (p: string) => Promise<boolean>;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly readDir: (p: string) => Promise<string[]>;
  readonly configPath: string;

  constructor(options: SshConfigLoaderOptions = {}) {
    this.configPath = options.configPath ?? path.join(sshDir(), 'config');
    this.exists = options.exists ?? defaultExists;
    this.readFile = options.readFile ?? ((p) => fs.readFile(p, 'utf8'));
    this.readDir = options.readDir ?? ((p) => fs.readdir(p));
  }

  /** Reads the configuration from disk. A missing file yields an empty config. */
  async load(): Promise<void> {
    let text = '';
    if (await this.exists(this.configPath)) {
      text = await this.inlineIncludes(this.configPath, 0, new Set());
    }
    this.loadFromText(text);
  }

  /** Parses configuration text directly (no Include processing). */
  loadFromText(text: string): void {
    this.config = SSHConfig.parse(text);
    this.hostAliases = this.collectHostAliases(this.config);
  }

  /** Concrete `Host` aliases (no wildcards or negations), in file order. */
  listHosts(): string[] {
    return [...this.hostAliases];
  }

  /**
   * Applies ssh_config to a profile. The profile's own fields win over the file.
   * `hostOverride` is used when resolving ProxyJump targets given as user@host:port.
   */
  async resolve(profile: ConnectionProfile, depth = 0): Promise<ResolvedHost> {
    const query = profile.user ? { Host: profile.host, User: profile.user } : { Host: profile.host };
    const computed = this.config.compute(query, { ignoreCase: true, matchExec: false });

    const get = (key: string): string | undefined => {
      const v = computed[key];
      if (Array.isArray(v)) return v[0];
      return v;
    };
    const getAll = (key: string): string[] => {
      const v = computed[key];
      if (Array.isArray(v)) return v;
      return v === undefined ? [] : [v];
    };

    const hostName = get('hostname') ?? profile.host;
    const port = profile.port ?? parsePort(get('port')) ?? 22;
    const user = profile.user ?? get('user') ?? os.userInfo().username;
    const tokens = { host: profile.host, hostName, user, port };

    const identityCandidates = (
      profile.identityFile && profile.identityFile.length > 0
        ? profile.identityFile
        : getAll('identityfile').length > 0
          ? getAll('identityfile')
          : DEFAULT_IDENTITY_FILES.map((f) => path.join(sshDir(), f))
    ).map((f) => expandTilde(expandTokens(f, tokens)));
    const identityFiles: string[] = [];
    for (const candidate of identityCandidates) {
      const abs = path.isAbsolute(candidate) ? candidate : path.join(homeDir(), candidate);
      if (await this.exists(abs)) identityFiles.push(abs);
    }

    const identityAgentRaw = get('identityagent');
    let identityAgent: string | undefined;
    if (identityAgentRaw !== undefined) {
      const trimmed = identityAgentRaw.trim();
      if (trimmed.toLowerCase() === 'none') identityAgent = 'none';
      else if (trimmed.toUpperCase() === 'SSH_AUTH_SOCK') identityAgent = process.env.SSH_AUTH_SOCK;
      else if (trimmed.startsWith('$')) identityAgent = process.env[trimmed.slice(1)];
      else identityAgent = expandTilde(expandTokens(trimmed, tokens));
    }

    const agentForward = profile.agentForward ?? /^yes$/i.test(get('forwardagent') ?? '');

    const unsupported = Object.keys(computed).filter((k) => UNSUPPORTED_IMPORTANT.has(k.toLowerCase()));

    const resolved: ResolvedHost = {
      profile,
      hostName,
      port,
      user,
      identityFiles,
      identityAgent,
      agentForward,
      unsupported,
    };

    const proxyJumpRaw = profile.proxyJump ?? get('proxyjump');
    if (proxyJumpRaw && !/^none$/i.test(proxyJumpRaw)) {
      if (depth > 8) throw new Error(`ProxyJump chain too deep while resolving ${profile.name}`);
      const hops = proxyJumpRaw
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      // Build the chain from the first hop outwards: first hop is the outermost connection.
      let jump: ResolvedHost | undefined;
      for (const hop of hops) {
        const hopProfile = parseJumpSpec(hop, profile);
        const hopResolved = await this.resolve({ ...hopProfile, proxyJump: hopProfile.proxyJump }, depth + 1);
        if (jump) hopResolved.proxyJump = hopResolved.proxyJump ?? jump;
        jump = hopResolved;
      }
      resolved.proxyJump = jump;
    }

    if (unsupported.length > 0) {
      log.warn(`Host ${profile.host}: ignoring unsupported directives ${unsupported.join(', ')}`);
    }
    return resolved;
  }

  private collectHostAliases(config: SSHConfig): string[] {
    const aliases: string[] = [];
    for (const line of config) {
      if (line.type !== SSHConfig.DIRECTIVE) continue;
      if (line.param.toLowerCase() !== 'host') continue;
      const values = Array.isArray(line.value) ? line.value.map((v) => v.val) : line.value.split(/\s+/);
      for (const v of values) {
        if (!v || /[*?!]/.test(v)) continue;
        if (!aliases.includes(v)) aliases.push(v);
      }
    }
    return aliases;
  }

  private async inlineIncludes(file: string, depth: number, seen: Set<string>): Promise<string> {
    if (depth > 16 || seen.has(file)) return '';
    seen.add(file);
    let text: string;
    try {
      text = await this.readFile(file);
    } catch (err) {
      log.warn(`Cannot read ${file}: ${String(err)}`);
      return '';
    }
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const m = /^\s*Include\s+(.+?)\s*$/i.exec(rawLine);
      if (!m) {
        out.push(rawLine);
        continue;
      }
      for (const pattern of m[1]!.split(/\s+/)) {
        const files = await this.expandIncludePattern(pattern.replace(/^"(.*)"$/, '$1'));
        for (const included of files) {
          out.push(`# >>> Include ${included}`);
          out.push(await this.inlineIncludes(included, depth + 1, seen));
          out.push(`# <<< Include ${included}`);
        }
      }
    }
    return out.join('\n');
  }

  private async expandIncludePattern(pattern: string): Promise<string[]> {
    let p = expandTilde(pattern);
    if (!path.isAbsolute(p)) p = path.join(sshDir(), p);
    const dir = path.dirname(p);
    const base = path.basename(p);
    if (!/[*?[]/.test(base)) {
      return (await this.exists(p)) ? [p] : [];
    }
    let entries: string[];
    try {
      entries = await this.readDir(dir);
    } catch {
      return [];
    }
    const re = globToRegExp(base);
    return entries
      .filter((e) => re.test(e))
      .sort()
      .map((e) => path.join(dir, e));
  }
}

function parsePort(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

/** Expands OpenSSH percent tokens (%d %u %h %r %p %n %%). */
export function expandTokens(
  value: string,
  ctx: { host: string; hostName: string; user: string; port: number },
): string {
  return value.replace(/%([%dhnrpu])/g, (_m, t: string) => {
    switch (t) {
      case '%':
        return '%';
      case 'd':
        return homeDir();
      case 'h':
        return ctx.hostName;
      case 'n':
        return ctx.host;
      case 'r':
        return ctx.user;
      case 'p':
        return String(ctx.port);
      case 'u':
        return os.userInfo().username;
      default:
        return `%${t}`;
    }
  });
}

/** Parses `[user@]host[:port]` into a profile inheriting `parent`'s auth settings. */
export function parseJumpSpec(spec: string, parent: ConnectionProfile): ConnectionProfile {
  let rest = spec;
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) {
    rest = bracket[1]!;
    port = bracket[2] ? Number.parseInt(bracket[2], 10) : undefined;
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon >= 0 && !rest.includes(':', colon + 1) && /^\d+$/.test(rest.slice(colon + 1))) {
      port = Number.parseInt(rest.slice(colon + 1), 10);
      rest = rest.slice(0, colon);
    }
  }
  return {
    name: `${parent.name}-jump-${rest}`,
    host: rest,
    user,
    port,
    agent: parent.agent,
    identityFile: undefined,
    source: parent.source,
  };
}
