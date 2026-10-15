// E3.9's pattern (Q-E3-5, the owner's ruling of 2026-10-11) for the demo copy: a live launch prices its calls from tables whose source
// and date were read from the vendor's page. A table that names a placeholder source is refused, and the live launch does not start
// until every table passes. The copy's tables are the example's, with example.com as source, until the owner reads the vendor's page
// and writes the model, the prices, the page and the date; recorded runs do not call a model and do not need them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Hosts that are never a vendor's pricing page (RFC 2606 and the like). */
const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|net|org)|invalid|test|localhost)$/i;
const MAX_AGE_DAYS = 90;
const DAY = 86_400_000;

/** Why one table is refused, as a list (empty when it passes). */
export function refusalsOf(table, today = new Date()) {
  const why = [];
  if (table?.v !== 1) why.push('v is not 1');
  if (typeof table?.provider !== 'string' || table.provider === '') why.push('no provider');
  if (typeof table?.model !== 'string' || table.model === '') why.push('no model');
  else if (/placeholder/i.test(table.model)) why.push('the model name is a placeholder');
  if (typeof table?.currency !== 'string' || !/^[a-z]{3}$/.test(table.currency)) why.push('no currency');
  const p = table?.perMillionTokens;
  if (!p || !Number.isInteger(p.input) || p.input <= 0 || !Number.isInteger(p.output) || p.output <= 0) why.push('input and output prices are not positive integers of micro-units');
  let host = null;
  try {
    const u = new URL(String(table?.source));
    if (u.protocol !== 'https:') why.push('the source is not an https page');
    host = u.hostname;
  } catch {
    why.push('the source is not a URL');
  }
  if (host && PLACEHOLDER_HOSTS.test(host)) why.push(`the source names a placeholder host (${host})`);
  const read = typeof table?.readOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(table.readOn) ? Date.parse(`${table.readOn}T00:00:00Z`) : NaN;
  if (Number.isNaN(read)) why.push('readOn is not a date');
  else if (read > today.getTime()) why.push('readOn is in the future');
  else if (today.getTime() - read > MAX_AGE_DAYS * DAY) why.push(`readOn is more than ${MAX_AGE_DAYS} days old`);
  return why;
}

/** Every table of a directory: { ok, tables: [{ file, refusals }] }. A directory with no table is refused. */
export function checkPrices(dir, today = new Date()) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const tables = files.map((file) => {
    let refusals;
    try { refusals = refusalsOf(JSON.parse(readFileSync(join(dir, file), 'utf8')), today); } catch (e) { refusals = [`not JSON (${e.message})`]; }
    return { file, refusals };
  });
  return { ok: tables.length > 0 && tables.every((t) => t.refusals.length === 0), tables };
}
