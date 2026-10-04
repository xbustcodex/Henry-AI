/**
 * Henry Engage — Content Script
 * Adds a floating "Send to Henry" button when text is selected
 */

let floatBtn = null;
let hideTimer = null;

function createButton() {
  const btn = document.createElement('div');
  btn.id = 'henry-engage-btn';
  btn.innerHTML = `
    <div style="
      position: fixed;
      z-index: 2147483647;
      background: #7c3aed;
      color: white;
      border-radius: 20px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      font-family: -apple-system, sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(124,58,237,0.4);
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
      transition: opacity 0.15s, transform 0.15s;
    " id="henry-engage-inner">
      <span style="font-size:14px">◉</span>
      <span>Send to Henry</span>
    </div>
  `;
  document.body.appendChild(btn);
  btn.querySelector('#henry-engage-inner').addEventListener('click', handleCapture);
  return btn;
}

function positionButton(x, y) {
  if (!floatBtn) floatBtn = createButton();
  const inner = floatBtn.querySelector('#henry-engage-inner');
  inner.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  inner.style.top = `${Math.max(y - 44, 8)}px`;
  inner.style.opacity = '1';
  inner.style.transform = 'scale(1)';
}

function hideButton() {
  if (floatBtn) {
    const inner = floatBtn.querySelector('#henry-engage-inner');
    if (inner) { inner.style.opacity = '0'; inner.style.transform = 'scale(0.9)'; }
  }
}

function handleCapture() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text) return;

  const payload = {
    text,
    source: window.location.href,
    pageTitle: document.title,
    category: 'quote',
    process: true,  // Use AI extraction
  };

  chrome.runtime.sendMessage({ type: 'CAPTURE_AND_PROCESS', payload }, (resp) => {
    const inner = floatBtn?.querySelector('#henry-engage-inner');
    if (inner) {
      inner.style.background = resp?.ok ? '#16a34a' : '#dc2626';
      inner.innerHTML = resp?.ok
        ? '<span style="font-size:14px">✓</span><span>Sent to Henry</span>'
        : '<span style="font-size:14px">✗</span><span>Henry not running</span>';
      setTimeout(() => { hideButton(); }, 1500);
    }
    sel?.removeAllRanges();
  });
}

// Also add keyboard listener for quick capture (backup if extension command fails)
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const modKey = isMac ? e.metaKey : e.ctrlKey;
  if (modKey && e.shiftKey && e.code === 'Space') {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 3) {
      e.preventDefault();
      chrome.runtime.sendMessage({
        type: 'CAPTURE_AND_PROCESS',
        payload: { text, source: window.location.href, pageTitle: document.title, process: true },
      }, (resp) => {
        // Brief flash feedback on the page
        const flash = document.createElement('div');
        flash.textContent = resp?.ok ? '⚡ Sent to Henry' : '✗ Henry not running';
        flash.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;background:' +
          (resp?.ok ? '#7c3aed' : '#dc2626') + ';color:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;font-family:-apple-system,sans-serif;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 2000);
      });
    }
  }
});

// Show button on text selection
document.addEventListener('mouseup', (e) => {
  clearTimeout(hideTimer);
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 10) {
      positionButton(e.clientX, e.clientY);
    } else {
      hideButton();
    }
  }, 100);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#henry-engage-btn')) {
    hideTimer = setTimeout(hideButton, 200);
  }
});
