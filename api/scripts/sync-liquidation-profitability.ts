import { db } from "../src/db/client.js";
import { runSyncLiquidationProfitability } from "../src/sync/liquidationProfitability.js";

// Thin CLI wrapper for local/manual dev (`npm run sync:liquidation-profitability`) - the real
// sync logic lives in src/sync/liquidationProfitability.ts now, specifically so it also
// compiles into dist/sync/liquidationProfitability.js and is runnable inside the real
// deployed container image (k8s Job, see k8s/base/sync-profitability-job.yaml), which
// scripts/ never was.
const ok = await runSyncLiquidationProfitability();
await db.destroy();
process.exitCode = ok ? 0 : 1;
