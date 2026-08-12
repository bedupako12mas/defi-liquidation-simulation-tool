import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import { AAVE_V3_POOL_ADDRESS, resolveAaveAddresses } from "./aaveAddresses.js";

const POOL_ABI = parseAbi(["function getReservesList() view returns (address[])"]);

const DATA_PROVIDER_ABI = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
]);

const ORACLE_ABI = parseAbi(["function getAssetsPrices(address[] assets) view returns (uint256[])"]);
const ERC20_SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

export interface AaveReserveConfig {
  asset: `0x${string}`;
  /** Real on-chain symbol() - "UNKNOWN" if that call fails (rare, non-standard token).
   *  Used for shock-model classification (see routes/simulate.ts), not for display trust -
   *  a symbol is not validated/sanitized here and must still be treated as untrusted
   *  string data anywhere it might reach a query or a rendered surface (see the
   *  parameterized-queries reasoning in the DB-layer commit's decisions entry). */
  symbol: string;
  decimals: number;
  /** Aave stores this as e.g. 10500 = 105% (a 5% bonus). This field is the raw on-chain
   *  value, NOT yet converted to the engine's "bonus only" bps convention - see
   *  aaveUserEnrichment.ts for that conversion, kept separate so this loader's output
   *  matches what the contract actually returns, unmodified. */
  liquidationBonusRaw: bigint;
  liquidationThresholdBps: bigint;
  isActive: boolean;
  isFrozen: boolean;
  priceUsd8: bigint;
}

/**
 * Reads protocol-wide (not per-user) reserve configuration and oracle prices for every
 * Aave V3 reserve, batched via Multicall3. This is snapshot-scoped data - the same for
 * every position at a given block - so it's fetched once per sync run, not once per user.
 *
 * blockNumber is optional and defaults to latest for normal sync use, but the validation
 * milestone (docs/decisions.md) passes an explicit, shared block number so its comparison
 * against a live getUserAccountData() call reads genuinely the same on-chain state -
 * without pinning, two sequential "latest" calls a few hundred ms apart could land on
 * different blocks, and interest accrues every block, which would show up as a fake
 * mismatch that has nothing to do with whether the math itself is correct.
 */
export async function loadReserveConfigs(
  client: PublicClient,
  blockNumber?: bigint,
): Promise<AaveReserveConfig[]> {
  const { dataProvider, oracle } = await resolveAaveAddresses(client);

  const reserves = await client.readContract({
    address: AAVE_V3_POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "getReservesList",
    blockNumber,
  });

  const [configResults, prices, symbolResults] = await Promise.all([
    client.multicall({
      contracts: reserves.map(
        (asset) =>
          ({
            address: dataProvider,
            abi: DATA_PROVIDER_ABI,
            functionName: "getReserveConfigurationData",
            args: [asset],
          }) as const,
      ),
      allowFailure: true,
      blockNumber,
    }),
    client.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "getAssetsPrices",
      args: [reserves],
      blockNumber,
    }),
    client.multicall({
      contracts: reserves.map((asset) => ({ address: asset, abi: ERC20_SYMBOL_ABI, functionName: "symbol" }) as const),
      allowFailure: true,
      blockNumber,
    }),
  ]);

  const configs: AaveReserveConfig[] = [];
  let skippedCount = 0;
  for (let i = 0; i < reserves.length; i++) {
    const result = configResults[i];
    const asset = reserves[i];
    const priceUsd8 = prices[i];
    if (!result || result.status !== "success" || asset === undefined || priceUsd8 === undefined) {
      // A single reverting reserve (e.g. one mid-deprecation) shouldn't take down the
      // whole sync, but a dropped reserve means every candidate's real debt/collateral in
      // it silently disappears too (see aaveUserEnrichment.ts) - surfaced via the warning
      // below rather than swallowed entirely, per review.
      skippedCount++;
      continue;
    }
    const [decimals, , liquidationThreshold, liquidationBonus, , , , , isActive, isFrozen] = result.result;
    const symbolResult = symbolResults[i];
    const symbol = symbolResult?.status === "success" ? symbolResult.result : "UNKNOWN";
    configs.push({
      asset,
      symbol,
      decimals: Number(decimals),
      liquidationBonusRaw: liquidationBonus,
      liquidationThresholdBps: liquidationThreshold,
      isActive,
      isFrozen,
      priceUsd8,
    });
  }

  if (skippedCount > 0) {
    console.warn(
      `[aaveReserveConfig] ${skippedCount} of ${reserves.length} reserves skipped (failed config/price ` +
        `call) - any position holding one of these assets will be missing that leg entirely`,
    );
  }

  return configs;
}
