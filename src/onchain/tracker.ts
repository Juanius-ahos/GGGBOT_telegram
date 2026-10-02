import { config } from '../config.js';
import type { WatchToken } from '../db/index.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { fetchBestPairs } from '../sources/dexscreener.js';
import { geckoterminal } from '../sources/geckoterminal.js';
import { solanaRpc } from '../sources/solanaRpc.js';
import type { Candle } from '../patterns/types.js';
import { CandleSeries, classifySlot } from './candles.js';
import { baseIntervalFor } from '../patterns/timeframes.js';
import { decodeMintDecimals, decodePool, decodeTokenAccount, rawPriceFromPoolAccount, type PoolLayout } from './pools.js';
import { SolanaWsPool, wsUrlFor } from './ws.js';

const log = logger.child({ mod: 'live' });

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Token-2022 extensions whose UI amount differs from the raw amount; raw on-chain prices would be off. */
const UI_SCALING_EXTENSIONS = new Set([10 /* InterestBearingConfig */, 25 /* ScaledUiAmount */]);

/** True when a Token-2022 mint carries an extension that rescales displayed balances. */
export function hasUiScaling(owner: string, data: Buffer): boolean {
  if (owner !== TOKEN_2022 || data.length <= 166) return false;
  let off = 166; // 82-byte base mint, padded to 165, then 1-byte account type
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    if (type === 0 && len === 0) break;
    if (UI_SCALING_EXTENSIONS.has(type)) return true;
    off += 4 + len;
  }
  return false;
}

interface Pool {
  token: WatchToken;
  layout: PoolLayout;
  tokenIsA: boolean;
  quoteMint: string;
  decA: number;
  decB: number;
  balA: bigint;
  balB: bigint;
  /** Concentrated-liquidity price of A in B (decimal-adjusted), from the pool account. */
  clPriceAB: number | null;
  pending: { slot: number; dA: bigint; dB: bigint; at: number } | null;
  series: CandleSeries;
  seededAt: number;
  /** Set after a websocket gap; detection pauses until a fresh seed. */
  dirty: boolean;
  swaps: number;
  liveVolumeUsd: number;
}

/** USD prices of quote tokens (SOL, USDC, meme quotes...), refreshed from DexScreener every minute. */
class QuotePrices {
  private prices = new Map<string, number>();
  private wanted = new Set<string>();

  get(mint: string): number | undefined {
    return this.prices.get(mint);
  }

  async ensure(mint: string): Promise<number | undefined> {
    this.wanted.add(mint);
    if (!this.prices.has(mint)) await this.refresh([mint]);
    return this.prices.get(mint);
  }

  async refresh(mints = [...this.wanted]): Promise<void> {
    if (mints.length === 0) return;
    try {
      const best = await fetchBestPairs(mints, 30_000);
      for (const [mint, pair] of best) {
        const p = Number(pair.priceUsd);
        if (p > 0) this.prices.set(mint, p);
      }
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'quote price refresh failed; keeping last values');
    }
  }
}

export type SetupResult = 'live' | 'unsupported';

/** Running accuracy of live candles vs GeckoTerminal, measured at every re-sync. */
export interface DriftStats {
  candles: number;
  closeErrPctSum: number;
  highErrPctSum: number;
  lowErrPctSum: number;
  liveVolume: number;
  gtVolume: number;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/**
 * Builds 15m candles (rolled up to 1h/4h by the scanner) for watchlist pools from on-chain vault/pool account updates.
 * History is seeded once from GeckoTerminal; after that the chain keeps candles current,
 * so GeckoTerminal is only needed for seeds, periodic re-syncs and alert confirmation.
 */
export class LiveTracker {
  private pools = new Map<string, Pool>(); // token address -> pool
  private unsupported = new Map<string, string>(); // token address -> reason
  private setupQueue: WatchToken[] = [];
  private queued = new Set<string>();
  private inSetup = new Set<string>();
  private ws: SolanaWsPool;
  readonly quotes = new QuotePrices();
  private loops: NodeJS.Timeout[] = [];
  readonly drift: DriftStats = { candles: 0, closeErrPctSum: 0, highErrPctSum: 0, lowErrPctSum: 0, liveVolume: 0, gtVolume: 0 };
  private running: Promise<void> | null = null;
  private stopped = false;
  /**
   * Called with the GeckoTerminal history fetched for every seed / re-sync. That history is exactly what
   * the scanner needs, so scanning it here saves a second GeckoTerminal call per token.
   */
  onSeed: ((token: WatchToken, base: Candle[], baseSec: number) => void) | null = null;

