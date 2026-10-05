import { config } from '../config.js';
import { errMsg } from '../lib/http.js';
import { logger } from '../logger.js';
import { fetchBestPairs } from '../sources/dexscreener.js';
import { solanaRpc } from '../sources/solanaRpc.js';
import { decodeMintDecimals, decodePool, decodeTokenAccount, rawPriceFromPoolAccount, type PoolLayout } from './pools.js';
import { hasUiScaling, QuotePrices } from './tracker.js';
import { SolanaWsPool, wsUrlFor } from './ws.js';

const log = logger.child({ mod: 'price-feed' });

interface Feed {
  token: string;
  pair: string;
  layout: PoolLayout;
  tokenIsA: boolean;
  quoteMint: string;
  decA: number;
  decB: number;
  balA: bigint;
  balB: bigint;
  clPriceAB: number | null;
  lastEmit: number;
}

/**
 * Real-time on-chain price for the few coins with an armed setup (no candles, no GeckoTerminal): subscribes to the
 * pool's vaults / pool account and calls `onPrice` on every change, so a neckline or hammer-high cross is seen within
 * a second or two instead of at the next DexScreener poll. Pools it can't decode are simply left to the poll.
 */
export class SetupPriceFeed {
  private feeds = new Map<string, Feed>(); // token -> feed
  private failed = new Set<string>(); // token:pair combos that can't be fed (unsupported pool, sanity check)
  private pending = new Set<string>();
  private ws: SolanaWsPool;
  private quotes = new QuotePrices();
  private timer: NodeJS.Timeout | null = null;

  constructor(private onPrice: (token: string, priceUsd: number) => void) {
    // A dropped socket just means a few seconds without pushes; the 20s poll still covers every setup.
    this.ws = new SolanaWsPool(wsUrlFor(config.rpcUrl), () => undefined);
  }

  start(): void {
    this.ws.start();
    this.timer = setInterval(() => void this.quotes.refresh(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.stop();
  }

  get size(): number {
    return this.feeds.size;
  }

  /** Make the fed set equal `wanted` (token -> pair address of its armed setups). */
  sync(wanted: Map<string, string>): void {
    for (const [token, f] of this.feeds) {
      if (wanted.get(token) !== f.pair) this.remove(token);
    }
    for (const [token, pair] of wanted) {
      if (this.feeds.size + this.pending.size >= config.setups.priceFeed.maxPools) break;
      if (this.feeds.has(token) || this.pending.has(token) || this.failed.has(`${token}:${pair}`)) continue;
      this.pending.add(token);
      void this.add(token, pair)
        .catch((err) => {
          this.failed.add(`${token}:${pair}`);
          log.debug({ token, err: errMsg(err) }, 'price feed unavailable; DexScreener poll covers it');
        })
        .finally(() => this.pending.delete(token));
    }
  }

  private remove(token: string): void {
    const f = this.feeds.get(token);
    if (!f) return;
    this.ws.unsubscribe(f.layout.vaultA);
    this.ws.unsubscribe(f.layout.vaultB);
    if (f.layout.priceSource !== 'reserves') this.ws.unsubscribe(f.pair);
    this.feeds.delete(token);
  }

  private async add(token: string, pair: string): Promise<void> {
    const [poolAcc] = await solanaRpc.multipleAccounts([pair]);
    if (!poolAcc) throw new Error('pool not found');
    const layout = decodePool(poolAcc.owner, poolAcc.data);
    if (!layout) throw new Error('pool program not supported');
    const tokenIsA = layout.mintA === token;
    if (!tokenIsA && layout.mintB !== token) throw new Error('token not in pool');
    const [mintA, mintB, vaultA, vaultB] = await solanaRpc.multipleAccounts([layout.mintA, layout.mintB, layout.vaultA, layout.vaultB]);
    if (!mintA || !mintB || !vaultA || !vaultB) throw new Error('accounts missing');
    if (hasUiScaling(mintA.owner, mintA.data) || hasUiScaling(mintB.owner, mintB.data)) throw new Error('UI-scaled mint');
    const decA = decodeMintDecimals(mintA.data);
    const decB = decodeMintDecimals(mintB.data);
    const va = decodeTokenAccount(vaultA.data);
    const vb = decodeTokenAccount(vaultB.data);
    if (decA === null || decB === null || !va || !vb || va.mint !== layout.mintA || vb.mint !== layout.mintB) throw new Error('layout check failed');
    const quoteMint = tokenIsA ? layout.mintB : layout.mintA;
    if (!(await this.quotes.ensure(quoteMint))) throw new Error('no quote price');

    const f: Feed = { token, pair, layout, tokenIsA, quoteMint, decA, decB, balA: va.amount, balB: vb.amount, clPriceAB: null, lastEmit: 0 };
    if (layout.priceSource !== 'reserves') {
      const raw = rawPriceFromPoolAccount(layout, poolAcc.data);
      if (raw === null) throw new Error('pool price undecodable');
      f.clPriceAB = raw * 10 ** (decA - decB);
    }
    // Sanity check against DexScreener before trusting the chain price.
    const chain = this.price(f);
    const ds = Number((await fetchBestPairs([token], 15_000)).get(token)?.priceUsd);
    if (!chain || !ds || Math.abs(chain - ds) / ds > config.live.maxSeedDeviationPct / 100) throw new Error(`price check failed (chain ${chain} vs DexScreener ${ds})`);

    this.feeds.set(token, f);
    this.ws.subscribe(layout.vaultA, (u) => this.onVault(f, 'A', u.data));
    this.ws.subscribe(layout.vaultB, (u) => this.onVault(f, 'B', u.data));
    if (layout.priceSource !== 'reserves') this.ws.subscribe(pair, (u) => this.onPool(f, u.data));
    log.info({ token, kind: layout.kind }, 'real-time price feed on');
  }

  private price(f: Feed): number | null {
    const q = this.quotes.get(f.quoteMint);
    if (!q) return null;
    const ab = f.layout.priceSource === 'reserves'
      ? f.balA > 0n && f.balB > 0n ? Number(f.balB) / 10 ** f.decB / (Number(f.balA) / 10 ** f.decA) : null
      : f.clPriceAB;
    if (!ab || !Number.isFinite(ab)) return null;
    return (f.tokenIsA ? ab : 1 / ab) * q;
  }

  private emit(f: Feed): void {
    const now = Date.now();
    if (now - f.lastEmit < config.setups.priceFeed.throttleMs) return;
    const p = this.price(f);
    if (!p) return;
    f.lastEmit = now;
    this.onPrice(f.token, p);
  }

  private onVault(f: Feed, side: 'A' | 'B', data: Buffer): void {
    const acc = decodeTokenAccount(data);
    if (!acc) return;
    if (side === 'A') f.balA = acc.amount;
    else f.balB = acc.amount;
    this.emit(f);
  }

  private onPool(f: Feed, data: Buffer): void {
    const raw = rawPriceFromPoolAccount(f.layout, data);
    if (raw === null) return;
    f.clPriceAB = raw * 10 ** (f.decA - f.decB);
    this.emit(f);
  }
}
