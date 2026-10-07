import type { IDisposable } from './disposable';

export type Listener<T> = (e: T) => unknown;
export type Event<T> = (listener: Listener<T>) => IDisposable;

/** Tiny typed event emitter (keeps the ssh layer independent of the vscode module). */
export class Emitter<T> implements IDisposable {
  private listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // Listeners must not break the emitter.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
