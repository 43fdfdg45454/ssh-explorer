import { describe, expect, it } from 'vitest';
import { AgentResolver } from '../../src/ssh/agentResolver';
import type { ConnectionProfile, ResolvedHost } from '../../src/ssh/types';

function host(
  partial: Omit<Partial<ResolvedHost>, 'profile'> & { profile?: Partial<ConnectionProfile> } = {},
): ResolvedHost {
  const { profile: profilePartial, ...rest } = partial;
  const profile: ConnectionProfile = { name: 'h', host: 'h', source: 'settings', ...profilePartial };
  return {
    profile,
    hostName: 'h',
    port: 22,
    user: 'u',
    identityFiles: [],
    agentForward: false,
    unsupported: [],
    ...rest,
  };
}

function resolver(
  sockets: Record<string, number | Error>,
  env: NodeJS.ProcessEnv = {},
  probePaths?: string[],
) {
  return new AgentResolver({
    env: { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1000', ...env },
    probePaths,
    isSocket: async (p) => p in sockets,
    countIdentities: async (p) => {
      const v = sockets[p];
      if (v instanceof Error) throw v;
      return v ?? 0;
    },
    identityTimeoutMs: 100,
  });
}

describe('AgentResolver', () => {
  it('prefers the profile override, then IdentityAgent, then SSH_AUTH_SOCK, then probes', async () => {
    const sockets = { '/p/override': 1, '/p/identity': 2, '/p/env': 3, '/run/user/1000/ssh-auth': 4 };
    const r = resolver(sockets, { SSH_AUTH_SOCK: '/p/env' });
    expect(
      (await r.resolve(host({ profile: { agent: '/p/override' }, identityAgent: '/p/identity' })))?.path,
    ).toBe('/p/override');
    expect((await r.resolve(host({ identityAgent: '/p/identity' })))?.path).toBe('/p/identity');
    expect((await r.resolve(host()))?.path).toBe('/p/env');
    const noEnv = resolver(sockets);
    const c = await noEnv.resolve(host());
    expect(c?.path).toBe('/run/user/1000/ssh-auth');
    expect(c?.source).toBe('probe');
    expect(c?.identities).toBe(4);
  });

  it('skips candidates that are not sockets', async () => {
    const r = resolver({ '/run/user/1000/keyring/ssh': 1 }, { SSH_AUTH_SOCK: '/missing' });
    const c = await r.resolve(host());
    expect(c?.path).toBe('/run/user/1000/keyring/ssh');
  });

  it('expands ~ and ${XDG_RUNTIME_DIR} in probe paths', async () => {
    const r = resolver({ '/home/me/.1password/agent.sock': 1 });
    expect((await r.resolve(host()))?.path).toBe('/home/me/.1password/agent.sock');
  });

  it('returns nothing when the agent is disabled', async () => {
    const r = resolver({ '/p/env': 1 }, { SSH_AUTH_SOCK: '/p/env' });
    expect(await r.resolve(host({ profile: { agent: false } }))).toBeUndefined();
    expect(await r.resolve(host({ identityAgent: 'none' }))).toBeUndefined();
  });

  it('falls through probes that do not answer, but not explicit sockets', async () => {
    const dead = new Error('ECONNREFUSED');
    const r = resolver({ '/p/env': dead, '/run/user/1000/gcr/ssh': 2 }, { SSH_AUTH_SOCK: '/p/env' });
    const c = await r.resolve(host());
    expect(c?.path).toBe('/run/user/1000/gcr/ssh');

    const explicit = await r.resolve(host({ profile: { agent: '/p/env' } }));
    expect(explicit?.path).toBe('/p/env');
    expect(explicit?.error).toContain('ECONNREFUSED');
  });

  it('diagnose lists every candidate with status', async () => {
    const r = resolver({ '/p/env': 5 }, { SSH_AUTH_SOCK: '/p/env' }, ['/nope']);
    const report = await r.diagnose(host());
    expect(report.map((c) => [c.path, c.isSocket, c.identities])).toEqual([
      ['/p/env', true, 5],
      ['/nope', false, undefined],
    ]);
  });
});
