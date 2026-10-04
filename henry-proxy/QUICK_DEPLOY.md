# Deploy Henry Proxy — 4 commands

This deploys Henry AI's licensing and metering backend. It does not serve AI:
the hosted chat route was retired with Groq and answers `503
provider_not_configured`.

## Prerequisites
- Cloudflare account (free at cloudflare.com)

## Deploy

```bash
# 1. Navigate to proxy directory
cd /Users/christophercook/Documents/henry-ai-desktop/henry-proxy

# 2. Login to Cloudflare (opens browser)
npx wrangler login

# 3. Create KV namespace for rate limiting
npx wrangler kv namespace create HENRY_KV
# ↑ Copy the "id" from output into wrangler.toml replacing "REPLACE_WITH_KV_ID"

# 4. (no provider secret — the chat route is disabled)

# 5. Deploy!
npx wrangler deploy
# ↑ Your proxy URL will be: https://henry-proxy.YOUR-SUBDOMAIN.workers.dev
```

## After deploying

Add your proxy URL to Henry's .env file:
```
VITE_HENRY_PROXY_URL=https://henry-proxy.YOUR-SUBDOMAIN.workers.dev
```

Then rebuild Henry:
```bash
cd /Users/christophercook/Documents/henry-ai-desktop
npm run build:mac:unsigned
```

## What this enables
- License validation and metering for Henry
- Pro users with license keys are recognised (2000/day tier recorded in KV)
- You control the rate limits in worker.js

It does **not** serve AI: hosted chat is disabled.
