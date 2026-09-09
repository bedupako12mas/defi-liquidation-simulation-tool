import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9" as const;
const DEBT_AMT = 18058587730924n;

const LIQUIDATE_ABI = parseAbi([
  "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, address to_, bool absorb_) payable returns (uint256 actualDebtAmt_, uint256 actualColAmt_)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const calldata = encodeFunctionData({ abi: LIQUIDATE_ABI, functionName: "liquidate", args: [DEBT_AMT, 0n, "0x000000000000000000000000000000000000dEaD", false] });
  try {
    await publicClient.call({ to: VAULT, data: calldata }); // NO state override at all - real current conditions
    console.log("NO REVERT (unexpected)");
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) { console.log("no revert data:", (err as Error).message.slice(0,200)); return; }
    try {
      const decoded = decodeErrorResult({ abi: LIQUIDATE_ABI, data });
      console.log(`${decoded.errorName}(${decoded.args.join(",")})`);
    } catch {
      console.log("raw data:", data);
    }
  }
}
main().catch(console.error);
