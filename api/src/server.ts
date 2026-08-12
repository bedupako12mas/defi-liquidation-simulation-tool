import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { publicClient, assertAllowedChain } from "./rpc/client.js";
import { db } from "./db/client.js";
import { registerMetaRoute } from "./routes/meta.js";
import { registerSimulateRoute } from "./routes/simulate.js";
import { registerPositionsRoute } from "./routes/positions.js";

const app = Fastify({ logger: true });

// context.md §10: "CORS locked to specific Vercel domains, not *" - ALLOWED_ORIGINS is a
// required, explicit allowlist (comma-separated), never a wildcard. Defaults to the local
// Next.js dev origin only, so an unconfigured deploy fails closed (empty-string split
// produces [""], which matches nothing) rather than accidentally open.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

await app.register(cors, { origin: allowedOrigins });

// context.md §10 names per-IP rate limiting explicitly ("cap sweep granularity
// server-side... rate-limit per IP") - this was the one piece of that sentence not
// actually implemented when the routes first shipped, caught in review. /api/simulate
// is the expensive one (a full 81-point sweep per request); the global limit is
// deliberately the binding constraint everywhere rather than a route-by-route guess.
await app.register(rateLimit, {
  max: 20,
  timeWindow: "1 minute",
});

// Catches anything that reaches here uncaught - most importantly errors thrown out of
// live RPC calls (loadReserveConfigs, enrichPositions) or DB calls. Both viem's
// HttpRequestError and pg's connection errors can embed the underlying connection URL
// in their .message - RPC_URL_MAINNET and DATABASE_URL both carry credentials in that
// URL. Sending err.message straight to a caller (an earlier version of simulate.ts did
// exactly this) would leak those credentials to the public internet on an ordinary,
// expected-in-production RPC hiccup - not a hypothetical, this is the actual shape of a
// real error a live provider throws. Logged in full server-side; the client gets a
// generic message.
app.setErrorHandler((error: FastifyError, request, reply) => {
  app.log.error(error);
  reply.status(error.statusCode ?? 500).send({ error: "Internal server error" });
});

registerMetaRoute(app, { db, client: publicClient });
registerSimulateRoute(app, { db, client: publicClient, allowedOrigins });
registerPositionsRoute(app, { db, client: publicClient });

app.get("/health", async () => ({ ok: true }));

async function main() {
  // Fail loud before binding a port, not on the first request - same pattern as every
  // other entrypoint in this codebase.
  await assertAllowedChain();

  const port = Number(process.env.PORT ?? 4000);
  // 0.0.0.0, not 127.0.0.1: this runs in a container (k8s/base/deployment.yaml), where
  // the pod's readiness/liveness probes and the Service connect via the pod's real
  // network interface, not localhost. A 127.0.0.1 bind (fine for a bare local script,
  // which is what the original demo was) would make the process run successfully while
  // being completely unreachable from outside the container - a silent, hard-to-diagnose
  // failure mode, not a crash.
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen({ port, host });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
