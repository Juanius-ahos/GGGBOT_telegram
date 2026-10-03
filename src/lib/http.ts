import { logger } from '../logger.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

export type Priority = 'high' | 'low';

/** A low-priority request waiting longer than this is served like a high one, so it can't starve. */
const LOW_PRIORITY_MAX_WAIT_MS = 10 * 60_000;

/**
 * Serial request queue that spaces calls evenly to stay under `perMinute`.
 * High-priority requests go first; low ones (background refreshes) use the slots left over.
 * A 429 pauses the whole queue (`cooldown`) and widens the spacing (`penalize`, up to 4x);
 * successes slowly bring it back to the configured rate (`reward`). Free APIs often enforce
 * less than they document, so the limiter adapts instead of trusting the number.
 */
export class RateLimiter {
  private readonly waiting: Record<Priority, { at: number; go: () => void }[]> = { high: [], low: [] };
  private pumping = false;
  private nextSlot = 0;
  private pausedUntil = 0;
  private pending = 0;
  private readonly baseIntervalMs: number;
  private currentIntervalMs: number;
  private successStreak = 0;
  /** 429s seen since start (diagnostics). */
  rateLimitHits = 0;
  /** Requests completed since start (diagnostics). */
  completed = 0;

  constructor(readonly name: string, readonly perMinute: number) {
    this.baseIntervalMs = Math.ceil(60_000 / Math.max(perMinute, 0.1));
    this.currentIntervalMs = this.baseIntervalMs;
  }

  get queued(): number {
    return this.pending;
  }

  get intervalMs(): number {
    return this.currentIntervalMs;
  }

  penalize(): void {
    this.rateLimitHits++;
    this.successStreak = 0;
    this.currentIntervalMs = Math.min(this.baseIntervalMs * 4, Math.ceil(this.currentIntervalMs * 1.5));
  }

  reward(): void {
    this.completed++;
    if (this.currentIntervalMs === this.baseIntervalMs) return;
    if (++this.successStreak >= 10) {
      this.successStreak = 0;
      this.currentIntervalMs = Math.max(this.baseIntervalMs, Math.floor(this.currentIntervalMs * 0.9));
    }
  }

  cooldown(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  schedule<T>(fn: () => Promise<T>, priority: Priority = 'high'): Promise<T> {
    this.pending++;
    const slot = new Promise<void>((go) => this.waiting[priority].push({ at: Date.now(), go }));
    void this.pump();
    return slot.then(fn).finally(() => this.pending--);
  }

  /** Hands out slots one at a time; re-checks the queues after every wait so a new high request jumps ahead. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.high.length || this.waiting.low.length) {
        const wait = Math.max(this.nextSlot, this.pausedUntil) - Date.now();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const low = this.waiting.low[0];
        const next = low && Date.now() - low.at > LOW_PRIORITY_MAX_WAIT_MS ? this.waiting.low.shift() : (this.waiting.high.shift() ?? this.waiting.low.shift());
        this.nextSlot = Date.now() + this.currentIntervalMs;
        next?.go();
      }
    } finally {
      this.pumping = false;
    }
  }
}

class TtlCache {
  private store = new Map<string, { expires: number; value: unknown }>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.store.size > 5000) {
      const now = Date.now();
      for (const [k, v] of this.store) if (v.expires < now) this.store.delete(k);
    }
    this.store.set(key, { expires: Date.now() + ttlMs, value });
  }
}

export const httpCache = new TtlCache();

export interface FetchJsonOptions {
  limiter: RateLimiter;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Cache successful responses for this long. */
  cacheTtlMs?: number;
  cacheKey?: string;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** 'low' = background work that should yield to everything else on this limiter. */
  priority?: Priority;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Rate-limited JSON fetch with timeout, exponential backoff + jitter, Retry-After support and caching.
 * Retries 408/429/5xx and network errors; other 4xx fail fast.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const key = opts.cacheKey ?? (opts.method === 'POST' ? undefined : url);
  if (opts.cacheTtlMs && key) {
    const cached = httpCache.get<T>(key);
    if (cached !== undefined) return cached;
  }

  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await opts.limiter.schedule(() =>
        fetch(url, {
          method: opts.method ?? 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'ggg-bot/1.0',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        }),
        opts.priority,
      );

      if (res.ok) {
        opts.limiter.reward();
        const data = (await res.json()) as T;
        if (opts.cacheTtlMs && key) httpCache.set(key, data, opts.cacheTtlMs);
        return data;
      }

      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      lastErr = new HttpError(res.status, `${opts.limiter.name} HTTP ${res.status}`, text.slice(0, 300));
      if (!retryable || attempt === retries) throw lastErr;

      // Some APIs send `Retry-After: 0` on 429; never trust a value below our own backoff floor.
      const exp = (res.status === 429 ? 10_000 : 2000) * 2 ** attempt + Math.random() * 1000;
      const backoff = Math.max(retryAfterMs(res) ?? 0, exp);
      if (res.status === 429) {
        opts.limiter.penalize();
        opts.limiter.cooldown(backoff);
        logger.warn(
          { source: opts.limiter.name, attempt, backoffMs: Math.round(backoff), intervalMs: opts.limiter.intervalMs },
          'rate limited, backing off',
        );
      }
      await sleep(backoff);
    } catch (err) {
      if (err instanceof HttpError && !(err.status === 429 || err.status === 408 || err.status >= 500)) throw err;
      lastErr = err;
      if (attempt === retries) break;
      await sleep(2000 * 2 ** attempt + Math.random() * 1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
