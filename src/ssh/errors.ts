/** SFTP protocol status codes (draft-ietf-secsh-filexfer-02). */
export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const CHANNEL_DEAD_PATTERNS = [
  /no response from server/i,
  /channel (is )?closed/i,
  /not connected/i,
  /connection (lost|closed|reset)/i,
  /socket (closed|hang up)/i,
  /keepalive timeout/i,
  /write after end/i,
  /sftp session (ended|closed)/i,
];

export type ErrorKind = 'network' | 'auth' | 'hostkey' | 'sftp' | 'timeout' | 'cancelled' | 'other';

export function errorCode(err: unknown): string | number | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return code;
  }
  return undefined;
}

export function sftpStatus(err: unknown): number | undefined {
  const code = errorCode(err);
  return typeof code === 'number' ? code : undefined;
}

/** True when the error means the transport (socket or SFTP channel) is gone and a retry may succeed after reconnecting. */
export function isTransportError(err: unknown): boolean {
  const code = errorCode(err);
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  if (code === SFTP_STATUS.NO_CONNECTION || code === SFTP_STATUS.CONNECTION_LOST) return true;
  const level = (err as { level?: unknown } | undefined)?.level;
  if (level === 'client-socket' || level === 'client-timeout') return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return CHANNEL_DEAD_PATTERNS.some((re) => re.test(message));
}

export function isAuthError(err: unknown): boolean {
  const level = (err as { level?: unknown } | undefined)?.level;
  if (level === 'client-authentication') return true;
  const message = err instanceof Error ? err.message : '';
  return /all configured authentication methods failed/i.test(message);
}

export function isHostKeyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return (
    /host (key )?verification failed|host verification|host denied/i.test(message) ||
    err instanceof HostKeyError
  );
}

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof CancelledError) return 'cancelled';
  if (err instanceof HostKeyError || isHostKeyError(err)) return 'hostkey';
  if (isAuthError(err)) return 'auth';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  if (isTransportError(err)) return 'network';
  if (sftpStatus(err) !== undefined) return 'sftp';
  return 'other';
}

export class CancelledError extends Error {
  constructor(message = 'Cancelled by user') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class HostKeyError extends Error {
  constructor(
    message: string,
    readonly details: {
      host: string;
      port: number;
      fingerprint: string;
      keyType: string;
      verdict: 'mismatch' | 'rejected';
    },
  ) {
    super(message);
    this.name = 'HostKeyError';
  }
}

/** Raised by connection operations when the connection cannot serve requests. */
export class ConnectionUnavailableError extends Error {
  constructor(
    message: string,
    readonly connectionName: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConnectionUnavailableError';
  }
}
