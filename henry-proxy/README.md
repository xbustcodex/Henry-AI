# Henry Proxy — Cloudflare Worker

Licensing, billing and metering for Henry. **No plan includes hosted AI.** The
hosted chat route used to front a Groq API key; Groq is no longer a supported
provider anywhere in Henry, and this worker will not quietly forward to a
different provider, so `POST /v1/chat` answers `503 provider_not_configured`.
`GET /v1/pricing` says the same thing in its payload (`hostedAI.enabled: false`,
no plans) instead of quoting a price for a service that does not run.
`/v1/license`, `/v1/usage` and the Stripe webhook are unaffected.

## What changed (v2.0 — Groq era)

> The model whitelist, cost dials and license gating this section lists are no
> longer in `worker.js` — only the KV license entries they read are still live.

- **License is mandatory** for `/v1/chat` (v2.0 behaviour, Groq's era; the route
  now answers `503 provider_not_configured` before any license check).
- ~~**Model whitelist**~~ — was a Groq-model whitelist; retired with Groq.
- **Hard caps** on `max_tokens`, request body size, and history depth.
- `/v1/license` and `/v1/usage` reflect license-based state.

A license key enables no AI anywhere in Henry: the desktop client never routes
a model call to this worker, and an install whose only "backend" is a license
reads as unconfigured throughout the UI. The worker is the authoritative check
for its own endpoints. Don't soften it.

## Deploy

```bash
cd henry-proxy
npx wrangler login                         # one time
npx wrangler deploy
```

Test:

```bash
curl https://henry-proxy.henryai.workers.dev/health
# → { "ok": true, "version": "1.1.0", "service": "henry-proxy" }

# Chat (no hosted provider is configured):
curl -X POST https://henry-proxy.henryai.workers.dev/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# → 503 provider_not_configured
```

## Issuing a license

Licenses live in KV (`HENRY_KV` namespace, id `dd0a36cb7d854ae2b1da573bb535a6be`).

> **Wrangler 4.x gotcha:** `kv key put` defaults to a **local simulated KV** used by `wrangler dev`. You must pass `--remote` for the deployed worker to see the value. The `issue-license.sh` script handles this for you, but if you run wrangler manually, always include `--remote`.

```bash
# Easiest path — use the script (handles --remote automatically):
./issue-license.sh alice@example.com pro

# Or do it manually:
KEY=$(uuidgen | tr -d '-' | head -c 24 | awk '{print "HENRY-" toupper($0)}')
echo "Generated: $KEY"

npx wrangler kv key put --binding=HENRY_KV --remote "license:$KEY" \
  '{"active":true,"tier":"pro","owner":"alice@example.com","daily_limit":2000,"created_at":"2026-05-05"}'

# Verify
npx wrangler kv key get --binding=HENRY_KV --remote "license:$KEY"
```

License entry fields:

| field          | required | example                     | notes                                        |
| -------------- | -------- | --------------------------- | -------------------------------------------- |
| `active`       | yes      | `true`                      | Set to `false` to revoke instantly.          |
| `tier`         | no       | `"pro"` / `"enterprise"`    | Defaults to `"pro"`.                         |
| `owner`        | no       | `"alice@example.com"`       | Audit trail only.                            |
| `daily_limit`  | no       | `2000`                      | Overrides tier default.                      |
| `expires_at`   | no       | `"2027-05-05T00:00:00Z"`    | If set, requests after this date 403.        |
| `created_at`   | no       | `"2026-05-05"`              | Audit trail only.                            |

Tier defaults (set in the worker source):
- `pro` → 2000/day
- `enterprise` → 20000/day

## Revoke

```bash
npx wrangler kv key put --binding=HENRY_KV --remote "license:$KEY" \
  '{"active":false}'
```

User instantly drops to 401 on the next request.

## Check usage

```bash
curl -H "X-Henry-License: HENRY-XXXX-XXXX-XXXX" \
  https://henry-proxy.henryai.workers.dev/v1/usage
# → { date, used, limit, remaining, tier, status }

curl -H "X-Henry-License: HENRY-XXXX-XXXX-XXXX" \
  https://henry-proxy.henryai.workers.dev/v1/license
# → { valid, tier, owner, daily_limit, expires_at }
```

## Cost dials (worker.js constants)

The v2.0 Groq-era dials (`TIER_LIMITS`, `ALLOWED_MODELS`, `DEFAULT_MODEL`,
`MAX_TOKENS_HARD_CAP`, `MAX_REQUEST_BYTES`, `MAX_MESSAGES`) were removed with
the chat route: `worker.js` forwards nothing and holds no provider key, so there
is no per-token cost to bound. The only limit left is `FREE_DAILY_LIMIT`
(`/v1/usage`).

## Last-seen audit (free)

The worker stores `last_seen:<license>` → `{ device, at }` for 90 days on
successful calls. Useful for spotting license sharing.

```bash
npx wrangler kv key get --binding=HENRY_KV --remote "last_seen:HENRY-XXXX-XXXX-XXXX"
```

## License-key generation script

Drop this in `henry-proxy/issue-license.sh` if you want a one-liner:

```bash
#!/usr/bin/env bash
set -e
EMAIL="${1:?usage: ./issue-license.sh email@example.com [tier]}"
TIER="${2:-pro}"
KEY="HENRY-$(uuidgen | tr -d '-' | head -c 16 | awk '{print toupper($0)}')"
LIMIT=$([ "$TIER" = "enterprise" ] && echo 20000 || echo 2000)
JSON=$(printf '{"active":true,"tier":"%s","owner":"%s","daily_limit":%d,"created_at":"%s"}' \
  "$TIER" "$EMAIL" "$LIMIT" "$(date -u +%Y-%m-%d)")
npx wrangler kv:key put --binding=HENRY_KV "license:$KEY" "$JSON"
echo
echo "License issued: $KEY"
echo "Tier: $TIER, daily limit: $LIMIT"
echo "Send to: $EMAIL"
```

Then `chmod +x issue-license.sh && ./issue-license.sh alice@example.com pro`.
