# Henry AI Cloud Proxy — Deploy Guide

This Cloudflare Worker handles Henry's licensing, billing and metering. **No
plan includes hosted AI**: the chat route is disabled because it used to forward
to Groq, and Groq is no longer a supported provider anywhere in Henry, so
`POST /v1/chat` answers `503 provider_not_configured` rather than forwarding to
something else. `GET /v1/pricing` reports `hostedAI.enabled: false` with no
plans, for the same reason.

KV rate limit: 50 requests/day per device. Pro tier: 2000/day with license key.

## Deploy in 5 minutes

### 1. Install wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace
```bash
wrangler kv:namespace create HENRY_KV
# Copy the ID into wrangler.toml → kv_namespaces[0].id
```

### 3. (No provider secret to set)
The worker holds no AI provider credential. Deploying it as-is serves licensing
and metering only.

### 4. Deploy
```bash
npm run deploy
# Worker URL: https://henry-proxy.YOUR-SUBDOMAIN.workers.dev
```

### 5. Update Henry
Set `VITE_HENRY_PROXY_URL` in Henry's .env:
```
VITE_HENRY_PROXY_URL=https://henry-proxy.YOUR-SUBDOMAIN.workers.dev
```

## License key management
Create a license key in KV:
```bash
wrangler kv:key put "license:LICENSE-KEY-HERE" '{"active":true,"tier":"pro","owner":"user@email.com"}' --binding HENRY_KV
```

## Endpoints
- GET  /health              → status check
- POST /v1/chat             → 503 provider_not_configured (no hosted provider)
- GET  /v1/pricing          → hostedAI.enabled: false, plans: []
- GET  /v1/license          → validate license key
- GET  /v1/usage            → check daily usage

## Rate limit headers
Every response includes:
- X-Henry-Tier: free | pro
- X-Henry-Usage: used/limit
