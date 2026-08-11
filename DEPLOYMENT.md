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

Nobody has pushed this anywhere - it's local commits in a worktree.

```bash
git remote add origin <your-github-repo-url>
git push -u origin <branch>
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
   Registry) and wire its push credentials into the GitHub Actions secret `deploy.yml`
   currently stubs out.
5. Point real DNS at the cluster's ingress IP through Cloudflare (see step 5), then replace
   the `.invalid` placeholder hostnames in `k8s/overlays/staging/patch-ingress.yaml` and
   `k8s/overlays/prod/patch-ingress.yaml` with the real ones.
6. Once the registry and cluster both exist, replace the stubbed steps in
   `.github/workflows/deploy.yml` ("Build and push image", "Authenticate to DOKS", "Set image
   and apply ... overlay") with the real `docker build`/`push`, `doctl`, and
   `kustomize edit set image` / `kubectl apply -k` commands each stub already sketches in its
   `echo` lines.

---

## 4. HashiCorp Vault

Not automatable: creating a Vault instance and its policies is exactly the kind of
credential-issuing action that shouldn't happen without a human deciding what gets access to
what.

1. Stand up Vault (HCP Vault Dedicated, or self-hosted on a small droplet/cluster - a
   separate decision from the DOKS cluster running the app).
2. Enable the Kubernetes auth method, pointed at the DOKS cluster's API server and CA cert.
3. Write a policy scoped to exactly what `api` needs to read (e.g.
   `secret/data/api/staging`, `secret/data/api/prod` - separate paths per environment,
   matching the namespace split above) - not a broad `secret/*` grant.
4. Create a Kubernetes auth role binding the `api` ServiceAccount (in each namespace) to
   that policy.
5. Install the Vault Agent Injector (Helm chart, `hashicorp/vault-k8s`) into the cluster.
6. Only then, uncomment and fill in the `vault.hashicorp.com/*` annotation block in
   `k8s/base/deployment.yaml` with the real role name and secret path - it's left commented
   out on purpose, see the comment already in that file for why a guessed `VAULT_ADDR` would
   be worse than an absent one.
7. Revisit the `automountServiceAccountToken: false` line in the same file once Vault auth is
   live - there's a comment flagging that Vault's Kubernetes auth method needs this pod's
   ServiceAccount token, and it's not yet confirmed whether the Injector supplies its own
   independent of that setting.

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
   exist.
2. Wire up the metric context.md §9 specifically calls out as meaningful: **indexer lag in
   blocks** - this requires the indexer (context.md §8's architecture diagram, not yet built)
   to emit that metric somewhere BetterStack can scrape/receive it. Nothing in this
   commit set builds the indexer; this is a forward pointer, not a completed step.
3. Configure alerting destinations (who gets paged) - a people/process decision, not a config
   file.

---

## Explicit list of everything in this commit set that is a placeholder

Grep-able by searching for `TODO` and `PLACEHOLDER` across the repo, but summarized here:

- `api/Dockerfile` - base image tag (`node:22-slim`) not pinned to a digest; needs
  `docker pull` + `docker inspect` against a real registry.
- `.github/workflows/ci.yml` - `aquasecurity/trivy-action@0.28.0` and
  `gitleaks/gitleaks-action@v2` referenced by tag, not digest, for the same reason.
- `.github/workflows/deploy.yml` - every actual deploy step is a stub that echoes intent and
  exits 1; no registry, cluster, or secret exists for it to act on yet.
- `k8s/base/deployment.yaml` - `image: api:unset` (deliberately inert placeholder, see
  comment in the file); Vault Agent annotations left absent, not guessed.
- `k8s/base/ingress.yaml`, `k8s/overlays/*/patch-ingress.yaml` - hostnames use the
  `.invalid` TLD (IANA-reserved, guaranteed not to resolve), and `ingressClassName: nginx`
  is an assumption to confirm once the cluster exists.
- `k8s/base/deployment.yaml` and both overlays' `resources.requests`/`resources.limits` -
  conservative starting guesses, not load-tested numbers.
- `.github/dependabot.yml` - the `api` and `web` directory entries will show as errored
  in the Dependabot UI until those directories have a real `package.json`.

None of these were made to *look* resolved - each is either commented as a TODO with the
exact command/step to resolve it, or uses a value (like `.invalid`) chosen specifically
because it cannot be mistaken for a real one.
