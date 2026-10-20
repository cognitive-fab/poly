// DF12 item 3: a failed decision is a line on the terminal. The runtime keeps each failed attempt of an effect in the outbox of its
// ledger with the message of the error (a decision is an effect, and so is each call of a route's tier). This reads those rows and
// says, for each, the decision, the tier and the reason, and nothing else: the line holds one reason from a fixed list, never the
// message, so it can hold no key, no body and no customer's text.

/**
 * DF17 item 2: the domain of each decision whose result type is declared `type T = { value: min..max }`, as { [decision]: { min, max } }.
 * A decision whose type is anything else has no entry.
 */
export function domainsOf(programText) {
  const types = {};
  for (const m of programText.matchAll(/^type (\w+) = \{ value: (\d+)\.\.(\d+) \}/gm)) types[m[1]] = { min: Number(m[2]), max: Number(m[3]) };
  const out = {};
  for (const m of programText.matchAll(/^[ \t]*decision (\w+)\([^)]*\) -> (\w+)/gm)) if (types[m[2]]) out[m[1]] = { ...types[m[2]] };
  return out;
}

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

/** DF13 item 4: the API's message part of an HTTP reason: the secrets removed, one line, at most 200 characters. */
function cleanMessage(text, secrets) {
  let out = text;
  for (const s of secrets) if (typeof s === 'string' && s !== '') out = out.split(s).join('[removed]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** DF15 item 2: the parenthesis of a rejected vote, rebuilt from numbers and reasons of a fixed list, or '' if any part is not on it. */
const REJECTIONS = ['no JSON object', 'value missing', 'value a string', 'value not a whole number', 'value negative', 'answer missing', 'answer not allowed', 'reply cut off'];
function rejections(text) {
  const m = new RegExp('\\((\\d+) asks?: ([^)]*)\\)').exec(text);
  if (!m) return '';
  // A vote gives a count before each reason; a single ask (answer, reply) gives the reason alone.
  const parts = m[2].split(', ').map((p) => new RegExp('^(?:(\\d+) )?(.+)$').exec(p));
  // DF16 item 3: a cut-off reason may carry the output tokens, 'reply cut off at <1 to 9 digits> tokens', and nothing else after a reason.
  const known = (r) => REJECTIONS.includes(r) || new RegExp('^reply cut off at [0-9]{1,9} tokens$').test(r);
  if (parts.some((p) => !p || !known(p[2]))) return '';
  const n = Number(m[1]);
  return ` (${n} ${n === 1 ? 'ask' : 'asks'}: ${parts.map((p) => (p[1] === undefined ? p[2] : `${Number(p[1])} ${p[2]}`)).join(', ')})`;
}

const REASONS = [
  [/route-exhausted/, () => 'every tier failed'],
  [/timed out after (\d+)\s*ms/, (m) => `timed out after ${m[1]} ms`],
  [/the limit \w+ is not a whole number/, () => 'limit is not a whole number'],
  [/HTTP (\d{3})(?: \((\w+)\)(?:: ([\s\S]+))?)?/, (m, secrets) => (m[2] ? `HTTP ${m[1]} (${m[2]})${m[3] ? `: ${cleanMessage(m[3], secrets)}` : ''}` : `HTTP ${m[1]}`)],
  [/over its share|over the declared input limit/, () => 'over its input share'],
  [/no ask gave an allowed answer/, (m, secrets, text) => `no allowed answer${rejections(text)}`],
  [/gave no text/, (m, secrets, text) => `no text${rejections(text)}`],
];

/** One line for a failed row of the outbox, or null for a row that is not a decision's (or has no error). */
export function describeFailure(row, context = {}) {
  const { routes = [], secrets = [], domains = {} } = context;
  if (!row || typeof row.last_error !== 'string' || row.last_error === '' || typeof row.kind !== 'string') return null;
  const route = routes.find((r) => r.kind === row.kind);
  if (!route && !row.kind.startsWith('decision.')) return null;
  const decision = route ? route.decision : row.kind.slice('decision.'.length);
  let payload = row.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  const tier = route && Number.isInteger(payload?.tier) ? (route.tiers[payload.tier] ?? 'none') : 'none';
  let reason = 'not recognised';
  // DF17 item 2: the dispatch refusal of AC30 (S140), with the bounds of the program's type and no value.
  const outside = /outside its type/.test(row.last_error);
  if (outside) reason = domains[decision] ? `outside its domain (${domains[decision].min} to ${domains[decision].max})` : 'outside its type';
  else for (const [re, say] of REASONS) {
    const m = re.exec(row.last_error);
    if (m) { reason = say(m, secrets, row.last_error); break; }
  }
  if (!reason.includes('[removed]') && secrets.some((s) => typeof s === 'string' && s !== '' && row.last_error.includes(s))) reason += ' [removed]';
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
