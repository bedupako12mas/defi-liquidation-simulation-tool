import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { parseAbi, encodeFunctionData } from "viem";

const VAULT = "0xb4a15526d427f4d20b0dAdaF3baB4177C85A699A" as const;
const LEG = "0x5f51AF8512d108F29c1f8De692fa96f0D3776a54" as const;
const CURRENT_RATE = 1102831254225611614215312782n;
const REQUEST_AMT = 1912980216479095334483n;

const ABI = parseAbi(["function liquidate(uint256,uint256,uint256,uint256,address,bool) payable returns (uint256,uint256,uint256,uint256)"]);

async function main() {
  await assertAllowedChain();
  for (const pct of [65, 80]) {
    const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
    const shockedRate = (CURRENT_RATE * factor) / 1_000_000n;
    const calldata = encodeFunctionData({ abi: ABI, functionName: "liquidate", args: [REQUEST_AMT, 0n, 0n, 0n, "0x1111111111111111111111111111111111111111", false] });
    try {
      await publicClient.call({ to: VAULT, data: calldata, stateOverride: [{ address: LEG, code: buildFixedReturnBytecode(shockedRate) }] });
      console.log(`${pct}%: NO REVERT`);
    } catch (err) {
      const data = extractRevertData(err);
      console.log(`${pct}%: raw revert data = ${data}`);
    }
  }
}
main().catch(console.error);
