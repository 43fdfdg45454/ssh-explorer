import * as vscode from 'vscode';
import { ConnectionUnavailableError, isTransportError, SFTP_STATUS, sftpStatus } from '../ssh/errors';
import { errorMessage } from '../util/logger';

/** Translates ssh2/SFTP/connection errors into the FileSystemError codes VS Code understands. */
export function toFileSystemError(
  err: unknown,
  uri: vscode.Uri,
  hint?: 'exists' | 'notEmpty',
): vscode.FileSystemError {
  if (err instanceof vscode.FileSystemError) return err;
  if (err instanceof ConnectionUnavailableError || isTransportError(err)) {
    return vscode.FileSystemError.Unavailable(`${uri.toString()}: ${errorMessage(err)}`);
  }
  const code = sftpStatus(err);
  const message = errorMessage(err);
  switch (code) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return vscode.FileSystemError.FileNotFound(uri);
    case SFTP_STATUS.PERMISSION_DENIED:
      return vscode.FileSystemError.NoPermissions(uri);
    case SFTP_STATUS.OP_UNSUPPORTED:
      return new vscode.FileSystemError(`Operation not supported by server: ${uri.toString()}`);
    case SFTP_STATUS.FAILURE:
      if (hint === 'exists' || /exist/i.test(message)) return vscode.FileSystemError.FileExists(uri);
      if (hint === 'notEmpty' || /not empty/i.test(message)) {
        return new vscode.FileSystemError(`Directory not empty: ${uri.toString()}`);
      }
      return new vscode.FileSystemError(`${uri.toString()}: ${message || 'operation failed'}`);
    default:
      if (/is a directory/i.test(message)) return vscode.FileSystemError.FileIsADirectory(uri);
      if (/not a directory/i.test(message)) return vscode.FileSystemError.FileNotADirectory(uri);
      return new vscode.FileSystemError(`${uri.toString()}: ${message}`);
  }
}
