# Henry AI Cloud Proxy — Deploy Guide

This Cloudflare Worker provides shared Groq AI access to Henry users.
Free tier: 50 requests/day per device. Pro tier: 2000/day with license key.

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

### 3. Add Groq API key as secret
```bash
wrangler secret put GROQ_API_KEY
# Paste your Groq key when prompted
```

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
- POST /v1/chat             → proxied Groq completion
- GET  /v1/license          → validate license key
- GET  /v1/usage            → check daily usage

## Rate limit headers
Every response includes:
- X-Henry-Tier: free | pro
- X-Henry-Usage: used/limit
