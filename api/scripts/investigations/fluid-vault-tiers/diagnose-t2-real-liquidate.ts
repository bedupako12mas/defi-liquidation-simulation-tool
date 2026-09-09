import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9" as const;
const LEG = "0x0964957869B2FDd70f0a120E8d8D7A5A187abB6C" as const;
const CURRENT_RATE = 1098343637572458800000000000n;
const DEBT_AMT = 18058587730924n;

// Real signature, sourced directly from Fluid's own VaultLiquidatorImplementationV1.sol
// (IFluidVaultT2 usage) - six params, not T1's four.
const ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_, uint256 actualToken0Amt_, uint256 actualToken1Amt_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const calldata = encodeFunctionData({ abi: ABI, functionName: "liquidate", args: [DEBT_AMT, 0n, 0n, 0n, "0x000000000000000000000000000000000000dEaD", false] });

  for (const pct of [0, 1, 5, 10, 20, 30, 50, 65, 80]) {
    const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
    const shockedRate = (CURRENT_RATE * factor) / 1_000_000n;
    try {
      await publicClient.call({ to: VAULT, data: calldata, stateOverride: [{ address: LEG, code: buildFixedReturnBytecode(shockedRate) }] });
      console.log(`${pct}%: NO REVERT (unexpected)`);
    } catch (err) {
      const data = extractRevertData(err);
      if (!data) { console.log(`${pct}%: no revert data -`, (err as Error).message.slice(0,150)); continue; }
      try {
        const decoded = decodeErrorResult({ abi: ABI, data });
        console.log(`${pct}%: ${decoded.errorName}(${decoded.args.join(",")})`);
      } catch (e) { console.log(`${pct}%: decode failed, raw:`, data.slice(0,80), (e as Error).message.slice(0,100)); }
    }
  }
}
main().catch(console.error);
