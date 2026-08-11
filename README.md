# Aave V3 vs. Fluid T1 Liquidation Simulator

A backend project comparing how Aave V3 and Fluid's T1 vaults handle liquidations under market
stress — real on-chain positions, deterministic price-shock simulation, and (planned) a
mainnet-fork validation tier for both protocols.

## Status

This repo tracks the application and its deployment infrastructure. Currently:

- `v2/api` — the simulation engine (health factor, toxic-liquidation-frontier math) is built and
  unit-tested. Real position loaders (Aave, then Fluid) are next.
- `v2/web` — not yet built.
- CI/CD (`.github/`), Kubernetes manifests (`k8s/`), and security scanning (`gitleaks.toml`) are
  in place ahead of the application code they'll deploy.

See `DEPLOYMENT.md` for the infrastructure runbook.

## Running locally

```bash
cd v2/api
npm install
npm test        # engine unit tests
npm run dev      # once a server exists
```

## Stack

Vercel (frontend), DigitalOcean Kubernetes (API), GitHub Actions (CI/CD), HashiCorp Vault
(secrets), Cloudflare (edge), BetterStack (monitoring).
