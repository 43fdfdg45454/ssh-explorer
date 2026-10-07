import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { utils } from 'ssh2';
import { Logger } from '../util/logger';
import type { HostKeyVerdict } from './types';

const log = new Logger('known-hosts');

interface KnownHostEntry {
  file: string;
  line: number;
  marker?: string;
  /** Plain patterns (may contain wildcards / negation) or a single hashed pattern. */
  patterns: string[];
  hashed?: { salt: Buffer; hash: Buffer };
  keyType: string;
  key: Buffer;
}

export interface KnownHostsCheckResult {
  verdict: HostKeyVerdict;
  /** Entries for this host whose keys did not match (for error messages). */
  conflicting: { file: string; line: number; keyType: string; fingerprint: string }[];
}

/** `host` as it appears in known_hosts: bare for port 22, `[host]:port` otherwise. */
export function hostPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function fingerprintSha256(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export function fingerprintMd5(key: Buffer): string {
  return 'MD5:' + crypto.createHash('md5').update(key).digest('hex').match(/.{2}/g)!.join(':');
}

/** Reads the key type (e.g. ssh-ed25519) from a raw SSH public key blob. */
export function keyTypeOf(key: Buffer): string {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) {
    if (key.length < 4) return 'unknown';
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('utf8') || 'unknown';
  }
  return parsed.type;
}

function hashedPatternMatches(entry: NonNullable<KnownHostEntry['hashed']>, host: string): boolean {
  const mac = crypto.createHmac('sha1', entry.salt).update(host).digest();
  return mac.length === entry.hash.length && crypto.timingSafeEqual(mac, entry.hash);
}

function plainPatternMatches(patterns: string[], host: string): boolean {
  let matched = false;
  const lower = host.toLowerCase();
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    const re = new RegExp(
      '^' +
        pattern
          .toLowerCase()
          .split('')
          .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
          .join('') +
        '$',
    );
    if (re.test(lower)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

export function parseKnownHostsText(text: string, file: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    let marker: string | undefined;
    if (parts[0]?.startsWith('@')) marker = parts.shift();
    if (parts.length < 3) return;
    const [hosts, keyType, keyB64] = parts as [string, string, string];
    let key: Buffer;
    try {
      key = Buffer.from(keyB64, 'base64');
    } catch {
      return;
    }
    if (key.length === 0) return;
    const entry: KnownHostEntry = { file, line: idx + 1, marker, patterns: [], keyType, key };
    if (hosts.startsWith('|1|')) {
      const [, , saltB64, hashB64] = hosts.split('|');
      if (!saltB64 || !hashB64) return;
      entry.hashed = { salt: Buffer.from(saltB64, 'base64'), hash: Buffer.from(hashB64, 'base64') };
    } else {
      entry.patterns = hosts.split(',').filter(Boolean);
    }
    entries.push(entry);
  });
  return entries;
}

export function formatKnownHostsLine(host: string, port: number, key: Buffer, hashed: boolean): string {
  const pattern = hostPattern(host, port);
  const type = keyTypeOf(key);
  let hostField = pattern;
  if (hashed) {
    const salt = crypto.randomBytes(20);
    const mac = crypto.createHmac('sha1', salt).update(pattern).digest();
    hostField = `|1|${salt.toString('base64')}|${mac.toString('base64')}`;
  }
  return `${hostField} ${type} ${key.toString('base64')}`;
}

export interface KnownHostsOptions {
  readFile?: (p: string) => Promise<string>;
  appendFile?: (p: string, data: string) => Promise<void>;
}

/** In-memory view of one or more known_hosts files with OpenSSH matching semantics. */
export class KnownHosts {
  private entries: KnownHostEntry[] = [];
  private readonly readFile: (p: string) => Promise<string>;
  private readonly appendFile: (p: string, data: string) => Promise<void>;

  constructor(options: KnownHostsOptions = {}) {
    this.readFile = options.readFile ?? ((p) => fs.readFile(p, 'utf8'));
    this.appendFile =
      options.appendFile ??
      (async (p, data) => {
        await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
        await fs.appendFile(p, data, { mode: 0o600 });
      });
  }

  async load(files: string[]): Promise<void> {
    const entries: KnownHostEntry[] = [];
    for (const file of files) {
      try {
        entries.push(...parseKnownHostsText(await this.readFile(file), file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`Cannot read ${file}: ${String(err)}`);
        }
      }
    }
    this.entries = entries;
  }

  loadFromText(text: string, file = '<memory>'): void {
    this.entries = parseKnownHostsText(text, file);
  }

  get size(): number {
    return this.entries.length;
  }

  private matching(host: string, port: number): KnownHostEntry[] {
    const pattern = hostPattern(host, port);
    const alt = port === 22 ? `[${host}]:22` : undefined;
    return this.entries.filter((e) => {
      if (e.hashed) {
        return (
          hashedPatternMatches(e.hashed, pattern) ||
          (alt !== undefined && hashedPatternMatches(e.hashed, alt))
        );
      }
      return (
        plainPatternMatches(e.patterns, pattern) ||
        (alt !== undefined && plainPatternMatches(e.patterns, alt))
      );
    });
  }

  check(host: string, port: number, key: Buffer): KnownHostsCheckResult {
    const keyType = keyTypeOf(key);
    const matches = this.matching(host, port);
    const conflicting: KnownHostsCheckResult['conflicting'] = [];
    let verdict: HostKeyVerdict = 'unknown';
    for (const entry of matches) {
      if (entry.marker === '@cert-authority') continue;
      const same = entry.key.length === key.length && crypto.timingSafeEqual(entry.key, key);
      if (entry.marker === '@revoked') {
        if (same) {
          return {
            verdict: 'mismatch',
            conflicting: [{ ...entry, fingerprint: fingerprintSha256(entry.key) }],
          };
        }
        continue;
      }
      if (same) {
        verdict = 'match';
      } else if (entry.keyType === keyType) {
        conflicting.push({
          file: entry.file,
          line: entry.line,
          keyType: entry.keyType,
          fingerprint: fingerprintSha256(entry.key),
        });
      }
    }
    if (verdict === 'match') return { verdict, conflicting: [] };
    if (conflicting.length > 0) return { verdict: 'mismatch', conflicting };
    return { verdict: 'unknown', conflicting: [] };
  }

  /** Appends a new entry to `file` and to the in-memory set. */
  async add(file: string, host: string, port: number, key: Buffer, hashed: boolean): Promise<void> {
    const line = formatKnownHostsLine(host, port, key, hashed);
    await this.appendFile(file, line + '\n');
    this.entries.push(...parseKnownHostsText(line, file));
    log.info(`Added host key for ${hostPattern(host, port)} (${fingerprintSha256(key)}) to ${file}`);
  }
}
