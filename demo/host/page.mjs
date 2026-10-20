// The room page and the presenter's staff panel (DF2, DF7): two small pages, no framework, no outside request. The page tells the
// participants what the demo is (a concierge on recorded and live model answers, payments through a mock-up of Stripe), that
// everything typed is shown on screen, and asks for no personal data.

const STYLE = `
:root { --fg: #1c1c1e; --bg: #fafaf7; --muted: #6a6a6e; --line: #d8d8d0; --me: #e6efe6; --them: #ffffff; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #17181a; --muted: #9a9aa0; --line: #34363a; --me: #1f2e22; --them: #222427; --warn: #e0a85c; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 40rem; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.25rem; margin: 0 0 4px; }
.note { color: var(--muted); font-size: .9rem; margin: 2px 0; }
.warn { color: var(--warn); }
#log { list-style: none; margin: 16px 0; padding: 0; display: grid; gap: 8px; }
#log li { padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--them); max-width: 90%; white-space: pre-wrap; overflow-wrap: anywhere; }
#log li.me { background: var(--me); justify-self: end; }
form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--them); color: var(--fg); }
button { cursor: pointer; }
#status { min-height: 1.4em; }
`;

/** The script of the room page (DF18 item 3): a function of its own so that a test can run it. */
export function roomPageScript() {
  return String.raw`const log = document.getElementById('log'), status = document.getElementById('status'), input = document.getElementById('t'), button = document.getElementById('b');
const add = (text, me) => { const li = document.createElement('li'); if (me) li.className = 'me'; li.textContent = text; log.appendChild(li); li.scrollIntoView({ block: 'end' }); };
const halted = () => { status.textContent = 'The presenter has stopped the room.'; input.disabled = true; button.disabled = true; };
fetch('/api/me').then((r) => r.json()).then((me) => { if (!me.persona) { status.textContent = 'The room is full.'; return; } document.getElementById('who').textContent = me.persona.id + ' (' + me.persona.display + ')'; if (me.killed) halted(); });
const events = new EventSource('/api/events');
events.onmessage = (e) => { const ev = JSON.parse(e.data); if (ev.kind === 'reply') add(ev.text, false); if (ev.kind === 'halted') halted(); };
// DF18 item 3: the page says it is sending, and gives up on the host after 10 seconds, so a request that the browser holds in a queue is not silent.
let sending = false;
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const text = input.value.trim();
  if (!text) return;
  sending = true;
  button.disabled = true;
  status.textContent = 'Sending...';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let j = null;
  let failure = null;
  try {
    const r = await fetch('/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
    j = await r.json().catch(() => ({}));
  } catch (err) {
    failure = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'error';
  }
  clearTimeout(timer);
  sending = false;
  if (failure === 'timeout') { status.textContent = 'The room did not answer. Close other tabs of this page, reload, and send again.'; button.disabled = false; return; }
  if (failure) { status.textContent = 'The message could not be sent.'; button.disabled = false; return; }
  if (j.reason === 'halted') { halted(); return; }
  button.disabled = false;
  if (j.ok) { add(text, true); input.value = ''; status.textContent = ''; }
  else if (j.reason === 'too-fast') status.textContent = 'One message every 5 seconds. Try again in ' + Math.ceil((j.retryInMs || 0) / 1000) + ' s.';
  else if (j.reason === 'too-many') status.textContent = 'That is the 12 messages each guest may send.';
  else if (j.reason === 'too-long') status.textContent = 'At most 280 characters.';
  else status.textContent = 'The message could not be sent.';
});`;
}

/** The room page. The behaviour is the browser's: it posts to /api/say and listens on /api/events. */
export function roomPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concierge demo</title><style>${STYLE}</style></head>
<body><main>
<h1>Ask the concierge</h1>
<p class="note">You are <strong id="who">...</strong>. This is a demo: the shop and its customers are made up.</p>
<p class="note warn">Everything you type is shown on screen and kept in this session's record. Please use no real personal data.</p>
<p class="note">Refunds go through a mock-up of Stripe on this machine: no real money moves.</p>
<ul id="log" aria-live="polite"></ul>
<form id="f"><input id="t" name="text" maxlength="280" autocomplete="off" placeholder="Where is my order? Can I have a refund?" aria-label="Your message"><button id="b" type="submit">Send</button></form>
<p id="status" class="note" role="status"></p>
</main>
<script>
${roomPageScript()}
</script></body></html>`;
}

/** The presenter's staff panel: what the staff channel was told, live. */
export function staffPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Staff panel</title><style>${STYLE}</style></head>
<body><main>
<h1>Staff panel</h1>
<p class="note">What the concierge told its staff channel. A message here approves nothing: approve with <code>poly approve</code>, signed with your person key.</p>
<ul id="log"></ul>
<script>
const t = new URLSearchParams(location.search).get('t') || '';
const log = document.getElementById('log');
const add = (e) => { const li = document.createElement('li'); li.textContent = new Date(e.at).toLocaleTimeString() + '  ' + e.text; log.appendChild(li); };
fetch('/presenter/staff/entries', { headers: { 'x-presenter-token': t } }).then((r) => r.json()).then((j) => { (j.entries || []).forEach(add); const ev = new EventSource('/presenter/staff/events?t=' + encodeURIComponent(t)); ev.onmessage = (m) => add(JSON.parse(m.data)); });
</script></main></body></html>`;
}
