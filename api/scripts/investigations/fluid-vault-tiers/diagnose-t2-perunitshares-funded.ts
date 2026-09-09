import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { extractRevertData } from "../../../src/validation/fluidValidator.js";
import { buildFixedReturnBytecode } from "../../../src/validation/stateOverride.js";
import { probeTokenSlots } from "../../../src/validation/slotProbe.js";
import { parseAbi, encodeFunctionData, decodeErrorResult, keccak256, encodeAbiParameters, numberToHex } from "viem";

const VAULT = "0xb4a15526d427f4d20b0dAdaF3baB4177C85A699A" as const;
const LEG = "0x5f51AF8512d108F29c1f8De692fa96f0D3776a54" as const;
const CURRENT_RATE = 1102831254225611614215312782n;
const REQUEST_AMT = 1912980216479095334483n;
const AGENT = "0x1111111111111111111111111111111111111111" as const;
const BORROW_TOKEN = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const; // real wstETH debt token, verified live for this vault

const ABI = parseAbi([
  "function liquidate(uint256,uint256,uint256,uint256,address,bool) payable returns (uint256,uint256,uint256,uint256)",
  "error FluidLiquidateResult(uint256 actualColAmt_, uint256 actualDebtAmt_)",
  "error FluidVaultError(uint256 errorId_)",
]);

async function main() {
  await assertAllowedChain();
  const slots = await probeTokenSlots(publicClient, BORROW_TOKEN, AGENT, VAULT);
  if (!slots) { console.log("could not probe slots"); return; }
  const fundedAmount = REQUEST_AMT * 1000n + 10n ** 30n;
  const balanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AGENT, BigInt(slots.balanceSlotIndex)]));
  const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [AGENT, BigInt(slots.allowanceSlotIndex)]));
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [VAULT, ownerSlot]));

  for (const pct of [65, 80]) {
    const factor = BigInt(Math.round((1 - pct / 100) * 1_000_000));
    const shockedRate = (CURRENT_RATE * factor) / 1_000_000n;
    for (const perUnit of [0n, 1n, 1_000n, 1_000_000n, 1_000_000_000n, 10n ** 15n, 10n ** 18n]) {
      const calldata = encodeFunctionData({ abi: ABI, functionName: "liquidate", args: [REQUEST_AMT, 0n, perUnit, perUnit, AGENT, false] });
      try {
        await publicClient.call({
          account: AGENT,
          to: VAULT,
          data: calldata,
          stateOverride: [
            { address: LEG, code: buildFixedReturnBytecode(shockedRate) },
            { address: BORROW_TOKEN, stateDiff: [
              { slot: balanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
              { slot: allowanceSlot, value: numberToHex(fundedAmount, { size: 32 }) },
            ] },
          ],
        });
        console.log(`${pct}% perUnit=${perUnit}: NO REVERT (unexpected for eth_call return-value liquidate)`);
      } catch (err) {
        const data = extractRevertData(err);
        if (!data) { console.log(`${pct}% perUnit=${perUnit}: no revert data -`, (err as Error).message.slice(0,120)); continue; }
        try {
          const decoded = decodeErrorResult({ abi: ABI, data });
          console.log(`${pct}% perUnit=${perUnit}: ${decoded.errorName}(${decoded.args.join(",")})`);
        } catch {
          console.log(`${pct}% perUnit=${perUnit}: undecodable raw: ${data}`);
        }
      }
    }
  }
}
main().catch(console.error);
