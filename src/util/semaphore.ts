/** Counting semaphore limiting the number of concurrent asynchronous operations. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private limit: number) {
    if (limit < 1) throw new RangeError('Semaphore limit must be >= 1');
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.drain();
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    // The slot is reserved by drain() on our behalf before we resume.
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return this.releaser();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.active++;
      next();
    }
  }
}
