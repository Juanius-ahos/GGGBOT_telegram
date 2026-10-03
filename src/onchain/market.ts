import crypto from 'node:crypto';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { config } from '../config.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { aggregate } from '../patterns/timeframes.js';
import type { Candle } from '../patterns/types.js';
import { solanaRpc } from '../sources/solanaRpc.js';
import { CandleSeries } from './candles.js';
import { decodeMintDecimals, decodePool, PROGRAMS } from './pools.js';
import { wsUrlFor } from './ws.js';

const log = logger.child({ mod: 'market' });

/**
 * DEX programs whose swaps carry the pool address in their logged events (checked against live data, Oct 2026).
 * Meteora DLMM (self-CPI events) and Raydium AMM v4 (ray_log has no pool) don't, so they stay on the feeds.
 */
const STREAMED = ['pumpswap', 'raydiumCpmm', 'raydiumClmm', 'orcaWhirlpool'] as const;
type StreamedKind = (typeof STREAMED)[number];

const disc = (name: string) => crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const PUMP_BUY = disc('BuyEvent');
const PUMP_SELL = disc('SellEvent');
const SWAP_EVENT = disc('SwapEvent'); // same name in Raydium CPMM and CLMM; told apart by the emitting program
const ORCA_TRADED = disc('Traded');

/** Quote tokens a coin can be priced against. Anything else (meme/meme pools) is skipped. */
export const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** One decoded swap: price of A in B (decimal-adjusted) after the trade, raw amounts of each side, optional reserves. */
export interface SwapEvent {
  pool: string;
  kind: StreamedKind;
  /** Raw token amounts moved on each side of the pool. */
  amountA: bigint;
  amountB: bigint;
  /** Post-trade price as raw B per raw A, or null when it must come from reserves. */
  rawPriceBA: number | null;
  /** Post-trade reserves (raw), when the event carries them. */
  reserveA?: bigint;
  reserveB?: bigint;
}

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const key = (b: Buffer, o: number) => bs58.encode(b.subarray(o, o + 32));
const sqrtToPrice = (x64: bigint) => {
  const s = Number(x64) / 2 ** 64;
  return s * s;
};

/**
 * Decodes a `Program data:` payload emitted by `program`. Layouts verified against pool accounts and
 * DexScreener prices on live events (Oct 2026). Returns null for anything that isn't a swap.
 * For Raydium CPMM `mintA` is needed to tell which side the input was.
 */
