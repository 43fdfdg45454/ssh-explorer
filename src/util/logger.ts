/**
 * Thin logging facade. The extension installs a `vscode.LogOutputChannel`
 * backed implementation at activation; tests and pure modules use the default
 * no-op sink so they never import the `vscode` module.
 */
export interface LogSink {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
}

const silent: LogSink = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let sink: LogSink = silent;

export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? silent;
}

/** Logger that prefixes every line with a component name. */
export class Logger {
  constructor(private readonly scope: string) {}

  trace(message: string, ...args: unknown[]): void {
    sink.trace(`[${this.scope}] ${message}`, ...args);
  }
  debug(message: string, ...args: unknown[]): void {
    sink.debug(`[${this.scope}] ${message}`, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    sink.info(`[${this.scope}] ${message}`, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    sink.warn(`[${this.scope}] ${message}`, ...args);
  }
  error(message: string | Error, ...args: unknown[]): void {
    if (message instanceof Error) {
      sink.error(`[${this.scope}] ${message.message}`, message.stack ?? '', ...args);
    } else {
      sink.error(`[${this.scope}] ${message}`, ...args);
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
