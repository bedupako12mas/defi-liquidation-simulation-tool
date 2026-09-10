# Deployment runbook

This repo now has DevOps scaffolding (`.github/workflows/`, `k8s/`, `api/Dockerfile`,
`web/vercel.json`, `gitleaks.toml`, `.github/dependabot.yml`) committed by an agent, in a
worktree, with no network access to any cloud provider and no account credentials. None of it
can deploy anything by itself yet. This document is the explicit list of what a human with
real credentials has to do, in roughly this order, before that changes.

**Why this isn't automated further:** every step below requires either (a) a credential that
only a human should hold and rotate (cloud account access, a Vault root token, a domain
registrar login), or (b) an interactive one-time authorization flow (`vercel login`, `doctl
auth init`) that's designed not to be scriptable by something that isn't the account owner.
An agent completing these steps on its own would mean either fabricating credentials (useless
at best, a security incident at worst) or somehow obtaining real ones (which should never
happen without a human directly in the loop). That's a deliberate boundary, not a gap in
effort.

---

## 0. Prerequisites this whole document assumes

- A GitHub repository this worktree's commits get pushed to (see step 1).
- Accounts, created by a human, with billing attached: Vercel, DigitalOcean, HashiCorp Cloud
  Platform (or self-hosted Vault), Cloudflare, BetterStack.
- The `doctl`, `vercel`, `kubectl`, and `kustomize` CLIs installed locally by whoever runs the
  one-time setup steps (not needed in CI - CI installs what it needs itself via Actions).

---

## 1. Git remote + push

`origin` is already set (`git remote -v`) and has real history - this step is about keeping
it current, not the one-time setup it originally was. Before every deploy attempt, confirm
local isn't sitting ahead of `origin/main`/`origin/staging` uncommitted-and-unpushed:

```bash
git fetch origin
git status --short --branch   # look for "ahead N" - CI can't gate on, and deploy.yml can't
                               # deploy, work that hasn't been pushed
git push origin <branch>
```

Then, in the GitHub repo's Settings:

- **Branch protection** on `main` and `staging`: require the `ci-gate` status check
  (`.github/workflows/ci.yml`) to pass before merge. This is what actually enforces "deploy
  gated on CI passing" at the GitHub level - the workflow files alone only *implement* the
  gate, a human has to *require* it.
- **Environments** named `staging` and `prod` (Settings → Environments): `deploy.yml`
  references both. Add required reviewers to the `prod` environment specifically - that's
  your manual approval gate in front of every production deploy.
- **Secrets** (Settings → Secrets and variables → Actions): at minimum, once the resources
  below exist, a DigitalOcean API token (referenced as `secrets.DIGITALOCEAN_ACCESS_TOKEN`
  in `deploy.yml`'s comments - the actual step is currently a stub) and registry push
  credentials. Scope tokens as narrowly as the provider allows; do not reuse a personal
  account token that also has billing/account-owner access.

---

## 2. Vercel (`web`)

Not runnable by an agent: `vercel login` opens a browser-based OAuth flow tied to a specific
human's identity, by design.

1. `vercel login` (interactively, as the account that should own this project).
2. `vercel link` inside `web` once that directory has real Next.js code in it - this
   writes a `.vercel/` directory locally (already covered by `.gitignore`'s `node_modules`/
   build-output patterns in spirit; add `.vercel` explicitly if it isn't already ignored by
   the time this runs, since it can contain project/org IDs).
3. In the Vercel dashboard: set the project's environment variables (e.g. the deployed
   `api` origin URL, once step 3 below produces one) separately for Preview/staging and
   Production - do not hardcode an API URL into committed code.
4. Confirm `web/vercel.json`'s headers actually show up (`curl -I` the deployed URL) once
   there's a real deployment to check.

---

## 3. DigitalOcean Kubernetes (DOKS) cluster

Not automatable: creating a cluster is a billed, account-scoped action.

**Redeploy note**: a real DOKS cluster existed before and was torn down for cost reasons -
`k8s/overlays/{staging,prod}/patch-ingress.yaml` still reference that cluster's real ingress
IP via `nip.io` hostnames (`staging.64-225-85-246.nip.io` / `prod.64-225-85-246.nip.io`, not
the `.invalid` placeholder `k8s/base/ingress.yaml` ships as its own default). That IP is dead
now - **replace both hostnames with the new cluster's real ingress IP once it exists** (step
3.5 below), don't assume the old ones still resolve to anything live. This is also the moment
to right-size node/replica counts against an actual budget instead of re-creating the same
shape by default - see the cost-control note at the end of this section.

