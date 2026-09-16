import { db } from "../src/db/client.js";
import { runSyncChainedLiquidation } from "../src/sync/chainedLiquidation.js";

// Thin CLI wrapper for local/manual dev (`npm run sync:chained-liquidation`) - the real sync
// logic lives in src/sync/chainedLiquidation.ts now, specifically so it also compiles into
// dist/sync/chainedLiquidation.js and is runnable inside the real deployed container image
// (k8s Job, see k8s/base/sync-chained-liquidation-job.yaml), which scripts/ never was.
const ok = await runSyncChainedLiquidation();
await db.destroy();
process.exitCode = ok ? 0 : 1;
