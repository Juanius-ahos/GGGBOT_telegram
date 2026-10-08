import 'dotenv/config';

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Double-bottom detector thresholds. All percentages are fractions (0.03 = 3%). */
export interface DoubleBottomConfig {
  /** Candles on each side a low must beat to count as a swing low. */
  swingLookback: number;
  /** Max price difference between the two lows, relative to the lower one. */
  lowTolerancePct: number;
  /** Minimum candles between the two lows. */
  minCandlesBetweenLows: number;
  /** Maximum candles between the two lows (keeps patterns "local"). */
  maxCandlesBetweenLows: number;
  /** Neckline (highest high between the lows) must be at least this far above the higher low. */
  minBouncePct: number;
  /**
   * Second-low sell volume must be <= first-low sell volume * (1 + this).
   * 0 means "lower or equal", as specified.
   */
  sellVolumeTolerancePct: number;
  /** Candles leading into each low used to measure "sell volume" (red candles only). */
  sellVolumeWindow: number;
  /** Breakout candle volume must exceed the N-candle average volume. */
  breakoutVolumeAvgPeriod: number;
  /** Breakout volume must be > average * this multiplier. */
  breakoutVolumeMultiplier: number;
  /** Max candles from the second low to the breakout candle. */
  maxCandlesAfterSecondLow: number;
  /** Invalidation is placed this far below the second low. */
  invalidationBufferPct: number;
}

