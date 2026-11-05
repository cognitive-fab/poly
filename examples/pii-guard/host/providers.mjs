// The providers of the pii-guard example's three decisions (docs/examples/pii-guard.md, "Host code", S587). scan and
// redact ask the edgepii adapter (live or recorded) and read its answer themselves; recipient asks the host's table. A
// provider that throws fails its decision, so the machine takes ScanFailed, Unredacted or CheckFailed: the guard fails
// closed on anything it cannot read (PG5, PG9). The rules preset is deterministic, so each answer has probability 1 and no
// calibration map (Q2, PD1.6c).
import { factsOf, FactError } from './facts.mjs';

export const SCAN_TYPES = Object.freeze(['SECRET', 'GOV_ID', 'PAYMENT', 'EMAIL', 'PHONE', 'IP_ADDRESS', 'PERSON', 'ORG']);

const SENSITIVE = ['SECRET', 'GOV_ID', 'PAYMENT'];
const PERSONAL = ['PERSON', 'EMAIL', 'PHONE'];

/** The types a redaction masks: the sensitive ones for a mail, and the personal ones too for a model. */
export function redactTypes(target) {
  if (target === 'Mail') return [...SENSITIVE];
  if (target === 'Model') return [...SENSITIVE, ...PERSONAL];
  throw new Error(`no target ${target}`);
}

/** The join of one group: Found when one field is, else NotRuledOut when one is, else Absent (A1). */
function join(findings, fields) {
  const values = fields.map((f) => findings[f]);
  if (values.includes('Found')) return 'Found';
  if (values.some((v) => v !== 'Absent')) return 'NotRuledOut';
  return 'Absent';
}

/** The two facts the program reads, from the fact table's eight (A1). ip and org are in neither. */
export function exposureOf(findings) {
  return { sensitive: join(findings, ['secret', 'govId', 'payment']), personal: join(findings, ['person', 'email', 'phone']) };
}

const reported = (client) => `edgepii-0.3.1/${client.preset}`;

function bodyOf(materials, name) {
  const body = materials?.bodies?.[name];
  if (typeof body !== 'string') throw new Error(`no ${name} body`);
  return body;
}

export function scanProvider(client, table) {
  return async (question, materials) => {
    const started = Date.now();
    const body = bodyOf(materials, 'doc');
    const answer = await client.locate(body, SCAN_TYPES);
    const exposure = exposureOf(factsOf(answer, table, client.preset));
    return { answer: exposure, distribution: [[exposure, 1]], usage: {}, reported: reported(client), latencyMs: Date.now() - started };
  };
}

const REDACT_KEYS = ['v', 'id', 'ok', 'masked', 'redacted', 'recheck'];
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Checks a redact answer itself, never trusting ok alone (PG9). */
function verified(answer, types) {
  if (!isObject(answer)) throw new FactError('malformed');
  const keys = Object.keys(answer);
  if (keys.length !== REDACT_KEYS.length || !REDACT_KEYS.every((k) => keys.includes(k))) throw new FactError('malformed');
  if (answer.ok !== true || typeof answer.masked !== 'string') throw new FactError('malformed');
  const { redacted, recheck } = answer;
  if (!isObject(redacted) || Object.entries(redacted).some(([t, n]) => !types.includes(t) || !Number.isInteger(n) || n < 1)) throw new FactError('malformed');
  if (!isObject(recheck) || !Number.isInteger(recheck.dropped) || recheck.dropped < 0 || !isObject(recheck.found)) throw new FactError('malformed');
  if (recheck.dropped > 0 || Object.keys(recheck.found).length > 0) throw new FactError('recheck');
  return answer.masked;
}

export function redactProvider(client) {
  return async (question, materials) => {
    const started = Date.now();
    const body = bodyOf(materials, 'doc');
    const types = redactTypes(question?.payload?.target);
    const masked = verified(await client.redact(body, types), types);
    return { answer: masked, distribution: [[masked, 1]], usage: {}, reported: reported(client), latencyMs: Date.now() - started };
  };
}

/** Known when the table holds the address; an address it does not hold is new (Q6). */
export function recipientProvider(recipients) {
  return async (question, materials) => {
    const started = Date.now();
    const who = recipients.has(bodyOf(materials, 'to')) ? 'Known' : 'New';
    return { answer: who, distribution: [[who, 1]], usage: {}, reported: 'recipients', latencyMs: Date.now() - started };
  };
}

/** Registers the three providers with a loaded runtime, none with a calibration map (uncalibrated, PD1.6c). */
export function provideGuard(rt, { client, table, recipients }) {
  rt.provide('scan', { provider: scanProvider(client, table), model: reported(client) });
  rt.provide('redact', { provider: redactProvider(client), model: reported(client) });
  rt.provide('recipient', { provider: recipientProvider(recipients), model: 'recipients' });
}