  constructor() {
    this.ws = new SolanaWsPool(wsUrlFor(config.rpcUrl), (accounts) => {
      // Missed updates while that connection was down: those pools' candles have a hole -> re-seed them.
      const missed = new Set(accounts);
      let n = 0;
      for (const p of this.pools.values()) {
        if (missed.has(p.layout.vaultA) || missed.has(p.layout.vaultB) || missed.has(p.token.pair_address)) {
          p.dirty = true;
          n++;
        }
      }
      log.warn({ pools: n }, 'websocket gap; affected pools marked for re-seed');
      this.kick();
    });
  }

  start(): void {
    this.ws.start();
    this.loops.push(setInterval(() => this.flushPending(), 1000));
    this.loops.push(setInterval(() => void this.quotes.refresh(), 60_000));
    this.loops.push(setInterval(() => this.kick(), 15_000));
  }

  stop(): void {
    this.stopped = true;
    this.loops.forEach(clearInterval);
    this.ws.stop();
  }

  /** Live and safe to use for detection. */
  isLive(address: string): boolean {
    const p = this.pools.get(address);
    return !!p && !p.dirty && p.seededAt > 0;
  }

  /**
   * Live, re-syncing, or waiting for setup: these get scanned from their seed fetch, so the
   * GeckoTerminal rotation can skip them. Only pools that can't be tracked on-chain stay in the rotation.
   */
  isCovered(address: string): boolean {
    return this.pools.has(address) || this.queued.has(address);
  }

  stats() {
    let dirty = 0;
    let swaps = 0;
    for (const p of this.pools.values()) {
      if (p.dirty) dirty++;
      swaps += p.swaps;
    }
    return {
      live: this.pools.size - dirty,
      reseeding: dirty,
      settingUp: this.setupQueue.length,
      unsupported: this.unsupported.size,
      subscriptions: this.ws.size,
      connections: this.ws.connections,
      wsConnected: this.ws.connected,
      swaps,
    };
  }

  /** Current on-chain USD price for a live pool, or null when not live. */
  priceNow(address: string): number | null {
    const p = this.pools.get(address);
    return p && !p.dirty && p.seededAt > 0 ? this.priceUsd(p) : null;
  }

  /** Live 15m candles (incl. the forming one) for a live pool, or null. */
  seriesFor(address: string): CandleSeries | null {
    const p = this.pools.get(address);
    return p && !p.dirty && p.seededAt > 0 ? p.series : null;
  }

  livePools(): { token: WatchToken; series: CandleSeries }[] {
    return [...this.pools.values()].filter((p) => !p.dirty && p.seededAt > 0).map((p) => ({ token: p.token, series: p.series }));
  }

  /** Align tracked pools with the rug-passed watchlist. */
  sync(tokens: WatchToken[]): void {
    const want = new Map(tokens.map((t) => [t.address, t]));
    for (const [addr, p] of this.pools) {
      const t = want.get(addr);
      if (!t || t.pair_address !== p.token.pair_address) this.remove(addr);
      else p.token = t; // refresh MC/liquidity snapshot
    }
    // Drop queued set-ups for tokens that left the watchlist (e.g. now above the max market cap), so they
    // don't burn scarce GeckoTerminal calls. A token mid-setup is left alone and removed by the next sync.
    const before = this.setupQueue.length;
    this.setupQueue = this.setupQueue.filter((t) => want.has(t.address));
    for (const addr of [...this.queued]) if (!want.has(addr) && !this.setupQueue.some((t) => t.address === addr) && !this.inSetup.has(addr)) this.queued.delete(addr);
    if (this.setupQueue.length < before) log.info({ dropped: before - this.setupQueue.length }, 'removed queued set-ups no longer on the watchlist');
    for (const t of tokens) {
      if (this.pools.has(t.address) || this.unsupported.has(t.address) || this.queued.has(t.address)) continue;
      this.queued.add(t.address);
      this.setupQueue.push(t);
    }
    // Biggest volume first so the most active tokens go live soonest.
    this.setupQueue.sort((a, b) => b.volume_24h - a.volume_24h);
    this.kick();
  }

