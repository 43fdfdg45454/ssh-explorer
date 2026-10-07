import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KnownHosts,
  fingerprintSha256,
  formatKnownHostsLine,
  hostPattern,
  keyTypeOf,
  parseKnownHostsText,
} from '../../src/ssh/knownHosts';
import { fakeEd25519PublicBlob, generateEcKeyPair } from '../fixtures/keys';

const keyA = fakeEd25519PublicBlob();
const keyB = fakeEd25519PublicBlob();
const b64 = (b: Buffer) => b.toString('base64');

function hashedHost(host: string): string {
  const salt = crypto.randomBytes(20);
  const mac = crypto.createHmac('sha1', salt).update(host).digest();
  return `|1|${salt.toString('base64')}|${mac.toString('base64')}`;
}

describe('known_hosts parsing', () => {
  it('parses plain, comment, marker and hashed lines', () => {
    const text = [
      '# comment',
      '',
      `example.com,10.0.0.1 ssh-ed25519 ${b64(keyA)} user@laptop`,
      `@revoked bad.example.com ssh-ed25519 ${b64(keyB)}`,
      `${hashedHost('hashed.example.com')} ssh-ed25519 ${b64(keyA)}`,
      'garbage',
    ].join('\n');
    const entries = parseKnownHostsText(text, 'f');
    expect(entries).toHaveLength(3);
    expect(entries[0]!.patterns).toEqual(['example.com', '10.0.0.1']);
    expect(entries[1]!.marker).toBe('@revoked');
    expect(entries[2]!.hashed).toBeDefined();
    expect(entries[2]!.line).toBe(5);
  });

  it('derives the key type from the blob', () => {
    expect(keyTypeOf(keyA)).toBe('ssh-ed25519');
    expect(keyTypeOf(generateEcKeyPair().publicBlob)).toBe('ecdsa-sha2-nistp256');
  });

  it('formats fingerprints like ssh-keygen', () => {
    const fp = fingerprintSha256(keyA);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('uses [host]:port for non-default ports', () => {
    expect(hostPattern('h', 22)).toBe('h');
    expect(hostPattern('h', 2222)).toBe('[h]:2222');
  });
});

describe('KnownHosts.check', () => {
  it('matches plain entries and detects mismatches', () => {
    const kh = new KnownHosts();
    kh.loadFromText(`example.com ssh-ed25519 ${b64(keyA)}`);
    expect(kh.check('example.com', 22, keyA).verdict).toBe('match');
    expect(kh.check('example.com', 22, keyB).verdict).toBe('mismatch');
    expect(kh.check('other.com', 22, keyA).verdict).toBe('unknown');
  });

  it('treats a different key type for the same host as unknown, not mismatch', () => {
    const kh = new KnownHosts();
    kh.loadFromText(`example.com ssh-ed25519 ${b64(keyA)}`);
    expect(kh.check('example.com', 22, generateEcKeyPair().publicBlob).verdict).toBe('unknown');
  });

  it('matches hashed entries and ports', () => {
    const kh = new KnownHosts();
    kh.loadFromText(
      [
        `${hashedHost('[example.com]:2222')} ssh-ed25519 ${b64(keyA)}`,
        `[other.com]:2200 ssh-ed25519 ${b64(keyB)}`,
      ].join('\n'),
    );
    expect(kh.check('example.com', 2222, keyA).verdict).toBe('match');
    expect(kh.check('example.com', 22, keyA).verdict).toBe('unknown');
    expect(kh.check('other.com', 2200, keyB).verdict).toBe('match');
    expect(kh.check('other.com', 2200, keyA).verdict).toBe('mismatch');
  });

  it('supports wildcards, negation and case-insensitive hosts', () => {
    const kh = new KnownHosts();
    kh.loadFromText(`*.example.com,!bad.example.com ssh-ed25519 ${b64(keyA)}`);
    expect(kh.check('Web.Example.com', 22, keyA).verdict).toBe('match');
    expect(kh.check('bad.example.com', 22, keyA).verdict).toBe('unknown');
  });

  it('treats revoked keys as mismatch and ignores cert authorities', () => {
    const kh = new KnownHosts();
    kh.loadFromText(
      [
        `@revoked example.com ssh-ed25519 ${b64(keyA)}`,
        `@cert-authority *.example.com ssh-ed25519 ${b64(keyB)}`,
      ].join('\n'),
    );
    expect(kh.check('example.com', 22, keyA).verdict).toBe('mismatch');
    expect(kh.check('x.example.com', 22, keyB).verdict).toBe('unknown');
  });

  it('appends new entries (hashed and plain) and recognises them afterwards', async () => {
    const written: string[] = [];
    const kh = new KnownHosts({ appendFile: async (_p, data) => void written.push(data) });
    await kh.add('/tmp/kh', 'new.example.com', 22, keyA, true);
    await kh.add('/tmp/kh', 'plain.example.com', 2222, keyB, false);
    expect(written[0]).toMatch(/^\|1\|/);
    expect(written[1]).toMatch(/^\[plain\.example\.com\]:2222 ssh-ed25519 /);
    expect(kh.check('new.example.com', 22, keyA).verdict).toBe('match');
    expect(kh.check('plain.example.com', 2222, keyB).verdict).toBe('match');
    const line = formatKnownHostsLine('h', 22, keyA, false);
    expect(line).toBe(`h ssh-ed25519 ${b64(keyA)}`);
  });

  it('loads several files and ignores missing ones', async () => {
    const files: Record<string, string> = { '/a': `a.com ssh-ed25519 ${b64(keyA)}` };
    const kh = new KnownHosts({
      readFile: async (p) => {
        if (p in files) return files[p]!;
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    await kh.load(['/a', '/missing']);
    expect(kh.size).toBe(1);
  });
});
