import { createServer, type IncomingMessage, type Server } from "node:http";
import type { SupportAgent } from "./agent.ts";
import type { Store } from "./store.ts";
import { parseWebhook, verifySignature, type InboundMessage } from "./whatsapp.ts";

export interface ServerDeps {
  agent: SupportAgent;
  store: Store;
  whatsapp: { sendText(to: string, body: string): Promise<void> };
  appSecret: string;
  verifyToken: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const MAX_BODY = 1024 * 1024;

export interface WebhookServer {
  server: Server;
  /** Resolves once every message received so far has been handled. */
  drain(): Promise<void>;
}

export function createWebhookServer(deps: ServerDeps): WebhookServer {
  const log = deps.log ?? ((event, data) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })));
  // Messages are processed strictly one at a time so concurrent "YES" replies can't race each other.
  let queue: Promise<void> = Promise.resolve();

  const processMessage = async (msg: InboundMessage) => {
    if (!(await deps.store.markProcessed(msg.id))) return; // webhook redelivery
    const reply = await deps.agent.handle(msg.from, msg.text);
    await deps.whatsapp.sendText(msg.from, reply);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz" && req.method === "GET") {
        res.writeHead(200).end("ok");
        return;
      }
      if (url.pathname !== "/webhook") {
        res.writeHead(404).end();
        return;
      }

      if (req.method === "GET") {
        // Meta's subscription handshake.
        const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === deps.verifyToken;
        if (ok) res.writeHead(200, { "Content-Type": "text/plain" }).end(url.searchParams.get("hub.challenge") ?? "");
        else res.writeHead(403).end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      const body = await readBody(req);
      if (!verifySignature(body, req.headers["x-hub-signature-256"] as string | undefined, deps.appSecret)) {
        log("webhook_bad_signature", {});
        res.writeHead(401).end();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }

      // Acknowledge immediately; Meta retries if we're slow.
      res.writeHead(200).end();
      for (const msg of parseWebhook(payload)) {
        queue = queue
          .then(() => processMessage(msg))
          .catch((err) => log("message_error", { message: msg.id, error: (err as Error).message }));
      }
    } catch (err) {
      log("request_error", { error: (err as Error).message });
      if (!res.headersSent) res.writeHead((err as any).status ?? 500).end();
    }
  });

  return { server, drain: () => queue };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
