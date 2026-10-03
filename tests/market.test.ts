import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { decodeSwap } from '../src/onchain/market.js';
import { PROGRAMS } from '../src/onchain/pools.js';

// Real events captured from mainnet logs (Oct 2026). Decoded prices were checked against the pool accounts
// and DexScreener (0-5% apart, the gap being the minute or two between capture and check).
const PUMP_BUY = 'Z/RSHyz1d3fM6cBqAAAAAFB0JgIAAAAA9B4DAAAAAABZNHNvAAAAAPQeAwAAAAAAlrzoWPUyAADtn7QiRQAAAPQeAwAAAAAAFAAAAAAAAACWAQAAAAAAAAUAAAAAAAAAZgAAAAAAAACfGAMAAAAAAAkXAwAAAAAA2HDWi7oZ18wTBFdfoPVkG6Z+pvZQDjqDlaf2OYt5k+z9G4/s1gApAqqZNRIbbI4wbxy0AUSbpbjZWa8wtxg5FaQqN5j5zraPfQTJMO04EFRo3BQhAu0e2MAig32FVtUfLTyNp7DOjRu5gS+igcp6qfxWa5wp+nH0MgCsdJ86MgP/g4OBi6j6KMPNO21ek/n6uPCXm8NyFazFskaHe6jDybnwRqOiz07iErT6kv2dAPpPsLP8/TYeQK5TkflgNepjRKbk83kPdsHW50zrpvmT39BQMpVM2jI02hO1L9H3i7tLAAAAAAAAAO8FAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2nEbAgAAAAASAAAAYnV5X2V4YWN0X3F1b3RlX2luAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAMwAAAAAAAADIQR4YBAAAAAAAAAAAAAAAAXZVG7QJiQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PUMP_SELL = 'Pi83CqUD3CrM6cBqAAAAAKbwRwAAAAAAGmh/ewIAAAADtikWAAAAAL+gPuMDAAAAeo7l/hQAAADHGILgPcMAANnm8ZwCAAAAGQAAAAAAAADwH6wBAAAAAAUAAAAAAAAA/Z9VAAAAAADpxkWbAgAAAOwm8JoCAAAAnqTwRi0KatSlt41gY/65C+F4Go7YvWYkaRkzfaKAXk0fX7V9mIn0EJbhuBXYyauTT7loAzMKojH6zIU9ekR/QcdzWXpN4s/E9WRwamC1rbcGSQfhjYcE+i6OXJk/ynDUjqIMdE53885Euxt6a+ivldB3jOHc89/4Xk0ksDqNelPXqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYbfYotnvOHqBF6jjsV91ekrkIWy4CekJiiIdmZ9IQ10AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAA/s8qAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CPMM = 'QMbN6CYIceKsAB7FOFEPJKziyOFh/uggI1NUTayWXxG/TjtxPv6pp8MfF/NZLQAAbXGzyZnwAQDJ5PeCNwAAAMq8cWxVAgAAQ7WDtwEAAAAAAAAAAAAAAAGY16CqLylg5xcxqV2xznSAM1U/Q3Wui3Q1jsf8W1Yx5TT63kVy4x9xFdDz6rMb/jYPFJuVBpFodZ06T1sozEBsDgWHIwAAAABqXNoIBgAAAAA=';
const CLMM = 'QMbN6CYIceKqT6R1EkGIQveiQJZtOM+xk079wmIjyLIRsXq7xcjN5YKGzfrGmQEGr6PQPp454RbFFjO+YA39ZP3vMmZf8Np3SLHvzyk3PKcSXx5XpGtYz9+RL7oNn8yg5Bv4qowiacXDKuZlN+ZzcnTIOljJ7qwron4GBIHdEWji9j/foEwtUTVJBwkAAAAAAAAAAAAAAADqmjwMyAAAAAAAAAAAAAAAAfOCf+8himGwSwAAAAAAAAD1Eh26b0sAAAAAAAAAAAAACFIBAOUcFwAAAAAAAAAAAAAAAAA=';
const ORCA = '4cpJr5MroJZQdLlffZYtQV0xTlMfVme44wHzhesMDmvM6v5wN9uNNAGCD49u/uV7iAEAAAAAAAAAuStxSsdCe4gBAAAAAAAAAIBTmgUAAAAAcLcqDQAAAAAAAAAAAAAAAAAAAAAAAAAA5D8AAAAAAACMCQAAAAAAAA==';
const b = (s: string) => Buffer.from(s, 'base64');

describe('swap event decoding', () => {
  it('PumpSwap buy: pool and post-trade reserves', () => {
    const ev = decodeSwap(PROGRAMS.pumpswap, b(PUMP_BUY))!;
    expect(ev.pool).toBe('FZtrit4gNT3wCKw4sM5pJStnb71vRXyDS9ewFuE3kWXM');
    expect(ev.reserveA).toBe(56029303949382n);
    expect(ev.reserveB).toBe(296935210721n);
    expect(ev.amountA).toBe(36074576n);
    expect(ev.amountB).toBe(204532n);
  });

  it('PumpSwap sell', () => {
    const ev = decodeSwap(PROGRAMS.pumpswap, b(PUMP_SELL))!;
    expect(ev.pool).toBe('BgHHkNTLhNzM9CpgHAp2nYjjq9tvmTgGHebBiAABgVKr');
    expect(ev.reserveA).toBe(90180517664n);
    expect(ev.reserveB).toBe(214659304010222n);
  });

  it('Raydium CPMM needs the pool mints, then prices either orientation consistently', () => {
    const unresolved = decodeSwap(PROGRAMS.raydiumCpmm, b(CPMM))!;
    expect(unresolved.pool).toBe('CaREMnjWjZ1Pb4Rf1W8Y4XZbi7S6iMP526yZvteTeCUv');
    expect(unresolved.reserveA).toBeUndefined();
    const inMint = bs58.encode(b(CPMM).subarray(89, 121));
    const asA = decodeSwap(PROGRAMS.raydiumCpmm, b(CPMM), () => inMint)!;
    const asB = decodeSwap(PROGRAMS.raydiumCpmm, b(CPMM), () => 'SomeOtherMint')!;
    expect(asA.reserveA).toBe(asB.reserveB);
    expect(asA.reserveB).toBe(asB.reserveA);
  });

  it('Raydium CLMM: price from sqrt_price', () => {
    const ev = decodeSwap(PROGRAMS.raydiumClmm, b(CLMM))!;
    expect(ev.pool).toBe('CTpkCQufppiECZJesCkvy1nETmVQQMFK41EoFjw1x4WG');
    expect(ev.rawPriceBA).toBeCloseTo(5728.82, 1);
  });

  it('Orca Whirlpool: price from post_sqrt_price', () => {
    const ev = decodeSwap(PROGRAMS.orcaWhirlpool, b(ORCA))!;
    expect(ev.pool).toBe('6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo');
    expect(ev.rawPriceBA! * 100).toBeCloseTo(235.05, 1); // decimals 8 vs 6 -> 235.05 USDC per token, as DexScreener showed
  });

  it('ignores other programs and unknown events', () => {
    expect(decodeSwap(PROGRAMS.raydiumCpmm, b(PUMP_BUY))).toBeNull();
    expect(decodeSwap(PROGRAMS.pumpswap, Buffer.alloc(200))).toBeNull();
  });
});
