/**
 * Henry Engage — Background Service Worker
 * Handles context menu actions and communication with Henry AI (port 4242)
 */

const HENRY_URL = 'http://127.0.0.1:4242';

// Create right-click context menu items
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'henry-capture-selection',
    title: 'Send to Henry: "%s"',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'henry-capture-page',
    title: 'Send page summary to Henry',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'henry-capture-link',
    title: 'Send link to Henry',
    contexts: ['link'],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let text = '';
  let source = tab?.url || '';
  let category = 'web_clip';

  if (info.menuItemId === 'henry-capture-selection') {
    text = info.selectionText || '';
    category = 'quote';
    // Use processing endpoint for right-click captures too
    if (text) {
      sendToHenryProcess({ text, source, category })
        .then(ok => showNotification(ok ? '⚡ Henry is processing…' : '✗ Henry not running', text.slice(0, 60)));
      return;
    }
  } else if (info.menuItemId === 'henry-capture-page') {
    text = `Page: ${tab?.title || source}`;
    category = 'web_clip';
  } else if (info.menuItemId === 'henry-capture-link') {
    text = `Link: ${info.linkUrl}`;
    source = info.linkUrl || '';
    category = 'link';
  }

  if (text) {
    await sendToHenry({ text, source, category });
    showNotification('Sent to Henry', text.slice(0, 60));
  }
});

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CAPTURE') {
    sendToHenry(msg.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
  if (msg.type === 'CAPTURE_AND_PROCESS') {
    sendToHenryProcess(msg.payload)
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async
  }
  if (msg.type === 'CHECK_HENRY') {
    fetch(`${HENRY_URL}/sync/health`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(d => sendResponse({ ok: true, version: d.version, paired: d.paired }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick-capture') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // Get current selection from page
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString().trim() || '',
    }, async (results) => {
      const selectedText = results?.[0]?.result || '';
      if (selectedText && selectedText.length > 3) {
        // Has selection — capture and process it
        const ok = await sendToHenryProcess({
          text: selectedText,
          source: tab.url || '',
          pageTitle: tab.title || '',
        });
        showNotification(
          ok ? '⚡ Henry is processing…' : '✗ Henry not running',
          ok ? selectedText.slice(0, 60) : 'Make sure Henry AI is open'
        );
      } else {
        // No selection — open popup to let user type
        chrome.action.openPopup().catch(() => {});
      }
    });
  }
});

async function sendToHenryProcess(payload) {
  try {
    const res = await fetch(`${HENRY_URL}/sync/capture-and-process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: payload.text,
        source: payload.source || '',
        pageTitle: payload.pageTitle || '',
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendToHenry(payload) {
  const { text, source, category } = payload;
  const res = await fetch(`${HENRY_URL}/sync/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source, category, from: 'henry-engage' }),
  });
  if (!res.ok) throw new Error(`Henry returned ${res.status}`);
  return res.json();
}

function showNotification(title, message) {
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}
