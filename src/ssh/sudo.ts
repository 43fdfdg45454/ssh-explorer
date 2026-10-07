import type { SaveSecretsPolicy, SecretStore } from './auth';
import type { Connection, ExecResult } from './connection';
import { CancelledError } from './errors';
import type { ResolvedHost } from './types';
import { Logger } from '../util/logger';

export interface SudoPrompter {
  askSudoPassword(host: ResolvedHost, attempt: number): Promise<string | undefined>;
  askSaveSudoPassword(host: ResolvedHost): Promise<boolean>;
}

export interface SudoRunnerDeps {
  prompter: SudoPrompter;
  secrets?: SecretStore;
  saveSecretsPolicy(): SaveSecretsPolicy;
  /** The privilege-escalation binary, normally `sudo`. */
  command(): string;
}

export type SudoFailure = 'cancelled' | 'badPassword' | 'notPermitted' | 'notInstalled';

export class SudoError extends Error {
  constructor(
    message: string,
    readonly failure: SudoFailure,
  ) {
    super(message);
    this.name = 'SudoError';
  }
}

/** Shell single-quotes `value` so it is passed literally. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

export function sudoSecretKey(host: ResolvedHost): string {
  return `sudo:${host.user}@${host.hostName}:${host.port}`;
}

const PASSWORD_REQUIRED = /password is required|a terminal is required|no tty present|askpass/i;
const BAD_PASSWORD = /sorry, try again|incorrect password|authentication failure/i;
const NOT_PERMITTED = /is not in the sudoers|not allowed to execute|may not run sudo/i;

/**
 * Runs commands as root through sudo over the connection's exec channel.
 * Tries passwordless sudo first (NOPASSWD / cached timestamp); otherwise asks
 * for the password once and reuses it, optionally persisting it.
 */
export class SudoRunner {
  private password: string | undefined;
  private passwordless: boolean | undefined;
  private readonly log: Logger;

  constructor(
    private readonly conn: Connection,
    private readonly deps: SudoRunnerDeps,
  ) {
    this.log = new Logger(`sudo:${conn.name}`);
  }

  forgetPassword(): void {
    this.password = undefined;
  }

  /**
   * Executes `argv` as root. Resolves with the command's own result (including
   * non-zero exit codes); rejects with SudoError when sudo itself refuses.
   */
  async run(argv: string[], options: { stdin?: Buffer; timeoutMs?: number } = {}): Promise<ExecResult> {
    const host = this.conn.host;
    if (!host) throw new SudoError('Connection is not resolved', 'notPermitted');
    const sudo = this.deps.command();
    if (options.stdin) {
      // Our commands never read stdin; keeping it free lets sudo -S read the password safely.
      throw new Error('SudoRunner.run does not support stdin');
    }

    if (this.passwordless !== false && this.password === undefined) {
      const result = await this.conn.exec(`${shellQuote(sudo)} -n -- ${shellJoin(argv)}`, {
        timeoutMs: options.timeoutMs,
      });
      if (!(result.code === 1 && PASSWORD_REQUIRED.test(result.stderr))) {
        this.classifySudoFailure(result);
        this.passwordless = true;
        return result;
      }
      this.passwordless = false;
      this.log.debug('sudo requires a password');
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const password = await this.getPassword(host, attempt);
      const result = await this.conn.exec(`${shellQuote(sudo)} -S -p '' -- ${shellJoin(argv)}`, {
        stdin: Buffer.from(password + '\n', 'utf8'),
        timeoutMs: options.timeoutMs,
      });
      if (result.code === 1 && BAD_PASSWORD.test(result.stderr)) {
        this.log.info('sudo rejected the password');
        this.password = undefined;
        await this.deps.secrets?.delete(sudoSecretKey(host));
        continue;
      }
      this.classifySudoFailure(result);
      await this.rememberPassword(host, password);
      return result;
    }
    throw new SudoError('sudo: too many incorrect password attempts', 'badPassword');
  }

  private classifySudoFailure(result: ExecResult): void {
    if (
      result.code === 127 ||
      /sudo: (command )?not found|No such file or directory.*sudo/i.test(result.stderr)
    ) {
      throw new SudoError(`${this.deps.command()} is not installed on the remote host`, 'notInstalled');
    }
    if (result.code === 1 && NOT_PERMITTED.test(result.stderr)) {
      throw new SudoError(result.stderr.trim() || 'sudo refused the command', 'notPermitted');
    }
  }

  private freshlyEntered = false;

  private async getPassword(host: ResolvedHost, attempt: number): Promise<string> {
    if (this.password !== undefined) return this.password;
    if (attempt === 1) {
      const stored = await this.deps.secrets?.get(sudoSecretKey(host));
      if (stored !== undefined) {
        this.password = stored;
        return stored;
      }
    }
    const entered = await this.deps.prompter.askSudoPassword(host, attempt);
    if (entered === undefined) throw new CancelledError('sudo password prompt cancelled');
    this.password = entered;
    this.freshlyEntered = true;
    return entered;
  }

  private async rememberPassword(host: ResolvedHost, password: string): Promise<void> {
    this.password = password;
    if (!this.freshlyEntered) return;
    this.freshlyEntered = false;
    const policy = this.deps.saveSecretsPolicy();
    if (!this.deps.secrets || policy === 'never') return;
    const save = policy === 'always' || (await this.deps.prompter.askSaveSudoPassword(host));
    if (save) await this.deps.secrets.store(sudoSecretKey(host), password);
  }
}
