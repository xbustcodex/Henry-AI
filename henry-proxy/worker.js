/**
 * Henry AI Cloud Proxy — Cloudflare Worker
 *
 * Licensing, billing and metering for Henry. Deploy: wrangler deploy,
 * test: wrangler dev.
 *
 * **No plan includes hosted AI.** The hosted chat route (`POST /v1/chat`) used
 * to forward every request to Groq; Groq is no longer a supported provider
 * anywhere in Henry, and this worker will not forward to some other provider
 * instead — see `handleChat` below. Until an owner supplies and enables a real
 * backend here, `/v1/chat` answers `503 provider_not_configured`, and every
 * other route (license, usage, Stripe webhook, health) is provider-independent
 * and still serves.
 */

const FREE_DAILY_LIMIT = 50;

// Pricing — single source of truth, surfaced at GET /v1/pricing so the app and
// the website read one canonical payload instead of drifting.
//
// There is deliberately no hosted-AI plan to sell: no AI backend is enabled in
// this worker, so no amount would buy "hosted AI included". The endpoint
// answers with that truth rather than a price list for a service that does not
// run. Bring-your-own-key and local Ollama are how Henry runs today, and they
// cost the user nothing but their own provider.
const PRICING = {
  currency: 'USD',
  hostedAI: {
    enabled: false,
    includedInAnyPlan: false,
    reason: 'provider_not_configured',
    message:
      'Henry runs on your own provider key (OpenAI, Anthropic, Google, ' +
      'OpenRouter), on free OpenCode Zen models through the local opencode ' +
      'bridge, or on Ollama on your own machine. No plan includes hosted AI.',
  },
  plans: [],
};

// KV namespace bound as HENRY_KV in wrangler.toml
// License keys stored as KV entries: license:KEY → { tier, owner, created }
// Rate counts stored as: rate:DEVICE:DATE → count


export default {
  async fetch(request, env) {
    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Henry-Device, X-Henry-License, X-Henry-Version',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ ok: true, version: '1.1.0', service: 'henry-proxy' }, { headers: corsHeaders });
    }

    // Pricing — canonical source of truth for app + website
    if (url.pathname === '/v1/pricing') {
      return Response.json(PRICING, { headers: corsHeaders });
    }

    // Chat completions proxy
    if (url.pathname === '/v1/chat' && request.method === 'POST') {
      return handleChat(request, env, corsHeaders);
    }

    // License validation
    if (url.pathname === '/v1/license' && request.method === 'GET') {
      return handleLicense(request, env, corsHeaders);
    }

    // Usage stats
    if (url.pathname === '/v1/usage' && request.method === 'GET') {
      return handleUsage(request, env, corsHeaders);
    }

    // Stripe webhook — fires on successful payment / renewal. Generates and
    // emails a license key automatically. NOT CORS-exposed (server-to-server).
    if (url.pathname === '/v1/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
};

/**
 * The hosted chat tier.
 *
 * This forwarded to Groq and nothing else. Groq is retired, and the one thing
 * this worker must not do is quietly forward to a different provider and bill
 * the caller as if it were the same offer — so the route answers explicitly
 * and names what the caller can do instead.
 */
async function handleChat(_request, _env, corsHeaders) {
  return Response.json(
    {
      error: {
        message:
          'Hosted chat is unavailable: no AI provider is configured for this proxy. ' +
          'Add your own key in Henry Settings (OpenAI, Anthropic, OpenRouter, Google or ' +
          'OpenCode Zen) or run Ollama locally.',
        type: 'provider_not_configured',
      },
    },
    { status: 503, headers: corsHeaders },
  );
}

async function handleLicense(request, env, corsHeaders) {
  const licenseKey = request.headers.get('X-Henry-License') || '';
  if (!licenseKey || !env.HENRY_KV) {
    return Response.json({ valid: false, tier: 'free' }, { headers: corsHeaders });
  }
  try {
    const data = await env.HENRY_KV.get(`license:${licenseKey}`, { type: 'json' });
    if (data?.active) {
      return Response.json({ valid: true, tier: data.tier, owner: data.owner }, { headers: corsHeaders });
    }
  } catch { }
  return Response.json({ valid: false, tier: 'free' }, { headers: corsHeaders });
}

async function handleUsage(request, env, corsHeaders) {
  const deviceId = request.headers.get('X-Henry-Device') || 'unknown';
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `rate:${deviceId}:${today}`;
  let count = 0;
  if (env.HENRY_KV) {
    count = parseInt(await env.HENRY_KV.get(rateKey).catch(() => '0') || '0');
  }
  return Response.json({
    date: today,
    used: count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
  }, { headers: corsHeaders });
}


// ───────────────────────────────────────────────────────────────────────────
// Stripe webhook → automatic license issuance
// ───────────────────────────────────────────────────────────────────────────
//
// Setup (one-time):
//   1. In Stripe → Developers → Webhooks → add endpoint:
//        https://henry-proxy.henryai.workers.dev/v1/stripe-webhook
//      Subscribe to events: checkout.session.completed, invoice.paid
//   2. Copy the signing secret (whsec_...) and set it:
//        npx wrangler secret put STRIPE_WEBHOOK_SECRET
//   3. Set the Resend API key (for emailing the key to the buyer):
//        npx wrangler secret put RESEND_API_KEY
//   4. (optional) override the from-address default:
//        npx wrangler secret put LICENSE_FROM_EMAIL   // e.g. "Henry <hello@henrysworkshop.app>"
//
// Maps Stripe Price IDs → Henry plan. These are the live IDs provided.
const PRICE_TO_PLAN = {
  'price_1TdHSl2LVfewrTUsEbOQThhM': { plan: 'monthly',  tier: 'pro', days: 31  },
  'price_1TdHZC2LVfewrTUs9K7Xudxw': { plan: 'annual',   tier: 'pro', days: 366 },
  'price_1TdHaz2LVfewrTUsXFKwYFPW': { plan: 'lifetime', tier: 'pro', days: 0   },
  'price_1TdHcZ2LVfewrTUscjjAO6ow': { plan: 'setup',    tier: null,  days: 0   }, // setup help: no license
};

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get('stripe-signature') || '';
  const raw = await request.text();

  // 1. Verify the signature so nobody can forge a "payment" and mint free keys.
  const verified = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }

  // We act on the initial purchase and on each successful renewal.
  if (event.type !== 'checkout.session.completed' && event.type !== 'invoice.paid') {
    return Response.json({ received: true, ignored: event.type });
  }

  const obj = event.data?.object || {};
  const email =
    obj.customer_details?.email || obj.customer_email ||
    obj.customer_address?.email || null;

  // Resolve which price was bought.
  const priceId = await extractPriceId(obj, event.type, env);
  const mapping = priceId ? PRICE_TO_PLAN[priceId] : null;

  if (!mapping) {
    // Unknown price (or a setup-help purchase, which needs no license).
    return Response.json({ received: true, note: 'no license for this price', priceId });
  }
  if (mapping.plan === 'setup') {
    return Response.json({ received: true, note: 'setup help — no license issued' });
  }
  if (!email) {
    return Response.json({ received: true, error: 'no email on event — cannot issue/email key' });
  }

  // 2. For renewals, extend the existing key for this customer instead of
  //    minting a new one, so a subscriber keeps the same HENRY-xxxx.
  const stripeCustomer = obj.customer || 'unknown';
  const custIndexKey = `cust:${stripeCustomer}`;
  let licenseKey = null;
  if (event.type === 'invoice.paid') {
    try { licenseKey = await env.HENRY_KV.get(custIndexKey); } catch { /* none yet */ }
  }
  const isNew = !licenseKey;
  if (!licenseKey) licenseKey = 'HENRY-' + randomKey(16);

  // 3. Compute expiry.
  const expires = mapping.days > 0
    ? new Date(Date.now() + mapping.days * 86400_000).toISOString().slice(0, 10)
    : null;
  const dailyLimit = mapping.tier === 'enterprise' ? 20000 : PRO_DAILY_LIMIT;

  const record = {
    active: true,
    tier: mapping.tier,
    plan: mapping.plan,
    owner: email,
    daily_limit: dailyLimit,
    created_at: new Date().toISOString().slice(0, 10),
    stripe_customer: stripeCustomer,
  };
  if (expires) record.expires = expires;

  // 4. Persist: the license itself + a customer→key index for renewals.
  await env.HENRY_KV.put(`license:${licenseKey}`, JSON.stringify(record));
  await env.HENRY_KV.put(custIndexKey, licenseKey);

  // 5. Email the key (only on the first issue; renewals are silent).
  let emailed = false;
  if (isNew) {
    emailed = await sendLicenseEmail(env, email, licenseKey, mapping.plan, expires);
  }

  // Log so you can recover the key from `wrangler tail` if email isn't set up.
  console.log(`[license] ${isNew ? 'ISSUED' : 'RENEWED'} ${licenseKey} → ${email} (${mapping.plan}${expires ? ', expires ' + expires : ''}) emailed=${emailed}`);

  return Response.json({ received: true, issued: isNew, emailed });
}

