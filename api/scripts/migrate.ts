import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import { db } from "../src/db/client.js";
import { redactError } from "../src/rpc/redact.js";

const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations",
);

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({ fs, path, migrationFolder }),
});

const direction = process.argv[2] === "down" ? "down" : "up";
const { error, results } =
  direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();

for (const result of results ?? []) {
  const status = result.status === "Success" ? "OK" : result.status;
  console.log(`[migration] ${result.migrationName}: ${status}`);
}

if (error) {
  // See redact.ts - a pg connection error can embed DATABASE_URL, credentials included,
  // directly in its .message.
  console.error("[migration] failed:", redactError(error));
  process.exit(1);
}

await db.destroy();
