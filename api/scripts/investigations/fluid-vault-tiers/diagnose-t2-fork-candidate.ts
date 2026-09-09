import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9" as const; // reUSD/USDT
const LEG = "0x0964957869B2FDd70f0a120E8d8D7A5A187abB6C" as const; // reserves-conversion oracle
const CURRENT_RATE = 1098343637572458800000000000n;
const DEBT_AMT = 18058587730924n; // real totalBorrowVault from earlier census

const LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const calldata = encodeFunctionData({ abi: LIQUIDATE_ABI, functionName: "liquidate", args: [DEBT_AMT, 0n, "0x000000000000000000000000000000000000dEaD", false] });

  for (const pct of [1, 5, 10, 20, 30, 50, 65, 80, 90, 95, 99]) {
    const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
    const shockedRate = (CURRENT_RATE * factor) / 1_000_000n;
    try {
      await publicClient.call({
        to: VAULT,
        data: calldata,
        stateOverride: [{ address: LEG, code: buildFixedReturnBytecode(shockedRate) }],
      });
      console.log(`${pct}%: NO REVERT (unexpected - liquidate() dry-run should always revert with a result)`);
    } catch (err) {
      const data = extractRevertData(err);
      if (!data) {
        console.log(`${pct}%: no revert data extracted - raw: ${(err as Error).message.slice(0, 150)}`);
        continue;
      }
      try {
        const decoded = decodeErrorResult({ abi: LIQUIDATE_ABI, data });
        if (decoded.errorName === "FluidLiquidateResult") {
          console.log(`${pct}%: FluidLiquidateResult actualColAmt=${decoded.args[0]} actualDebtAmt=${decoded.args[1]}`);
        } else if (decoded.errorName === "FluidVaultError") {
          console.log(`${pct}%: FluidVaultError errorId=${decoded.args[0]}`);
        } else {
          console.log(`${pct}%: unrecognized error ${decoded.errorName}`);
        }
      } catch (decodeErr) {
        console.log(`${pct}%: decode failed, raw data: ${data.slice(0, 80)} (${(decodeErr as Error).message.slice(0, 100)})`);
      }
    }
  }
}
main().catch(console.error);
