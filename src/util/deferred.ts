/** A promise whose resolution is controlled externally. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason?: unknown) => void;
  private settledFlag = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // Avoid unhandled-rejection noise when nobody awaits a rejected deferred.
    this.promise.catch(() => undefined);
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.resolveFn(value);
  }

  reject(reason?: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.rejectFn(reason);
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Rejects with {@link TimeoutError} if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
