import { db } from "../src/db/client.js";
import { runSyncValidationResults } from "../src/sync/validationResults.js";

// Thin CLI wrapper for local/manual dev (`npm run sync:validation-results`) - the real sync
// logic lives in src/sync/validationResults.ts now, specifically so it also compiles into
// dist/sync/validationResults.js and is runnable inside the real deployed container image
// (k8s Job, see k8s/base/sync-validation-job.yaml), which scripts/ never was.
const ok = await runSyncValidationResults();
await db.destroy();
process.exitCode = ok ? 0 : 1;
