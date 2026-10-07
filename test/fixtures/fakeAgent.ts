/**
 * Minimal SSH agent listening on a UNIX socket, implemented with ssh2's
 * AgentProtocol. Lets tests verify the agent code path end to end.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentProtocol, utils, type ParsedKey } from 'ssh2';

// Not part of ssh2's public API, but exactly what the client uses to turn OpenSSL DER
// signatures into SSH wire format; good enough for a test double.
const protocolUtils = createRequire(import.meta.url)('ssh2/lib/protocol/utils') as {
  convertSignature: (signature: Buffer, keyType: string) => Buffer | false;
};
const convertSignature = protocolUtils.convertSignature;

export class FakeAgent {
  readonly socketPath: string;
  private server: net.Server | undefined;
  private readonly keys: ParsedKey[];
  signRequests = 0;
  identityRequests = 0;

  constructor(privatePems: string[]) {
    this.keys = privatePems.map((pem) => {
      const k = utils.parseKey(pem);
      if (k instanceof Error) throw k;
      return k;
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agent-'));
    this.socketPath = path.join(dir, 'agent.sock');
  }

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      const agent = new AgentProtocol(false);
      agent.on('identities', (req) => {
        this.identityRequests++;
        agent.getIdentitiesReply(req, this.keys);
      });
      agent.on('sign', (req, pubKey, data, options) => {
        this.signRequests++;
        const wanted = pubKey.getPublicSSH();
        const key = this.keys.find((k) => k.getPublicSSH().equals(wanted));
        if (!key) return agent.failureReply(req);
        const raw = key.sign(data, options?.hash);
        const converted = convertSignature(raw, key.type);
        agent.signReply(req, converted === false ? raw : converted);
      });
      socket.pipe(agent).pipe(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true });
  }
}
