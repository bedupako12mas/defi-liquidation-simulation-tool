import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0xB58634A962A579bD01c392451a718cB5d74DfB53" as const;
const ABI = parseAbi([
  "function simulateLiquidate(uint256 debtAmt_, bool absorb_) external",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const calldata = encodeFunctionData({ abi: ABI, functionName: "simulateLiquidate", args: [0n, false] });
  try {
    await publicClient.call({ to: VAULT, data: calldata });
    console.log("NO REVERT (unexpected)");
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) { console.log("no revert data:", (err as Error).message.slice(0,150)); return; }
    try {
      const decoded = decodeErrorResult({ abi: ABI, data });
      console.log(`${decoded.errorName}(${decoded.args.join(",")})`);
    } catch { console.log("undecodable raw:", data); }
  }
}
main().catch(console.error);
