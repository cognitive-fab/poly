// AC18 (PT22.7), a standing test: the concierge's credential suite runs with tokens that carry a canary prefix
// generated here, and a scan of every output finds none of them: the store's every table (state snapshots, the journal
// and the ledger, the content store, the proposals and decisions kept by digest, handler results, the audit), the
// certificate, the build and what the process printed. The scan knows four encodings: plain, base64, base64url and
// URL-encoded. A token in another encoding is not found, which is the scan's stated limit. Its seeded control, a provider
// that echoes the token in a header the vault does not strip and a handler that prints it, is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { handleWith } from './runtime-helpers.mjs';
import { concierge, REFUNDS, verdicts } from './concierge-refund-helpers.mjs';

const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];

/** Every text the run left: each column of each row of the store, and each file of the project and its build. */
function outputs(rt, dir, printed) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push([`table ${name}`, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]);
  }
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push([p, readFileSync(p, 'latin1')]); } };
  walk(dir);
  out.push(['printed', printed.join('')]);
  return out;
}
const found = (texts, tokens) => texts.flatMap(([where, text]) => tokens.flatMap((t) => (encodings(t).some((e) => text.includes(e)) ? [where] : [])));

/** Runs the credential suite: a grant, two refunds through api, a refresh and a revocation; returns what it printed. */
async function suite(c, { echo = false } = {}) {
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return ewrite(chunk, ...rest); };
  try {
    const { rt, clock } = c;
    handleWith(rt, 'payments.refund', async (payload, { api }) => {
      const r = await api.post(REFUNDS, `amount=${payload.amount}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      console.log(`refund answered ${r.status}${echo ? ` ${JSON.stringify(r.headers)}` : ''}`);
      return { status: r.status, body: r.body };
    });
    const grant = await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await rt.advance();
    // The access token expires: the Grant refreshes it through the vault (RFC 6749 section 6), and a second refund uses it.
    await rt.dispatch(grant, 'TokenExpiring');
    await rt.advance();
    clock.advance(1_000);
    await c.refund(app, 'merchant-1', 60);
    await rt.advance();
    await rt.revokeGrant('payments', 'merchant-1', { source: 'provider' });
    await rt.advance();
    return { printed, app, grant };
  } finally { process.stdout.write = write; process.stderr.write = ewrite; }
}

test('AC18: no output of the concierge\'s credential suite holds a token, in any encoding the scan knows', { timeout: 300_000 }, async () => {
  const canary = `CANARY${randomBytes(6).toString('hex')}`;
  const c = await concierge('canary', { token: (kind) => `${canary}${kind}${randomBytes(18).toString('base64url')}` });
  try {
    const { printed, app, grant } = await suite(c);
    // The suite did what it says: two refunds sent with a token, a refresh that issued a new one, a revocation.
    assert.deepEqual((await verdicts(c.rt, app)).map((v) => v[0]), ['allowed', 'allowed']);
    assert.equal((await c.rt.store.getInstance(grant)).state.g, 'Revoked');
    assert.ok(c.issued.length >= 3, `${c.issued.length} tokens issued`);
    assert.ok(c.sent.filter((q) => q.url === REFUNDS).every((q) => q.headers.authorization?.startsWith(`Bearer ${canary}`)));
    const hits = found(outputs(c.rt, c.dir, printed), [canary]);
    assert.deepEqual(hits, [], `the canary was found in ${[...new Set(hits)].join(', ')}`);
  } finally { await c.rt.close(); }
});

test('AC18, seeded control: a provider that echoes the token in a header the vault does not strip, and a handler that prints it, is found by the scan', { timeout: 300_000 }, async () => {
  const canary = `CANARY${randomBytes(6).toString('hex')}`;
  const c = await concierge('canary-control', {
    token: (kind) => `${canary}${kind}${randomBytes(18).toString('base64url')}`,
    provider: (q) => ({ status: 200, headers: { 'x-echo': q.headers.authorization }, body: '{"id":"re_1"}' }),
  });
  try {
    const { printed } = await suite(c, { echo: true });
    assert.ok(found(outputs(c.rt, c.dir, printed), [canary]).length > 0, 'the scan finds the leaked token');
  } finally { await c.rt.close(); }
});
