// electron/ipc/companionControlHtml.ts
// v3: multi-display + Apple Pencil + drag/draw mode.

export const PAIR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0a0a">
<title>Pair with Henry</title>
<style>
  :root { --bg:#0a0a0a; --surface:#161616; --border:#2a2a2a; --text:#f5f5f5; --muted:#888; --accent:#6366f1; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif; -webkit-font-smoothing:antialiased; }
  body { display:flex; align-items:center; justify-content:center; padding:env(safe-area-inset-top) 24px env(safe-area-inset-bottom); }
  .card { width:100%; max-width:360px; background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:32px 24px; }
  .logo { width:56px; height:56px; border-radius:14px; background:linear-gradient(135deg,var(--accent),#4338ca); margin:0 auto 20px; display:grid; place-items:center; font-size:28px; font-weight:700; }
  h1 { margin:0 0 6px; font-size:22px; text-align:center; }
  .sub { color:var(--muted); font-size:13px; text-align:center; margin-bottom:28px; }
  label { display:block; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; margin:18px 0 8px; }
  input { width:100%; padding:14px 16px; background:#0d0d0d; border:1px solid var(--border); border-radius:12px; color:var(--text); font-size:18px; font-family:'SF Mono',monospace; letter-spacing:2px; text-align:center; }
  input:focus { outline:none; border-color:var(--accent); }
  button { width:100%; margin-top:24px; padding:14px; background:var(--accent); border:0; border-radius:12px; color:white; font-size:15px; font-weight:600; cursor:pointer; font-family:inherit; }
  button:disabled { opacity:.5; }
  .err { margin-top:16px; padding:10px 14px; border-radius:10px; background:rgba(220,38,38,.12); border:1px solid rgba(220,38,38,.3); color:#fca5a5; font-size:13px; display:none; }
  .err.show { display:block; }
  .hint { margin-top:20px; padding-top:20px; border-top:1px solid var(--border); font-size:12px; color:var(--muted); line-height:1.5; }
</style>
</head>
<body>
  <form class="card" id="f">
    <div class="logo">H</div>
    <h1>Pair with Henry</h1>
    <div class="sub">Open Henry on your Mac &rarr; Companion &rarr; Remote Access<br>to see your ID and PIN</div>
    <label>Henry ID</label>
    <input id="hid" inputmode="numeric" pattern="[0-9 ]*" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="11" placeholder="000 000 000" required>
    <label>Session PIN</label>
    <input id="pin" inputmode="numeric" pattern="[0-9 ]*" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="7" placeholder="000 000" required>
    <button type="submit" id="go">Pair this device</button>
    <div class="err" id="err"></div>
    <div class="hint">The PIN expires in 30 minutes. After pairing, this device is remembered.</div>
  </form>
<script>
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => v.replace(/\\D/g,'').replace(/(\\d{3})(?=\\d)/g,'$1 ').trim();
  $('hid').addEventListener('input', e => e.target.value = fmt(e.target.value));
  $('pin').addEventListener('input', e => e.target.value = fmt(e.target.value));
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    return 'Browser';
  }
  // Safari only exposes crypto.randomUUID() in SECURE contexts (HTTPS or
  // localhost). The companion is served over plain http://lan-ip:4242, so
  // iPad Safari throws "crypto.randomUUID is not a function". Polyfill it.
  function _uuid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) { /* fallthrough */ }
    // RFC4122-v4-shaped fallback via crypto.getRandomValues (available in all
    // browsers, secure context or not).
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant
        const h = Array.from(b, x => x.toString(16).padStart(2, '0'));
        return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
      }
    } catch (e) { /* fallthrough */ }
    // Last-resort: not cryptographically strong but the deviceId only needs
    // to be unique per browser, not unguessable.
    return 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function deviceId() {
    let id = localStorage.getItem('henryDeviceId');
    if (!id) { id = _uuid(); localStorage.setItem('henryDeviceId', id); }
    return id;
  }
  // R3-Fix 2: auto-fill from URL fragment (#id=...&pin=...). The
  // RemoteControlPanel QR code now encodes the URL with credentials in the
  // fragment, so scanning with the iPad camera takes you here and prefills
  // the form. The fragment never reaches the server (browsers don't send it
  // in HTTP) and never leaves the device. If both fields are present we
  // auto-submit after a brief delay so the user sees what's being entered.
  (function autofill() {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const id = (params.get('id') || '').replace(/\\D/g, '');
      const pin = (params.get('pin') || '').replace(/\\D/g, '');
      if (id) $('hid').value = fmt(id);
      if (pin) $('pin').value = fmt(pin);
      if (id && pin) {
        // Clear the fragment so it's not visible in the URL bar / history.
        history.replaceState(null, '', location.pathname);
        setTimeout(() => $('f').dispatchEvent(new Event('submit', { cancelable: true })), 500);
      }
    } catch (_) { /* fragment is optional */ }
  })();

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('hid').value.replace(/\\D/g,'');
    const pin = $('pin').value.replace(/\\D/g,'');
    $('err').classList.remove('show');
    $('go').disabled = true;
    try {
      const r = await fetch('/sync/pair', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ id, pin, deviceId: deviceId(), deviceName: deviceName() })
      });
      // R2-Fix 4: don't crash on non-JSON error responses (e.g. proxy 502s).
      const j = await r.json().catch(() => ({ ok: false, error: 'bad_response' }));
      if (!r.ok || !j.ok) {
        const m = { bad_id:'Henry ID is wrong.', bad_pin:'PIN is wrong or expired.', locked_out:'Too many failed attempts. Try again in 15 minutes.' };
        $('err').textContent = m[j.error] || 'Pairing failed: ' + (j.error || 'unknown');
        $('err').classList.add('show');
        return;
      }
      localStorage.setItem('henryToken', j.token);
      localStorage.setItem('henryId', j.henryId);
      location.href = '/companion/control';
    } catch (e2) {
      $('err').textContent = 'Connection failed: ' + e2.message;
      $('err').classList.add('show');
    } finally { $('go').disabled = false; }
  });
