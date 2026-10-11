// The network, here and nowhere else in poly (S182): an HTTPS transport for the adapters' sends, an SMTP transport over
// implicit TLS (port 465), and the ingress endpoint. No test uses them: every test replays recorded traffic (S183).
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { connect } from 'node:tls';
import type { HttpTransport, SmtpTransport, Webhook } from '@poly/runtime/adapters';
import type { IngressAnswer } from './ingress.js';

/** The longest a provider may take to answer a send (Standard Webhooks recommends 15 to 30 s). */
const TIMEOUT_MS = 15_000;

export const httpsTransport: HttpTransport = {
  request: (r) => new Promise((resolve, reject) => {
    const url = new URL(r.url);
    if (url.protocol !== 'https:') { reject(new Error(`a send goes over https, not ${url.protocol}`)); return; }
    const req = request(url, { method: r.method, headers: { ...r.headers, 'content-length': String(Buffer.byteLength(r.body)) }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(r.body);
  }),
};

/** An SMTP transport to host:port over implicit TLS. A read returns one whole reply, its continuation lines included. */
export function smtpsTransport(host: string, port = 465): SmtpTransport {
  return {
    open: () => new Promise((resolve, reject) => {
      const socket = connect({ host, port, servername: host, timeout: TIMEOUT_MS }, () => {
        let buffer = '';
        const waiting: ((reply: string) => void)[] = [];
        const replies: string[] = [];
        socket.setEncoding('utf8');
        socket.on('data', (d: string) => {
          buffer += d;
          // A reply ends with a line whose code is followed by a space (RFC 5321 4.2.1).
          let m: RegExpExecArray | null;
          while ((m = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(buffer))) {
            buffer = buffer.slice(m[0].length);
            const next = waiting.shift();
            if (next) next(m[0]); else replies.push(m[0]);
          }
        });
        resolve({
          read: () => new Promise((res) => { const r = replies.shift(); if (r !== undefined) res(r); else waiting.push(res); }),
          write: (line) => new Promise((res, rej) => socket.write(`${line}\r\n`, (e) => (e ? rej(e) : res()))),
          close: async () => { socket.end(); },
        });
      });
      socket.on('timeout', () => socket.destroy(new Error('timed out')));
      socket.on('error', reject);
    }),
  };
}

/** The URL the provider called: the public base, its path kept, followed by the request's path (polywatch). */
export function publicUrl(publicBase: string, path: string): string {
  return publicBase.replace(/\/+$/, '') + path;
}

/**
 * The ingress endpoint: a POST or GET to /channels/<name> becomes a Webhook with the public URL the provider called
 * (publicBase and the request's path), and handle's answer is sent back. Bodies over limit bytes are refused.
 *
 * PT21.4 (ruled 2026-10-11): it listens on the loopback address, 127.0.0.1, unless `host` names another. A personal host is
 * not reachable from the network by default; listening on every interface (`0.0.0.0`, `::`) or on one network address is the
 * host's explicit choice, and the provider reaches the endpoint through publicBase, a tunnel or a proxy.
 */
export function serveIngress(handle: (channel: string, w: Webhook) => Promise<IngressAnswer>, opts: { port: number; host?: string; publicBase: string; limit?: number; credentials?: (credential: string, w: Webhook) => Promise<IngressAnswer> }): Server {
  const limit = opts.limit ?? 1_000_000;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const path = req.url ?? '/';
      // PT10f, S202: a provider's OAuth redirect comes to /credentials/<name>, a channel's webhook to /channels/<name>.
      const m = /^\/(channels|credentials)\/([A-Za-z_][A-Za-z0-9_]*)(?:[/?]|$)/.exec(path);
      const route = m?.[1] === 'credentials' ? opts.credentials : m ? handle : undefined;
      if (!m || !route) { res.writeHead(404).end(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
      route(m[2], { method: req.method ?? 'POST', url: publicUrl(opts.publicBase, path), headers, body: Buffer.concat(chunks).toString('utf8') })
        .then((a) => res.writeHead(a.status, { 'content-type': a.contentType }).end(a.body))
        .catch(() => res.writeHead(500).end());
    });
  });
  server.listen(opts.port, opts.host ?? '127.0.0.1');
  return server;
}
