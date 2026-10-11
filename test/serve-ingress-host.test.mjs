// PT21.4 (ruled 2026-10-11): serveIngress listens on the loopback address, 127.0.0.1, unless opts.host names another. A
// personal host is not reachable from the network by default; listening on every interface is the host's explicit choice.
// The first version of this file was a placeholder; the release session wrote the cases from the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveIngress } from '@poly/io';

const answer = async () => ({ status: 200, contentType: 'text/plain', body: 'ok' });

/** Starts an ingress with the options, waits until it listens, and returns the server and its port. */
async function start(opts) {
  const server = serveIngress(answer, { port: 0, publicBase: 'https://example.org', ...opts });
  if (!server.listening) await new Promise((done) => server.once('listening', done));
  return { server, port: server.address().port };
}
const stop = (server) => new Promise((done) => server.close(done));

test('PT21.4: with no host the ingress listens on the loopback address, and answers there', async () => {
  const { server, port } = await start({});
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const r = await fetch(`http://127.0.0.1:${port}/channels/x`, { method: 'POST', body: 'hi' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'ok');
  } finally { await stop(server); }
});

test('PT21.4: a host named explicitly is the address it listens on, every interface included', async () => {
  const all = await start({ host: '0.0.0.0' });
  try { assert.equal(all.server.address().address, '0.0.0.0'); } finally { await stop(all.server); }
  const loop = await start({ host: '127.0.0.1' });
  try { assert.equal(loop.server.address().address, '127.0.0.1'); } finally { await stop(loop.server); }
});
