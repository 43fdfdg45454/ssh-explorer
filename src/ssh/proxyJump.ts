import type { Duplex } from 'node:stream';
import { Client, type ConnectConfig } from 'ssh2';
import { Logger } from '../util/logger';
import type { ResolvedHost } from './types';

const log = new Logger('proxy-jump');

export interface JumpChain {
  /** Stream to hand to the final Client as `sock`. */
  sock: Duplex;
  /** Ends every intermediate client. */
  close(): void;
}

export type ConnectConfigBuilder = (host: ResolvedHost) => Promise<ConnectConfig>;

/**
 * Opens the chain of intermediate connections described by `target.proxyJump`
 * and returns a stream tunnelled to `target`. Each hop authenticates with the
 * same machinery as a direct connection.
 */
export async function openJumpChain(
  target: ResolvedHost,
  buildConfig: ConnectConfigBuilder,
): Promise<JumpChain> {
  const hop = target.proxyJump;
  if (!hop) throw new Error('openJumpChain called without a ProxyJump');

  // Recursively establish the hop's own transport first (first hop is outermost).
  const inner = hop.proxyJump ? await openJumpChain(hop, buildConfig) : undefined;
  const config = await buildConfig(hop);
  if (inner) config.sock = inner.sock;

  const client = new Client();
  const closeAll = () => {
    try {
      client.end();
    } catch {
      // ignore
    }
    inner?.close();
  };

  return new Promise<JumpChain>((resolve, reject) => {
    let settled = false;
    client.once('ready', () => {
      log.debug(
        `Jump host ${hop.hostName}:${hop.port} ready, forwarding to ${target.hostName}:${target.port}`,
      );
      client.forwardOut('127.0.0.1', 0, target.hostName, target.port, (err, stream) => {
        if (settled) return;
        settled = true;
        if (err) {
          closeAll();
          reject(
            new Error(
              `Jump host ${hop.hostName}: cannot reach ${target.hostName}:${target.port}: ${err.message}`,
            ),
          );
          return;
        }
        stream.once('close', () => closeAll());
        resolve({ sock: stream, close: closeAll });
      });
    });
    client.once('error', (err) => {
      if (settled) return;
      settled = true;
      closeAll();
      reject(new Error(`Jump host ${hop.hostName}:${hop.port}: ${err.message}`));
    });
    client.connect(config);
  });
}
