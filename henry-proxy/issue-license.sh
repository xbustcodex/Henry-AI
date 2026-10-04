#!/usr/bin/env bash
#
# issue-license.sh — generate a Henry license key and insert it into KV.
#
# Usage:
#   ./issue-license.sh alice@example.com                  # lifetime pro (no expiry)
#   ./issue-license.sh alice@example.com monthly          # pro, expires in 31 days
#   ./issue-license.sh alice@example.com annual           # pro, expires in 366 days
#   ./issue-license.sh alice@example.com monthly pro 5000 # custom daily limit
#
# Args: email [plan] [tier] [daily_limit]
#   plan: lifetime (default) | monthly | annual
#   tier: pro (default) | enterprise
#
# The worker reads `expires` (ISO date) and falls a lapsed license back to the
# free tier automatically. Renew a monthly/annual license by re-issuing on each
# successful payment (or update its `expires`).
#
# Output: prints the new license key to stdout. Send it to the buyer.
#
set -euo pipefail

EMAIL="${1:?usage: ./issue-license.sh email@example.com [plan] [tier] [daily_limit]}"
PLAN="${2:-lifetime}"
TIER="${3:-pro}"
CUSTOM_LIMIT="${4:-}"

case "$TIER" in
  pro)        DEFAULT_LIMIT=2000 ;;
  enterprise) DEFAULT_LIMIT=20000 ;;
  *)          echo "Unknown tier '$TIER' (expected pro|enterprise)" >&2; exit 1 ;;
esac

# Plan → expiry. Lifetime omits `expires` entirely (permanent).
case "$PLAN" in
  lifetime) EXPIRES="" ;;
  monthly)  EXPIRES="$(date -u -v+31d +%Y-%m-%d)" ;;
  annual)   EXPIRES="$(date -u -v+366d +%Y-%m-%d)" ;;
  *)        echo "Unknown plan '$PLAN' (expected lifetime|monthly|annual)" >&2; exit 1 ;;
esac

LIMIT="${CUSTOM_LIMIT:-$DEFAULT_LIMIT}"
SUFFIX="$(uuidgen | tr -d '-' | head -c 16 | awk '{print toupper($0)}')"
KEY="HENRY-${SUFFIX}"
TODAY="$(date -u +%Y-%m-%d)"

if [ -n "$EXPIRES" ]; then
  JSON="{\"active\":true,\"tier\":\"$TIER\",\"plan\":\"$PLAN\",\"owner\":\"$EMAIL\",\"daily_limit\":$LIMIT,\"created_at\":\"$TODAY\",\"expires\":\"$EXPIRES\"}"
else
  JSON="{\"active\":true,\"tier\":\"$TIER\",\"plan\":\"$PLAN\",\"owner\":\"$EMAIL\",\"daily_limit\":$LIMIT,\"created_at\":\"$TODAY\"}"
fi

echo "→ Inserting license into KV (remote / production)…"
# wrangler 4.x uses 'kv key put' (spaces) and defaults writes to LOCAL simulated KV,
# so --remote is required to hit the real KV the deployed worker reads. Fall back to
# the 3.x 'kv:key put' (colon) form if the modern syntax is unavailable.
if ! npx wrangler kv key put --binding=HENRY_KV --remote "license:$KEY" "$JSON" 2>/dev/null; then
  npx wrangler kv:key put --binding=HENRY_KV --remote "license:$KEY" "$JSON"
fi

cat <<EOF

✓ License issued

  Key:          $KEY
  Plan:         $PLAN${EXPIRES:+ (expires $EXPIRES)}
  Tier:         $TIER
  Daily limit:  $LIMIT
  Owner:        $EMAIL
  Created:      $TODAY

Send to buyer:
──────────────────────────────────────────
Your Henry license key: $KEY

Paste it into Henry -> Settings -> License.
You'll get $LIMIT requests/day with hosted AI included.
──────────────────────────────────────────

To revoke later:
  npx wrangler kv key put --binding=HENRY_KV --remote "license:$KEY" '{"active":false}'
EOF