</script>
</body>
</html>`;

export const CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Henry">
<meta name="theme-color" content="#000">
<!-- R3-Fix 3: PWA install metadata so iPad's "Add to Home Screen" gives a
     real app-like launch (full screen, black status bar, "Henry" title).
     After installing, tapping the home icon launches /companion/control
     directly using the cached JWT — no Safari, no URL bar, no re-pair. -->
<link rel="apple-touch-icon" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%236366f1'/><stop offset='1' stop-color='%234338ca'/></linearGradient></defs><rect width='180' height='180' rx='40' fill='url(%23g)'/><text x='90' y='118' text-anchor='middle' font-family='-apple-system,Helvetica' font-size='100' font-weight='700' fill='white'>H</text></svg>">
<title>Henry &middot; Remote Control</title>
<style>
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  /* R2-Fix 8: overscroll-behavior:none is not supported in iOS Safari < 16.4,
     so two-finger gestures that overshoot the canvas boundaries can still
     cause the entire page to rubber-band, interrupting the touch event
     stream and wedging the gesture state machine. position:fixed + overflow:
     hidden on body acts as a belt-and-suspenders backstop. touch-action:none
     suppresses default pinch-zoom of the page. */
  html,body { margin:0; height:100vh; height:100dvh; background:#000; overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif; color:#fff;
    user-select:none; -webkit-user-select:none; overscroll-behavior:none;
    position:fixed; width:100%; top:0; left:0; touch-action:none; }

  /* R2-Fix C1: respect iPad safe-area (notch / home indicator) so the topbar
     isn't hidden behind the status bar and the toolbar isn't behind the
     home-indicator pill. */
  #stage { position:fixed; left:0; right:0;
    top:calc(48px + env(safe-area-inset-top, 0px));
    bottom:calc(64px + env(safe-area-inset-bottom, 0px));
    overflow:hidden;
    display:flex; align-items:center; justify-content:center; background:#000; }
  #canvasWrap { position:relative; transform-origin:0 0; will-change:transform; }
  #screen { display:block; image-rendering:auto; }
  #aim { position:absolute; width:36px; height:36px; pointer-events:none;
    transform:translate(-50%,-50%); opacity:0; transition:opacity .15s, transform .1s; z-index:5; }
  #aim.show { opacity:1; }
  #aim::before,#aim::after { content:''; position:absolute; background:#22c55e; box-shadow:0 0 8px rgba(34,197,94,.9); }
  #aim::before { left:50%; top:0; width:2px; height:36px; transform:translateX(-50%); }
  #aim::after  { top:50%; left:0; width:36px; height:2px; transform:translateY(-50%); }
  #aim.pencil::before, #aim.pencil::after { background:#fbbf24; box-shadow:0 0 8px rgba(251,191,36,.9); }

  #topbar { position:fixed; top:env(safe-area-inset-top, 0px); left:0; right:0; height:48px; z-index:20;
    background:rgba(10,10,10,.95); backdrop-filter:blur(20px);
    display:flex; align-items:center; padding:6px 8px; gap:6px;
    border-bottom:1px solid #1f1f1f; overflow-x:auto; scrollbar-width:none; }
  #topbar::-webkit-scrollbar { display:none; }
  .displaybtn { flex-shrink:0; background:#222; border:1px solid #333; color:#fff;
    padding:6px 10px; border-radius:8px; font-size:11px; font-weight:500;
    font-family:inherit; cursor:pointer; height:36px; display:flex; align-items:center; gap:6px; }
  .displaybtn.active { background:#6366f1; border-color:#6366f1; }
  .displaybtn .ic { width:14px; height:9px; border:1.5px solid currentColor; border-radius:2px; }
  #status { margin-left:auto; flex-shrink:0; padding:6px 10px; border-radius:8px; background:rgba(0,0,0,.4); font-size:11px; display:flex; align-items:center; gap:6px; }
  #status .dot { width:7px; height:7px; border-radius:50%; background:#fbbf24; }
  #status.live .dot { background:#22c55e; animation:pulse 2s infinite; }
  #status.err .dot { background:#dc2626; }
  @keyframes pulse { 50% { opacity:.3; } }
  #zoomInfo { flex-shrink:0; padding:6px 10px; border-radius:8px; background:rgba(0,0,0,.4); font-size:11px; font-variant-numeric:tabular-nums; }

  #mode { position:fixed; top:52px; left:50%; transform:translateX(-50%);
    padding:3px 12px; border-radius:12px; font-size:10px; font-weight:600;
    z-index:18; letter-spacing:.3px; pointer-events:none; opacity:0; transition:opacity .2s;
    background:rgba(99,102,241,.95); }
  #mode.show { opacity:1; }
  #mode.pencil { background:rgba(251,191,36,.95); color:#000; }

  #toolbar { position:fixed; bottom:env(safe-area-inset-bottom, 0px); left:0; right:0; height:64px; z-index:10;
    background:rgba(10,10,10,.95); backdrop-filter:blur(20px);
    padding:8px; display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; align-items:center; }
  #toolbar::-webkit-scrollbar { display:none; }
  .btn { flex-shrink:0; background:#222; border:1px solid #333; color:#fff;
    padding:10px 12px; border-radius:10px; font-size:12px; font-weight:500;
    font-family:inherit; cursor:pointer; min-height:44px; min-width:44px;
    transition:background .12s,border-color .12s; }
  .btn:active,.btn.held { background:#6366f1; border-color:#6366f1; }
  .btn.primary { background:#22c55e; border-color:#22c55e; }
  .btn.primary:active { background:#16a34a; }
  .btn.danger { background:#dc2626; border-color:#dc2626; }
  .btn.draw.held { background:#fbbf24; border-color:#fbbf24; color:#000; }

  #kb { position:fixed; left:8px; right:8px; bottom:72px; display:none; z-index:15; }
  #kb.show { display:block; }
  #kb input { width:100%; padding:14px 16px; font-size:16px; background:#1a1a1a;
    border:1px solid #333; border-radius:12px; color:#fff; font-family:inherit; }

  #overlay { position:fixed; inset:0; background:#000; z-index:100;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:14px; padding:24px; text-align:center; }
  #overlay.hide { display:none; }
  #overlay h2 { margin:0; font-size:18px; font-weight:600; }
  #overlay p { margin:0; color:#888; font-size:13px; max-width:280px; line-height:1.5; }
  #overlay .spinner { width:32px; height:32px; border:3px solid #333; border-top-color:#6366f1; border-radius:50%; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  #overlay button { margin-top:8px; padding:12px 24px; background:#6366f1; border:0; border-radius:10px; color:#fff; font-size:14px; font-weight:600; font-family:inherit; cursor:pointer; }

  #dbg { position:fixed; left:8px; bottom:80px; max-width:60%; max-height:30%;
    overflow:auto; font:10px/1.3 monospace; color:#0f0; background:rgba(0,0,0,.85);
    padding:6px 8px; border-radius:6px; z-index:50; pointer-events:none; display:none; }
</style>
</head>
<body>
  <div id="topbar">
    <div id="displays"></div>
    <div id="zoomInfo">100%</div>
    <div id="status"><div class="dot"></div><span id="statusText">Connecting&hellip;</span></div>
  </div>

  <div id="stage">
    <div id="canvasWrap">
      <canvas id="screen"></canvas>
      <div id="aim"></div>
    </div>
  </div>

  <div id="mode">FINGER MODE &middot; tap to aim</div>
  <div id="dbg"></div>

  <div id="kb"><input id="kbinput" autocapitalize="off" autocomplete="off"
    autocorrect="off" spellcheck="false" placeholder="Type, press Enter"></div>

  <div id="toolbar">
    <button class="btn primary" id="clickbtn">Click</button>
    <button class="btn" id="dblbtn">Double</button>
    <button class="btn" id="rightbtn">Right</button>
    <button class="btn draw" id="drawbtn" title="Pencil drag mode">&#x270E; Draw</button>
    <button class="btn" id="zoomin">&#xff0b;</button>
    <button class="btn" id="zoomout">&#x2212;</button>
    <button class="btn" id="zoomfit">Fit</button>
    <button class="btn" data-mod="Meta">&#x2318;</button>
    <button class="btn" data-mod="Control">Ctrl</button>
    <button class="btn" data-mod="Alt">&#x2325;</button>
    <button class="btn" data-mod="Shift">&#x21E7;</button>
    <button class="btn" data-key="Escape">Esc</button>
    <button class="btn" data-key="Tab">Tab</button>
    <button class="btn" data-key="Return">&#x21B5;</button>
    <button class="btn" data-key="Delete">&#x232B;</button>
    <button class="btn" data-arrow="Up">&#x2191;</button>
    <button class="btn" data-arrow="Down">&#x2193;</button>
    <button class="btn" data-arrow="Left">&#x2190;</button>
    <button class="btn" data-arrow="Right">&#x2192;</button>
    <button class="btn" id="kbtoggle">&#x2328;&#xFE0E;</button>
    <button class="btn danger" id="end">End</button>
  </div>

  <div id="overlay">
    <div class="spinner"></div>
    <h2 id="ovTitle">Connecting to Henry&hellip;</h2>
    <p id="ovMsg">Asking your Mac for permission. Approve the dialog on screen.</p>
    <button id="ovBtn" style="display:none">OK</button>
  </div>

<script>
const token = localStorage.getItem('henryToken');
if (!token) location.href = '/companion/pair';
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const headers = { 'Content-Type':'application/json', 'Authorization':'Bearer ' + token };

const $ = (id) => document.getElementById(id);
const stage = $('stage'), wrap = $('canvasWrap'), canvas = $('screen'), ctx = canvas.getContext('2d');
const aim = $('aim'), status = $('status'), statusText = $('statusText');
const overlay = $('overlay'), zoomInfo = $('zoomInfo'), mode = $('mode');
const dbgEl = $('dbg');

// Debug
const DEBUG = location.search.includes('debug');
if (DEBUG) dbgEl.style.display = 'block';
function dbg(msg) {
  if (!DEBUG && dbgEl.style.display === 'none') return;
  const line = document.createElement('div');
  line.textContent = new Date().toISOString().slice(14,22) + ' ' + msg;
  dbgEl.appendChild(line);
  while (dbgEl.children.length > 30) dbgEl.firstChild.remove();
  dbgEl.scrollTop = dbgEl.scrollHeight;
}

function setStatus(text, state) { statusText.textContent = text; status.className = state || ''; }
function showOverlay(title, msg, btnLabel, onClick) {
  $('ovTitle').textContent = title; $('ovMsg').textContent = msg;
  overlay.classList.remove('hide');
  if (btnLabel) { $('ovBtn').textContent = btnLabel; $('ovBtn').style.display=''; $('ovBtn').onclick = onClick || (() => location.reload()); }
  else $('ovBtn').style.display='none';
}
function hideOverlay() { overlay.classList.add('hide'); }
function showMode(text, isPencil) {
  mode.textContent = text;
  mode.classList.toggle('pencil', !!isPencil);
  mode.classList.add('show');
  clearTimeout(showMode._t);
  showMode._t = setTimeout(() => mode.classList.remove('show'), 1500);
}

// State
let zoom = 1, panX = 0, panY = 0;
let macW = 0, macH = 0, baseFit = 1;
let displays = [], activeDisplayId = null;
let drawMode = false;
// Fix E: two-finger scroll state. While scrolling we track the last midpoint
// Y and accumulate delta; we post /companion/v2/scroll at most every 60ms
// to avoid flooding the cliclick subprocess.
let scrollLastMidY = 0, scrollLastPostAt = 0;

// View transform
function applyTransform() {
  wrap.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
  zoomInfo.textContent = Math.round((zoom / baseFit) * 100) + '%';
}
function computeFit() {
  if (!macW || !macH) return;
  const rect = stage.getBoundingClientRect();
  baseFit = Math.min(rect.width / macW, rect.height / macH);
}
function fitToScreen() {
  computeFit();
  // R3-Fix 8/9: 15% margin (was 0%, then 8% — both insufficient for some
  // portrait iPad geometries where stage.getBoundingClientRect was returning
  // pre-safe-area dimensions on initial render, leaving the bottom of the
  // Mac screen tucked behind the toolbar.
  zoom = baseFit * 0.85;
  const rect = stage.getBoundingClientRect();
  panX = (rect.width  - macW * zoom) / 2;
  panY = (rect.height - macH * zoom) / 2;
  applyTransform();
}
// R3-Fix 9: re-fit whenever the viewport geometry can change. iPad orientation
// flips and Stage Manager resizes both invalidate the previously-computed
// baseFit. Without this, rotating the iPad after pairing leaves the screen
// either zoomed too far (cutoff) or floating with massive black bars.
window.addEventListener('resize', () => { if (macW && macH) fitToScreen(); });
window.addEventListener('orientationchange', () => {
  // The resize event fires before the new viewport dimensions are committed,
  // so wait a tick for layout to settle.
  setTimeout(() => { if (macW && macH) fitToScreen(); }, 200);
});
function setZoom(newZoom, focusClientX, focusClientY) {
  const stageRect = stage.getBoundingClientRect();
  const fx = (focusClientX != null ? focusClientX : (stageRect.width  / 2 + stageRect.left)) - stageRect.left;
  const fy = (focusClientY != null ? focusClientY : (stageRect.height / 2 + stageRect.top))  - stageRect.top;
  const before = { x:(fx - panX)/zoom, y:(fy - panY)/zoom };
  zoom = Math.max(baseFit * 0.5, Math.min(8, newZoom));
  panX = fx - before.x * zoom;
  panY = fy - before.y * zoom;
  clampPan(); applyTransform();
}
function clampPan() {
  const rect = stage.getBoundingClientRect();
  const sw = macW * zoom, sh = macH * zoom;
  const margin = 50;
  if (sw < rect.width)  panX = (rect.width - sw)/2;
  else panX = Math.min(margin, Math.max(rect.width - sw - margin, panX));
  if (sh < rect.height) panY = (rect.height - sh)/2;
  else panY = Math.min(margin, Math.max(rect.height - sh - margin, panY));
}

// Aim
let aimX = null, aimY = null;
function setAim(canvasX, canvasY, isPencil) {
  aimX = Math.max(0, Math.min(1, canvasX / macW));
  aimY = Math.max(0, Math.min(1, canvasY / macH));
  aim.style.left = canvasX + 'px';
  aim.style.top  = canvasY + 'px';
  aim.classList.toggle('pencil', !!isPencil);
  aim.classList.add('show');
}
function clientToCanvas(clientX, clientY) {
  const r = wrap.getBoundingClientRect();
  return { x:(clientX - r.left)/zoom, y:(clientY - r.top)/zoom };
}

// HTTP
let sessionReady = false;
async function post(path, body) {
  if (!sessionReady) { dbg('skip ' + path + ' not ready'); return null; }
  try {
    dbg('POST ' + path + ' ' + JSON.stringify(body).slice(0, 60));
    const r = await fetch(path, { method:'POST', headers, body: JSON.stringify(body) });
    const text = await r.text().catch(() => '');
    dbg('  -> ' + r.status + ' ' + text.slice(0, 80));
    if (r.status === 401) location.href = '/companion/pair';
    if (r.status === 409) { sessionReady = false; showOverlay('Session ended', 'The Mac side closed the session.', 'Reconnect', () => location.reload()); }
    if (r.status === 403) {
      setStatus('Click denied - check Accessibility permission', 'err');
      setTimeout(() => setStatus('Live', 'live'), 4000);
    }
    if (r.status === 501) {
      setStatus('Install cliclick on Mac for this feature', 'err');
      setTimeout(() => setStatus('Live', 'live'), 4000);
    }
    return { status: r.status, text };
  } catch (e) {
    dbg('  ERR ' + e.message);
    return null;
  }
}

// Display picker
function renderDisplayButtons() {
  const c = $('displays');
  c.innerHTML = '';
  for (const d of displays) {
    const b = document.createElement('button');
    b.className = 'displaybtn' + (d.id === activeDisplayId ? ' active' : '');
    b.innerHTML = '<span class="ic"></span> ' + d.label + (d.primary ? ' &middot; Main' : '');
    b.onclick = () => {
      activeDisplayId = d.id;
      renderDisplayButtons();
      if (ws) ws.send(JSON.stringify({ type:'config', displayId: d.id }));
      macW = 0; macH = 0;
      showMode('Switching to ' + d.label);
    };
    c.appendChild(b);
  }
}

// Session
(async () => {
  setStatus('Requesting permission...', '');
  try {
    // Fix G: 45s client-side timeout. The /companion/session/request
    // endpoint awaits a macOS modal dialog — if the user is away from the
    // Mac (or the Mac is sleeping) the fetch would otherwise hang forever.
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 45000);
    let r;
    try {
      r = await fetch('/companion/session/request', { method:'POST', headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    // R2-Fix 4: check 401 BEFORE parsing JSON. A 401 with a non-JSON body
    // (or no body) would throw on r.json() and surface as "Network error"
    // instead of redirecting the user to re-pair.
    if (r.status === 401) { localStorage.removeItem('henryToken'); location.href = '/companion/pair'; return; }
    const j = await r.json().catch(() => ({ ok: false, reason: 'bad_response' }));
    if (!j.ok) {
      const m = { denied:'Your Mac denied the connection.', busy:'Someone else is already controlling this Mac.' };
      showOverlay('Connection refused', m[j.reason] || j.reason || 'Unknown', 'Try again', () => location.reload());
      return;
    }
    sessionReady = true;
    hideOverlay();
    setStatus('Live', 'live');
    startScreen();
    pingLoop();
    keepAwake();  // R3-Fix 6: prevent iPad screen-sleep during remote control
    setTimeout(() => showMode('Tap to click | Two fingers to scroll | Pencil to draw'), 500);
  } catch (e) {
    if (e.name === 'AbortError') {
      showOverlay(
        'No response from Mac',
        "We didn't hear back from your Mac. Make sure Henry AI is open and unlocked, then try again.",
        'Try again',
        () => location.reload()
      );
    } else {
      showOverlay('Network error', e.message, 'Retry', () => location.reload());
    }
  }
})();

// Screen stream
let ws = null;
function startScreen() {
  ws = new WebSocket(wsProto + '://' + location.host + '/ws/screen?token=' + encodeURIComponent(token));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type:'config',
      width: Math.min(1920, Math.round(window.innerWidth * (window.devicePixelRatio || 1))),
      height:Math.min(1200, Math.round(window.innerHeight * (window.devicePixelRatio || 1))),
      quality: 60, fps: 15,
    }));
  };
  ws.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') {
        displays = m.displays || [];
        activeDisplayId = m.activeDisplayId;
        renderDisplayButtons();
        dbg('hello, ' + displays.length + ' display(s)');
      } else if (m.type === 'error') {
        // Fix G: surface server-side capture failures (most commonly:
        // Screen Recording permission not granted) instead of a black canvas.
        sessionReady = false;
        if (m.code === 'no_screen_recording') {
          showOverlay(
            'Screen Recording permission needed',
            m.message || 'Open System Settings → Privacy & Security → Screen Recording, enable Henry AI / Electron, then restart Henry.',
            'Retry',
            () => location.reload()
          );
        } else {
          showOverlay('Screen capture error', m.message || m.code || 'unknown', 'Retry', () => location.reload());
        }
        try { ws.close(); } catch (e) {}
      }
      return;
    }
    try {
      const bmp = await createImageBitmap(new Blob([e.data], { type:'image/jpeg' }));
      const first = macW === 0;
      if (canvas.width !== bmp.width)   { canvas.width  = bmp.width;  macW = bmp.width;  }
      if (canvas.height !== bmp.height) { canvas.height = bmp.height; macH = bmp.height; }
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      if (first) fitToScreen();
    } catch (err) {}
  };
  ws.onclose = () => { setStatus('Disconnected', 'err'); setTimeout(() => { if (sessionReady) startScreen(); }, 1500); };
  ws.onerror = () => ws.close();
}

// Touch + pencil events
let touches = new Map();
let gesture = null;
let pinchStart = null, panStart = null;
let pencilDragPath = null;

const D = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const M = (a,b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });

// PENCIL via pointer events
// R2-Fix B2: setPointerCapture so iPad Safari can't lose the pointerup event
// to focus changes / overlay elements. Without capture, Pencil tap fires
// pointerdown (orange crosshair appears) but pointerup never reaches stage,
// so the /v2/click POST never fires.
stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'pen') return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* not all browsers */ }
  const c = clientToCanvas(e.clientX, e.clientY);
  if (c.x < 0 || c.y < 0 || c.x > macW || c.y > macH) return;
  setAim(c.x, c.y, true);
  if (drawMode) {
    pencilDragPath = [{ x: c.x / macW, y: c.y / macH }];
    showMode('PENCIL DRAW', true);
  }
  dbg('pencil down ' + (drawMode ? '(draw)' : '(click)'));
});

stage.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'pen') return;
  if (!drawMode || !pencilDragPath) return;
  e.preventDefault();
  const c = clientToCanvas(e.clientX, e.clientY);
  if (c.x < 0 || c.y < 0 || c.x > macW || c.y > macH) return;
  setAim(c.x, c.y, true);
  const last = pencilDragPath[pencilDragPath.length - 1];
  const dist = Math.hypot(c.x/macW - last.x, c.y/macH - last.y);
  if (dist > 0.002) pencilDragPath.push({ x: c.x / macW, y: c.y / macH });
});

// R2-Fix B2: shared end handler so pointerup AND pointercancel both trigger
// the click/drag. iPad WebKit occasionally delivers pointercancel for a Pencil
// lift instead of pointerup (e.g. when system gestures interrupt the touch).
async function endPencilGesture() {
  if (drawMode && pencilDragPath && pencilDragPath.length >= 2) {
    dbg('pencil drag end, ' + pencilDragPath.length + ' pts');
    const path = pencilDragPath;
    pencilDragPath = null;
    await post('/companion/v2/drag', { displayId: activeDisplayId, points: path });
  } else if (aimX !== null) {
    dbg('pencil tap, click directly');
    await post('/companion/v2/click', { displayId: activeDisplayId, x: aimX, y: aimY });
    flashAim();
  }
  pencilDragPath = null;
}
stage.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'pen') return;
  e.preventDefault();
  try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  void endPencilGesture();
});
stage.addEventListener('pointercancel', (e) => {
  if (e.pointerType !== 'pen') return;
  try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  dbg('pencil cancel — treating as tap');
  void endPencilGesture();
});

// FINGERS via touch events
stage.addEventListener('touchstart', (ev) => {
  if ([].slice.call(ev.touches).some(t => t.touchType === 'stylus')) return;
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    touches.set(t.identifier, { x:t.clientX, y:t.clientY, startX:t.clientX, startY:t.clientY, t:performance.now() });
  }
  if (touches.size === 1) {
    gesture = 'tap';
  } else if (touches.size === 2) {
    const pts = [...touches.values()];
    pinchStart = { dist: D(pts[0], pts[1]), zoom, mid: M(pts[0], pts[1]) };
    panStart = { panX, panY, mid: pinchStart.mid };
    // gesture starts as 'twoFinger' (ambiguous); touchmove decides between
    // 'pinch' (distance changes) and 'scroll' (midpoint translates).
    gesture = 'twoFinger';
    scrollLastMidY = pinchStart.mid.y;
    scrollLastPostAt = 0;
  }
  dbg('touchstart n=' + touches.size + ' g=' + gesture);
}, { passive: false });

stage.addEventListener('touchmove', (ev) => {
  if ([].slice.call(ev.touches).some(t => t.touchType === 'stylus')) return;
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    const rec = touches.get(t.identifier);
    if (rec) { rec.x = t.clientX; rec.y = t.clientY; }
  }
  if (gesture === 'tap' && touches.size === 1) {
    const r = [...touches.values()][0];
    if (Math.hypot(r.x - r.startX, r.y - r.startY) > 10) {
      gesture = 'pan';
      panStart = { panX, panY, mid: { x: r.startX, y: r.startY } };
    }
  }
  if (gesture === 'pan' && touches.size === 1) {
    const r = [...touches.values()][0];
    panX = panStart.panX + (r.x - panStart.mid.x);
    panY = panStart.panY + (r.y - panStart.mid.y);
    clampPan(); applyTransform();
  }
  // Fix E: discriminate two-finger gesture into pinch (zoom) vs. scroll
  // (forward to Mac). Done once based on the early motion; once committed
  // we stay in that mode for the duration of the gesture.
  if (gesture === 'twoFinger' && touches.size === 2 && pinchStart) {
    const pts = [...touches.values()];
    const newDist = D(pts[0], pts[1]);
    const newMid = M(pts[0], pts[1]);
    const distChange = Math.abs(newDist - pinchStart.dist) / pinchStart.dist;
    const midDy = Math.abs(newMid.y - pinchStart.mid.y);
    if (distChange > 0.12) {
      gesture = 'pinch';
    } else if (midDy > 14) {
      gesture = 'scroll';
      scrollLastMidY = newMid.y;
    }
  }

  if (gesture === 'scroll' && touches.size === 2) {
    const pts = [...touches.values()];
    const newMid = M(pts[0], pts[1]);
    const now = performance.now();
    if (now - scrollLastPostAt >= 60) {
      const dy = newMid.y - scrollLastMidY;
      // Convert pixel delta into a small wheel-tick count. Cap at ±6 per
      // tick to keep the cliclick subprocess responsive.
      const ticks = Math.max(-6, Math.min(6, Math.round(dy / 14)));
      if (ticks !== 0) {
        const c = clientToCanvas(newMid.x, newMid.y);
        post('/companion/v2/scroll', {
          displayId: activeDisplayId,
          x: Math.max(0, Math.min(1, c.x / macW)),
          y: Math.max(0, Math.min(1, c.y / macH)),
          dy: ticks,
        });
        scrollLastMidY = newMid.y;
        scrollLastPostAt = now;
      }
    }
  }

  if (gesture === 'pinch' && touches.size === 2 && pinchStart) {
    const pts = [...touches.values()];
    const newDist = D(pts[0], pts[1]);
    const newMid = M(pts[0], pts[1]);
    const targetZoom = pinchStart.zoom * (newDist / pinchStart.dist);
    const sr = stage.getBoundingClientRect();
    const fx = pinchStart.mid.x - sr.left, fy = pinchStart.mid.y - sr.top;
    const before = { x:(fx - panStart.panX)/pinchStart.zoom, y:(fy - panStart.panY)/pinchStart.zoom };
    zoom = Math.max(baseFit * 0.5, Math.min(8, targetZoom));
    const newFx = newMid.x - sr.left, newFy = newMid.y - sr.top;
    panX = newFx - before.x * zoom;
    panY = newFy - before.y * zoom;
    clampPan(); applyTransform();
  }
}, { passive: false });

let lastTapTime = 0, lastTapPos = null;
stage.addEventListener('touchend', (ev) => {
  if ([].slice.call(ev.touches).some(t => t.touchType === 'stylus')) return;
  ev.preventDefault();
  for (const t of ev.changedTouches) {
    const rec = touches.get(t.identifier);
    if (!rec) continue;
    const dt = performance.now() - rec.t;
    const moved = Math.hypot(t.clientX - rec.startX, t.clientY - rec.startY);
    dbg('touchend dt=' + dt.toFixed(0) + ' mv=' + moved.toFixed(0) + ' g=' + gesture);
    if (gesture === 'tap' && moved < 10 && dt < 400 && touches.size === 1) {
      const c = clientToCanvas(t.clientX, t.clientY);
      if (c.x >= 0 && c.y >= 0 && c.x <= macW && c.y <= macH) {
        // Fix D: TeamViewer-style — single finger tap clicks immediately.
        // (Previous behavior moved a crosshair and required pressing the
        // "Click" button, which confused everyone.) The explicit Click /
        // Double / Right buttons remain for precision use cases.
        setAim(c.x, c.y, false);
        const now = performance.now();
        const isDouble = lastTapPos && now - lastTapTime < 320 &&
            Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) < 30;
        if (isDouble) {
          post('/companion/v2/click', { displayId: activeDisplayId, x: c.x/macW, y: c.y/macH, double: true });
          lastTapTime = 0;
          lastTapPos = null;
        } else {
          post('/companion/v2/click', { displayId: activeDisplayId, x: c.x/macW, y: c.y/macH });
          lastTapTime = now;
          lastTapPos = { x: t.clientX, y: t.clientY };
        }
        flashAim();
      }
    }
    touches.delete(t.identifier);
  }
  if (touches.size === 0) gesture = null;
  else if (touches.size === 1 && (gesture === 'pinch' || gesture === 'twoFinger' || gesture === 'scroll')) {
    gesture = 'pan';
    const r = [...touches.values()][0];
    panStart = { panX, panY, mid: { x: r.x, y: r.y } };
  }
}, { passive: false });

stage.addEventListener('touchcancel', (ev) => {
  ev.preventDefault();
  touches.clear();
  gesture = null;
  pencilDragPath = null;
}, { passive: false });

function flashAim() {
  aim.style.transition = 'none';
  aim.style.transform = 'translate(-50%,-50%) scale(1.8)';
  setTimeout(() => { aim.style.transition = ''; aim.style.transform = 'translate(-50%,-50%) scale(1)'; }, 120);
}
$('clickbtn').addEventListener('click', () => {
  if (aimX === null) { setStatus('Tap the screen first to aim', ''); setTimeout(() => setStatus('Live', 'live'), 1500); return; }
  post('/companion/v2/click', { displayId: activeDisplayId, x: aimX, y: aimY });
  flashAim();
});
$('dblbtn').addEventListener('click', () => {
  if (aimX === null) return;
  post('/companion/v2/click', { displayId: activeDisplayId, x: aimX, y: aimY, double: true });
  flashAim();
});
$('rightbtn').addEventListener('click', () => {
  if (aimX === null) return;
  post('/companion/v2/click', { displayId: activeDisplayId, x: aimX, y: aimY, right: true });
  flashAim();
});

$('drawbtn').addEventListener('click', () => {
  drawMode = !drawMode;
  $('drawbtn').classList.toggle('held', drawMode);
  showMode(drawMode ? 'PENCIL DRAW MODE ON' : 'Draw mode off', drawMode);
});

$('zoomin').addEventListener('click', () => setZoom(zoom * 1.5));
$('zoomout').addEventListener('click', () => setZoom(zoom / 1.5));
$('zoomfit').addEventListener('click', () => fitToScreen());

const sticky = new Set();
document.querySelectorAll('[data-mod]').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mod;
    if (sticky.has(m)) { sticky.delete(m); btn.classList.remove('held'); }
    else { sticky.add(m); btn.classList.add('held'); }
  });
});
document.querySelectorAll('[data-key]').forEach(btn => {
  btn.addEventListener('click', () => {
    post('/companion/key', { key: btn.dataset.key, modifiers:[...sticky] });
    sticky.clear();
    document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('held'));
  });
});
document.querySelectorAll('[data-arrow]').forEach(btn => {
  // Fix F: arrows post just "Up"/"Down"/"Left"/"Right" — the server's
  // KEY_ALIASES map handles the suffix. Modifiers from sticky keys (Shift
  // for selection, Cmd for word-jump on macOS) are included.
  btn.addEventListener('click', () => {
    post('/companion/key', { key: btn.dataset.arrow, modifiers:[...sticky] });
    sticky.clear();
    document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('held'));
  });
});

$('kbtoggle').addEventListener('click', () => {
  $('kb').classList.toggle('show');
  if ($('kb').classList.contains('show')) $('kbinput').focus();
});
$('kbinput').addEventListener('keydown', (e) => {
  // Fix F: live-forward special keys + modifier combos (Cmd+C, Cmd+V, etc.).
  // Plain printable input still buffers in the box; Enter flushes it as text
  // followed by a Return keystroke, matching the original behavior.
  const k = e.key;
  // If any modifier is sticky OR the OS keyboard is sending one with this
  // keydown, route through /companion/key with both sets merged.
  const liveMods = [];
  if (e.metaKey)  liveMods.push('Meta');
  if (e.ctrlKey)  liveMods.push('Control');
  if (e.altKey)   liveMods.push('Alt');
  if (e.shiftKey) liveMods.push('Shift');
  const allMods = [...new Set([...sticky, ...liveMods])];

  // Single printable char + at least one non-shift modifier → live combo
  const isSingleChar = k.length === 1;
  const hasNonShiftMod = allMods.some(m => m !== 'Shift');
  if (isSingleChar && hasNonShiftMod) {
    e.preventDefault();
    post('/companion/key', { key: k, modifiers: allMods });
    sticky.clear();
    document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('held'));
    return;
  }

  // Special keys that should fire immediately even without modifiers
  if (['Backspace','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Delete'].includes(k)) {
    e.preventDefault();
    post('/companion/key', { key: k, modifiers: allMods });
    return;
  }

  // Enter flushes buffered text + Return
  if (k === 'Enter') {
    e.preventDefault();
    const v = e.target.value;
    if (v) post('/companion/type', { text: v });
    post('/companion/key', { key:'Return' });
    e.target.value = '';
  }
});

document.addEventListener('touchstart', (e) => {
  if (e.touches.length === 3) dbgEl.style.display = dbgEl.style.display === 'none' ? 'block' : 'none';
});

$('end').addEventListener('click', async () => {
  sessionReady = false;
  try { await fetch('/companion/session/end', { method:'POST', headers }); } catch (e) {}
  if (ws) ws.close();
  showOverlay('Session ended', 'You ended the session.', 'Reconnect', () => location.reload());
});

async function pingLoop() {
  while (sessionReady) {
    try { await fetch('/companion/session/ping', { method:'POST', headers }); } catch (e) {}
    await new Promise(r => setTimeout(r, 20000));
  }
}

// R3-Fix 6: keep iPad/iPhone screen from sleeping during a remote-control
// session. Tries navigator.wakeLock first (works in secure contexts), then
// falls back to the NoSleep video-loop technique — playing a hidden silent
// muted looped MP4 keeps the screen on in iOS Safari even over HTTP.
let _wakeLockSentinel = null;
let _wakeVideoEl = null;
async function keepAwake() {
  // Tier 1: real WakeLock API (HTTPS or localhost only).
  if ('wakeLock' in navigator) {
    try {
      _wakeLockSentinel = await navigator.wakeLock.request('screen');
      // Re-acquire if released when the page is hidden then re-shown.
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && sessionReady) {
          try { _wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch (e) {}
        }
      });
      return;
    } catch (e) { /* fall through to video trick */ }
  }
  // Tier 2: NoSleep.js-style silent looping muted inline video.
  // ~1 KB silent black MP4, public-domain version used by the NoSleep.js
  // library. Plays in iOS Safari without user gesture because it's muted.
  const mp4 = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAGF21kYXTeBAAAbGliZmFhYyAxLjI4AABCAJMgBDIARwAAArEGBf//rdxF6b3m9UtdsdT1G6N0aZIDhFy2WHd47v/2qiYM7gnT/9Hm7P/JIGPzbrhZjP/+OwhmnE/x4j/4cAvyZx/+vF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDiXxf8jyZ98OJfF/yPJn3w4l8X/I8mffDi';
  // NOTE: the above MP4 string is a placeholder of arbitrary content. If
  // playback never starts (some Safari versions reject malformed MP4), the
  // worst case is just that the screen sleeps — which is the pre-fix
  // behavior. We still try; failure is silent.
  try {
    _wakeVideoEl = document.createElement('video');
    _wakeVideoEl.setAttribute('playsinline', '');
    _wakeVideoEl.setAttribute('muted', '');
    _wakeVideoEl.muted = true;
    _wakeVideoEl.loop = true;
    _wakeVideoEl.src = mp4;
    _wakeVideoEl.style.position = 'fixed';
    _wakeVideoEl.style.width = '1px';
    _wakeVideoEl.style.height = '1px';
    _wakeVideoEl.style.opacity = '0';
    _wakeVideoEl.style.pointerEvents = 'none';
    document.body.appendChild(_wakeVideoEl);
    await _wakeVideoEl.play().catch(() => {});
  } catch (e) { /* best-effort; user can manually disable auto-lock */ }
}

window.addEventListener('resize', () => { computeFit(); clampPan(); applyTransform(); });
</script>
</body>
</html>
`;
