import * as vscode from 'vscode';
import { Logger } from '../util/logger';

const log = new Logger('watch');

export interface WatchTarget {
  uri: vscode.Uri;
  stat(): Promise<vscode.FileStat | undefined>;
}

/**
 * Best-effort change detection for remote files: SFTP has no notifications, so
 * watched URIs are polled for mtime/size changes when polling is enabled.
 * With an interval of 0 the watcher is a no-op (VS Code still reflects our own writes).
 */
export class PollingWatcher implements vscode.Disposable {
  private readonly watched = new Map<
    string,
    { target: WatchTarget; refs: number; last?: { mtime: number; size: number } | null }
  >();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly emit: (events: vscode.FileChangeEvent[]) => void,
    private intervalMs: () => number,
  ) {}

  watch(target: WatchTarget): vscode.Disposable {
    const key = target.uri.toString();
    const entry = this.watched.get(key);
    if (entry) {
      entry.refs++;
    } else {
      this.watched.set(key, { target, refs: 1 });
    }
    this.ensureTimer();
    return new vscode.Disposable(() => {
      const e = this.watched.get(key);
      if (!e) return;
      if (--e.refs <= 0) this.watched.delete(key);
      if (this.watched.size === 0) this.stopTimer();
    });
  }

  /** Call when settings change so a new interval takes effect. */
  refresh(): void {
    this.stopTimer();
    this.ensureTimer();
  }

  private ensureTimer(): void {
    const ms = this.intervalMs();
    if (this.timer || ms <= 0 || this.watched.size === 0) return;
    this.timer = setInterval(() => void this.poll(), Math.max(1000, ms));
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const events: vscode.FileChangeEvent[] = [];
      for (const entry of [...this.watched.values()]) {
        let st: vscode.FileStat | undefined;
        try {
          st = await entry.target.stat();
        } catch {
          continue; // connection trouble: skip this round
        }
        const prev = entry.last;
        if (prev === undefined) {
          entry.last = st ? { mtime: st.mtime, size: st.size } : null;
          continue;
        }
        if (!st) {
          if (prev !== null) events.push({ type: vscode.FileChangeType.Deleted, uri: entry.target.uri });
          entry.last = null;
        } else if (prev === null) {
          events.push({ type: vscode.FileChangeType.Created, uri: entry.target.uri });
          entry.last = { mtime: st.mtime, size: st.size };
        } else if (prev.mtime !== st.mtime || prev.size !== st.size) {
          events.push({ type: vscode.FileChangeType.Changed, uri: entry.target.uri });
          entry.last = { mtime: st.mtime, size: st.size };
        }
      }
      if (events.length > 0) {
        log.debug(`Detected ${events.length} remote change(s)`);
        this.emit(events);
      }
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.stopTimer();
    this.watched.clear();
  }
}
