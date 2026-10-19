// DF3: the demo's orders table. The concierge retrieves a customer's own orders from Postgres through the certified source adapter;
// the demo's table is a small in-memory one holding the personas' synthetic orders, answering the three queries the adapter issues
// (the list of a customer's orders, one order's body, and the erasure of a customer's rows). No database is reached.

/** Rows of the orders table for these personas, with the Stripe charge each was paid with. */
export function ordersRows(personas) {
  return personas.flatMap((p) => p.orders.map((o) => ({ order_id: o.id, customer_id: o.owner, updated_at: o.asOf, summary: o.body, charge_id: o.charge })));
}

/**
 * DF11 item 2a: the table is live. A row is served as of the time of the query, because the program's source declares `freshness 1h` and a fixed
 * date goes stale (an order dated 1 October is 18 days old on 19 October). The persona's own date still orders a customer's orders.
 */
export function ordersDb(personas, { now = () => Date.now() } = {}) {
  const rows = ordersRows(personas);
  const seen = [];
  const query = async (text, params) => {
    seen.push({ text, params });
    if (text.startsWith('SELECT "order_id" AS id')) {
      // The adapter's list query takes [owner, limit] for a customer's own orders or [limit] for all: any other shape is refused, not read as all.
      if (params.length !== 1 && params.length !== 2) throw new Error(`unexpected list query with ${params.length} parameters`);
      const owner = params.length === 2 ? params[0] : undefined;
      const limit = params[params.length - 1];
      return { rows: rows.filter((r) => owner === undefined || r.customer_id === owner).sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1)).slice(0, limit).map((r) => ({ id: r.order_id, owner: r.customer_id, as_of: new Date(now()).toISOString(), key_0: r.charge_id })) };
    }
    if (text.startsWith('SELECT "summary" AS body')) return { rows: rows.filter((r) => r.order_id === params[0]).map((r) => ({ body: r.summary })) };
    if (text.startsWith('DELETE FROM "orders"')) { const gone = rows.filter((r) => r.customer_id === params[0]); for (const g of gone) rows.splice(rows.indexOf(g), 1); return { rows: gone.map((g) => ({ id: g.order_id })) }; }
    throw new Error(`unexpected query ${text}`);
  };
  return { query, seen, rows };
}
