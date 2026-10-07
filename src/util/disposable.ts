export interface IDisposable {
  dispose(): unknown;
}

/** Collects disposables and disposes them together, in reverse order. */
export class DisposableStore implements IDisposable {
  private items: IDisposable[] = [];
  private disposed = false;

  add<T extends IDisposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
    } else {
      this.items.push(item);
    }
    return item;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items.reverse();
    this.items = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch {
        // Disposal must never throw.
      }
    }
  }
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn };
}