1. Create the cluster (DO dashboard or `doctl kubernetes cluster create`) - one for staging,
   one for prod, or one cluster with two namespaces (`liquidation-sim-staging` /
   `liquidation-sim-prod`, matching `k8s/overlays/*/kustomization.yaml`) if cost is a
   concern. The manifests in this repo don't assume which - they only assume the namespace
   names above exist by the time `kubectl apply -k` runs.
2. `doctl kubernetes cluster kubeconfig save <cluster-name>` to get a local kubeconfig.
   **Never commit this file** - `.gitignore` already excludes `kubeconfig*` / `*.kubeconfig`
   / `.kube/config`, but the discipline matters more than the gitignore entry: a kubeconfig
   is a bearer credential for the whole cluster.
3. Install an ingress controller if the cluster doesn't have one - `k8s/base/ingress.yaml`
   assumes `ingressClassName: nginx` (ingress-nginx, DOKS's common marketplace 1-click).
   Confirm this is actually what gets installed; if DigitalOcean's native load-balancer
   annotations end up preferred instead, `k8s/base/ingress.yaml` needs more than a value
   change - flag that to whoever picks up this repo next.
4. Provision a container registry (DigitalOcean Container Registry, or GitHub Container
   Registry) and wire its push credentials into the GitHub Actions secrets `deploy.yml`
   references (`DOCR_REGISTRY`, `DIGITALOCEAN_ACCESS_TOKEN`) - see step 1's Secrets note.
5. Point real DNS at the cluster's ingress IP through Cloudflare (see step 5), then replace
   the stale/placeholder hostnames in `k8s/overlays/staging/patch-ingress.yaml` and
   `k8s/overlays/prod/patch-ingress.yaml` with the real, current ones - both files currently
   reference the OLD torn-down cluster's IP (see the redeploy note above), not the
   `.invalid` value `k8s/base/ingress.yaml`'s own default uses.
6. `deploy.yml`'s deploy steps are real now (`docker build`/`push`, `kubectl apply -k`,
   `kustomize edit set image`) - not stubs, despite this document's old placeholder list
   below still describing them that way. What's still needed is for the GitHub Actions
   secrets they reference to actually exist (step 1) and for the registry/cluster from steps
   above to be real.

**Cost control, given this came down once already**: before recreating the same shape,
decide deliberately rather than defaulting back to whatever was running before -
`k8s/base/deployment.yaml` and the overlays' `resources.requests`/`limits` are still
conservative starting *guesses*, not load-tested numbers (see the placeholder list below).
Concretely worth deciding up front: node pool size/count, whether staging and prod share one
small cluster (two namespaces) instead of two separate clusters, whether Vault
(`k8s/vault/values.yaml`, currently sized to "whatever headroom is left" - `cpu: 50-150m`,
`memory: 96-192Mi`) runs on the same node pool or gets its own, and a DO billing alert
threshold configured *before* anything is created, not after.

---

## 4. HashiCorp Vault

**Correction**: this section originally described an Injector-based plan that was never
actually built. The real, deployed shape (`k8s/vault/values.yaml`,
`scripts/sync-secrets-from-vault.sh`, comments in `k8s/base/deployment.yaml`) is deliberately
simpler: real standalone Vault (raft storage, real encryption at rest, manual Shamir unseal,
`injector.enabled: false`) running cluster-internal only (`ClusterIP`, no public ingress),
with a manual bridge script instead of the Vault Agent Injector - the Injector means a whole
second deployment (mutating webhook + sidecar injection), real resource cost this
cost-constrained cluster doesn't have room for. Vault is the real, encrypted, audited source
of truth for `DATABASE_URL`/`RPC_URL_MAINNET`; delivery to the pod stays the plain k8s
Secret (`api-secrets`) the deployment already reads via `envFrom` - unchanged either way.

Not automatable: initializing Vault and writing its policies is exactly the kind of
credential-issuing action that shouldn't happen without a human deciding what gets access to
what, and `vault operator init` displays the unseal keys + root token exactly once.

1. `helm install vault hashicorp/vault -f k8s/vault/values.yaml -n vault --create-namespace`
   (the chart values are already real and committed - nothing to write here).
2. `kubectl exec vault-0 -n vault -- vault operator init` - **store the unseal keys and root
   token somewhere real immediately** (a password manager, not this repo, not a chat log).
   This is shown exactly once.
3. `kubectl exec vault-0 -n vault -- vault operator unseal` (repeat with a threshold number of
   the real unseal keys from step 2).
