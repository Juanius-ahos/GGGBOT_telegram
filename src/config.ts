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
  /** Require the next candle to close above the hammer's high before alerting. */
  requireConfirmation: boolean;
  invalidationBufferPct: number;
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
  },

  jobs: {
    discoveryIntervalMs: 10 * 60_000,
    patternScanIntervalMs: 5 * 60_000,
    outcomeIntervalMs: 5 * 60_000,
    /** Max new rug checks per discovery cycle (RugCheck budget). */
    maxRugChecksPerCycle: 60,
    /** Keep re-checking surfaced addresses for this long (catches tokens that grow into the filters). */
    candidatePoolDays: 7,
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
    minVolume24hUsd: 100_000,
    /** 0 = no age requirement (fresh launches qualify as soon as they pass every other filter). */
    minPairAgeHours: 0,
  },

  rug: {
    cacheHours: 24,
    /** Retry a token whose check errored (API down) after this long. */
    errorRetryMinutes: 60,
    maxTop10HolderPct: 30,
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
    requireConfirmation: true,
    invalidationBufferPct: 0.01,
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
    enabled: process.env.LIVE_TRACKING !== '0',
    /** Re-seed each live pool from GeckoTerminal this often to correct any drift. */
    resyncHours: envNum('LIVE_RESYNC_HOURS', 2),
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
  },

  tracking: {
    checkpointsHours: [1, 4, 24] as const,
  },
};

export type AppConfig = typeof config;
