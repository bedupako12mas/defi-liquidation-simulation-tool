import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import { db } from "./client.js";
import { redactError } from "../rpc/redact.js";

// Lives under src/, not scripts/, specifically so it gets compiled into dist/db/migrate.js
// by the normal `npm run build` - the real reason migrations were never runnable inside the
// deployed container image at all (scripts/ is dev-only, never copied into the Docker
// image). Real, disclosed gap this closes: every migration up to and including
// 0003_validation_results.ts had to be applied by hand via `kubectl exec` against a live
// pod, for both staging and prod, because nothing in CI/CD could run one. See
// k8s/base/migrate-job.yaml + .github/workflows/deploy.yml's "Run migration" step - this
// function is what that Job's `node dist/db/migrate.js` actually executes.
const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function runMigrations(direction: "up" | "down" = "up"): Promise<boolean> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

  const { error, results } = direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();

  for (const result of results ?? []) {
    const status = result.status === "Success" ? "OK" : result.status;
    console.log(`[migration] ${result.migrationName}: ${status}`);
  }

  if (error) {
    // See redact.ts - a pg connection error can embed DATABASE_URL, credentials included,
    // directly in its .message. This is what actually runs inside a real k8s Job (real pod
    // logs, visible via `kubectl logs job/migrate`) as well as local dev, so this matters
    // in both places, not just locally.
    console.error("[migration] failed:", redactError(error));
    return false;
  }
  return true;
}

// Self-executing when run directly (`node dist/db/migrate.js` in the real container, or
// `tsx src/db/migrate.ts` / via scripts/migrate.ts locally) - NOT when imported as a
// library elsewhere, which nothing in this codebase currently does, but keeping the
// function itself side-effect-free (no process.exit/db.destroy inside runMigrations) is
// what makes that possible later without a rewrite.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const direction = process.argv[2] === "down" ? "down" : "up";
  const ok = await runMigrations(direction);
  await db.destroy();
  process.exit(ok ? 0 : 1);
}
