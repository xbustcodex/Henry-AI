/**
 * Ordinary-Chat acceptance through the REAL installed UI.
 *
 * Uses trusted CDP input events on purpose: React ignores a programmatically
 * assigned textarea value, so the send button stays disabled and nothing is ever
 * submitted. That is a harness problem, not an app problem.
 *
 * usage: node scripts/acceptance/chat-turn.mjs "<prompt>"
 */
import net from 'node:net';

const CDP = 'http://127.0.0.1:9600';
const PROMPT = process.argv[2] || 'Name one colour.';
const WAIT_MS = Number(process.env.WAIT_MS || 240000);

function wsConnect(url) {
  const u = new URL(url);
  const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshake = Buffer.alloc(0);
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const head = handshake.subarray(0, end).toString();
      if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(`upgrade failed: ${head.split('\r\n')[0]}`));
      const rest = handshake.subarray(end + 4);
      if (rest.length) socket.emit('cdp-data', rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

// Client→server frames MUST be masked.
function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([header, mask, masked]);
}

function wsParse(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) };
}

async function session(wsUrl) {
  const socket = await wsConnect(wsUrl);
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let id = 0;

  const drain = () => {
    for (;;) {
      const f = wsParse(buffer);
      if (!f) return;
      buffer = f.rest;
      if (f.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(f.payload.toString()); } catch { continue; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  };
  socket.on('cdp-data', (c) => { buffer = Buffer.concat([buffer, c]); drain(); });
  socket.on('data', (c) => { buffer = Buffer.concat([buffer, c]); drain(); });

  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((res) => {
      pending.set(mid, res);
      socket.write(wsFrame(JSON.stringify({ id: mid, method, params })));
    });
  };

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  return { socket, send, evaluate };
}

const targets = await (await fetch(`${CDP}/json`)).json();
const page =
  targets.find((t) => t.type === 'page' && t.title === 'Henry AI') ??
  targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.log(JSON.stringify({ error: 'no Henry target' }));
  process.exit(1);
}

const { socket, send, evaluate } = await session(page.webSocketDebuggerUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Land on the Chat surface if we are not already there.
await evaluate(`(async()=>{const b=[...document.querySelectorAll('button[role=button],button')]
  .find(x=>/Start talking to Henry/i.test(x.innerText||''));
  if(b){b.click();await new Promise(r=>setTimeout(r,3000));}return true;})()`);

const SCREEN = `(document.body.innerText||'').replace(/\\s+/g,' ')`;
const SEND = 'Send message (Enter)';

// Trusted focus + trusted text: React ignores a programmatic .value assignment.
await evaluate(`(()=>{const e=document.querySelector('textarea[placeholder*="Message Henry"]');
  if(!e) return false; e.focus(); return true;})()`);
await send('Input.insertText', { text: PROMPT });
await sleep(1200);

const armed = await evaluate(`(()=>{const b=[...document.querySelectorAll('button[title="${SEND}"]')][0];
  return {found:!!b, disabled:b?b.disabled:null};})()`);
if (!armed.found || armed.disabled) {
  console.log(JSON.stringify({ error: 'send button not armed', armed }));
  process.exit(1);
}

const t0 = Date.now();
await evaluate(`document.querySelector('button[title="${SEND}"]').click()`);

let sawThinking = false;
while (Date.now() - t0 < WAIT_MS) {
  await sleep(2500);
  const s = await evaluate(SCREEN);
  if (/Thinking/i.test(s)) sawThinking = true;
  if (sawThinking && !/Thinking/i.test(s)) break;
}
await sleep(3000);

const out = await evaluate(`(()=>{const s=${SCREEN};const i=s.lastIndexOf(${JSON.stringify(PROMPT)});
  return {screen:s, after:i>=0?s.slice(i+${PROMPT.length}):''};})()`);

console.log(JSON.stringify({
  prompt: PROMPT,
  elapsed: Math.round((Date.now() - t0) / 1000),
  sawThinking,
  stillThinking: /Thinking/i.test(out.screen),
  fabricated8B70B: /\((8B|70B)\)/i.test(out.screen),
  reply: out.after.slice(0, 300),
  toolSyntax: /\(computer:|openApp\(|runShell/i.test(out.after),
  taskCard: /\bTasks\b/.test(out.after),
}));
socket.end();
