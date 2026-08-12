import type { PublicClient } from "viem";
import { parseAbi } from "viem";

// Verified against live mainnet before use, not copied from memory unchecked - see
// docs/decisions.md's "Aave loader part 1" entry for the getReservesList() check that
// confirmed this is a real, live Aave V3 Pool with a real reserve list (67 reserves,
// including WETH/WBTC) at the time of verification.
export const AAVE_V3_POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;

const POOL_ABI = parseAbi(["function ADDRESSES_PROVIDER() view returns (address)"]);
const ADDRESSES_PROVIDER_ABI = parseAbi([
  "function getPoolDataProvider() view returns (address)",
  "function getPriceOracle() view returns (address)",
]);

export interface AaveAddresses {
  pool: `0x${string}`;
  dataProvider: `0x${string}`;
  oracle: `0x${string}`;
}

/**
 * Derives the data-provider and oracle addresses from the Pool contract itself at
 * runtime, rather than hardcoding a second and third address from memory - an earlier
 * draft of this file hardcoded a guessed AddressesProvider address that turned out to be
 * one hex character short (an invalid, un-checksummable address), caught only because it
 * was verified against a live call before being committed. Deriving from the one
 * already-verified entry point (the Pool) removes that whole class of transcription error
 * for every address downstream of it.
 */
export async function resolveAaveAddresses(client: PublicClient): Promise<AaveAddresses> {
  const addressesProvider = await client.readContract({
    address: AAVE_V3_POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "ADDRESSES_PROVIDER",
  });

  const [dataProvider, oracle] = await Promise.all([
    client.readContract({
      address: addressesProvider,
      abi: ADDRESSES_PROVIDER_ABI,
      functionName: "getPoolDataProvider",
    }),
    client.readContract({
      address: addressesProvider,
      abi: ADDRESSES_PROVIDER_ABI,
      functionName: "getPriceOracle",
    }),
  ]);

  return { pool: AAVE_V3_POOL_ADDRESS, dataProvider, oracle };
}
