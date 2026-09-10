import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { PublicClient } from "viem";
import type { DB } from "../db/types.js";
import { getShockPreset, sweepMagnitudes } from "../engine/shockModel.js";
import { sweep } from "../engine/sweep.js";
import { getCachedReserveConfigs } from "./reserveConfigCache.js";
import { classifyForShock } from "./aaveShockClassification.js";
import { classifyFluidAssets } from "./fluidShockClassification.js";
import { loadLatestAaveSnapshot, loadLatestFluidSnapshot, loadLatestAaveV4Snapshot } from "./latestSnapshot.js";
import { redactError } from "../rpc/redact.js";

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

        // Fluid and aave-v4 snapshots are both optional at the route level - same "no
        // snapshot yet" tolerance as Aave's own null-check above, just non-fatal here since
        // Aave's stream already has real data to show. classifyFluidAssets reuses
        // reserveConfigs (already fetched above for Aave) - no extra RPC call for either.
        const fluidSnapshot = await loadLatestFluidSnapshot(deps.db);
        const fluidAssetConfig = fluidSnapshot ? classifyFluidAssets(fluidSnapshot.positions, reserveConfigs) : null;

        const aaveV4Snapshot = await loadLatestAaveV4Snapshot(deps.db);
        const aaveV4AssetConfig = aaveV4Snapshot ? classifyFluidAssets(aaveV4Snapshot.positions, reserveConfigs) : null;

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

          if (fluidSnapshot && fluidAssetConfig) {
            const [fluidPoint] = sweep({
              positions: fluidSnapshot.positions,
              basePrices: fluidSnapshot.basePrices,
              assetConfig: fluidAssetConfig,
              preset,
              magnitudes: [magnitude],
            });
            if (fluidPoint) {
              sendEvent(reply, "point", { protocol: "fluid", point: fluidPoint });
            }
          }

          if (aaveV4Snapshot && aaveV4AssetConfig) {
            const [aaveV4Point] = sweep({
              positions: aaveV4Snapshot.positions,
              basePrices: aaveV4Snapshot.basePrices,
              assetConfig: aaveV4AssetConfig,
              preset,
              magnitudes: [magnitude],
            });
            if (aaveV4Point) {
              sendEvent(reply, "point", { protocol: "aave-v4", point: aaveV4Point });
            }
          }
          // If a given snapshot is null, no point for it is emitted this round - omitted,
          // not faked, same discipline as the comment this replaced.

          await yieldToEventLoop();
        }

        if (!clientDisconnected) {
          sendEvent(reply, "done", { preset });
        }
      } catch (err) {
        // Never forward err.message to the client - a live RPC/DB error can embed a
        // credential-bearing URL (viem's HttpRequestError includes the request URL;
        // RPC_URL_MAINNET carries the Alchemy key in its path). The client only ever gets
        // a generic message. Server-side, app.log.error(err) would have the same problem
        // one level removed - pino's default err serializer prints .message/.stack (and a
        // viem BaseError's .details/.shortMessage/.metaMessages) straight into the server
        // logs, so route it through redactError first. See redact.ts and server.ts's
        // global setErrorHandler, which applies the same treatment.
        app.log.error(redactError(err));
        sendEvent(reply, "error", { message: "Simulation failed." });
      } finally {
        activeStreams--;
        reply.raw.end();
      }
    },
  );
}
