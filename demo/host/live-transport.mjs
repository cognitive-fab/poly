// DF6: the model transport of a live launch, and the only code of the demo that reaches an outside host. It carries a request to the
// model provider's API and to nothing else: a request for any other host is refused before a socket is opened. It is given to the
// live providers by the launcher at the owner's own run; no test calls it with the provider's host, and a recorded run never builds it.
import https from 'node:https';

const HOST = 'api.anthropic.com';

export function liveTransport() {
  return {
    request(q) {
      let url;
      try { url = new URL(q.url); } catch { return Promise.reject(Object.assign(new Error(`no route: ${q.url} is not a URL`), { code: 'ENOROUTE' })); }
      if (url.protocol !== 'https:' || url.hostname !== HOST) return Promise.reject(Object.assign(new Error(`no route: the live transport reaches the model provider alone, not ${url.hostname}`), { code: 'ENOROUTE' }));
      return new Promise((resolve, reject) => {
        const body = q.body ?? '';
        const req = https.request({ host: HOST, path: `${url.pathname}${url.search}`, method: q.method, headers: { ...q.headers, 'content-length': Buffer.byteLength(body) }, timeout: 60_000 }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('the model provider did not answer in 60 s')));
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}
