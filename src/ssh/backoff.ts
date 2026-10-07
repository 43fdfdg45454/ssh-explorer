export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor?: number;
  /** Jitter ratio in [0, 1); 0.2 = ±20 %. */
  jitter?: number;
  random?: () => number;
}

/** Delay before reconnect attempt number `attempt` (1-based), exponential with jitter. */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const base = Math.min(options.maxMs, options.initialMs * Math.pow(factor, Math.max(0, attempt - 1)));
  const spread = base * jitter;
  const delay = base + (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(Math.min(options.maxMs, delay)));
}
