// PS18.3, S350 (M11 step 2): money as integers. An amount is a count of micro-units, one millionth of a currency unit,
// so every sum, reservation and cost is exact. A price table is a JSON file a route's tier names: its provider and
// model, its currency, and the price of a million tokens per token class, in micro-units, with the source it was read
// from and the date it was read (PL6843 without them). poly-check reads the file and passes it in as data, so the
// checker never reads the file system; poly-ref reads it on its own, and the runtime reads the copy the route's
// descriptor certifies.

/** Micro-units in one currency unit. */
export const MICRO = 1_000_000;

/** A price table, as PS18.3 and PT10r give its fields. */
export interface PriceTable {
  v: 1;
  provider: string;
  /** The model the prices are for: the tier's model, which its calibration map must be fitted for (PL6842). */
  model: string;
  /** A lower-case ISO 4217 code, `usd` for example. */
  currency: string;
  /** Per token class (`input`, `output`, …): the price of a million tokens, in micro-units. */
  perMillionTokens: Record<string, number>;
  /** Where the prices were read: an https URL. */
  source: string;
  /** The date they were read, `YYYY-MM-DD`. */
  readOn: string;
}

/** A price table as poly-check found it: the parsed JSON (unchecked), the file, and the digest of its bytes. */
export interface PriceEntry {
  table: unknown;
  file: string;
  digest: string;
}

const CURRENCY = /^[a-z]{3}$/;
const CLASS = /^[a-z][a-z0-9_]*$/;

/**
 * `12.50` in micro-units, or null when it is not a non-negative decimal with at most six places, or is beyond the
 * integers a number holds exactly. Written as a string so no binary fraction is ever rounded.
 */
export function parseAmount(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const v = BigInt(m[1]) * BigInt(MICRO) + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/** An amount of micro-units in decimal, `12.5` for 12_500_000: the inverse of parseAmount, for reports. */
export function formatAmount(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const a = BigInt(Math.abs(micro));
  const whole = a / BigInt(MICRO);
  const frac = (a % BigInt(MICRO)).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * What is wrong with a price table for `provider`, as a diagnostic code and message, or null when it has every field
 * PS18.3 names, well formed. A table with no https source or no date it was read is PL6843 PRICE_UNSOURCED; any other
 * fault is PL1201.
 */
export function priceTableProblem(t: unknown, provider: string): { code: 'PL6843' | 'PL1201'; message: string } | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { code: 'PL1201', message: 'is not a JSON object' };
  const o = t as Record<string, unknown>;
  if (o.v !== 1) return { code: 'PL1201', message: 'has no version 1' };
  if (o.provider !== provider) return { code: 'PL1201', message: `names the provider ${JSON.stringify(o.provider)}, not "${provider}"` };
  if (typeof o.model !== 'string' || !o.model) return { code: 'PL1201', message: 'names no model' };
  if (typeof o.currency !== 'string' || !CURRENCY.test(o.currency)) return { code: 'PL1201', message: 'names no currency as a lower-case three-letter code' };
  const p = o.perMillionTokens;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length) return { code: 'PL1201', message: 'prices no token class' };
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (!CLASS.test(k)) return { code: 'PL1201', message: `has the token class ${JSON.stringify(k)}, which is not a lower-case name` };
    if (!isAmount(v)) return { code: 'PL1201', message: `prices ${k} at ${JSON.stringify(v)}, which is not a whole number of micro-units` };
  }
  let sourced = false;
  if (typeof o.source === 'string') { try { sourced = new URL(o.source).protocol === 'https:'; } catch { sourced = false; } }
  if (!sourced || typeof o.readOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.readOn) || Number.isNaN(Date.parse(`${o.readOn}T00:00:00Z`))) {
    return { code: 'PL6843', message: 'does not name the https source its prices were read from and the date they were read (readOn, YYYY-MM-DD)' };
  }
  return null;
}

/** `ceil(a / b)` for non-negative bigints. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** S360: the price of the class `input`, and the highest price of any other class (the input price when there is none). */
export function limitPrices(table: Pick<PriceTable, 'perMillionTokens'>): { input: number | null; output: number } {
  const p = table.perMillionTokens;
  const input = Object.hasOwn(p, 'input') ? p.input : null;
  const others = Object.entries(p).filter(([k]) => k !== 'input').map(([, v]) => v);
  return { input, output: others.length ? Math.max(...others) : input ?? 0 };
}

/**
 * PS18.3, S360: a tier's reservation in micro-units: its input token limit at the table's `input` price and its output
 * limit at the highest price of any other class, rounded up once. A table with no `input` class prices the input at its
 * highest price, so the reservation never falls short; the checker refuses such a table for a route (PL1201).
 */
export function reservationOf(maxInputTokens: number, maxTokens: number, table: Pick<PriceTable, 'perMillionTokens'>): number {
  const { input, output } = limitPrices(table);
  const top = Math.max(0, ...Object.values(table.perMillionTokens));
  return Number(ceilDiv(BigInt(maxInputTokens) * BigInt(input ?? top) + BigInt(maxTokens) * BigInt(output), BigInt(MICRO)));
}

/**
 * PS18.3: a call's cost from its provider's usage report, in micro-units: each class at its price, a class the table
 * does not price at the table's highest, rounded up once. `unpriced` names the classes so priced, for the record.
 */
export function costOf(usage: Record<string, number>, table: Pick<PriceTable, 'perMillionTokens'>): { cost: number; unpriced: string[] } {
  const top = Math.max(0, ...Object.values(table.perMillionTokens));
  let sum = 0n;
  const unpriced: string[] = [];
  for (const [k, n] of Object.entries(usage).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isAmount(n)) throw new Error(`the usage of ${k} is ${JSON.stringify(n)}, not a whole number of tokens (K15)`);
    // Review C1 (M11): a class is priced only by the table's own entry, never an inherited property's.
    const price = Object.hasOwn(table.perMillionTokens, k) ? table.perMillionTokens[k] : undefined;
    if (price === undefined) unpriced.push(k);
    sum += BigInt(n) * BigInt(price ?? top);
  }
  return { cost: Number(ceilDiv(sum, BigInt(MICRO))), unpriced };
}
