// M10 step 7 (PT20.2, PS17.2, S308, K14): the source adapters in poly-io, against recorded results only. Postgres runs
// over a host query function that answers from two customers' seeded rows and records every query; OpenSearch over a
// transport that replays recorded responses and records every request. No test reaches a database or a cluster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { postgresSource, openSearchSource, madeHere } from '@poly/io';
import { ROOT } from './helpers.mjs';

const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic', 'opensearch');
const recorded = (f) => readFileSync(join(TRAFFIC, f), 'utf8');

/** Two customers' orders, as a host's database holds them. */
const ROWS = [
  { order_id: 'o-1', customer_id: 'cust-a', updated_at: '2026-10-01T09:30:00Z', summary: 'Order 1: a lamp.' },
  { order_id: 'o-2', customer_id: 'cust-a', updated_at: '2026-10-06T12:00:00Z', summary: 'Order 2: two lamps.' },
  { order_id: 'o-3', customer_id: 'cust-b', updated_at: '2026-10-05T08:00:00Z', summary: 'Order 3: a chair.' },
];

/** A query function that answers the three statement shapes the adapter writes, and keeps every query it was given. */
function pg() {
  const rows = ROWS.map((r) => ({ ...r }));
  const seen = [];
  const query = async (text, params) => {
    seen.push({ text, params });
    if (text.startsWith('SELECT "order_id" AS id')) {
      const owner = params.length === 2 ? params[0] : undefined;
      const limit = params[params.length - 1];
      return { rows: rows.filter((r) => owner === undefined || r.customer_id === owner).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, limit).map((r) => ({ id: r.order_id, owner: r.customer_id, as_of: r.updated_at })) };
    }
    if (text.startsWith('SELECT "summary" AS body')) return { rows: rows.filter((r) => r.order_id === params[0]).map((r) => ({ body: r.summary })) };
    if (text.startsWith('DELETE FROM "orders"')) { const gone = rows.filter((r) => r.customer_id === params[0]); for (const g of gone) rows.splice(rows.indexOf(g), 1); return { rows: gone.map((g) => ({ id: g.order_id })) }; }
    throw new Error(`unexpected query ${text}`);
  };
  return { query, seen, rows };
}

test('S308: postgres retrieves one owner\'s items by reference, with their owner and asOf, through parameterized queries only', async () => {
  const db = pg();
  const s = postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' });
  assert.ok(madeHere(s));
  const items = await s.retrieve({ owner: 'cust-a', limit: 5 });
  assert.deepEqual(items, [{ id: 'o-2', owner: 'cust-a', asOf: Date.parse('2026-10-06T12:00:00Z') }, { id: 'o-1', owner: 'cust-a', asOf: Date.parse('2026-10-01T09:30:00Z') }]);
  // K14: no body comes back with a retrieval; the owner and the limit are parameters, never text.
  assert.ok(items.every((i) => !('body' in i)));
  assert.equal(db.seen[0].text, 'SELECT "order_id" AS id, "customer_id" AS owner, "updated_at" AS as_of FROM "orders" WHERE "customer_id" = $1 ORDER BY "updated_at" DESC LIMIT $2');
  assert.deepEqual(db.seen[0].params, ['cust-a', 5]);
  assert.equal(await s.resolve('o-2'), 'Order 2: two lamps.');
  assert.equal(await s.resolve('o-9'), null);
  // A value that would be SQL, as text, stays a parameter.
  assert.deepEqual(await s.retrieve({ owner: "cust-a' OR '1'='1", limit: 5 }), []);
});

test('S308: postgres forgets a subject\'s rows, and refuses a name that is not plain', async () => {
  const db = pg();
  const s = postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' });
  assert.deepEqual(await s.forget('cust-a'), { removed: 2 });
  assert.deepEqual(await s.retrieve({ owner: 'cust-a', limit: 5 }), []);
  assert.equal((await s.retrieve({ owner: 'cust-b', limit: 5 })).length, 1);
  for (const bad of [{ table: 'orders; DROP TABLE x' }, { owner: 'customer id' }, { body: 'summary"' }]) {
    assert.throws(() => postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', ...bad }), /not a plain name/);
  }
  const unowned = postgresSource({ query: db.query, table: 'orders', id: 'order_id', asOf: 'updated_at', body: 'summary' });
  await assert.rejects(unowned.retrieve({ owner: 'cust-a', limit: 1 }), /no owner column/);
  await assert.rejects(s.retrieve({ owner: 'cust-a', limit: 0 }), /positive integer/);
});

test('S308: opensearch retrieves by a term filter, resolves a document, and forgets by query, against recorded responses', async () => {
  const sent = [];
  const answers = new Map([
    ['POST https://search.example/orders/_search', recorded('search-customer-a.json')],
    ['GET https://search.example/orders/_doc/order-1002', recorded('doc-order-1002.json')],
    ['GET https://search.example/orders/_doc/order-9999', [404, recorded('doc-missing.json')]],
    ['POST https://search.example/orders/_delete_by_query?refresh=true', recorded('delete-by-query-customer-a.json')],
  ]);
  const transport = { async request(r) { sent.push(r); const a = answers.get(`${r.method} ${r.url}`); if (!a) throw new Error(`no recorded answer for ${r.method} ${r.url}`); const [status, body] = Array.isArray(a) ? a : [200, a]; return { status, headers: { 'content-type': 'application/json' }, body }; } };
  const s = openSearchSource({ base: 'https://search.example', index: 'orders', transport, owner: 'customer_id', asOf: 'updated_at', body: 'summary' });
  const items = await s.retrieve({ owner: 'cust-a', limit: 2 });
  assert.deepEqual(items, [{ id: 'order-1002', owner: 'cust-a', asOf: Date.parse('2026-10-06T12:00:00Z') }, { id: 'order-1001', owner: 'cust-a', asOf: Date.parse('2026-10-01T09:30:00Z') }]);
  assert.deepEqual(JSON.parse(sent[0].body), { size: 2, query: { bool: { filter: [{ term: { customer_id: 'cust-a' } }] } }, sort: [{ updated_at: { order: 'desc' } }], _source: ['customer_id', 'updated_at'] });
  assert.equal(await s.resolve('order-1002'), 'Order 1002: two lamps, shipped 6 October.');
  assert.equal(await s.resolve('order-9999'), null);
  assert.deepEqual(await s.forget('cust-a'), { removed: 2 });
  assert.deepEqual(JSON.parse(sent[sent.length - 1].body), { query: { term: { customer_id: 'cust-a' } } });
  assert.throws(() => openSearchSource({ base: 'http://search.example', index: 'orders', transport, asOf: 'updated_at', body: 'summary' }), /https origin/);
  assert.throws(() => openSearchSource({ base: 'https://search.example', index: '../x', transport, asOf: 'updated_at', body: 'summary' }), /not an index name/);
});
