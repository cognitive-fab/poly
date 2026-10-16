import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SupportAgent } from './agent.ts';
import type { InboundMessage, WhatsAppClient } from './whatsapp.ts';
import { extractMessages, verifySignature } from './whatsapp.ts';

export interface AppDeps {
  agent: SupportAgent;
  whatsapp: WhatsAppClient;
  verifyToken: string;
  appSecret: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface App {
  server: Server;
  /** Resolves once every queued message has been handled. */
  drain(): Promise<void>;
}

const MAX_BODY = 1_000_000;
const MAX_SEEN = 10_000;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

export function createApp(deps: AppDeps): App {
  const log = deps.log ?? (() => {});
  const seen = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  async function processMessage(m: InboundMessage): Promise<void> {
    let reply: string;
    try {
      reply =
        m.type === 'text' && m.text
          ? await deps.agent.handle(m.from, m.text)
          : 'Sorry, I can only read text messages. Send "refund" followed by your order number.';
    } catch (err) {
      log('agent error', { from: m.from, error: String(err) });
      reply = 'Sorry, something went wrong on our side. Please try again later.';
    }
    await deps.whatsapp.sendText(m.from, reply);
  }

  // Messages are handled one at a time so two concurrent requests can't
  // both pass the "not yet refunded" check.
  function enqueue(m: InboundMessage): void {
    queue = queue
      .then(() => processMessage(m))
      .catch((err) => log('failed to handle message', { id: m.id, error: String(err) }));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/webhook') return send(res, 404, 'not found');

    if (req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === deps.verifyToken) {
        return send(res, 200, q.get('hub.challenge') ?? '');
      }
      return send(res, 403, 'forbidden');
    }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      return send(res, 413, 'payload too large');
    }

    const sig = req.headers['x-hub-signature-256'];
    if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, deps.appSecret)) {
      log('rejected webhook with bad signature');
      return send(res, 401, 'invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, 'invalid json');
    }

    // Acknowledge straight away; Meta retries deliveries that are slow to get a 200.
    send(res, 200, 'ok');

    for (const m of extractMessages(payload)) {
      if (seen.has(m.id)) continue; // redelivered webhook
      seen.add(m.id);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
      enqueue(m);
    }
  });

  return {
    server,
    async drain() {
      let current;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
  };
}
