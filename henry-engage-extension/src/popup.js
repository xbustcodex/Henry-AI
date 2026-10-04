/**
 * Henry Engage — Popup Script
 */

const statusEl = document.getElementById('status');
const versionEl = document.getElementById('version');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const categoryEl = document.getElementById('category');

// Check Henry connection on open
chrome.runtime.sendMessage({ type: 'CHECK_HENRY' }, (resp) => {
  if (resp?.ok) {
    statusEl.textContent = 'Connected ✓';
    statusEl.className = 'status ok';
    versionEl.textContent = `v${resp.version || '?'}`;
  } else {
    statusEl.textContent = 'Henry not running';
    statusEl.className = 'status err';
    sendBtn.disabled = true;
  }
});

// Quick action buttons
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;

    if (action === 'selection') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || '',
      }, (results) => {
        const sel = results?.[0]?.result || '';
        if (sel) {
          textInput.value = sel;
          categoryEl.value = 'quote';
        } else {
          textInput.placeholder = 'No text selected on page';
        }
      });
    } else if (action === 'page') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      textInput.value = `${tab.title}\n${tab.url}`;
      categoryEl.value = 'web_clip';
    } else if (action === 'url') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      textInput.value = tab.url || '';
      categoryEl.value = 'link';
    } else if (action === 'note') {
      textInput.focus();
      textInput.placeholder = 'Type your note…';
    }
  });
});

// Send button
sendBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const useProcess = true; // always use AI processing
  chrome.runtime.sendMessage({
    type: useProcess ? 'CAPTURE_AND_PROCESS' : 'CAPTURE',
    payload: {
      text,
      source: tab?.url || '',
      pageTitle: tab?.title || '',
      category: categoryEl.value,
      process: true,
    },
  }, (resp) => {
    if (resp?.ok) {
      sendBtn.textContent = '⚡ Henry processing…';
      sendBtn.className = 'btn success';
      textInput.value = '';
      setTimeout(() => {
        sendBtn.textContent = 'Send to Henry';
        sendBtn.className = 'btn';
        sendBtn.disabled = false;
      }, 1500);
    } else {
      sendBtn.textContent = '✗ Failed';
      sendBtn.className = 'btn error';
      setTimeout(() => {
        sendBtn.textContent = 'Send to Henry';
        sendBtn.className = 'btn';
        sendBtn.disabled = false;
      }, 2000);
    }
  });
});

// Enter to send
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBtn.click();
});
