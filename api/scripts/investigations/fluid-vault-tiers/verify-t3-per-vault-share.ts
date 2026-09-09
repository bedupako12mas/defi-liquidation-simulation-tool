import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexDebtReserves } from "../../../src/loaders/fluidDexPoolState.js";
import { parseAbi } from "viem";

const VAULT = "0x3E11B9aEb9C7dBbda4DD41477223Cc2f3f24b9d7" as const;
const DEX_RESOLVER = "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07" as const;
const X128 = (1n << 128n) - 1n;

const ABI = parseAbi([
  "function getTotalBorrowSharesRaw(address dex_) view returns (uint256)",
]);

async function main() {
  await assertAllowedChain();
  const legs = await detectSmartLegs(publicClient, VAULT);
  if (!legs.debtDex) { console.log("no debt dex"); return; }
  const reserves = await loadDexDebtReserves(publicClient, legs.debtDex);
  const rawTotalBorrowShares = await publicClient.readContract({ address: DEX_RESOLVER, abi: ABI, functionName: "getTotalBorrowSharesRaw", args: [legs.debtDex] });
  const totalBorrowShares = rawTotalBorrowShares & X128;
  console.log("totalBorrowShares (pool-wide):", totalBorrowShares);

  const thisVaultOwnShares = 134773724813238997090304n; // from earlier getVaultEntireData totalSupplyAndBorrow.totalBorrowVault
  const fraction = Number(thisVaultOwnShares) / Number(totalBorrowShares);
  console.log(`this vault's fraction of pool debt shares: ${(fraction * 100).toFixed(4)}%`);

  console.log("real pool token0Debt/token1Debt:", reserves.token0Debt, reserves.token1Debt);
  console.log(`this vault's real share of token0Debt: ${(Number(reserves.token0Debt) * fraction).toFixed(0)}`);
  console.log(`this vault's real share of token1Debt: ${(Number(reserves.token1Debt) * fraction).toFixed(0)}`);
}
main().catch(console.error);
