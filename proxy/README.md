# Henry AI — Cloudflare Worker Proxy

Forwards AI API calls from the mobile (iOS/Android) Capacitor build, which
browsers block by CORS. Desktop (Electron) and development (Vite) don't need
this — they handle it natively.

It is a pass-through and nothing more: your own `Authorization` header is
forwarded to the provider you configured in Henry, and the worker holds no AI
credential of its own. It does not serve a model for you and is not a hosted
AI tier — there is none.

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
| /proxy/openrouter/*| openrouter.ai (free models available)    |
