# Aave V3/V4 vs. Fluid Liquidation Simulator

A full-stack project comparing how Aave (V3 and V4) and Fluid's vault tiers (T1-T4) handle
liquidations under market stress — real on-chain positions, deterministic price-shock
simulation, and a mainnet-fork validation tier for both protocols.

## Status

Both `api` and `web` are built and live, deployed through the real CI/CD pipeline described in
`DEPLOYMENT.md`:

- `api` — simulation engine (health factor, toxic-liquidation-frontier math), real position
  indexers for Aave V3/V4 and Fluid T1-T4, liquidation/profitability validators, a mainnet-fork
  validation tier (real `liquidationCall()`/chained-liquidation execution via `anvil`), and
  self-hosted Postgres for position/result storage.
- `web` — Next.js frontend (Overview, Validation, Cascade Detail, Smart Vaults, Methodology
  tabs), deployed on Vercel.
- CI/CD (`.github/`), Kubernetes manifests (`k8s/`), and security scanning (Trivy image scan,
  `npm audit`, `gitleaks` against full history) gate every deploy — see `ci.yml`'s `ci-gate` job.

## Live environments

- **Production**: https://defi-liquidation-simulation-tool-amber.vercel.app (frontend) →
  `https://prod.139-59-49-28.nip.io` (API), deploys from `main`, gated behind manual review on
  the `prod` GitHub Environment.
- **Staging**: Vercel's Preview deployment for the `staging` branch → 
  `https://staging.139-59-49-28.nip.io` (API), deploys automatically on push to `staging`.
- Both API origins run on a single DigitalOcean Kubernetes cluster (`liquidation-sim-cluster`,
  cost-constrained to one small node — see `k8s/base/deployment.yaml`'s comments), namespaced
  apart, with real HashiCorp Vault-backed secrets and Let's Encrypt TLS via cert-manager.
- Cloudflare (the intended edge/WAF/rate-limiting layer) is not yet wired up — it requires a
  registered domain, which doesn't exist yet. The `nip.io` hostnames above are real, working
  HTTPS endpoints in the meantime.

See `DEPLOYMENT.md` for the full infrastructure runbook.

## Running locally

```bash
cd api
npm install
npm test        # engine + integration tests
npm run dev      # http://localhost:4000

cd web
npm install
npm test         # component tests
npm run dev       # http://localhost:3000 (talks to the local api by default)
```

## Stack

Vercel (frontend), DigitalOcean Kubernetes (API), GitHub Actions (CI/CD), HashiCorp Vault
(secrets), BetterStack (monitoring - not yet configured), Cloudflare (edge - deferred, needs a
domain).
