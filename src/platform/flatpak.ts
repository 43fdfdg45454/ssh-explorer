import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

export const VSCODIUM_FLATPAK_ID = 'com.vscodium.codium';

let cached: boolean | undefined;

/** True when the extension host runs inside a Flatpak sandbox. */
export function isFlatpak(): boolean {
  if (cached === undefined) {
    cached = Boolean(process.env.FLATPAK_ID) || fs.existsSync('/.flatpak-info');
  }
  return cached;
}

/** Test seam. */
export function resetFlatpakDetection(value?: boolean): void {
  cached = value;
}

export function flatpakAppId(): string {
  return process.env.FLATPAK_ID || VSCODIUM_FLATPAK_ID;
}

export interface HostCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class HostCommandError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HostCommandError';
  }
}

/**
 * Runs a command on the host system. Inside Flatpak this goes through
 * `flatpak-spawn --host`, which requires the `org.freedesktop.Flatpak` D-Bus
 * permission (granted by the VSCodium Flatpak manifest).
 */
export function runOnHost(command: string, args: string[], timeoutMs = 10_000): Promise<HostCommandResult> {
  const [file, fileArgs] = isFlatpak() ? ['flatpak-spawn', ['--host', command, ...args]] : [command, args];
  return new Promise((resolve, reject) => {
    execFile(file, fileArgs, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new HostCommandError(`${file} is not available`, error));
        return;
      }
      if (
        error &&
        typeof (error as { code?: unknown }).code !== 'number' &&
        !(error as { killed?: boolean }).killed
      ) {
        reject(new HostCommandError(error.message, error));
        return;
      }
      const code = (error as { code?: number } | null)?.code ?? 0;
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : null });
    });
  });
}

/** The command a user must run to expose the SSH agent socket to the sandbox. */
export function sshAuthOverrideCommand(): string {
  return `flatpak override --user --socket=ssh-auth ${flatpakAppId()}`;
}
