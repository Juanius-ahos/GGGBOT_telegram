# SOLEYE — free Solana pattern alert bot

Scans Solana tokens, filters out likely rugs, detects **double-bottom breakouts** and **confirmed hammer candles** on
**15m, 1h and 4h** charts, and sends Telegram alerts.
Everything runs on free, keyless APIs.

## Pipeline

| Stage | Every | Source | Notes |
|---|---|---|---|
| Discovery | 10 min | DexScreener (boosts, profiles, takeovers) + GeckoTerminal (trending, top volume) + Jupiter (top trending/traded/organic, 1h/6h/24h) + PumpPortal websocket (every pump.fun graduation, real time) → DexScreener `tokens/v1` for MC/liq/vol/age | Every address ever surfaced goes into a candidate pool that is re-checked each cycle for 7 days, so tokens that are too young/small today join automatically later. No cap on watchlist size. Keeps MC ≥ $200k, liq ≥ $50k, vol24h ≥ $100k, pair age ≥ 24h. |
| Rug filter | once / 24h per token | Solana RPC `getAccountInfo` (authorities) + RugCheck report (holders, LP/locker accounts, risks, score). RPC `getTokenLargestAccounts` is fallback only | Mint + freeze revoked, top-10 holders < 30% excluding AMM/LP vaults, lockers and burn addresses, RugCheck `score_normalised` ≤ 50, no `danger` risks, not rugged. API failures give `error` (retried after 1h), never `pass`. |
| Live on-chain candles | continuous | Solana websocket `accountSubscribe` on each pool's vaults (+ pool account for concentrated liquidity) | History seeded once from GeckoTerminal, then 15m candles are built from chain updates. Detector runs every minute on every live pool. See below. |
| GT rotation | 5 min | GeckoTerminal 15m OHLCV (200 candles) | Only for tokens whose pool can't be tracked on-chain (unsupported DEX, Token-2022 UI-scaled mints, failed sanity check). |
| Alert | on detection | Telegram Bot API | Fresh price/MC from DexScreener, 12h cooldown per token. |
| Tracking | 5 min | DexScreener price, GeckoTerminal candles at 24h | Price + % at 1h/4h/24h; at 24h, candles decide whether target or invalidation was hit first. |

## Live on-chain candles (`src/onchain/`)

Why: GeckoTerminal (the only free candle API) allows ~5 calls/min, i.e. each token re-checked only every ~30+ min. Reading the chain directly removes that limit.

- **Supported pools** (decoded from raw account data): PumpSwap, Raydium AMM v4, Raydium CPMM (price = vault reserves), Raydium CLMM, Orca Whirlpool (price = `sqrt_price`), Meteora DLMM (price = active bin). Verified against live data: decoded vault mints matched 100% of pools; median price error vs DexScreener 0.004–1.2% depending on DEX.
- **Self-checks per pool, or it falls back to GT rotation:** vaults must hold the pool's two mints; Token-2022 mints with interest-bearing/scaled-UI extensions are excluded (raw ≠ displayed price); chain price must be within 15% of GeckoTerminal's last close at every seed.
- **Volume** = quote-vault change in slots where the two vaults moved in opposite directions (a swap). Same-direction moves (add/remove liquidity, fee claims) are not counted. Swaps that cancel out inside one ~400ms slot are invisible this way, so live volume can under-count.
- **Because of that, live candles only pre-screen.** The breakout-volume threshold is relaxed to 60% for the pre-screen; every hit is then re-checked on GeckoTerminal candles with the exact rules before any alert is sent. Alerts are never based on live candles alone.
- **Re-sync every 2h** from GeckoTerminal (and immediately after any websocket gap). Each re-sync measures live vs GT accuracy (close/high/low error, % of volume captured), shown in `/status`.
- Quote tokens (SOL, USDC, meme/stock quotes) are priced in USD from DexScreener every minute.

## Timeframes

One GeckoTerminal call returns up to 1000 × 15m candles (~10 days). 1h and 4h candles are built from those
(UTC-aligned, same as GeckoTerminal). Verified on real tokens: **all 748 rebuilt 1h candles and all 186 rebuilt 4h
candles matched GeckoTerminal's native 1h/4h candles exactly** (0.000% OHLC difference, volume ratio 1.000).
So all three timeframes cost one request per token, and live on-chain 15m candles roll up the same way.
Limit: ~10 days of history means at most ~62 4h candles, so 4h signals are rare.

## Hammer rules (`src/patterns/hammer.ts`, thresholds in `config.hammer`)

- Shape: lower wick ≥ 2× body and ≥ 60% of the candle's range; upper wick ≤ 15% of range.
- Context: price fell ≥ 5% over the 6 candles before it, and the hammer's low is the lowest low of the last 20 candles.
- Size/volume: range ≥ recent average range (14), volume ≥ recent average volume (20).
- Confirmation: the next candle must close above the hammer's high; the alert fires on that close.
- Stop = hammer low − 1%. Target = entry + 2× risk.
- A double bottom whose second low is itself a hammer-shaped candle is flagged as extra confluence.

## Backtest (real data)

