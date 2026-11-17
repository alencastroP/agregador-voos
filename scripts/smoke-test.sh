#!/usr/bin/env bash
# Smoke test da API contra uma stack rodando (usado na CI; funciona em qualquer URL).
# Uso: scripts/smoke-test.sh <base-url> [versão-esperada]   (requer bash, curl e jq)
set -euo pipefail

BASE="${1:?uso: smoke-test.sh <base-url> [versão]}"
EXPECTED_VERSION="${2:-}"
DATE=$(date -u -d '+30 days' +%F 2>/dev/null || date -u -v+30d +%F)
BODY="{\"origin\":\"GRU\",\"destination\":\"GIG\",\"date\":\"$DATE\"}"

echo "→ aguardando readiness em $BASE"
for _ in $(seq 36); do
  curl -fsS "$BASE/health/ready" >/dev/null 2>&1 && break
  sleep 5
done
curl -fsS "$BASE/health/ready" | jq -e '.status | startswith("ready")' >/dev/null

echo "→ POST /search (1ª: calculada)"
FIRST=$(curl -fsS -X POST "$BASE/search" -H 'content-type: application/json' -d "$BODY")
echo "$FIRST" | jq '{results: (.results | length), meta: (.meta | {cached, partial, providers: [.providers[] | .name + ":" + .status]})}'
test "$(echo "$FIRST" | jq '.results | length')" -eq 60
test "$(echo "$FIRST" | jq '.meta.partial')" = "false"

echo "→ POST /search (2ª: cache hit)"
curl -fsS -X POST "$BASE/search" -H 'content-type: application/json' -d "$BODY" \
  | jq -e '.meta.cached == true' >/dev/null

echo "→ validação devolve 400 problem+json"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/search" \
  -H 'content-type: application/json' -d '{"origin":"XX"}')" = "400"

if [ -n "$EXPECTED_VERSION" ]; then
  echo "→ versão implantada = $EXPECTED_VERSION"
  curl -fsS "$BASE/health" | jq -e --arg v "$EXPECTED_VERSION" '.version == $v' >/dev/null
fi

echo "✓ smoke test ok"
