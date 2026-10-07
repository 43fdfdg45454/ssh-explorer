import * as crypto from 'node:crypto';
import { utils } from 'ssh2';

export interface TestKeyPair {
  /** PEM private key in a format ssh2 understands (SEC1 for EC, PKCS#1 for RSA). */
  privatePem: string;
  /** Raw SSH wire-format public key blob (what known_hosts stores base64-encoded). */
  publicBlob: Buffer;
  type: string;
}

/** Generates a fresh ECDSA P-256 key pair (fast; fine for tests). */
export function generateEcKeyPair(): TestKeyPair {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
  const parsed = utils.parseKey(privatePem);
  if (parsed instanceof Error) throw parsed;
  return { privatePem, publicBlob: parsed.getPublicSSH(), type: parsed.type };
}

/** Generates an RSA key pair, for servers that reject ECDSA host keys. */
export function generateRsaKeyPair(bits = 2048): TestKeyPair {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const parsed = utils.parseKey(privatePem);
  if (parsed instanceof Error) throw parsed;
  return { privatePem, publicBlob: parsed.getPublicSSH(), type: parsed.type };
}

/** Builds an ssh-ed25519 public blob from 32 random bytes (no private key needed). */
export function fakeEd25519PublicBlob(seed = crypto.randomBytes(32)): Buffer {
  const type = Buffer.from('ssh-ed25519');
  const out = Buffer.alloc(4 + type.length + 4 + seed.length);
  out.writeUInt32BE(type.length, 0);
  type.copy(out, 4);
  out.writeUInt32BE(seed.length, 4 + type.length);
  seed.copy(out, 8 + type.length);
  return out;
}