/** Hammer candle thresholds. Percentages are fractions. */
export interface HammerConfig {
  /** Lower wick must be at least this many times the body. */
  minLowerWickToBody: number;
  /** Lower wick must be at least this share of the candle's full range. */
  minLowerWickPctOfRange: number;
  /** Upper wick may be at most this share of the range (little or no upper shadow). */
  maxUpperWickPctOfRange: number;
  /** Price must have fallen at least this much over the candles before the hammer. */
  minPriorDeclinePct: number;
  priorTrendCandles: number;
  /** Hammer low must be the lowest low of this many candles (it marks a bottom). */
  lowLookback: number;
  /** Hammer range must be at least this multiple of the recent average range (no tiny candles). */
  minRangeVsAvg: number;
  rangeAvgPeriod: number;
  /** Hammer volume must be at least this multiple of the recent average volume. */
  minVolumeVsAvg: number;
  volumeAvgPeriod: number;
  /** Also detect inverted hammers (long upper wick at a bottom), same rules with the wick flipped. */
  inverted: boolean;
  /** Require the next candle to close above the hammer's high before alerting. */
  requireConfirmation: boolean;
  /** Confirmation candle must close above the hammer's 'high' (strict) or its closing price ('close', textbook). */
  confirmAbove: 'high' | 'close';
  invalidationBufferPct: number;
  /** Timeframes hammers are detected and alerted on. */
  timeframes: readonly string[];
  /** Target = entry + this x (entry - stop). */
  rewardToRisk: number;
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    /** Long-poll timeout for getUpdates, seconds. */
    pollTimeoutSec: 30,
  },

  rpcUrl: process.env.RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
  /** Optional free key from portal.jup.ag; without it the keyless lite-api host is used. */
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || '',
  /** Optional free key from dexpaprika.com: 15m/1h candles (last 7 days) on its own quota instead of GeckoTerminal. */
  dexpaprikaApiKey: process.env.DEXPAPRIKA_API_KEY?.trim() || '',
  dbPath: process.env.DB_PATH?.trim() || './data/soleye.db',

  /** Only needed on hosts like Render free (ephemeral disk, sleeps without traffic). */
  hosting: {
    /** Postgres URL (e.g. Neon free) for database snapshots. Empty = local disk only. */
    databaseUrl: process.env.DATABASE_URL?.trim() || '',
    snapshotMinutes: envNum('SNAPSHOT_MINUTES', 30),
    /**
     * Upload snapshots only from the hosted instance (Render sets RENDER=true) or when forced with
     * SNAPSHOT_UPLOAD=1. Local/dev copies may restore from snapshots but never overwrite them.
     */
    snapshotUpload: process.env.SNAPSHOT_UPLOAD === '1' || process.env.RENDER === 'true',
    /** Seconds to wait before restoring, so an overlapping previous instance can save its final snapshot. */
    handoffDelaySec: envNum('HANDOFF_DELAY_SEC', process.env.RENDER === 'true' ? 45 : 0),
    /** If set, serve GET /health on this port. Render sets PORT automatically. */
    port: envNum('PORT', 0),
    /** If set, ping our own /health every 10 min. Render sets RENDER_EXTERNAL_URL automatically. */
    publicUrl: process.env.RENDER_EXTERNAL_URL?.trim() || process.env.PUBLIC_URL?.trim() || '',
  },
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',

  /** Requests per minute per upstream. Kept below published limits on purpose. */
  rateLimits: {
    dexscreenerSlow: 50, // profiles/boosts/takeovers: 60/min published
    dexscreenerFast: 240, // tokens/pairs/search: 300/min published
    // Docs say 10-30/min, but measured Oct 2026: bursts of ~5 then 429s at 10/min; 5/min sustained = 0 errors.
    geckoterminal: envNum('GT_RPM', 5),
    rugcheck: envNum('RUGCHECK_RPM', 20), // unpublished; be polite
    rpc: envNum('RPC_RPM', 120), // public RPC: 100 req / 10 s per IP, 40 / 10 s per method
    jupiter: 30, // free tier: 60/min
    // Free key: 100K credits/month at ~1 credit per call, i.e. ~2.3/min sustained. 2/min = ~89K/month.
    dexpaprika: envNum('DEXPAPRIKA_RPM', 2),
  },

  jobs: {
    discoveryIntervalMs: 10 * 60_000,
    patternScanIntervalMs: 5 * 60_000,
    outcomeIntervalMs: 5 * 60_000,
    /** Max new rug checks per discovery cycle (RugCheck budget). */
    maxRugChecksPerCycle: 60,
    /** Keep re-checking surfaced addresses for this long (catches tokens that grow into the filters). */
    candidatePoolDays: 7,
    /** Candidates below this fraction of the minimum market cap (or with no pair) are re-checked only every... */
    deadMcFraction: 0.3,
    deadRecheckMs: 2 * 3_600_000,
    /** GeckoTerminal calls kept in reserve for discovery each scan window. */
    gtReservedCallsPerScan: 3,
  },

  market: {
    /** Quote/base assets that are not tradable "tokens" for this bot. */
    excludedMints: [
      'So11111111111111111111111111111111111111112', // wSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ],
    minMarketCapUsd: 100_000,
    /** Skip large caps: only small/mid caps up to this market cap. */
    maxMarketCapUsd: 3_000_000,
    minLiquidityUsd: 50_000,
    minVolume24hUsd: 50_000,
    /** 0 = no age requirement (fresh launches qualify as soon as they pass every other filter). */
    minPairAgeHours: 0,
  },

  rug: {
    cacheHours: 24,
    /** Retry a token whose check errored (API down) after this long. */
    errorRetryMinutes: 60,
    maxTop10HolderPct: 40,
    /** RugCheck score_normalised (0 = safest). */
    maxRugcheckScore: 50,
    /** Reject if RugCheck reports any risk at this level. */
    rejectRiskLevels: ['danger'] as string[],
    /** Addresses/owners never counted as holders. */
    burnAddresses: [
      '1nc1nerator11111111111111111111111111111111',
      '11111111111111111111111111111111',
    ],
  },

  scan: {
    /** GeckoTerminal OHLCV: minute candles aggregated to 15m. */
    timeframe: 'minute' as const,
    aggregate: 15,
    candleSeconds: 15 * 60,
    /** 15m candles fetched per call: 1000 = ~10 days, enough to build 1h and 4h candles too. */
    candleLimit: 1000,
    /**
     * Accept a breakout on any of the last N closed candles (price must still be above the neckline).
     * Covers rotation gaps when the watchlist is larger than one scan's GeckoTerminal budget.
     */
    breakoutLookbackCandles: 2,
    /** Upper bound when the lookback is stretched to cover a long scan rotation. */
    maxBreakoutLookbackCandles: 8,
  },

  doubleBottom: {
    swingLookback: 3,
    lowTolerancePct: 0.03,
    minCandlesBetweenLows: 8,
    maxCandlesBetweenLows: 120,
    minBouncePct: 0.08,
    sellVolumeTolerancePct: 0,
    sellVolumeWindow: 3,
    breakoutVolumeAvgPeriod: 20,
    breakoutVolumeMultiplier: 1.0,
    maxCandlesAfterSecondLow: 40,
    invalidationBufferPct: 0.01,
  } satisfies DoubleBottomConfig,

  hammer: {
    minLowerWickToBody: 2,
    minLowerWickPctOfRange: 0.6,
    maxUpperWickPctOfRange: 0.15,
    minPriorDeclinePct: 0.05,
    priorTrendCandles: 6,
    lowLookback: 20,
    minRangeVsAvg: 1.0,
    rangeAvgPeriod: 14,
    minVolumeVsAvg: 1.0,
    volumeAvgPeriod: 20,
    // Off: backtest on 400 coins' real 15m/1h candles (8 Oct) found no edge (86 15m trades, -0.1% to -3.3% per trade).
    inverted: false,
    requireConfirmation: true,
    confirmAbove: 'high' as 'high' | 'close',
    invalidationBufferPct: 0.01,
    timeframes: ['15m', '1h', '4h'],
    rewardToRisk: 2,
  } satisfies HammerConfig,

  /**
   * Timeframes scanned. One GeckoTerminal call per token: tokens younger than `youngTokenHours` are fetched as
   * 5m candles (their whole life fits in 1000) and rolled up to 15m/1h/4h; older tokens are fetched as 15m
   * (~10 days) and rolled up to 1h/4h, so 5m only applies to young tokens.
   */
  timeframes: ['5m', '15m', '1h', '4h'] as const,
  youngTokenHours: 80,
  /** Candles per timeframe given to the detectors. */
  detectCandles: { '5m': 200, '15m': 200, '1h': 200, '4h': 200 } as Record<'5m' | '15m' | '1h' | '4h', number>,
  /** How long an alert is tracked before win/loss is decided, per timeframe. */
  resolutionHours: { '5m': 12, '15m': 24, '1h': 72, '4h': 168 } as Record<'5m' | '15m' | '1h' | '4h', number>,

  /**
   * Real-time triggers: a double bottom whose two lows are in place (or a fresh hammer) is "armed", and a
   * watcher checks the live price every few seconds, alerting the moment price crosses the neckline /
   * hammer high instead of waiting for the candle to close.
   */
  setups: {
    /**
     * Early entry: alert the moment a double bottom's second low is confirmed, take profit at the neckline, stop 1%
     * under the second low, only when the neckline is at least `minRoomPct` above the price. Real 15m data, 30
     * watched coins, ~10 days to 8 Oct 2026 (110 formations): TP at neckline won 29% for +4.2%/trade overall; with
     * >25% room +9.6%/trade (n=50), with less room -0.6% (n=57). Expect ~7 in 10 to stop out; winners ~4x bigger.
     */
    early: { minRoomPct: 25 },
    /** Real-time on-chain price for coins with an armed setup (websocket, no GeckoTerminal). PRICE_FEED=0 disables. */
    priceFeed: { enabled: process.env.PRICE_FEED !== '0', maxPools: 60, throttleMs: 1500 },
    watchIntervalMs: 20_000,
    /** Price must clear the trigger level by this much (filters ticks that just touch it). */
    crossBufferPct: 0.003,
    /**
     * Double-bottom cross needs the forming candle's volume pace (volume so far / share of candle elapsed)
     * to beat the average by this multiple. Early in a candle the elapsed share is floored at 25%.
     */
    minVolumePace: 1.0,
    /** On-chain volume misses swaps that net out inside a slot, so live-pool pace is scaled down by this. */
    onchainPaceFactor: 0.6,
    /** Send a "forming" alert only while the second low is fresh (at most this many candles past confirmation). */
    earlyMaxCandlesAfterConfirm: 2,
  },

  live: {
    /** Build candles from on-chain pool updates (websocket) for supported pools. */
    // Off by default: the whole-market watch replaces per-pool tracking on free hosting. LIVE_TRACKING=1 to use it.
    enabled: process.env.LIVE_TRACKING === '1',
    /** Re-seed each live pool from GeckoTerminal this often to correct any drift. */
    // 2h re-syncs of ~50 pools used nearly all of the GeckoTerminal calls Render's shared IP gets (~25/h).
    resyncHours: envNum('LIVE_RESYNC_HOURS', 6),
    /** Reject live tracking when the on-chain price and GeckoTerminal's last close differ by more. */
    maxSeedDeviationPct: 15,
    /**
     * Live candles only *pre-screen*: their breakout-volume threshold is multiplied by this, because
     * swaps that net out inside one slot are invisible to vault diffs. Every alert is then confirmed on
     * GeckoTerminal candles with the exact thresholds above.
     */
    preScreenVolumeFactor: 0.6,
    detectIntervalMs: 60_000,
    /** Wait this long after a candle closes before asking GeckoTerminal to confirm it. */
    confirmDelaySec: 75,
  },

  alerts: {
    cooldownHours: 12,
    recentCount: 10,
    /**
     * Breakout alerts are skipped when, at the live price, the distance to target is less than this x the
     * distance to the stop (late entries). Live data 1-3 Oct 2026: R:R >= 1 averaged +23.7%, R:R < 1 +0.4%.
     */
    minRewardToRisk: 1,
    /**
     * Breakout alerts (double bottom / hammer) are skipped once the live price is more than this % past the trigger
     * level. All live double-bottom breakouts 1-5 Oct 2026: <=5% past won 75% (+13.1%/trade, n=24); >5% -1.2% (n=10).
     */
    maxChasePct: 5,
  },

  /**
   * Whole-market stream: every swap on PumpSwap, Raydium CPMM/CLMM and Orca via Solana logsSubscribe (free RPC).
   * Coins near the market filter get 5m candles kept in memory and are passed to discovery as candidates.
   */
  stream: {
    // ~37 GB/day of incoming data (Oct 2026): only for hosts without a bandwidth cap. MARKET_STREAM=1 to use it.
    enabled: process.env.MARKET_STREAM === '1',
    candleSec: 300,
    /** 5m candles kept per pool: 1100 = ~3.8 days. */
    maxCandles: 1100,
    /** Hard cap on pools with candles in memory (~1 MB per 10 pools at full history). */
    maxPools: envNum('STREAM_MAX_POOLS', 3000),
    /** Keep candles for coins between minMC x low and maxMC x high, so coins growing into range have history. */
    mcMarginLow: 0.3,
    mcMarginHigh: 2,
    /** Forget pools with no trade for this long. */
    dropAfterQuietHours: 6,
    /** Re-offer an in-range coin to discovery at most this often. */
    candidateEveryMs: 30 * 60_000,
    /** New pools are looked up (account + mints) in batches this often. */
    resolveEveryMs: 5000,
  },

  /**
   * Sudden drop: the price of a watched token falls at least this much within one candle (open -> live price),
   * sampled from DexScreener so it covers every watched token, live on-chain or not.
   */
  dumps: {
    /** Prices come from the watch job's once-a-minute DexScreener look (see `watch`). */
    sampleIntervalMs: 60_000,
    timeframes: ['5m', '15m'] as const,
    minDropPct: 30,
    /** Falls deeper than this are still alerted, labelled as a possible rug. */
    rugLabelAbovePct: 50,
    /**
     * Falls deeper than rugLabelAbovePct, or ending under this market cap, are rugs (live 3-5 Oct 2026: 139 of 225 5m
     * drops were >50%, many to ~$2K MC). They are not entries, so they are not sent.
     */
    alertRugs: false,
    minMcAfterUsd: 50_000,
  },

  /**
   * Whole-market watch, sized for free hosting: an hourly sweep finds every coin above the volume/liquidity floor,
   * a once-a-minute DexScreener look at every watched coin spots activity, and only active coins get their chart
   * downloaded and checked. Coins with nothing going on are still checked every `baselineEveryMs`.
   */
  watch: {
    intervalMs: envNum('WATCH_INTERVAL_SEC', 60) * 1000,
    // A safety net (discovery feeds already catch most coins); every 2h leaves more DexPaprika credits for charts.
    sweepEveryMs: 2 * 3_600_000,
    /** 5-minute volume at least this many times the 6h average pace. */
    volumeSpike: 2,
    /** ...or price moved this much (either way) in 5 minutes / 1 hour. */
    moveM5Pct: 5,
    moveH1Pct: 10,
    /** A coin checked less than this long ago isn't queued again. */
    recheckAfterMs: 10 * 60_000,
    /** Quiet coins still get a chart check this often, when the candle APIs are idle. */
    baselineEveryMs: 3 * 3_600_000,
    /** Each chart-check run stops after this long, so the scheduler stays responsive. */
    chartRunMs: 50_000,
    /** Chart checks running at once. */
    chartWorkers: 3,
  },

  tracking: {
    /** Win/loss tracking and follow-up replies. Off: the bot alerts once per event and moves on. */
    enabled: process.env.TRACK_OUTCOMES === '1',
    checkpointsHours: [1, 4, 24] as const,
  },
};

export type AppConfig = typeof config;
