# Henry AI — Cloudflare Worker Proxy

Proxies AI API calls for mobile (iOS/Android) Capacitor builds.
Desktop (Electron) and development (Vite) don't need this — they handle it natively.

## Deploy (free, ~2 minutes)

1. Create a free Cloudflare account at cloudflare.com
2. Install Wrangler: `npm install -g wrangler`
3. Login: `npx wrangler login`
4. Deploy: `cd proxy && npx wrangler deploy`

Your proxy URL will be: `https://henry-ai-proxy.<your-subdomain>.workers.dev`

## Configure in Henry

In Henry on your phone: Settings → AI Providers → Mobile Proxy URL
Paste the URL above. All AI calls route through it automatically on mobile.

## Free tier limits

Cloudflare Workers free tier: 100,000 requests/day — more than enough for personal use.

## Routes

| Henry path         | Forwards to                              |
|--------------------|------------------------------------------|
| /proxy/openai/*    | api.openai.com                           |
| /proxy/anthropic/* | api.anthropic.com                        |
| /proxy/google/*    | generativelanguage.googleapis.com        |
| /proxy/groq/*      | api.groq.com (free, fast)                |
| /proxy/openrouter/*| openrouter.ai (free models available)    |
