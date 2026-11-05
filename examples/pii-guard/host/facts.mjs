// The fact table of the pii-guard example (docs/examples/pii-guard.md, "The fact table", S587). It turns the adapter's
// locate answer into one Presence per type, and fails on anything it cannot read: silence is Absent only for a type a
// rule of the preset can find (PG6), a span that carries a value is malformed (PG3), and a dropped span fails the scan,
// since it may hide a rule type that would otherwise read Absent (PG5).
import { readFileSync } from 'node:fs';

/** An Error with a string code, the one way the host fails a fact (PG3, PG5). */
export class FactError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FactError';
    this.code = code;
  }
}

/** Reads host/facts.json; a table without fields or ruledOut is refused. */
export function loadTable(file) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  if (!t || typeof t !== 'object' || !t.fields || typeof t.fields !== 'object' || !t.ruledOut || typeof t.ruledOut !== 'object') {
    throw new Error(`${file}: a fact table has fields and ruledOut`);
  }
  return t;
}

const TOP = new Set(['v', 'id', 'ok', 'dropped', 'spans']);
const SPAN = new Set(['type', 'start', 'end', 'detector', 'detectorId']);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = (n) => Number.isInteger(n) && n >= 0;

function wellFormed(answer) {
  if (Object.keys(answer).some((k) => !TOP.has(k))) return false;
  if (!isCount(answer.dropped)) return false;
  if (!Array.isArray(answer.spans)) return false;
  for (const s of answer.spans) {
    if (!isObject(s) || Object.keys(s).some((k) => !SPAN.has(k))) return false;
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || !(0 <= s.start && s.start < s.end)) return false;
    if (s.detector !== 'rule' && s.detector !== 'model') return false;
  }
  return true;
}

/** One Presence per field of the table, or a FactError whose code is the first condition that holds, in the spec's order. */
export function factsOf(answer, table, preset) {
  if (!isObject(answer) || answer.ok !== true) throw new FactError('not-ok');
  if (!wellFormed(answer)) throw new FactError('malformed');
  if (answer.spans.some((s) => !Object.hasOwn(table.fields, s.type))) throw new FactError('unknown-type');
  if (answer.dropped > 0) throw new FactError('dropped');
  if (!Object.hasOwn(table.ruledOut, preset)) throw new FactError('unknown-preset');
  const found = new Set(answer.spans.map((s) => s.type));
  const ruledOut = new Set(table.ruledOut[preset]);
  const findings = {};
  for (const [type, field] of Object.entries(table.fields)) {
    findings[field] = found.has(type) ? 'Found' : ruledOut.has(type) ? 'Absent' : 'NotRuledOut';
  }
  return findings;
}
