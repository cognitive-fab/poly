import { createServer, type IncomingMessage as Req, type Server } from "node:http";
import type { RefundAgent } from "./agent.ts";
import type { StateStore } from "./state.ts";
import { parseWebhook, verifySignature, type MessageSender } from "./whatsapp.ts";

export interface ServerOptions {
  agent: RefundAgent;
  state: StateStore;
  sender: MessageSender;
  appSecret: string;
  verifyToken: string;
  log?: (msg: string) => void;
}

const MAX_BODY = 1_000_000;

export interface WebhookServer {
  server: Server;
  /** Resolves once every accepted message has been processed and answered. */
  idle(): Promise<void>;
}

export function createWebhookServer(opts: ServerOptions): WebhookServer {
  const log = opts.log ?? console.log;
  // Messages are processed one at a time so two confirmations can never race each other.
  let queue: Promise<void> = Promise.resolve();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/webhook") return void res.writeHead(404).end();

    if (req.method === "GET") {
      // Meta's subscription handshake.
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === opts.verifyToken;
      if (!ok) return void res.writeHead(403).end();
      return void res.writeHead(200, { "Content-Type": "text/plain" }).end(url.searchParams.get("hub.challenge") ?? "");
    }
    if (req.method !== "POST") return void res.writeHead(405).end();

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      return void res.writeHead(413).end();
    }
    if (!verifySignature(raw, header(req, "x-hub-signature-256"), opts.appSecret)) {
      log("rejected webhook with bad signature");
      return void res.writeHead(401).end();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return void res.writeHead(400).end();
    }

    // Acknowledge immediately; Meta retries slow webhooks, and duplicates are dropped by message ID.
    res.writeHead(200).end();
    for (const m of parseWebhook(payload)) {
      if (!opts.state.markSeen(m.id)) continue;
      queue = queue.then(async () => {
        try {
          const reply = await opts.agent.handle(m.from, m.text);
          await opts.sender.sendText(m.from, reply);
        } catch (err) {
          log(`error handling message ${m.id}: ${String(err)}`);
        }
      });
    }
  });

  return { server, idle: () => queue };
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: Req): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
