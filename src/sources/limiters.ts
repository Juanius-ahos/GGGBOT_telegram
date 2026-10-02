import { config } from '../config.js';
import { RateLimiter } from '../lib/http.js';

const r = config.rateLimits;

/** One limiter per upstream bucket, shared by every job so budgets are global. */
export const limiters = {
  dexSlow: new RateLimiter('dexscreener-slow', r.dexscreenerSlow),
  dexFast: new RateLimiter('dexscreener', r.dexscreenerFast),
  gecko: new RateLimiter('geckoterminal', r.geckoterminal),
  rugcheck: new RateLimiter('rugcheck', r.rugcheck),
  rpc: new RateLimiter('solana-rpc', r.rpc),
  jupiter: new RateLimiter('jupiter', r.jupiter),
};
