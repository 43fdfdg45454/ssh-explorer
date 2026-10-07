import { describe, expect, it } from 'vitest';
import { SshConfigLoader, expandTokens, globToRegExp, parseJumpSpec } from '../../src/ssh/sshConfigLoader';
import type { ConnectionProfile } from '../../src/ssh/types';

const HOME = process.env.HOME ?? '/root';

function loader(files: Record<string, string>, existing: string[] = []) {
  const all = new Set([...Object.keys(files), ...existing]);
  return new SshConfigLoader({
    configPath: `${HOME}/.ssh/config`,
    exists: async (p) => all.has(p),
    readFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT ${p}`);
    },
    readDir: async (dir) =>
      [...all]
        .filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1)),
  });
}

const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  name: 'web',
  host: 'web',
  source: 'sshConfig',
  ...over,
});

describe('SshConfigLoader', () => {
  it('lists concrete host aliases only', async () => {
    const l = loader({
      [`${HOME}/.ssh/config`]: [
        'Host web db',
        '  HostName 10.0.0.2',
        'Host *.internal',
        'Host *',
        '  User fallback',
      ].join('\n'),
    });
    await l.load();
    expect(l.listHosts()).toEqual(['web', 'db']);
  });

  it('resolves HostName, User, Port, IdentityFile and IdentityAgent with tokens', async () => {
    const l = loader(
      {
        [`${HOME}/.ssh/config`]: [
          'Host web',
          '  HostName web.example.com',
          '  User deploy',
          '  Port 2222',
          '  IdentityFile ~/.ssh/%r_%h',
          '  IdentityFile ~/.ssh/missing',
          '  IdentityAgent ~/.1password/agent.sock',
          '  ForwardAgent yes',
          '  ProxyCommand ssh bastion -W %h:%p',
        ].join('\n'),
      },
      [`${HOME}/.ssh/deploy_web.example.com`],
    );
    await l.load();
    const r = await l.resolve(profile());
    expect(r.hostName).toBe('web.example.com');
    expect(r.user).toBe('deploy');
    expect(r.port).toBe(2222);
    expect(r.identityFiles).toEqual([`${HOME}/.ssh/deploy_web.example.com`]);
    expect(r.identityAgent).toBe(`${HOME}/.1password/agent.sock`);
    expect(r.agentForward).toBe(true);
    expect(r.unsupported.map((u) => u.toLowerCase())).toContain('proxycommand');
  });

  it('lets the profile override the file and falls back to default identities', async () => {
    const l = loader({ [`${HOME}/.ssh/config`]: 'Host web\n  User fromfile\n  Port 2222' }, [
      `${HOME}/.ssh/id_ed25519`,
      `${HOME}/.ssh/id_rsa`,
    ]);
    await l.load();
    const r = await l.resolve(profile({ user: 'me', port: 22 }));
    expect(r.user).toBe('me');
    expect(r.port).toBe(22);
    expect(r.identityFiles).toEqual([`${HOME}/.ssh/id_ed25519`, `${HOME}/.ssh/id_rsa`]);
  });

  it('inlines Include directives (relative to ~/.ssh, with globs)', async () => {
    const l = loader({
      [`${HOME}/.ssh/config`]: 'Include conf.d/*.conf\nHost *\n  User everyone',
      [`${HOME}/.ssh/conf.d/a.conf`]: 'Host alpha\n  HostName alpha.example.com',
      [`${HOME}/.ssh/conf.d/b.conf`]: 'Host beta\n  Port 2200',
      [`${HOME}/.ssh/conf.d/ignored.txt`]: 'Host nope',
    });
    await l.load();
    expect(l.listHosts()).toEqual(['alpha', 'beta']);
    const r = await l.resolve(profile({ name: 'alpha', host: 'alpha' }));
    expect(r.hostName).toBe('alpha.example.com');
    expect(r.user).toBe('everyone');
  });

  it('IdentityAgent none disables the agent and SSH_AUTH_SOCK is honoured', async () => {
    const l = loader({
      [`${HOME}/.ssh/config`]: 'Host web\n  IdentityAgent none\nHost other\n  IdentityAgent SSH_AUTH_SOCK',
    });
    await l.load();
    expect((await l.resolve(profile())).identityAgent).toBe('none');
    const prev = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/sock';
    try {
      expect((await l.resolve(profile({ name: 'other', host: 'other' }))).identityAgent).toBe('/tmp/sock');
    } finally {
      if (prev === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prev;
    }
  });

  it('builds a ProxyJump chain (first hop outermost)', async () => {
    const l = loader({
      [`${HOME}/.ssh/config`]: [
        'Host target',
        '  HostName 10.0.0.9',
        '  ProxyJump bastion,admin@relay.example.com:2201',
        'Host bastion',
        '  HostName bastion.example.com',
        '  User jump',
      ].join('\n'),
    });
    await l.load();
    const r = await l.resolve(profile({ name: 'target', host: 'target' }));
    expect(r.hostName).toBe('10.0.0.9');
    expect(r.proxyJump?.hostName).toBe('relay.example.com');
    expect(r.proxyJump?.user).toBe('admin');
    expect(r.proxyJump?.port).toBe(2201);
    expect(r.proxyJump?.proxyJump?.hostName).toBe('bastion.example.com');
    expect(r.proxyJump?.proxyJump?.user).toBe('jump');
    expect(r.proxyJump?.proxyJump?.proxyJump).toBeUndefined();
  });

  it('works without a config file', async () => {
    const l = loader({});
    await l.load();
    expect(l.listHosts()).toEqual([]);
    const r = await l.resolve(profile({ host: 'plain.example.com', user: 'x' }));
    expect(r.hostName).toBe('plain.example.com');
    expect(r.port).toBe(22);
  });
});

describe('helpers', () => {
  it('expands tokens', () => {
    const out = expandTokens('%d/%h-%n-%r-%p-%%', {
      host: 'alias',
      hostName: 'real',
      user: 'bob',
      port: 2200,
    });
    expect(out).toBe(`${HOME}/real-alias-bob-2200-%`);
  });

  it('parses jump specs', () => {
    const parent = profile();
    expect(parseJumpSpec('user@host:2222', parent)).toMatchObject({ host: 'host', user: 'user', port: 2222 });
    expect(parseJumpSpec('host', parent)).toMatchObject({ host: 'host', user: undefined, port: undefined });
    expect(parseJumpSpec('u@[::1]:22', parent)).toMatchObject({ host: '::1', user: 'u', port: 22 });
  });

  it('converts globs', () => {
    expect(globToRegExp('*.conf').test('a.conf')).toBe(true);
    expect(globToRegExp('*.conf').test('a.conf.bak')).toBe(false);
    expect(globToRegExp('h?st').test('host')).toBe(true);
  });
});
