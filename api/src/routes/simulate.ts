import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { getShockPreset } from "../engine/shockModel.js";
import { sweep } from "../engine/sweep.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";
import { classifyForShock } from "./aaveShockClassification.js";
import { loadLatestAaveSnapshot } from "./latestSnapshot.js";

// Fixed, server-controlled sweep range - never derived from a request parameter. Matches
// the mock fixtures' own range (web/scripts/generate-mock-fixtures.ts) so the UI's
// existing behavior doesn't change. context.md §10 "denial of wallet": capping sweep
// granularity server-side, regardless of what a caller might ask for, is the whole point -
// there is currently no caller-supplied range at all, which is the strongest version of
// that rule (nothing to cap because nothing is accepted).
function sweepMagnitudes(): number[] {
  const out: number[] = [];
  for (let pct = 0; pct >= -80; pct -= 1) out.push(pct / 100);
  return out;
}

function sendEvent(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Node is single-threaded; sweep() is fully synchronous CPU work with no natural yield
// point. Reviewed and confirmed live: without an explicit yield, a destroyed client
// socket's 'close' event never gets a chance to fire mid-loop, so a disconnect check
// inside the loop was dead code, and a long sweep blocks the whole event loop - including
// /health, against k8s's liveness probe timeout. Yielding via setImmediate between every
// magnitude gives Node's event loop an actual turn to deliver the 'close' event and to
// service other requests.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A second, explicit backstop beyond the rate limiter: caps how many /api/simulate
// streams can be open across the whole process at once, not per IP. The rate limiter
// bounds new connections per minute per IP; this bounds total concurrent CPU-bound work
// regardless of how many distinct IPs are involved.
const MAX_CONCURRENT_STREAMS = 10;
let activeStreams = 0;

export function registerSimulateRoute(
  app: FastifyInstance,
  deps: { db: Kysely<DB>; client: PublicClient; allowedOrigins: string[] },
) {
  app.get(
    "/api/simulate",
    async (request: FastifyRequest<{ Querystring: { presetId?: string } }>, reply: FastifyReply) => {
      const preset = getShockPreset(request.query.presetId);

      if (!preset) {
        // Reject before opening the SSE stream at all - an invalid presetId is a normal
        // 400, not a stream that opens and then immediately errors.
        reply
          .code(400)
          .send({ error: `Unknown presetId "${request.query.presetId}".` });
        return;
      }

      if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        reply.code(503).send({ error: "Too many concurrent simulations - try again shortly." });
        return;
      }
      activeStreams++;

      // @fastify/cors hooks into Fastify's normal response lifecycle (reply.send()) to
      // inject Access-Control-Allow-Origin - it never fires here, since this route bypasses
      // that entirely via reply.raw.writeHead() to stream. Found live: curl doesn't check
      // CORS (only browsers do), so every curl-based test of this route looked completely
      // fine while a real browser's EventSource silently failed with no CORS header at all.
      // Reproducing the same origin-allowlist check @fastify/cors does, by hand, here.
      const origin = request.headers.origin;
      const corsHeaders: Record<string, string> = { Vary: "Origin" };
      if (origin && deps.allowedOrigins.includes(origin)) {
        corsHeaders["Access-Control-Allow-Origin"] = origin;
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders,
      });

      let clientDisconnected = false;
      request.raw.on("close", () => {
        clientDisconnected = true;
      });

      try {
        const snapshot = await loadLatestAaveSnapshot(deps.db);
        if (!snapshot) {
          sendEvent(reply, "error", { message: "No Aave snapshot available yet - run the indexer first." });
          reply.raw.end();
          return;
        }

        const reserveConfigs = await getCachedReserveConfigs(deps.client);
        const assetConfig = Object.fromEntries(reserveConfigs.map((r) => [r.asset, classifyForShock(r)]));

        for (const magnitude of sweepMagnitudes()) {
          if (clientDisconnected) break;

          const [point] = sweep({
            positions: snapshot.positions,
            basePrices: snapshot.basePrices,
            assetConfig,
            preset,
            magnitudes: [magnitude],
          });

          if (point) {
            sendEvent(reply, "point", { protocol: "aave", point });
          }
          // No fluid point emitted - Fluid data doesn't exist yet. Omitted, not faked.

          await yieldToEventLoop();
        }

        if (!clientDisconnected) {
          sendEvent(reply, "done", { preset });
        }
      } catch (err) {
        // Never forward err.message here - a live RPC/DB error can embed a credential-
        // bearing URL (viem's HttpRequestError includes the request URL; RPC_URL_MAINNET
        // carries the Alchemy key in its path). Logged in full server-side via app.log,
        // the client gets a generic message. Same reasoning as server.ts's global
        // setErrorHandler, applied here too since this route catches its own errors
        // instead of letting them reach that handler.
        app.log.error(err);
        sendEvent(reply, "error", { message: "Simulation failed." });
      } finally {
        activeStreams--;
        reply.raw.end();
      }
    },
  );
}
