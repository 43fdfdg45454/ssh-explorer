import * as os from 'node:os';
import * as path from 'node:path';

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

export function xdgRuntimeDir(): string | undefined {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (dir) return dir;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined ? undefined : `/run/user/${uid}`;
}

export function sshDir(): string {
  return path.join(homeDir(), '.ssh');
}

/** Expands a leading `~` or `~/` to the home directory. */
export function expandTilde(p: string, home: string = homeDir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Expands `${VAR}` and `$VAR` references using `env` (defaults to process.env). */
export function expandEnv(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      return env[name] ?? '';
    },
  );
}

/** Full expansion used for user-provided paths: env vars, then `~`. */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return expandTilde(expandEnv(p, env), env.HOME || homeDir());
}
