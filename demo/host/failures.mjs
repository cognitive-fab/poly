// DF12 item 3: a failed decision is a line on the terminal. The runtime keeps each failed attempt of an effect in the outbox of its
// ledger with the message of the error (a decision is an effect, and so is each call of a route's tier). This reads those rows and
// says, for each, the decision, the tier and the reason, and nothing else: the line holds one reason from a fixed list, never the
// message, so it can hold no key, no body and no customer's text.

/** The routes of a program's text: each decision with a `route <name>`, the route's effect kind and its tiers in order. */
export function routesOf(programText) {
  const routes = [];
  for (const m of programText.matchAll(/^route (\w+) \{([\s\S]*?)^\}/gm)) {
    const name = m[1];
    const tiers = [...m[2].matchAll(/^\s*tier (\w+) provider/gm)].map((t) => t[1]);
    const decision = [...programText.matchAll(/decision (\w+)\([^)]*\)[^{]*\{\s*route (\w+)/g)].find((d) => d[2] === name)?.[1];
    if (decision) routes.push({ kind: `route.${name}.call`, decision, tiers });
  }
  return routes;
}

const REASONS = [
  [/route-exhausted/, () => 'every tier failed'],
  [/timed out after (\d+)\s*ms/, (m) => `timed out after ${m[1]} ms`],
  [/HTTP (\d{3})(?: \((\w+)\))?/, (m) => (m[2] ? `HTTP ${m[1]} (${m[2]})` : `HTTP ${m[1]}`)],
  [/over its share/, () => 'over its input share'],
  [/no ask gave an allowed answer/, () => 'no allowed answer'],
  [/gave no text/, () => 'no text'],
];

/** One line for a failed row of the outbox, or null for a row that is not a decision's (or has no error). */
export function describeFailure(row, context = {}) {
  const { routes = [], secrets = [] } = context;
  if (!row || typeof row.last_error !== 'string' || row.last_error === '' || typeof row.kind !== 'string') return null;
  const route = routes.find((r) => r.kind === row.kind);
  if (!route && !row.kind.startsWith('decision.')) return null;
  const decision = route ? route.decision : row.kind.slice('decision.'.length);
  let payload = row.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  const tier = route && Number.isInteger(payload?.tier) ? (route.tiers[payload.tier] ?? 'none') : 'none';
  let reason = 'not recognised';
  for (const [re, say] of REASONS) {
    const m = re.exec(row.last_error);
    if (m) { reason = say(m); break; }
  }
  if (secrets.some((s) => typeof s === 'string' && s !== '' && row.last_error.includes(s))) reason += ' [removed]';
  return `decision failed: ${decision}, tier ${tier}, ${reason}`;
}

const SQL = 'SELECT intent_id, kind, attempts, last_error, payload FROM pr_outbox WHERE last_error IS NOT NULL';

/** Polls the runtime's outbox and calls onLine once for each distinct (intent, attempts, error) that describeFailure reports. */
export function watchFailures({ db, context, onLine, everyMs = 500 }) {
  const seen = new Set();
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    let rows;
    try { rows = db.prepare(SQL).all(); } catch { return; }
    for (const r of rows) {
      const key = `${r.intent_id}|${r.attempts}|${r.last_error}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = describeFailure(r, context);
      if (line) onLine(line);
    }
  };
  const timer = setInterval(poll, everyMs);
  timer.unref?.();
  poll();
  return { stop() { stopped = true; clearInterval(timer); } };
}
