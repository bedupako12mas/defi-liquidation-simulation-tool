// Cross-checks our own computed `liquidatable` flag (fluidSmartLegValuation.ts /
// syncFluidT2Shock.ts) against Fluid's real, contract-provided answer - the same real
// dry-run mechanism (FluidLiquidateResult, via getVaultLiquidation()) already used
// elsewhere in this project. Same reasoning as T1's Validation tab: trust the real contract
// over our own math, verify our math agrees with it - don't just assume it does.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { FLUID_VAULT_RESOLVER } from "../../../src/loaders/fluidAddresses.js";
import { parseAbi } from "viem";

const ABI = parseAbi([
  "struct LiquidationStruct { address vault; address token0In; address token0Out; address token1In; address token1Out; uint256 inAmt; uint256 outAmt; uint256 inAmtWithAbsorb; uint256 outAmtWithAbsorb; bool absorbAvailable; }",
  "function getVaultLiquidation(address vault, uint256 tokenInAmt) returns (LiquidationStruct)",
]);

// The 3 real vaults we independently computed as liquidatable at baseline (0% shock).
const VAULTS = [
  "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9",
  "0x0FAA99E9662d5b6000f525b830CA2d054cDB8339",
  "0x7e1874Cdc9195163c23A1bb38B83E136B0b1D8E5",
] as const;

async function main() {
  await assertAllowedChain();
  for (const vault of VAULTS) {
    try {
      const result = await publicClient.simulateContract({
        address: FLUID_VAULT_RESOLVER,
        abi: ABI,
        functionName: "getVaultLiquidation",
        args: [vault as `0x${string}`, 0n],
      });
      const { inAmt, outAmt, inAmtWithAbsorb, outAmtWithAbsorb, absorbAvailable } = result.result;
      console.log(`${vault}:`);
      console.log(`  real dry-run inAmt=${inAmt} outAmt=${outAmt} (with absorb: in=${inAmtWithAbsorb} out=${outAmtWithAbsorb}, absorbAvailable=${absorbAvailable})`);
      console.log(`  Fluid's own contract says liquidatable right now? ${inAmt > 0n || outAmt > 0n || inAmtWithAbsorb > 0n || outAmtWithAbsorb > 0n}`);
    } catch (err) {
      console.log(`${vault}: getVaultLiquidation call FAILED - ${(err as Error).message.slice(0, 200)}`);
    }
  }
}
main().catch((e) => console.error(e));
