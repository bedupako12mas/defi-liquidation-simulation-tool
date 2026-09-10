#!/usr/bin/env bash
# Syncs api-secrets AND postgres-secrets from Vault (the real, encrypted, audited source of
# truth) into the k8s Secrets the api pod and the self-hosted Postgres StatefulSet actually
# read via envFrom - see k8s/base/deployment.yaml and k8s/base/postgres.yaml.
#
# Deliberately not dynamic secret injection (Vault Agent Injector / CSI provider) - that's
# real production-grade scope this deployment doesn't need yet (see docs/decisions.md).
# Vault is the real source of truth and audit trail; delivery to the pod stays the
# existing Secret-based mechanism. Re-run this after rotating a secret in Vault, or after
# any `kubectl apply` that might have reset a Secret.
#
# postgres-secrets is a SEPARATE Vault KV path from api-secrets (liquidation-sim/<env>/
# postgres-secrets, not bundled into api-secrets) - Postgres's own admin credentials are a
# different secret consumer than the api's runtime env, kept distinct on purpose.
#
# Usage: VAULT_READ_TOKEN=<token> ./sync-secrets-from-vault.sh <staging|prod>
set -euo pipefail

ENV="${1:?Usage: $0 <staging|prod>}"
NAMESPACE="liquidation-sim-${ENV}"

if [ -z "${VAULT_READ_TOKEN:-}" ]; then
  echo "VAULT_READ_TOKEN must be set (a token scoped to the liquidation-sim-read policy)." >&2
  exit 1
fi

vault_get() {
  kubectl exec vault-0 -n vault -- env "VAULT_TOKEN=${VAULT_READ_TOKEN}" vault kv get -format=json "$1"
}

API_SECRET_JSON=$(vault_get "liquidation-sim/${ENV}/api-secrets")
DATABASE_URL=$(echo "$API_SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['DATABASE_URL'])")
RPC_URL_MAINNET=$(echo "$API_SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['RPC_URL_MAINNET'])")

kubectl create secret generic api-secrets -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=RPC_URL_MAINNET="$RPC_URL_MAINNET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Synced api-secrets in ${NAMESPACE} from Vault (liquidation-sim/${ENV}/api-secrets)."

POSTGRES_SECRET_JSON=$(vault_get "liquidation-sim/${ENV}/postgres-secrets")
POSTGRES_USER=$(echo "$POSTGRES_SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['POSTGRES_USER'])")
POSTGRES_PASSWORD=$(echo "$POSTGRES_SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['POSTGRES_PASSWORD'])")
POSTGRES_DB=$(echo "$POSTGRES_SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['POSTGRES_DB'])")

kubectl create secret generic postgres-secrets -n "$NAMESPACE" \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRES_DB="$POSTGRES_DB" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Synced postgres-secrets in ${NAMESPACE} from Vault (liquidation-sim/${ENV}/postgres-secrets)."