// Resolve the Stripe Price ID from either a checkout session (needs a line-items
// fetch) or an invoice (price is inline on the line item).
async function extractPriceId(obj, type, env) {
  if (type === 'invoice.paid') {
    return obj.lines?.data?.[0]?.price?.id || obj.lines?.data?.[0]?.pricing?.price_details?.price || null;
  }
  // checkout.session.completed — line items aren't embedded; fetch them.
  if (obj.id && env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${obj.id}/line_items?limit=1`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (r.ok) { const d = await r.json(); return d.data?.[0]?.price?.id || null; }
    } catch { /* fall through */ }
  }
  return null;
}

// Verify Stripe's HMAC-SHA256 signature header using Web Crypto.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;

  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

function randomKey(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

async function sendLicenseEmail(env, to, licenseKey, plan, expires) {
  if (!env.RESEND_API_KEY) return false; // not configured yet — key is still stored + logged
  const from = env.LICENSE_FROM_EMAIL || 'Henry <onboarding@resend.dev>';
  const planLabel = plan === 'monthly' ? 'Henry Pro (Monthly)'
    : plan === 'annual' ? 'Henry Pro (Annual)'
    : 'Henry Pro Lifetime';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">
      <h2 style="color:#6d4aff">Welcome to ${planLabel} 🎉</h2>
      <p>Thanks for your purchase! Here's your Henry license key:</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f2ff;border:1px solid #d8d0ff;border-radius:10px;padding:14px 18px;text-align:center;color:#3a2b7a">${licenseKey}</p>
      <p><strong>To activate:</strong> open Henry → <strong>Settings → License</strong> → paste the key. Your license covers Henry itself — AI still runs on your own provider key, on free OpenCode Zen models through the local opencode bridge, or on Ollama on your own machine. No plan includes hosted AI.</p>
      ${expires ? `<p style="color:#666;font-size:13px">Your subscription renews automatically. This key stays active as long as your subscription is current.</p>` : `<p style="color:#666;font-size:13px">This is a lifetime key — it never expires.</p>`}
      <p style="color:#888;font-size:12px;margin-top:24px">Questions? Just reply to this email.</p>
    </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `Your Henry license key — ${planLabel}`, html }),
    });
    return r.ok;
  } catch { return false; }
}
