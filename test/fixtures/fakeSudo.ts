import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Installs a `sudo` stand-in on a temp directory and returns the PATH prefix.
 * Behaviour mirrors real sudo closely enough for the SudoRunner:
 *   -n            : succeeds only when FAKE_SUDO_NOPASSWD is set, else "a password is required" (exit 1)
 *   -S -p '' --   : reads one password line from stdin; wrong → "Sorry, try again." (exit 1)
 * Everything after `--` runs as the current user (tests cannot really become root).
 */
export function installFakeSudo(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sudo-'));
  const script = `#!/bin/sh
mode=n
while [ $# -gt 0 ]; do
  case "$1" in
    -n) mode=n; shift ;;
    -S) mode=S; shift ;;
    -p) shift 2 ;;
    -k) shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
echo "fake-sudo $mode $*" >> "$FAKE_SUDO_LOG"
if [ "$mode" = n ]; then
  if [ -n "$FAKE_SUDO_NOPASSWD" ]; then exec "$@"; fi
  echo "sudo: a password is required" >&2
  exit 1
fi
IFS= read -r pw
if [ "$pw" != "$FAKE_SUDO_PASSWORD" ]; then
  echo "Sorry, try again." >&2
  echo "sudo: 1 incorrect password attempt" >&2
  exit 1
fi
exec "$@"
`;
  fs.writeFileSync(path.join(dir, 'sudo'), script, { mode: 0o755 });
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, '');
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_SUDO_LOG: log } };
}

export function fakeSudoLog(dir: string): string[] {
  return fs.readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean);
}
