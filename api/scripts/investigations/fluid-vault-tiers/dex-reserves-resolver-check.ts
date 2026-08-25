// Live verification of the new DexReservesResolver address + ABI shape before hardcoding it
// into fluidAddresses.ts, matching this project's existing convention (see fluidAddresses.ts's
// own top comment) of verifying resolver addresses live before trusting them.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { parseAbi } from "viem";

const DEX_RESERVES_RESOLVER = "0x05Bd8269A20C472b148246De20E6852091BF16Ff" as const;

const ABI = parseAbi([
  "struct CollateralReserves { uint256 token0RealReserves; uint256 token1RealReserves; uint256 token0ImaginaryReserves; uint256 token1ImaginaryReserves; }",
  "struct DebtReserves { uint256 token0Debt; uint256 token1Debt; uint256 token0RealReserves; uint256 token1RealReserves; uint256 token0ImaginaryReserves; uint256 token1ImaginaryReserves; }",
  "function getDexCollateralReserves(address dex) returns (CollateralReserves)",
  "function getDexDebtReserves(address dex) returns (DebtReserves)",
  "function getPoolTokens(address pool) view returns (address token0, address token1)",
]);

const KNOWN_T3_DEBT_DEX = "0x085b07a30381f3cc5a4250e10e4379d465b770ac" as const; // shared by 6 real T3 vaults
const KNOWN_T4_DEX = "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b" as const; // shared by 18 real vaults

async function main() {
  await assertAllowedChain();

  const code = await publicClient.getCode({ address: DEX_RESERVES_RESOLVER });
  console.log(`DexReservesResolver has real code deployed? ${!!code && code !== "0x"}`);

  for (const [label, dex] of [
    ["T3 shared debt-side pool", KNOWN_T3_DEBT_DEX],
    ["T2/T3/T4 shared pool (18 vaults)", KNOWN_T4_DEX],
  ] as const) {
    const tokens = await publicClient.readContract({
      address: DEX_RESERVES_RESOLVER,
      abi: ABI,
      functionName: "getPoolTokens",
      args: [dex],
    });
    console.log(`\n${label} (${dex}): token0=${tokens[0]} token1=${tokens[1]}`);

    const debtReserves = await publicClient.simulateContract({
      address: DEX_RESERVES_RESOLVER,
      abi: ABI,
      functionName: "getDexDebtReserves",
      args: [dex],
    });
    console.log(`  debt reserves:`, debtReserves.result);

    const colReserves = await publicClient.simulateContract({
      address: DEX_RESERVES_RESOLVER,
      abi: ABI,
      functionName: "getDexCollateralReserves",
      args: [dex],
    });
    console.log(`  collateral reserves:`, colReserves.result);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
