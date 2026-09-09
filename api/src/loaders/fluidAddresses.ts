// Fluid's resolvers are independently deployed periphery contracts - unlike Aave's
// Pool -> ADDRESSES_PROVIDER() -> getPoolDataProvider()/getPriceOracle() chain
// (aaveAddresses.ts), there is no single on-chain entry point to derive these from each
// other. Sourced from Instadapp's own deployments/deployments.md and verified live
// (getTotalVaults()/getAllVaultsAddresses()/getAllVaultNftIds() and getCode() checks) before
// being hardcoded - see docs/decisions.md's "Fluid resolver addresses verified live" entry.
export const FLUID_VAULT_T1_RESOLVER = "0xB21C67DD518F6d31257d3A4F12B0A6344885b268" as const;
export const FLUID_VAULT_POSITIONS_RESOLVER = "0xaA21a86030EAa16546A759d2d10fd3bF9D053Bc7" as const;
export const FLUID_VAULT_RESOLVER = "0xA5C3E16523eeeDDcC34706b0E6bE88b4c6EA95cC" as const;
export const FLUID_LIQUIDITY_RESOLVER = "0xca13A15de31235A37134B4717021C35A3CF25C60" as const;
// Verified live (2026-08-25, T2-T4 base-layer investigation): getCode() returns real bytecode,
// getDexCollateralReserves()/getDexDebtReserves() against real, active T2/T3/T4 pools return
// sane values (real token0/token1 resolve to real mainnet tokens, e.g. USDC/USDT for a
// confirmed smart-debt pool) - see api/scripts/investigations/fluid-vault-tiers/.
export const FLUID_DEX_RESERVES_RESOLVER = "0x05Bd8269A20C472b148246De20E6852091BF16Ff" as const;
// The real, general "Dex Resolver" (periphery/resolvers/dex/main.sol) - distinct from
// FLUID_DEX_RESERVES_RESOLVER above (a narrower, swap-integration-focused resolver). Used
// for getTotalSupplyShares/BorrowSharesRaw() - the real per-vault-share fix for T2/T3's
// pool-level valuation approximation (see docs/decisions.md's 2026-09-03 T3 entry: a real
// vault's own totalSupply/BorrowVault is denominated in DEX shares for a smart leg, and
// needs dividing by the pool's total shares to get this vault's real fractional value,
// rather than attributing the whole shared pool's value to every vault sharing it).
export const FLUID_DEX_RESOLVER = "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07" as const;

export interface FluidAddresses {
  vaultT1Resolver: `0x${string}`;
  vaultPositionsResolver: `0x${string}`;
  vaultResolver: `0x${string}`;
  liquidityResolver: `0x${string}`;
  dexReservesResolver: `0x${string}`;
  dexResolver: `0x${string}`;
}

export function resolveFluidAddresses(): FluidAddresses {
  return {
    vaultT1Resolver: FLUID_VAULT_T1_RESOLVER,
    vaultPositionsResolver: FLUID_VAULT_POSITIONS_RESOLVER,
    vaultResolver: FLUID_VAULT_RESOLVER,
    liquidityResolver: FLUID_LIQUIDITY_RESOLVER,
    dexReservesResolver: FLUID_DEX_RESERVES_RESOLVER,
    dexResolver: FLUID_DEX_RESOLVER,
  };
}
