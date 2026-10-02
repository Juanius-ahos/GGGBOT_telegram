import bs58 from 'bs58';

/**
 * Decoders for Solana DEX pool accounts. Layouts are self-checked at runtime: a decoded pool is only
 * used when its mints match the token's mints and its live price agrees with DexScreener
 * (see onchain/tracker.ts). Anything that fails falls back to GeckoTerminal candles.
 */

export const PROGRAMS = {
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  raydiumAmmV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydiumClmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  orcaWhirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
} as const;

export type PoolKind = keyof typeof PROGRAMS;

/**
 * How price is derived:
 * - 'reserves': constant-product pool, price = quote vault / base vault.
 * - 'sqrtPrice' / 'binId': concentrated liquidity, price read from the pool account itself.
 */
export type PriceSource = 'reserves' | 'sqrtPrice' | 'binId';

export interface PoolLayout {
  kind: PoolKind;
  priceSource: PriceSource;
  /** Token order as stored in the pool ("A"/"B", "0"/"1", "x"/"y", "base"/"quote"). */
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  /** DLMM bin step (basis points), only for binId pools. */
  binStep?: number;
}

const key = (b: Buffer, off: number) => bs58.encode(b.subarray(off, off + 32));

export function decodePool(owner: string, data: Buffer): PoolLayout | null {
  try {
    switch (owner) {
      case PROGRAMS.pumpswap:
        // disc 8 | bump 1 | index u16 | creator 32 | base_mint | quote_mint | lp_mint | base_vault | quote_vault
        if (data.length < 203) return null;
        return { kind: 'pumpswap', priceSource: 'reserves', mintA: key(data, 43), mintB: key(data, 75), vaultA: key(data, 139), vaultB: key(data, 171) };
      case PROGRAMS.raydiumAmmV4:
        // 16 u64 header + fees/state ... coin_vault @336, pc_vault @368, coin_mint @400, pc_mint @432
        if (data.length < 464) return null;
        return { kind: 'raydiumAmmV4', priceSource: 'reserves', mintA: key(data, 400), mintB: key(data, 432), vaultA: key(data, 336), vaultB: key(data, 368) };
      case PROGRAMS.raydiumCpmm:
        // disc 8 | amm_config | pool_creator | token_0_vault @72 | token_1_vault @104 | lp_mint | token_0_mint @168 | token_1_mint @200
        if (data.length < 232) return null;
        return { kind: 'raydiumCpmm', priceSource: 'reserves', mintA: key(data, 168), mintB: key(data, 200), vaultA: key(data, 72), vaultB: key(data, 104) };
      case PROGRAMS.raydiumClmm:
        // disc 8 | bump 1 | amm_config | owner | mint_0 @73 | mint_1 @105 | vault_0 @137 | vault_1 @169 | ... sqrt_price_x64 @253
        if (data.length < 269) return null;
        return { kind: 'raydiumClmm', priceSource: 'sqrtPrice', mintA: key(data, 73), mintB: key(data, 105), vaultA: key(data, 137), vaultB: key(data, 169) };
      case PROGRAMS.orcaWhirlpool:
        // disc 8 | config 32 | bump 1 | tick_spacing u16 | seed [2] | fee u16 | proto_fee u16 | liquidity u128 | sqrt_price @65 | ...
        // mint_a @101 | vault_a @133 | fee_growth_a u128 | mint_b @181 | vault_b @213
        if (data.length < 245) return null;
        return { kind: 'orcaWhirlpool', priceSource: 'sqrtPrice', mintA: key(data, 101), mintB: key(data, 181), vaultA: key(data, 133), vaultB: key(data, 213) };
      case PROGRAMS.meteoraDlmm:
        // disc 8 | static params 32 | variable params 32 | bump 1 | bin_step_seed 2 | pair_type 1 | active_id i32 @76 | bin_step u16 @80
        // ... token_x_mint @88 | token_y_mint @120 | reserve_x @152 | reserve_y @184
        if (data.length < 216) return null;
        return {
          kind: 'meteoraDlmm', priceSource: 'binId', mintA: key(data, 88), mintB: key(data, 120), vaultA: key(data, 152), vaultB: key(data, 184),
          binStep: data.readUInt16LE(80),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const Q64 = 2 ** 64;

/** Raw price of A in units of B (not decimal-adjusted), read from a concentrated-liquidity pool account. */
export function rawPriceFromPoolAccount(layout: PoolLayout, data: Buffer): number | null {
  if (layout.priceSource === 'sqrtPrice') {
    const off = layout.kind === 'orcaWhirlpool' ? 65 : 253;
    if (data.length < off + 16) return null;
    const lo = data.readBigUInt64LE(off);
    const hi = data.readBigUInt64LE(off + 8);
    const sqrt = Number(lo) / Q64 + Number(hi);
    return sqrt * sqrt;
  }
  if (layout.priceSource === 'binId' && layout.binStep) {
    if (data.length < 82) return null;
    const activeId = data.readInt32LE(76);
    return Math.pow(1 + layout.binStep / 10_000, activeId);
  }
  return null;
}

/** SPL token account (Token and Token-2022 share this prefix): mint @0, owner @32, amount u64 @64. */
export function decodeTokenAccount(data: Buffer): { mint: string; amount: bigint } | null {
  if (data.length < 72) return null;
  return { mint: key(data, 0), amount: data.readBigUInt64LE(64) };
}

/** SPL mint account: decimals u8 @44. */
export function decodeMintDecimals(data: Buffer): number | null {
  return data.length >= 45 ? data[44] : null;
}