  private remove(addr: string): void {
    const p = this.pools.get(addr);
    if (!p) return;
    this.ws.unsubscribe(p.layout.vaultA);
    this.ws.unsubscribe(p.layout.vaultB);
    if (p.layout.priceSource !== 'reserves') this.ws.unsubscribe(p.token.pair_address);
    this.pools.delete(addr);
  }

  /** Runs set-ups, gap re-seeds and periodic re-syncs one at a time (each costs a GeckoTerminal call). */
  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = (async () => {
      try {
        while (!this.stopped) {
          const next = this.setupQueue.shift();
          if (next) {
            this.inSetup.add(next.address);
            // Stays in `queued` until setup finishes, so a concurrent sync() can't queue it twice.
            await this.setup(next)
              .catch((err) => {
                this.unsupported.set(next.address, `setup error: ${errMsg(err)}`);
                log.warn({ token: next.symbol, err: errMsg(err) }, 'live setup failed; using GT rotation');
              })
              .finally(() => {
                this.queued.delete(next.address);
                this.inSetup.delete(next.address);
              });
            continue;
          }
          const resyncMs = config.live.resyncHours * 3_600_000;
          const due = [...this.pools.values()]
            .filter((p) => p.dirty || Date.now() - p.seededAt > resyncMs)
            .sort((a, b) => Number(b.dirty) - Number(a.dirty) || a.seededAt - b.seededAt)[0];
          if (!due) break;
          await this.seed(due).catch((err) => log.warn({ token: due.token.symbol, err: errMsg(err) }, 're-seed failed'));
        }
      } finally {
        this.running = null;
      }
    })();
  }

  private async setup(t: WatchToken): Promise<SetupResult> {
    const reject = (reason: string): SetupResult => {
      this.unsupported.set(t.address, reason);
      log.info({ token: t.symbol, dex: t.dex_id, reason }, 'not live-trackable; using GT rotation');
      return 'unsupported';
    };

    const [poolAcc] = await solanaRpc.multipleAccounts([t.pair_address]);
    if (!poolAcc) return reject('pool account not found');
    const layout = decodePool(poolAcc.owner, poolAcc.data);
    if (!layout) return reject(`pool program not supported (${poolAcc.owner.slice(0, 8)})`);
    const tokenIsA = layout.mintA === t.address;
    if (!tokenIsA && layout.mintB !== t.address) return reject('token not in decoded pool');
    const quoteMint = tokenIsA ? layout.mintB : layout.mintA;

    const [mintA, mintB, vaultA, vaultB] = await solanaRpc.multipleAccounts([layout.mintA, layout.mintB, layout.vaultA, layout.vaultB]);
    if (!mintA || !mintB || !vaultA || !vaultB) return reject('mint/vault account missing');
    if (hasUiScaling(mintA.owner, mintA.data) || hasUiScaling(mintB.owner, mintB.data)) return reject('Token-2022 UI-scaled amounts');
    const decA = decodeMintDecimals(mintA.data);
    const decB = decodeMintDecimals(mintB.data);
    const va = decodeTokenAccount(vaultA.data);
    const vb = decodeTokenAccount(vaultB.data);
    if (decA === null || decB === null || !va || !vb) return reject('undecodable mint/vault');
    // Layout self-check: the vaults we read must hold exactly the pool's two mints.
    if (va.mint !== layout.mintA || vb.mint !== layout.mintB) return reject('vault mint mismatch (layout check failed)');

    const quoteUsd = await this.quotes.ensure(quoteMint);
    if (!quoteUsd) return reject('no USD price for quote token');

    const pool: Pool = {
      token: t, layout, tokenIsA, quoteMint, decA, decB, balA: va.amount, balB: vb.amount,
      clPriceAB: null, pending: null, series: new CandleSeries(baseIntervalFor(t.pair_created_at, config.youngTokenHours).sec), seededAt: 0, dirty: false, swaps: 0, liveVolumeUsd: 0,
    };
    if (layout.priceSource !== 'reserves') {
      const raw = rawPriceFromPoolAccount(layout, poolAcc.data);
      if (raw === null) return reject('undecodable pool price');
      pool.clPriceAB = raw * 10 ** (decA - decB);
    }

    // Subscribe before seeding so nothing is missed between the seed and the first update.
    this.pools.set(t.address, pool);
    const subscribed =
      this.ws.subscribe(layout.vaultA, (u) => this.onVault(pool, 'A', u.slot, u.data)) &&
      this.ws.subscribe(layout.vaultB, (u) => this.onVault(pool, 'B', u.slot, u.data)) &&
      (layout.priceSource === 'reserves' || this.ws.subscribe(t.pair_address, (u) => this.onPoolAccount(pool, u.data)));
    if (!subscribed) {
      this.remove(t.address);
      return reject('websocket capacity reached');
    }

    const ok = await this.seed(pool);
    if (!ok) {
      this.remove(t.address);
      return reject('on-chain price disagrees with GeckoTerminal (sanity check failed)');
    }
    log.info({ token: t.symbol, kind: layout.kind, price: this.priceUsd(pool) }, 'live tracking');
    return 'live';
  }

