# Henry Proxy — Cloudflare Worker

License-only proxy that fronts a Groq API key. **Every call is paid by you (the
operator), so the worker never serves chat without a valid license.**

## What changed (v2.0)

- **License is now mandatory** for `/v1/chat`. No license → `401`.
- **Rate limit is per-license**, not per-device (prevents device-ID rotation).
- **Model whitelist** — only the cheap Groq models are allowed.
- **Hard caps** on `max_tokens`, request body size, and history depth.
- `/v1/license` and `/v1/usage` reflect license-based state.

The desktop client also gates the proxy behind a license key
(`canUseHenryProxy()` in `src/henry/proxyUsage.ts`), but the worker is the
authoritative check. Don't soften it.

## Deploy

```bash
cd henry-proxy
npx wrangler login                         # one time
npx wrangler secret put GROQ_API_KEY       # paste your Groq key
npx wrangler deploy
```

Test:

```bash
curl https://henry-proxy.henryai.workers.dev/health
# → { "ok": true, "version": "2.0.0", "service": "henry-proxy", "mode": "license-only" }

# Without license:
curl -X POST https://henry-proxy.henryai.workers.dev/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# → 401 license_required
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

- `TIER_LIMITS` — daily request quotas per tier
- `ALLOWED_MODELS` — Groq models you'll let licensees call (whitelist)
- `DEFAULT_MODEL` — coercion target if user requests a non-whitelisted model
- `MAX_TOKENS_HARD_CAP` — 4096; upper bound on `max_tokens` regardless of tier
- `MAX_REQUEST_BYTES` — 200 KB; rejects oversize prompts before hitting Groq
- `MAX_MESSAGES` — 80; trims history depth to prevent token blowup

If you ever change these to be more permissive, audit your Groq billing dashboard
the next day.

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
