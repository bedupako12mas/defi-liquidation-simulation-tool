import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { parseAbi, encodeFunctionData, decodeErrorResult } from "viem";

const VAULT = "0x57EF7CdCdb639742Fcd4FF88Edb00BbDad1929F9" as const;
const LEG = "0x0964957869B2FDd70f0a120E8d8D7A5A187abB6C" as const;
const CURRENT_RATE = 1098343637572458800000000000n;
const DEBT_AMT = 18058587730924n;

const ABI = parseAbi([
  "function simulateLiquidate(uint256 debtAmt_, bool absorb_) external",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();

  // First: zero override, real current conditions.
  const calldata = encodeFunctionData({ abi: ABI, functionName: "simulateLiquidate", args: [DEBT_AMT, false] });
  try {
    await publicClient.call({ to: VAULT, data: calldata });
    console.log("baseline: NO REVERT (unexpected)");
  } catch (err) {
    const data = extractRevertData(err);
    if (!data) { console.log("baseline: no revert data -", (err as Error).message.slice(0,150)); }
    else {
      try {
        const decoded = decodeErrorResult({ abi: ABI, data });
        console.log(`baseline: ${decoded.errorName}(${decoded.args.join(",")})`);
      } catch { console.log("baseline: raw data", data); }
    }
  }

  // Then: ladder with the price override.
  for (const pct of [1, 5, 10, 20, 30, 50, 65, 80, 90, 95, 99]) {
    const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
    const shockedRate = (CURRENT_RATE * factor) / 1_000_000n;
    try {
      await publicClient.call({ to: VAULT, data: calldata, stateOverride: [{ address: LEG, code: buildFixedReturnBytecode(shockedRate) }] });
      console.log(`${pct}%: NO REVERT (unexpected)`);
    } catch (err) {
      const data = extractRevertData(err);
      if (!data) { console.log(`${pct}%: no revert data`); continue; }
      try {
        const decoded = decodeErrorResult({ abi: ABI, data });
        console.log(`${pct}%: ${decoded.errorName}(${decoded.args.join(",")})`);
      } catch { console.log(`${pct}%: raw`, data.slice(0,80)); }
    }
  }
}
main().catch(console.error);
