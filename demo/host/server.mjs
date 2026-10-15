// DF2, DF7: the room's server. Two kinds of route on one listener:
//   the participants' side   GET /  (the page, and a session cookie), GET /api/me, POST /api/say, GET /api/events (server-sent events)
//   the presenter's side     POST /presenter/kill, GET /presenter/staff, /presenter/staff/entries, /presenter/staff/events
// The presenter's routes answer only to the loopback and only with the presenter's token (made at start, shown on the presenter's
// terminal alone), so the LAN sees the participants' side alone. There is no kill route on the participants' side. A body over 2 KB
// is refused. The server holds no rule of the concierge: the room does the limits, the kill switch and the signing.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { roomPage, staffPage } from './page.mjs';

const MAX_BODY = 2048;
const COOKIE = 'room_session';
const STATUS = { ok: 200, 'too-long': 400, empty: 400, 'too-fast': 429, 'too-many': 429, halted: 503, refused: 502, 'no-session': 401 };

/** Whether an address is the machine itself. */
export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const sameToken = (given, token) => {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Over the limit the rest is read and thrown away, so that the answer can still be sent.
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sse(res, onClose) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': hello\n\n');
  res.on('close', onClose);
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** `room` is room.mjs, `staff` the staff feed, `presenterToken` the secret of the presenter's routes. */
export async function startRoomServer({ room, staff, presenterToken, host = '127.0.0.1', port = 0, limiter }) {
  const sessionOf = (req) => new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{32})`).exec(req.headers.cookie ?? '')?.[1] ?? null;
  const presenter = (req, url) => isLoopback(req.socket.remoteAddress) && sameToken(req.headers['x-presenter-token'] ?? url.searchParams.get('t'), presenterToken);
  const open = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://room.local');
    try {
      // ---- the presenter's side ----
      if (url.pathname.startsWith('/presenter/')) {
        if (!presenter(req, url)) return json(res, 403, { error: 'presenter only' });
        if (req.method === 'POST' && url.pathname === '/presenter/kill') { room.kill('presenter'); return json(res, 200, { ok: true, killed: true }); }
        if (req.method === 'GET' && url.pathname === '/presenter/staff') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(staffPage()); }
        if (req.method === 'GET' && url.pathname === '/presenter/staff/entries') return json(res, 200, { entries: staff.entries() });
        if (req.method === 'GET' && url.pathname === '/presenter/staff/events') {
          const send = sse(res, () => stop());
          const stop = staff.subscribe((e) => send(e));
          return undefined;
        }
        return json(res, 404, { error: 'not found' });
      }
      // ---- the participants' side ----
      if (req.method === 'GET' && url.pathname === '/') {
        const existing = sessionOf(req);
        const session = existing ?? randomBytes(16).toString('hex');
        room.join(session);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(existing ? {} : { 'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` }) });
        return res.end(roomPage());
      }
      const session = sessionOf(req);
      const API = new Set(['GET /api/me', 'POST /api/say', 'GET /api/events']);
      if (url.pathname.startsWith('/api/') && !API.has(`${req.method} ${url.pathname}`)) return json(res, 404, { error: 'not found' });
      if (url.pathname.startsWith('/api/') && !session) return json(res, 401, { ok: false, reason: 'no-session' });
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const persona = room.persona(session);
        return json(res, 200, {
          persona: persona ? { id: persona.id, phone: persona.phone, display: persona.display, orders: persona.orders.map((o) => o.id) } : null,
          killed: room.killed,
          limits: limiter ? { maxChars: limiter.maxChars, minGapMs: limiter.minGapMs, maxMessages: limiter.maxMessages } : undefined,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/say') {
        let text;
        try { text = JSON.parse(await readBody(req)).text; } catch (e) { return json(res, e.status ?? 400, { ok: false, reason: e.status === 413 ? 'too-large' : 'bad-json' }); }
        const r = await room.say(session, text);
        return json(res, STATUS[r.ok ? 'ok' : r.reason] ?? 400, r);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const send = sse(res, () => stop());
        const stop = room.subscribe(session, (e) => send(e));
        open.add(res);
        res.on('close', () => open.delete(res));
        return undefined;
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) return json(res, e.status ?? 500, { error: e.status ? 'refused' : 'error' });
      return undefined;
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    port: server.address().port,
    host,
    close: () => new Promise((resolve) => { for (const r of open) r.end(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
