// M10: two customers' orders, as a host's database holds them, behind a query function that answers the statements the
// Postgres source adapter writes (S308) and keeps every query it was given. No test reaches a database.

export const ORDERS = [
  { order_id: 'o-1', customer_id: 'cust-a', updated_at: '2026-10-01T09:30:00Z', summary: 'Order 1: a lamp.' },
  { order_id: 'o-2', customer_id: 'cust-a', updated_at: '2026-10-06T12:00:00Z', summary: 'Order 2: two lamps.' },
  { order_id: 'o-3', customer_id: 'cust-b', updated_at: '2026-10-05T08:00:00Z', summary: 'Order 3: a chair.' },
];

export function pgOrders(rows0 = ORDERS) {
  const rows = rows0.map((r) => ({ ...r }));
  const seen = [];
  const query = async (text, params) => {
    seen.push({ text, params });
    if (text.startsWith('SELECT "order_id" AS id')) {
      const owner = params.length === 2 ? params[0] : undefined;
      const limit = params[params.length - 1];
      return { rows: rows.filter((r) => owner === undefined || r.customer_id === owner).sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1)).slice(0, limit).map((r) => ({ id: r.order_id, owner: r.customer_id, as_of: r.updated_at })) };
    }
    if (text.startsWith('SELECT "summary" AS body')) return { rows: rows.filter((r) => r.order_id === params[0]).map((r) => ({ body: r.summary })) };
    if (text.startsWith('DELETE FROM "orders"')) { const gone = rows.filter((r) => r.customer_id === params[0]); for (const g of gone) rows.splice(rows.indexOf(g), 1); return { rows: gone.map((g) => ({ id: g.order_id })) }; }
    throw new Error(`unexpected query ${text}`);
  };
  return { query, seen, rows };
}
