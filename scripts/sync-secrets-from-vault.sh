#!/usr/bin/env bash
# Syncs api-secrets from Vault (the real, encrypted, audited source of truth) into the
# k8s Secret the API pod actually reads via envFrom - see k8s/base/deployment.yaml.
#
# Deliberately not dynamic secret injection (Vault Agent Injector / CSI provider) - that's
# real production-grade scope this deployment doesn't need yet (see docs/decisions.md).
# Vault is the real source of truth and audit trail; delivery to the pod stays the
# existing Secret-based mechanism. Re-run this after rotating a secret in Vault, or after
# any `kubectl apply` that might have reset the Secret.
#
# Usage: VAULT_READ_TOKEN=<token> ./sync-secrets-from-vault.sh <staging|prod>
set -euo pipefail

ENV="${1:?Usage: $0 <staging|prod>}"
NAMESPACE="liquidation-sim-${ENV}"

if [ -z "${VAULT_READ_TOKEN:-}" ]; then
  echo "VAULT_READ_TOKEN must be set (a token scoped to the liquidation-sim-read policy)." >&2
  exit 1
fi

SECRET_JSON=$(kubectl exec vault-0 -n vault -- env "VAULT_TOKEN=${VAULT_READ_TOKEN}" \
  vault kv get -format=json "liquidation-sim/${ENV}/api-secrets")

DATABASE_URL=$(echo "$SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['DATABASE_URL'])")
RPC_URL_MAINNET=$(echo "$SECRET_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['data']['RPC_URL_MAINNET'])")

kubectl create secret generic api-secrets -n "$NAMESPACE" \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=RPC_URL_MAINNET="$RPC_URL_MAINNET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Synced api-secrets in ${NAMESPACE} from Vault (liquidation-sim/${ENV}/api-secrets)."
