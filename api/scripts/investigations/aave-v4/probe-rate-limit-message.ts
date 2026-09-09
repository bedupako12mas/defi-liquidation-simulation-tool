import { publicClient } from "../../../src/rpc/client.js";
import { AAVE_V4_SPOKE_ADDRESSES } from "../../../src/loaders/aaveV4Addresses.js";
import { parseAbiItem } from "viem";

const BORROW_EVENT = parseAbiItem(
  "event Borrow(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 drawnAmount)",
);

async function main() {
  const finalized = (await publicClient.getBlock({ blockTag: "finalized" })).number;
  // Fire a burst of concurrent getLogs calls to force a real 429, then print the raw message.
  const promises = Array.from({ length: 8 }, (_, i) =>
    publicClient
      .getLogs({ address: AAVE_V4_SPOKE_ADDRESSES, event: BORROW_EVENT, fromBlock: finalized - 5000n, toBlock: finalized })
      .then(() => `call ${i}: success`)
      .catch((err) => `call ${i}: ${err instanceof Error ? err.message : String(err)}`),
  );
  const results = await Promise.all(promises);
  for (const r of results) console.log(r);
  console.log("---END---");
}
main().catch(console.error);
