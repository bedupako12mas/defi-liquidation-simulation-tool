import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { db } from "../src/db/client.js";
import { validateAaveHealthFactors } from "../src/validation/aaveHealthFactorValidation.js";
import { redactError } from "../src/rpc/redact.js";

const SAMPLE_SIZE = Number(process.env.VALIDATION_SAMPLE_SIZE ?? "50");

async function main() {
  await assertAllowedChain();

  const candidates = await db
    .selectFrom("aave_borrow_candidates")
    .select("address")
    .limit(SAMPLE_SIZE)
    .execute();

  if (candidates.length === 0) {
    console.error("No candidates in aave_borrow_candidates - run `npm run index:aave` first.");
    process.exitCode = 1;
    await db.destroy();
    return;
  }

  // Pin one block for the whole comparison - required, not a convenience default. See
  // aaveHealthFactorValidation.ts's docs for why an unpinned comparison would be
  // comparing against a moving target.
  const blockNumber = await publicClient.getBlockNumber();

  const rows = await validateAaveHealthFactors(
    publicClient,
    candidates.map((c) => c.address),
    blockNumber,
  );

  const failures = rows.filter((r) => !r.withinTolerance);

  console.log(`Validated ${rows.length} positions at block ${blockNumber}`);
  console.log(`  within tolerance: ${rows.length - failures.length}`);
  console.log(`  FAILED:           ${failures.length}`);

  for (const row of failures) {
    console.log(
      `  MISMATCH ${row.user}: ours=${row.ourHf ?? "null"} onChain=${row.onChainHf ?? "null"} diffBps=${row.diffBps ?? "n/a"}`,
    );
  }

  await db.destroy();
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((err) => {
  // See redact.ts - a raw console.error(err) here can print the RPC_URL_MAINNET/
  // DATABASE_URL credential embedded in a viem/pg error's own message.
  console.error(redactError(err));
  process.exitCode = 1;
});
