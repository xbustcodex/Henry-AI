# Deploy Henry Proxy — 4 commands

This deploys Henry AI's cloud backend so new users get AI without an API key.

## Prerequisites
- Cloudflare account (free at cloudflare.com)
- Your Groq API key (console.groq.com)

## Deploy

```bash
# 1. Navigate to proxy directory
cd /Users/christophercook/Documents/henry-ai-desktop/henry-proxy

# 2. Login to Cloudflare (opens browser)
npx wrangler login

# 3. Create KV namespace for rate limiting
npx wrangler kv namespace create HENRY_KV
# ↑ Copy the "id" from output into wrangler.toml replacing "REPLACE_WITH_KV_ID"

# 4. Set your Groq API key as a secret
npx wrangler secret put GROQ_API_KEY
# ↑ Paste your gsk_... key when prompted

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
- New users get 50 free AI requests/day without any API key
- Pro users with license keys get 2000/day
- You control the rate limits in worker.js
