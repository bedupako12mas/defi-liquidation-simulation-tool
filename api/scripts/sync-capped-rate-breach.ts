import { db } from "../src/db/client.js";
import { runSyncCappedRateBreach } from "../src/sync/cappedRateBreach.js";

// Thin CLI wrapper for local/manual dev (`npm run sync:capped-rate-breach`) - the real sync
// logic lives in src/sync/cappedRateBreach.ts now, specifically so it also compiles into
// dist/sync/cappedRateBreach.js and is runnable inside the real deployed container image
// (k8s Job, see k8s/base/sync-capped-rate-breach-job.yaml), which scripts/ never was.
const ok = await runSyncCappedRateBreach();
await db.destroy();
process.exitCode = ok ? 0 : 1;
