import { describe, expect, it } from 'vitest';
import { expandEnv, expandPath, expandTilde } from '../../src/platform/paths';
import { Deferred, TimeoutError, withTimeout } from '../../src/util/deferred';
import { Semaphore } from '../../src/util/semaphore';

describe('Semaphore', () => {
  it('limits concurrency and drains the queue in order', async () => {
    const s = new Semaphore(2);
    let running = 0;
    let max = 0;
    const order: number[] = [];
    const task = (i: number) =>
      s.run(async () => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
        running--;
      });
    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(max).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(s.running).toBe(0);
    expect(s.pending).toBe(0);
  });

  it('releases the slot even when the task throws', async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(s.running).toBe(0);
    await s.run(async () => undefined);
  });
});

describe('Deferred / withTimeout', () => {
  it('resolves once', async () => {
    const d = new Deferred<number>();
    d.resolve(1);
    d.resolve(2);
    expect(await d.promise).toBe(1);
    expect(d.settled).toBe(true);
  });

  it('times out', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toBeInstanceOf(TimeoutError);
    expect(await withTimeout(Promise.resolve('ok'), 10)).toBe('ok');
  });
});

describe('paths', () => {
  const env = { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1' };
  it('expands env vars and tilde', () => {
    expect(expandEnv('${XDG_RUNTIME_DIR}/ssh-auth', env)).toBe('/run/user/1/ssh-auth');
    expect(expandEnv('$HOME/x', env)).toBe('/home/me/x');
    expect(expandEnv('${MISSING}/x', env)).toBe('/x');
    expect(expandTilde('~/.ssh')).toMatch(/\/\.ssh$/);
    expect(expandPath('~/.1password/agent.sock', env)).toMatch(/\/\.1password\/agent\.sock$/);
  });
});
