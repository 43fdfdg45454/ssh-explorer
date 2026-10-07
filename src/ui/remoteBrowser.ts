import * as vscode from 'vscode';
import { buildSshUri, remoteDirname, remoteJoin } from '../fs/uri';
import type { Connection } from '../ssh/connection';
import * as ops from '../fs/sftpOps';
import * as sudoOps from '../fs/sudoOps';
import { sftpStatus, SFTP_STATUS } from '../ssh/errors';
import { errorMessage } from '../util/logger';

interface EntryItem extends vscode.QuickPickItem {
  entry: 'dir' | 'file' | 'up' | 'addFolder' | 'openHere';
  path: string;
}

export interface BrowseResult {
  kind: 'file' | 'folder';
  path: string;
}

const S_IFDIR = 0o040000;
const S_IFMT = 0o170000;

/** Lists `dir` as [name, isDirectory]; falls back to sudo when the profile allows it. */
async function listDirectory(conn: Connection, dir: string): Promise<[string, boolean][]> {
  try {
    return await conn.withSftp(
      async (sftp) => {
        const out: [string, boolean][] = [];
        for (const e of await ops.readdir(sftp, dir)) {
          if (e.filename === '.' || e.filename === '..') continue;
          let isDir = (e.attrs.mode & S_IFMT) === S_IFDIR;
          if ((e.attrs.mode & S_IFMT) === 0o120000) {
            try {
              isDir = ((await ops.stat(sftp, remoteJoin(dir, e.filename))).mode & S_IFMT) === S_IFDIR;
            } catch {
              // dangling link
            }
          }
          out.push([e.filename, isDir]);
        }
        return out;
      },
      { idempotent: true },
    );
  } catch (err) {
    if (!conn.profile.sudo || sftpStatus(err) !== SFTP_STATUS.PERMISSION_DENIED) throw err;
    const entries = await sudoOps.readdir(conn.sudo, buildSshUri(conn.name, dir), dir);
    return entries.map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0]);
  }
}

/**
 * Keyboard-driven remote directory navigator built on QuickPick. Returns the
 * file to open or the folder to add to the workspace, or undefined when cancelled.
 */
export async function browseRemote(
  conn: Connection,
  startPath: string,
  mode: 'any' | 'folder' | 'file' = 'any',
): Promise<BrowseResult | undefined> {
  const qp = vscode.window.createQuickPick<EntryItem>();
  qp.title = `SSH Explorer: ${conn.name}`;
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  let current = startPath;

  const load = async (dir: string) => {
    qp.busy = true;
    qp.placeholder = dir;
    try {
      const entries = await listDirectory(conn, dir);
      const items: EntryItem[] = [];
      if (mode !== 'file') {
        items.push({
          entry: 'addFolder',
          path: dir,
          label: '$(folder-opened) Add this folder to the workspace',
          description: dir,
          alwaysShow: true,
        });
      }
      if (dir !== '/') {
        items.push({ entry: 'up', path: remoteDirname(dir), label: '$(arrow-up) ..', alwaysShow: true });
      }
      const dirs: EntryItem[] = [];
      const files: EntryItem[] = [];
      for (const [name, isDir] of entries) {
        const full = remoteJoin(dir, name);
        if (isDir) dirs.push({ entry: 'dir', path: full, label: `$(folder) ${name}` });
        else if (mode !== 'folder') files.push({ entry: 'file', path: full, label: `$(file) ${name}` });
      }
      const sortByLabel = (a: EntryItem, b: EntryItem) => a.label.localeCompare(b.label);
      qp.items = [...items, ...dirs.sort(sortByLabel), ...files.sort(sortByLabel)];
      current = dir;
    } catch (err) {
      void vscode.window.showErrorMessage(`SSH Explorer: cannot list ${dir}: ${errorMessage(err)}`);
      if (dir !== startPath) await load(startPath);
    } finally {
      qp.busy = false;
    }
  };

  return new Promise<BrowseResult | undefined>((resolve) => {
    let settled = false;
    const done = (r: BrowseResult | undefined) => {
      if (settled) return;
      settled = true;
      qp.hide();
      qp.dispose();
      resolve(r);
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (!item) return;
      qp.value = '';
      switch (item.entry) {
        case 'dir':
        case 'up':
          void load(item.path);
          break;
        case 'file':
          done({ kind: 'file', path: item.path });
          break;
        case 'addFolder':
        case 'openHere':
          done({ kind: 'folder', path: item.path });
          break;
      }
    });
    qp.onDidHide(() => done(undefined));
    qp.show();
    void load(current);
  });
}

export function uriFor(conn: Connection, remotePath: string): vscode.Uri {
  return buildSshUri(conn.name, remotePath);
}
