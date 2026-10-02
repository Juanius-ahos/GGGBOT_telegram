/** One OHLCV candle. `time` is the candle open time in unix seconds. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PatternPoint {
  index: number;
  time: number;
  price: number;
}

export interface DoubleBottomResult {
  firstLow: PatternPoint;
  secondLow: PatternPoint;
  /** Highest high between the two lows. */
  neckline: number;
  necklineIndex: number;
  breakout: PatternPoint & { volume: number; avgVolume: number };
  firstLowSellVolume: number;
  secondLowSellVolume: number;
  /** neckline - lowest of the two lows. */
  patternHeight: number;
  target: number;
  invalidation: number;
}
