// V4 of the v1 plan (AC27, PT10f "Replaying a grant", PS11.4): a build with a credential records `std.credentials`
// among its certified type modules, as a build with a route records `std.routing` (PT10r), so replay reads the module
// the build instantiated and folds each credential's `Grant` instance through poly-ref's step like any other run.
// Before V4 no build recorded `std.credentials` and replay could not rebuild a grant (decisions-m11, step 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayRuntime } from '@poly/check';
import { handleWith } from './runtime-helpers.mjs';
import { concierge, REFUNDS, verdicts } from './concierge-refund-helpers.mjs';

/** The concierge's delegated refund: a grant, a refund through it, a refresh of its token, and a second refund. */
async function drive(c) {
  const { rt, clock } = c;
  handleWith(rt, 'payments.refund', async (p, { api }) => ({ status: (await api.post(REFUNDS, `amount=${p.amount}`)).status }));
  const grant = await c.grant('merchant-1');
  const app = await c.ticket('alice');
  await c.refund(app, 'merchant-1', 40);
  await rt.advance();
  await rt.dispatch(grant, 'TokenExpiring');
  await rt.advance();
  clock.advance(1_000);
  await c.refund(app, 'merchant-1', 60);
  await rt.advance();
  return { grant, app };
}

const certificateOf = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('AC27, V4: replay of a concierge run with a delegated refund reproduces every run, the grant included, with no diagnostic and nothing not run', { timeout: 300_000 }, async () => {
  const c = await concierge('v4-grant-replay');
  try {
    const { grant, app } = await drive(c);
    // The run did what it says: the grant was granted and both refunds were allowed and sent with its token.
    assert.deepEqual((await verdicts(c.rt, app)).map((v) => v[0]), ['allowed', 'allowed']);
    assert.equal((await c.rt.store.getInstance(grant)).state.g, 'Granted');
    assert.equal(c.sent.filter((q) => q.url === REFUNDS).length, 2);
    assert.ok((await c.rt.getJournal(grant)).length >= 2, 'the grant stepped: granted, then refreshed');

    const runs = await replayRuntime(c.rt);
    // Every instance of the store is replayed, the Grant among them.
    const ids = c.rt.store.db.prepare('SELECT instance_id FROM pr_instance').all().map((r) => r.instance_id);
    const replayed = new Set(runs.map((r) => r.run));
    for (const id of ids) assert.ok(replayed.has(id), `run ${id} was not replayed`);
    const g = runs.find((r) => r.run === grant);
    assert.ok(g, 'the grant\'s run is replayed');
    assert.match(g.machine, /Grant$/);
    assert.ok(g.rows >= 2 && g.folded === g.rows, `the grant's ${g.rows} rows are all folded (${g.folded})`);
    assert.ok(g.windows > 0, 'polygraph replays the grant\'s accepted windows');
    assert.ok(runs.find((r) => r.run === app), 'the ticket\'s run is replayed');
    for (const r of runs) {
      // No diagnostic: every post-state and every snapshot agrees with the fold (PL9001 otherwise, PS11.4).
      assert.deepEqual([r.run, r.diagnostics.map((d) => `${d.code} ${d.message}`)], [r.run, []]);
      assert.equal(r.folded, r.rows, `${r.run}: every row is folded`);
      assert.deepEqual([r.run, r.notRun ?? []], [r.run, []], 'nothing listed as not run');
      assert.ok(!r.archived && !r.skipped, `${r.run} is replayed, not skipped`);
    }
  } finally { await c.rt.close(); }
});

test('AC27, V4: the certificate of a build with a credential records std.credentials among its type modules, under std', { timeout: 300_000 }, async () => {
  const c = await concierge('v4-grant-certificate');
  try {
    const cert = certificateOf(c.certificate);
    assert.ok(cert.poly, 'the certificate has its poly section');
    const tm = cert.poly.typeModules ?? {};
    assert.ok(tm['std.credentials'], `std.credentials is among the certified type modules: ${JSON.stringify(Object.keys(tm))}`);
    assert.equal(tm['std.credentials'].path, 'std:credentials/grant.poly');
    assert.equal(typeof tm['std.credentials'].digest, 'string');
    assert.ok(tm['std.credentials'].digest.length > 0);
  } finally { await c.rt.close(); }
});