export function decodeSwap(program: string, data: Buffer, mintAOf?: (pool: string) => string | undefined): SwapEvent | null {
  if (data.length < 16) return null;
  const d = data.subarray(0, 8).toString('hex');
  try {
    if (program === PROGRAMS.pumpswap && (d === PUMP_BUY || d === PUMP_SELL) && data.length >= 152) {
      const buy = d === PUMP_BUY; // buy = base (A) out of the pool, quote (B) in
      const baseAmt = u64(data, 16);
      const quoteAmt = u64(data, 64);
      const baseRes = u64(data, 48); // pre-trade pool reserves
      const quoteRes = u64(data, 56);
      const reserveA = buy ? baseRes - baseAmt : baseRes + baseAmt;
      const reserveB = buy ? quoteRes + quoteAmt : quoteRes - quoteAmt;
      if (reserveA <= 0n || reserveB <= 0n) return null;
      return { pool: key(data, 120), kind: 'pumpswap', amountA: baseAmt, amountB: quoteAmt, rawPriceBA: null, reserveA, reserveB };
    }
    if (program === PROGRAMS.raydiumCpmm && d === SWAP_EVENT && data.length >= 153) {
      const pool = key(data, 8);
      const inBefore = u64(data, 40);
      const outBefore = u64(data, 48);
      const inAmt = u64(data, 56);
      const outAmt = u64(data, 64);
      const inMint = key(data, 89);
      const mintA = mintAOf?.(pool);
      if (!mintA) return { pool, kind: 'raydiumCpmm', amountA: 0n, amountB: 0n, rawPriceBA: null }; // resolve pool first
      const aIsIn = inMint === mintA;
      const reserveA = aIsIn ? inBefore + inAmt : outBefore - outAmt;
      const reserveB = aIsIn ? outBefore - outAmt : inBefore + inAmt;
      if (reserveA <= 0n || reserveB <= 0n) return null;
      return { pool, kind: 'raydiumCpmm', amountA: aIsIn ? inAmt : outAmt, amountB: aIsIn ? outAmt : inAmt, rawPriceBA: null, reserveA, reserveB };
    }
    if (program === PROGRAMS.raydiumClmm && d === SWAP_EVENT && data.length >= 185) {
      return { pool: key(data, 8), kind: 'raydiumClmm', amountA: u64(data, 136), amountB: u64(data, 152), rawPriceBA: sqrtToPrice(u128(data, 169)) };
    }
    if (program === PROGRAMS.orcaWhirlpool && d === ORCA_TRADED && data.length >= 89) {
      const aToB = data[40] === 1;
      const inAmt = u64(data, 73);
      const outAmt = u64(data, 81);
      return { pool: key(data, 8), kind: 'orcaWhirlpool', amountA: aToB ? inAmt : outAmt, amountB: aToB ? outAmt : inAmt, rawPriceBA: sqrtToPrice(u128(data, 57)) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Pool facts needed to price its swaps. `null` = known but not usable (no quote token, odd mint...). */
interface PoolMeta {
  mintA: string;
  mintB: string;
  decA: number;
  decB: number;
  tokenIsA: boolean;
  token: string;
  quoteMint: string;
  /** Token supply in whole tokens, for a market-cap estimate. */
  supply: number;
}

interface Tracked {
  meta: PoolMeta;
  series: CandleSeries;
  firstSeen: number;
  lastTrade: number;
  trades: number;
  lastPriceUsd: number;
  lastMcUsd: number;
  lastLiqUsd: number | null;
  candidateAt: number;
}

export interface MarketStats {
  connected: boolean;
  eventsPerMin: number;
  poolsKnown: number;
  poolsTracked: number;
  candidates: number;
  since: string | null;
}

/**
 * Whole-market view: listens to every swap on the streamed DEXes (Solana `logsSubscribe`, free public RPC),
 * prices it in USD, and keeps 5m candles for every pool whose coin is roughly inside the market filter.
 * Such coins are handed to discovery as candidates, and their candles can seed live tracking without
 * an API call.
 */
export class MarketStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private subIds = new Map<number, string>(); // subscription id -> program
  private meta = new Map<string, PoolMeta | null>();
  private resolving = new Set<string>();
  private toResolve = new Set<string>();
  private tracked = new Map<string, Tracked>();
  private byToken = new Map<string, string>(); // token mint -> pool (deepest seen)
  private events: number[] = [];
  private candidates = 0;
  private startedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private connected = false;

  /** Called with a token mint that is (roughly) inside the market filter. */
  onCandidate: ((mint: string) => void) | null = null;

  constructor(private quoteUsd: (mint: string) => number | undefined) {}

  start(): void {
    this.startedAt = Date.now();
    this.connect();
    this.timers.push(setInterval(() => void this.resolveBatch(), config.stream.resolveEveryMs));
    this.timers.push(setInterval(() => this.evict(), 60_000));
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.ws?.close();
  }

  stats(): MarketStats {
    const cutoff = Date.now() - 60_000;
    this.events = this.events.filter((t) => t > cutoff);
    return {
      connected: this.connected,
      eventsPerMin: this.events.length,
      poolsKnown: this.meta.size,
      poolsTracked: this.tracked.size,
      candidates: this.candidates,
      since: this.startedAt ? new Date(this.startedAt).toISOString() : null,
    };
  }

  /**
   * Candles built from the stream for `pool`, rolled to `baseSec`, if they cover enough history to replace an
   * API download: since the pair was created (we saw it from launch) or at least `minHours`.
   */
  history(pool: string, baseSec: number, pairCreatedAtMs: number, minHours = 48): Candle[] | null {
    const t = this.tracked.get(pool);
    if (!t || t.series.length === 0) return null;
    const first = t.series.all()[0].time * 1000;
    const fromLaunch = pairCreatedAtMs > 0 && first - pairCreatedAtMs <= 10 * 60_000;
    if (!fromLaunch && Date.now() - first < minHours * 3_600_000) return null;
    const base = t.series.all();
    return baseSec === t.series.intervalSec ? base.map((c) => ({ ...c })) : aggregate(base, baseSec);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(wsUrlFor(config.rpcUrl));
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retry = 0;
      STREAMED.forEach((k, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [PROGRAMS[k]] }, { commitment: 'confirmed' }] })));
      log.info({ programs: STREAMED }, 'market stream connected');
    });
    ws.on('message', (raw) => this.handle(raw.toString()));
    ws.on('error', (err) => log.warn({ err: errMsg(err) }, 'market stream error'));
    ws.on('close', () => {
      this.connected = false;
      this.subIds.clear();
      if (this.stopped) return;
      const wait = Math.min(60_000, 1000 * 2 ** this.retry++);
      log.warn({ retryInMs: wait }, 'market stream closed; reconnecting');
      setTimeout(() => this.connect(), wait);
    });
  }

  private handle(raw: string): void {
    let msg: { id?: number; result?: number; params?: { subscription: number; result: { value: { err: unknown; logs: string[] } } } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && typeof msg.result === 'number') {
      this.subIds.set(msg.result, PROGRAMS[STREAMED[msg.id - 1]]);
      return;
    }
    const v = msg.params?.result?.value;
    if (!v || v.err || !Array.isArray(v.logs)) return;
    // Attribute each event to the program frame that logged it (aggregators log their own events too).
    const stack: string[] = [];
    for (const line of v.logs) {
      if (line.startsWith('Program ') && line.includes(' invoke [')) {
        stack.push(line.slice(8, line.indexOf(' ', 8)));
        continue;
      }
      if (line.startsWith('Program ') && (line.endsWith(' success') || line.includes(' failed'))) {
        stack.pop();
        continue;
      }
      if (!line.startsWith('Program data: ')) continue;
      const program = stack[stack.length - 1];
      if (!program) continue;
      const ev = decodeSwap(program, Buffer.from(line.slice(14), 'base64'), (pool) => this.meta.get(pool)?.mintA);
      if (ev) this.onSwap(ev);
    }
  }

  private onSwap(ev: SwapEvent): void {
    this.events.push(Date.now());
    const meta = this.meta.get(ev.pool);
    if (meta === undefined) {
      if (!this.resolving.has(ev.pool)) this.toResolve.add(ev.pool);
      return;
    }
    if (meta === null) return;
    const priceBA = ev.rawPriceBA ?? (ev.reserveA && ev.reserveB ? Number(ev.reserveB) / Number(ev.reserveA) : null);
    if (!priceBA || !Number.isFinite(priceBA)) return;
    const adj = priceBA * 10 ** (meta.decA - meta.decB); // B per A in whole tokens
    const qUsd = this.quoteUsd(meta.quoteMint);
    if (!qUsd || !(adj > 0)) return;
    const priceUsd = (meta.tokenIsA ? adj : 1 / adj) * qUsd;
    const quoteRaw = meta.tokenIsA ? ev.amountB : ev.amountA;
    const quoteDec = meta.tokenIsA ? meta.decB : meta.decA;
    const volumeUsd = (Number(quoteRaw) / 10 ** quoteDec) * qUsd;
    const mcUsd = priceUsd * meta.supply;
    const quoteReserve = meta.tokenIsA ? ev.reserveB : ev.reserveA;
    const liqUsd = quoteReserve !== undefined ? 2 * (Number(quoteReserve) / 10 ** quoteDec) * qUsd : null;

    const m = config.market;
    // Keep candles only for coins near the filter (wide margin, so a coin growing into range has history).
    const near = mcUsd >= m.minMarketCapUsd * config.stream.mcMarginLow && mcUsd <= m.maxMarketCapUsd * config.stream.mcMarginHigh;
    let t = this.tracked.get(ev.pool);
    if (!t) {
      if (!near) return;
      if (this.tracked.size >= config.stream.maxPools) return;
      t = { meta, series: new CandleSeries(config.stream.candleSec, config.stream.maxCandles), firstSeen: Date.now(), lastTrade: 0, trades: 0, lastPriceUsd: 0, lastMcUsd: 0, lastLiqUsd: null, candidateAt: 0 };
      this.tracked.set(ev.pool, t);
    }
    t.series.tick(Date.now() / 1000, priceUsd, volumeUsd);
    t.lastTrade = Date.now();
    t.trades++;
    t.lastPriceUsd = priceUsd;
    t.lastMcUsd = mcUsd;
    if (liqUsd !== null) t.lastLiqUsd = liqUsd;
    const known = this.byToken.get(meta.token);
    if (!known || (this.tracked.get(known)?.lastLiqUsd ?? 0) < (t.lastLiqUsd ?? 0)) this.byToken.set(meta.token, ev.pool);

    // In the filter's range (liquidity when known): hand to discovery for the exact DexScreener + rug checks.
    const inRange = mcUsd >= m.minMarketCapUsd && mcUsd <= m.maxMarketCapUsd && (t.lastLiqUsd === null || t.lastLiqUsd >= m.minLiquidityUsd);
    if (inRange && Date.now() - t.candidateAt > config.stream.candidateEveryMs) {
      t.candidateAt = Date.now();
      this.candidates++;
      this.onCandidate?.(meta.token);
    }
  }

  /** Looks up new pools in batches: pool account -> mints -> decimals + supply. */
  private async resolveBatch(): Promise<void> {
    if (this.toResolve.size === 0 || this.resolving.size > 0) return;
    const pools = [...this.toResolve].slice(0, 100);
    pools.forEach((p) => {
      this.toResolve.delete(p);
      this.resolving.add(p);
    });
    try {
      const accs = await solanaRpc.multipleAccounts(pools);
      const layouts = new Map<string, ReturnType<typeof decodePool>>();
      pools.forEach((p, i) => {
        const a = accs[i];
        layouts.set(p, a ? decodePool(a.owner, a.data) : null);
      });
      const mints = [...new Set([...layouts.values()].flatMap((l) => (l ? [l.mintA, l.mintB] : [])))];
      const mintInfo = new Map<string, { dec: number; supply: bigint } | null>();
      for (let i = 0; i < mints.length; i += 100) {
        const chunk = mints.slice(i, i + 100);
        const res = await solanaRpc.multipleAccounts(chunk);
        chunk.forEach((m, j) => {
          const a = res[j];
          const dec = a ? decodeMintDecimals(a.data) : null;
          mintInfo.set(m, a && dec !== null && a.data.length >= 44 ? { dec, supply: a.data.readBigUInt64LE(36) } : null);
        });
      }
      for (const [pool, l] of layouts) {
        if (!l || !(STREAMED as readonly string[]).includes(l.kind)) {
          this.meta.set(pool, null);
          continue;
        }
        const aQuote = QUOTE_MINTS.has(l.mintA);
        const bQuote = QUOTE_MINTS.has(l.mintB);
        const ia = mintInfo.get(l.mintA);
        const ib = mintInfo.get(l.mintB);
        if (aQuote === bQuote || !ia || !ib) {
          this.meta.set(pool, null); // quote/quote, meme/meme or unreadable mints
          continue;
        }
        const tokenIsA = !aQuote;
        const tok = tokenIsA ? ia : ib;
        this.meta.set(pool, {
          mintA: l.mintA, mintB: l.mintB, decA: ia.dec, decB: ib.dec, tokenIsA,
          token: tokenIsA ? l.mintA : l.mintB, quoteMint: tokenIsA ? l.mintB : l.mintA,
          supply: Number(tok.supply) / 10 ** tok.dec,
        });
      }
    } catch (err) {
      log.warn({ err: errMsg(err), pools: pools.length }, 'pool lookup failed; will retry');
      pools.forEach((p) => this.toResolve.add(p));
    } finally {
      pools.forEach((p) => this.resolving.delete(p));
    }
  }

  /** Drops pools that went quiet or drifted far out of range, so memory stays bounded. */
  private evict(): void {
    const m = config.market;
    const quietMs = config.stream.dropAfterQuietHours * 3_600_000;
    for (const [pool, t] of this.tracked) {
      const far = t.lastMcUsd < m.minMarketCapUsd * config.stream.mcMarginLow * 0.5 || t.lastMcUsd > m.maxMarketCapUsd * config.stream.mcMarginHigh * 2;
      if (far || Date.now() - t.lastTrade > quietMs) {
        this.tracked.delete(pool);
        if (this.byToken.get(t.meta.token) === pool) this.byToken.delete(t.meta.token);
      }
    }
    // Unusable pools are cheap to keep, but don't let the cache grow forever.
    if (this.meta.size > 200_000) this.meta.clear();
  }
}