`npm run backtest` replays both detectors over ~10 days of real history for the top watchlist tokens and reports
which level price hit first. Run on 2 Oct 2026 over 12 tokens: double bottom 15m 9 target / 5 stop / 2 open,
double bottom 1h 3 / 1 / 0, hammer 15m 2 / 3 / 0, hammer 1h 0 / 1 / 1, 4h none. Small samples on tokens that
are still trending today (survivorship bias): a sanity check, not proof of an edge.
`npx tsx scripts/render-signal.ts <SYMBOL> <double_bottom|hammer> <15m|1h|4h>` renders the exact chart + caption
the bot would send for the latest real signal of that kind.

## Double bottom rules (`src/patterns/doubleBottom.ts`, thresholds in `src/config.ts`)

- Two swing lows (lowest within ±3 candles) within **3%** of each other, **8–120** candles apart.
- Nothing between them trades below the lower low; nothing after the second low undercuts it.
- Neckline = highest high between the lows, **≥ 8%** above the higher low.
- Second-low "sell volume" ≤ first-low sell volume. OHLCV has no buy/sell split, so sell volume is approximated as the volume of red candles in the 3 candles leading into each low.
- Trigger: a **closed** candle closes above the neckline with volume > **20-candle average**, and it is the *first* close above the neckline since the second low (stale breakouts don't fire). The breakout may be on either of the last 2 closed candles, provided price is still above the neckline.
- Invalidation = second low − 1%. Target = neckline + (neckline − lower low).

## Free API limits (checked Oct 2026)

| API | Key | Limit used |
|---|---|---|
| DexScreener | none | 60/min profiles/boosts (we use 50), 300/min tokens (we use 240) |
| GeckoTerminal | none | Docs say 10–30/min, but **measured**: 10/min gave 429s after a ~5-call burst; 5/min sustained gave zero. Default 5 (`GT_RPM`) → 22 tokens per 5-min scan |
| RugCheck | none | unpublished; 20/min (`RUGCHECK_RPM`) |
| Solana public RPC | none | 100 req/10s per IP, 40/10s per method; we use 120/min. `getTokenLargestAccounts` is throttled much harder, so it is fallback only |

Every upstream has its own serial rate-limited queue with timeouts, exponential backoff + jitter, `Retry-After` support, a queue-wide pause on 429, adaptive slow-down (spacing widens up to 4× after 429s and recovers on success), and short-lived response caching.

## Run locally

```bash
npm install
cp .env.example .env     # add TELEGRAM_BOT_TOKEN
npm test
npm run dev              # tsx watch
```

No token yet? `DRY_RUN=1 npm run dev` scans live and logs alerts instead of sending them.

Production: `npm run build && npm start`, or see **[DEPLOY.md](DEPLOY.md)** for Oracle Cloud + pm2.

## Telegram

- **Alerts** are a chart image (candles, L1/L2, neckline, breakout, target and stop lines, volume) with a caption: CA (tap to copy), MC, liquidity, breakout volume vs average, and an entry/target/stop/R:R table.
- **Buttons** under each alert: DexScreener, Birdeye, Jupiter, Solscan, 🔄 *Price now* (pop-up with live price and distance to target/stop), 🔕 *Mute 24h* (per chat, per token).
- **Follow-ups** reply under the original alert: 🎯 target hit / 🛑 stop hit as soon as it happens, then a 📋 24h recap.
- **Menu keyboard** (Status, Recent, Stats, Settings) is pinned after `/start`; commands `/start /stop /status /recent /stats /settings` also work.
- `DRY_RUN=1` writes each alert's chart and caption to `data/previews/` instead of sending.

## Layout

```
src/
  config.ts            all thresholds
  index.ts             wiring, graceful shutdown
  lib/http.ts          rate limiter, fetch with retry/backoff, cache
  sources/             dexscreener, geckoterminal, rugcheck, solanaRpc, limiters
  filters/             marketFilter, rugFilter
  patterns/            doubleBottom (pure), types
  db/                  better-sqlite3 schema + queries
  jobs/                scheduler, discovery, patternScan, outcomes
  bot/                 Telegram client, commands, message formatting
tests/                 detector (synthetic candles), filters, outcome resolution
```

Not financial advice. Patterns fail; use the invalidation level.

## Working on it from another PC

```bash
git clone https://github.com/Juanius-ahos/GGGBOT_telegram.git
cd GGGBOT_telegram
npm install
cp .env.example .env      # then put a bot token in .env (never commit .env)
npm test
```

**Only one copy of the bot may run per Telegram token.** If the live bot is running (server or another PC) and you
start a second copy with the same token, both fight over Telegram updates and alerts can be duplicated. While the
live bot runs, develop with either:

- `DRY_RUN=1 npm run dev` — scans for real, writes alert charts to `data/previews/` instead of sending, or
- a second test bot from @BotFather with its own token in your local `.env`.

Ship a change: `git add -A && git commit -m "..." && git push`. If the live bot is on Render with auto-deploy,
it rebuilds and restarts on its own (state is restored from the Neon snapshot). On a PC/VPS: `git pull && npm ci && npm run build && npx pm2 restart soleye`.