  /** Loads history from GeckoTerminal and sanity-checks the on-chain price against it. */
  private async seed(p: Pool): Promise<boolean> {
    if (p.seededAt > 0) {
      // Re-seed: reload balances/price so changes made during a gap aren't booked as one giant swap.
      const keys = [p.layout.vaultA, p.layout.vaultB, ...(p.layout.priceSource !== 'reserves' ? [p.token.pair_address] : [])];
      const [va, vb, poolAcc] = await solanaRpc.multipleAccounts(keys);
      const a = va && decodeTokenAccount(va.data);
      const b = vb && decodeTokenAccount(vb.data);
      if (!a || !b) return false;
      p.pending = null;
      p.balA = a.amount;
      p.balB = b.amount;
      if (poolAcc) {
        const raw = rawPriceFromPoolAccount(p.layout, poolAcc.data);
        if (raw !== null) p.clPriceAB = raw * 10 ** (p.decA - p.decB);
      }
    }
    const base = baseIntervalFor(p.token.pair_created_at, config.youngTokenHours);
    const candles = await geckoterminal.ohlcv(p.token.pair_address, p.token.address, {
      timeframe: 'minute',
      aggregate: base.aggregate,
      limit: config.scan.candleLimit,
    });
    if (candles.length === 0) return false;
    const chainPrice = this.priceUsd(p);
    const gtPrice = candles[candles.length - 1].close;
    const deviation = chainPrice ? Math.abs(chainPrice - gtPrice) / gtPrice : Infinity;
    if (p.seededAt > 0 && !p.dirty) this.measureDrift(p, candles);
    if (deviation > config.live.maxSeedDeviationPct / 100) {
      log.info({ token: p.token.symbol, chainPrice, gtPrice, deviationPct: +(deviation * 100).toFixed(1) }, 'seed sanity check failed');
      return false;
    }
    // A token that aged past the 5m window switches to a 15m base on its next re-sync.
    if (p.series.intervalSec !== base.sec) p.series = new CandleSeries(base.sec);
    p.series.seed(candles);
    p.seededAt = Date.now();
    p.dirty = false;
    this.onSeed?.(p.token, candles, base.sec);
    return true;
  }

