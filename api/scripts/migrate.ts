import { db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

// Thin CLI wrapper for local/manual dev (`npm run migrate` / `migrate:down`) - the real
// Migrator logic lives in src/db/migrate.ts now, specifically so it also compiles into
// dist/db/migrate.js and is runnable inside the real deployed container image (k8s Job,
// see k8s/base/migrate-job.yaml), which scripts/ never was.
const direction = process.argv[2] === "down" ? "down" : "up";
const ok = await runMigrations(direction);
await db.destroy();
process.exitCode = ok ? 0 : 1;
