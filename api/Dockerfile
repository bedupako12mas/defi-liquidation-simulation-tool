# v2/api/Dockerfile
#
# NOTE: v2/api does not exist yet (context.md's real backend, not the app/api demo). This
# Dockerfile is written against the shape context.md/STUDY_GUIDE.md describe the demo
# following: Node/TypeScript/Fastify, "npm run build" -> dist/, "npm start" runs the built
# output, a GET /health route, and a PORT env var. Once v2/api's real package.json exists,
# re-check: the exact build script name, whether it emits to dist/, and whether any native
# addons need extra apt packages in the builder stage.
#
# TODO(security, CIS Docker Benchmark 4.2 - pin image versions): both FROM lines below
# should be pinned to a resolved sha256 digest, not just the "node:22-slim" tag. A tag is
# mutable - the maintainer can repoint it to a different image tomorrow, which silently
# changes what ships to prod and defeats reproducible builds / image scanning history.
# I cannot resolve a real digest here: doing so requires pulling the image from Docker Hub,
# and this environment has no registry network access. Before the first real build, a human
# (or a CI job that does have registry access) must run:
#     docker pull node:22-slim
#     docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
# and replace every "FROM node:22-slim" below with the resulting
# "FROM node:22-slim@sha256:<digest>". Re-resolve and bump intentionally (not silently) on
# a regular cadence, since Dependabot (.github/dependabot.yml) does not track Docker base
# images in this repo yet - that would be a natural follow-up once this file has real usage.

# ---------------------------------------------------------------------------
# Stage 1: build - has devDependencies and the TypeScript compiler, never shipped.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# Copy only manifests first so this layer caches across dependency-unchanged rebuilds.
COPY package.json package-lock.json ./
# npm ci, not npm install: fails closed on a lockfile/manifest mismatch instead of silently
# resolving new versions at build time (OWASP A03 - Software Supply Chain Failures: a build
# should install exactly what was audited/scanned in CI, not "whatever satisfies the range
# today").
RUN npm ci

COPY . .
RUN npm run build

# Prune devDependencies out of node_modules before copying it into the runtime stage, so the
# shipped image doesn't carry the TypeScript compiler, test runner, etc.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime - minimal, non-root, read-only-root-fs-friendly.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# CIS Docker Benchmark 4.1: run as a non-root user. node:*-slim ships a "node" user/group
# (uid/gid 1000) out of the box - reuse it instead of inventing a new one.
# CIS Docker Benchmark 5.x / OWASP A06 (Insecure Design): a container that runs as root
# means a code-execution bug in the app is a code-execution bug on the host user namespace's
# root mapping too. There is no reason this API needs root for anything it does.
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

# PORT is configurable (matches app/api/src/server.ts's `process.env.PORT ?? 4000` pattern);
# 4000 is the default so local `docker run` without extra flags still works.
ENV PORT=4000
EXPOSE 4000

USER node

# CIS Docker Benchmark 4.6 / OWASP A09 (Security Logging and Alerting Failures): a
# HEALTHCHECK gives the orchestrator (and a human running `docker ps`) a signal independent
# of "the process didn't crash" - a Fastify process can be alive but stuck (event loop
# blocked, DB pool exhausted) and still fail this. Kubernetes uses its own liveness/readiness
# probes (see k8s/base/deployment.yaml) against the same /health route; this HEALTHCHECK is
# for plain `docker run` / local compose use, where there is no kubelet to ask.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No shell form, no package-manager-installed extras at runtime: smaller attack surface,
# fewer CVEs for Trivy to ever have to flag (OWASP A03).
#
# read-only root filesystem: this image itself writes nothing to disk at runtime (Fastify
# logs go to stdout - see server.ts's `logger: true` - and there's no local file cache), so
# it is safe to run with Kubernetes' `securityContext.readOnlyRootFilesystem: true` (set in
# k8s/base/deployment.yaml) unmodified. If a future feature needs scratch space, mount an
# explicit emptyDir at e.g. /tmp rather than removing the read-only setting.
CMD ["node", "dist/server.js"]