  /** Compares candles built purely from chain updates since the last seed with GeckoTerminal's. */
  private measureDrift(p: Pool, gt: Candle[]): void {
    const iv = p.series.intervalSec;
    const firstLive = Math.floor(p.seededAt / 1000 / iv) * iv + iv; // first bucket fully observed live
    const gtByTime = new Map(gt.map((c) => [c.time, c]));
    const closeErr: number[] = [];
    let liveVol = 0;
    let gtVol = 0;
    for (const c of p.series.closed(Date.now() / 1000)) {
      if (c.time < firstLive) continue;
      const g = gtByTime.get(c.time);
      if (!g) continue;
      const ce = (Math.abs(c.close - g.close) / g.close) * 100;
      closeErr.push(ce);
      this.drift.candles++;
      this.drift.closeErrPctSum += ce;
      this.drift.highErrPctSum += (Math.abs(c.high - g.high) / g.high) * 100;
      this.drift.lowErrPctSum += (Math.abs(c.low - g.low) / g.low) * 100;
      liveVol += c.volume;
      gtVol += g.volume;
    }
    if (!closeErr.length) return;
    this.drift.liveVolume += liveVol;
    this.drift.gtVolume += gtVol;
    log.info(
      {
        token: p.token.symbol,
        kind: p.layout.kind,
        candles: closeErr.length,
        medianCloseErrPct: +median(closeErr).toFixed(2),
        volumeLiveVsGt: gtVol ? +(liveVol / gtVol).toFixed(2) : null,
      },
      'live vs GT accuracy',
    );
  }

  private priceUsd(p: Pool): number | null {
    const quoteUsd = this.quotes.get(p.quoteMint);
    if (!quoteUsd) return null;
    let priceAB: number | null;
    if (p.layout.priceSource === 'reserves') {
      if (p.balA === 0n || p.balB === 0n) return null;
      priceAB = Number(p.balB) / 10 ** p.decB / (Number(p.balA) / 10 ** p.decA);
    } else {
      priceAB = p.clPriceAB;
    }
    if (!priceAB || !Number.isFinite(priceAB)) return null;
    return (p.tokenIsA ? priceAB : 1 / priceAB) * quoteUsd;
  }

  private onVault(p: Pool, side: 'A' | 'B', slot: number, data: Buffer): void {
    const acc = decodeTokenAccount(data);
    if (!acc) return;
    if (p.pending && p.pending.slot !== slot) this.finalize(p);
    if (!p.pending) p.pending = { slot, dA: 0n, dB: 0n, at: Date.now() };
    if (side === 'A') {
      p.pending.dA += acc.amount - p.balA;
      p.balA = acc.amount;
    } else {
      p.pending.dB += acc.amount - p.balB;
      p.balB = acc.amount;
    }
  }

  private onPoolAccount(p: Pool, data: Buffer): void {
    const raw = rawPriceFromPoolAccount(p.layout, data);
    if (raw === null) return;
    p.clPriceAB = raw * 10 ** (p.decA - p.decB);
    const price = this.priceUsd(p);
    if (price) p.series.tick(Date.now() / 1000, price, 0);
  }

  /** Closes out one slot's vault changes: swap volume + post-slot price. */
  private finalize(p: Pool): void {
    const pend = p.pending;
    p.pending = null;
    if (!pend) return;
    const kind = classifySlot(pend.dA, pend.dB);
    let volumeUsd = 0;
    if (kind === 'swap') {
      const dQuote = p.tokenIsA ? pend.dB : pend.dA;
      const decQ = p.tokenIsA ? p.decB : p.decA;
      const abs = dQuote < 0n ? -dQuote : dQuote;
      volumeUsd = (Number(abs) / 10 ** decQ) * (this.quotes.get(p.quoteMint) ?? 0);
      p.swaps++;
      p.liveVolumeUsd += volumeUsd;
    }
    const price = this.priceUsd(p);
    if (price) p.series.tick(pend.at / 1000, price, volumeUsd);
  }

  /** Slots that saw only one vault update (or the last slot before a quiet period) get flushed here. */
  private flushPending(): void {
    const cutoff = Date.now() - 1500;
    for (const p of this.pools.values()) if (p.pending && p.pending.at < cutoff) this.finalize(p);
  }
}