4. Enable the KV v2 secrets engine at `liquidation-sim/` and write the two real per-environment
   secrets: `vault kv put liquidation-sim/staging/api-secrets DATABASE_URL=... RPC_URL_MAINNET=...`
   (and the same for `prod`) - separate paths per environment, matching the namespace split.
5. Write a `liquidation-sim-read` policy scoped to exactly those two paths (not a broad
   `secret/*` grant), and issue a token against it for `scripts/sync-secrets-from-vault.sh`
   to use (`VAULT_READ_TOKEN=<token> ./scripts/sync-secrets-from-vault.sh staging`, then
   `prod`) - re-run after any secret rotation or any `kubectl apply` that might reset the
   Secret.

---

## 5. Cloudflare

1. Add the real domain(s) as a Cloudflare zone, update nameservers at the registrar.
2. Point DNS records at the DOKS ingress IP (from step 3.3) for both the staging and prod
   hostnames that replace the `.invalid` placeholders.
3. Configure rate limiting rules for the API routes - context.md §10 calls this out
   explicitly ("rate limiting at the edge") as the primary defense against the sweep
   endpoint's cost-exhaustion risk; `k8s/base/ingress.yaml`'s `proxy-body-size` annotation is
   only a coarse backstop, not a substitute.
4. Decide and configure the TLS mode (Full strict, with either a Cloudflare Origin CA cert or
   cert-manager on the cluster) - noted as an open decision in `k8s/base/ingress.yaml`'s
   comments.

---

## 6. BetterStack

1. Create an uptime monitor against each environment's `/health` endpoint once real hostnames
   exist. **Correction**: `/health` (`api/src/server.ts`) is real and running, but currently
   just returns `{ ok: true }` unconditionally - it doesn't check DB or RPC connectivity, even
   though both throw at process startup if misconfigured. Worth deepening it (a cheap
   `SELECT 1`) before wiring an uptime monitor to it, so "healthy" means something beyond "the
   process didn't crash."
2. Wire up the metric context.md §9 calls out as meaningful: **indexer lag in blocks**.
   **Correction**: the indexers themselves (`aaveIndexer.ts`, `fluidIndexer.ts`,
   `aaveV4Indexer.ts`, `indexer_progress` table) are real and have been running all session -
   this part of the original doc was written before they existed and is stale. What's still
   genuinely missing is a route exposing `indexer_progress.last_indexed_block` vs. the current
   chain tip as a scrapeable/receivable metric - a small, real, scoped addition, not a
   rebuild.
3. Configure alerting destinations (who gets paged) - a people/process decision, not a config
   file.

---

## Explicit list of everything in this commit set that is a placeholder

Grep-able by searching for `TODO` and `PLACEHOLDER` across the repo, but summarized here:

- `api/Dockerfile` - base image tag (`node:22-slim`) not pinned to a digest; needs
  `docker pull` + `docker inspect` against a real registry.
- `.github/workflows/ci.yml` - `aquasecurity/trivy-action@0.28.0` and
  `gitleaks/gitleaks-action@v2` referenced by tag, not digest, for the same reason.
- `.github/workflows/deploy.yml` - **correction**: the deploy steps are real now (`docker
  build`/`push`, `kubectl apply -k`, `kustomize edit set image`), not stubs - this claim was
  accurate when first written and has since drifted stale. What's still missing is the
  registry/cluster/secrets themselves (see section 3).
- `k8s/base/deployment.yaml` - `image: api:unset` (deliberately inert placeholder, see
  comment in the file); Vault Agent Injector annotations correctly left absent (the real
  setup doesn't use the Injector at all - see the corrected Vault section above).
- `k8s/base/ingress.yaml` - its own default hostname still uses the `.invalid` TLD
  (IANA-reserved, guaranteed not to resolve) - correct and unchanged. The overlays
  (`k8s/overlays/*/patch-ingress.yaml`) currently reference the *previous, now-torn-down*
  cluster's real IP instead - see the redeploy note in section 3, replace with the new
  cluster's real IP once it exists. `ingressClassName: nginx` is still an assumption to
  reconfirm once the new cluster exists.
- `k8s/base/deployment.yaml` and both overlays' `resources.requests`/`resources.limits` -
  conservative starting guesses, not load-tested numbers.
- `.github/dependabot.yml` - the `api` and `web` directory entries will show as errored
  in the Dependabot UI until those directories have a real `package.json`.

None of these were made to *look* resolved - each is either commented as a TODO with the
exact command/step to resolve it, or uses a value (like `.invalid`) chosen specifically
because it cannot be mistaken for a real one.
