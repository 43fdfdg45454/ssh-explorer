import type { HostVerifier } from 'ssh2';
import { Logger } from '../util/logger';
import { HostKeyError } from './errors';
import { fingerprintSha256, hostPattern, keyTypeOf, type KnownHosts } from './knownHosts';
import type { ResolvedHost } from './types';

const log = new Logger('hostkey');

export type HostKeyPolicy = 'ask' | 'accept-new' | 'yes';
export type UnknownHostDecision = 'save' | 'once' | 'reject';

export interface HostKeyPrompter {
  confirmUnknownHost(info: {
    host: ResolvedHost;
    fingerprintSha256: string;
    keyType: string;
  }): Promise<UnknownHostDecision>;
}

export interface HostVerifierOptions {
  knownHosts: KnownHosts;
  /** File new keys are appended to. */
  writeFile: string;
  hashNewEntries: boolean;
  policy: HostKeyPolicy;
  prompter: HostKeyPrompter;
}

export interface HostVerification {
  verifier: HostVerifier;
  /** Set when verification refused the key. */
  error?: HostKeyError;
}

/** Builds the ssh2 `hostVerifier` for one connection attempt. */
export function createHostVerifier(host: ResolvedHost, o: HostVerifierOptions): HostVerification {
  const result: HostVerification = { verifier: () => undefined };
  result.verifier = (key, verify) => {
    const fingerprint = fingerprintSha256(key);
    const keyType = keyTypeOf(key);
    const where = hostPattern(host.hostName, host.port);
    const check = o.knownHosts.check(host.hostName, host.port, key);

    if (check.verdict === 'match') {
      log.debug(`${where}: host key ${fingerprint} matches known_hosts`);
      verify(true);
      return;
    }
    if (check.verdict === 'mismatch') {
      const lines = check.conflicting
        .map((c) => `${c.file}:${c.line} (${c.keyType} ${c.fingerprint})`)
        .join(', ');
      result.error = new HostKeyError(
        `Host key for ${where} has changed! Offered ${keyType} ${fingerprint}, known_hosts has ${lines}. ` +
          'Someone could be eavesdropping; verify the server and remove the stale entry before reconnecting.',
        { host: host.hostName, port: host.port, fingerprint, keyType, verdict: 'mismatch' },
      );
      log.error(result.error.message);
      verify(false);
      return;
    }

    const decide = async (): Promise<UnknownHostDecision> => {
      if (o.policy === 'yes') return 'reject';
      if (o.policy === 'accept-new') return 'save';
      return o.prompter.confirmUnknownHost({ host, fingerprintSha256: fingerprint, keyType });
    };

    decide()
      .then(async (decision) => {
        if (decision === 'reject') {
          result.error = new HostKeyError(
            `Host key for ${where} (${keyType} ${fingerprint}) was not accepted.`,
            {
              host: host.hostName,
              port: host.port,
              fingerprint,
              keyType,
              verdict: 'rejected',
            },
          );
          verify(false);
          return;
        }
        if (decision === 'save') {
          try {
            await o.knownHosts.add(o.writeFile, host.hostName, host.port, key, o.hashNewEntries);
          } catch (err) {
            log.warn(`Could not write ${o.writeFile}: ${String(err)}`);
          }
        }
        verify(true);
      })
      .catch((err: unknown) => {
        log.error(err instanceof Error ? err : String(err));
        verify(false);
      });
  };
  return result;
}
