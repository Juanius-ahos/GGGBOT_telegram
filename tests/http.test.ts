import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/http.js';

describe('RateLimiter', () => {
  it('spaces calls by the configured rate', async () => {
    const l = new RateLimiter('t', 600); // 100ms spacing
    const times: number[] = [];
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => l.schedule(async () => times.push(Date.now() - t0))));
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(95);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(95);
  });

  it('keeps the queue alive after a task throws', async () => {
    const l = new RateLimiter('t', 6000);
    await expect(l.schedule(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(l.schedule(async () => 42)).resolves.toBe(42);
  });

  it('serves waiting high-priority calls before low ones', async () => {
    const l = new RateLimiter('t', 1200); // 50ms spacing
    const order: string[] = [];
    const first = l.schedule(async () => order.push('first'));
    const rest = [
      l.schedule(async () => order.push('low'), 'low'),
      l.schedule(async () => order.push('high'), 'high'),
    ];
    await Promise.all([first, ...rest]);
    expect(order).toEqual(['first', 'high', 'low']);
  });

  it('widens spacing on 429 (max 4x) and recovers after successes', () => {
    const l = new RateLimiter('t', 60); // 1000ms
    for (let i = 0; i < 10; i++) l.penalize();
    expect(l.intervalMs).toBe(4000);
    for (let i = 0; i < 1000; i++) l.reward();
    expect(l.intervalMs).toBe(1000);
  });
});
