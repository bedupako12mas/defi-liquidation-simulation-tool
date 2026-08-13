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

export interface FluidAddresses {
  vaultT1Resolver: `0x${string}`;
  vaultPositionsResolver: `0x${string}`;
  vaultResolver: `0x${string}`;
  liquidityResolver: `0x${string}`;
}

export function resolveFluidAddresses(): FluidAddresses {
  return {
    vaultT1Resolver: FLUID_VAULT_T1_RESOLVER,
    vaultPositionsResolver: FLUID_VAULT_POSITIONS_RESOLVER,
    vaultResolver: FLUID_VAULT_RESOLVER,
    liquidityResolver: FLUID_LIQUIDITY_RESOLVER,
  };
}
