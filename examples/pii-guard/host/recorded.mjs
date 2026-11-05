// The recorded edgepii adapter of the pii-guard example (docs/examples/pii-guard.md, "The recorded adapter", S587). It
// answers what the real adapter answered for each sample, as host/record.mjs wrote it, and a `fault` changes every answer
// so that each way a scan or a redaction can fail is reached without Python. `calls` keeps the op and the types, never a
// text. With `hold`, a redaction stays in flight until the test releases it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactError } from './facts.mjs';

const SAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

/** The fixture of recorded answers. */
export function loadRecorded(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || typeof f !== 'object' || !f.hello || !Array.isArray(f.documents)) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const sameTypes = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

function faultLocate(answer, fault) {
  const a = clone(answer);
  if (fault === 'malformed') delete a.spans;
  if (fault === 'text') for (const s of a.spans) s.text = 'x';
  if (fault === 'unknown-type') a.spans.push({ type: 'USERNAME', start: 0, end: 1, detector: 'rule', detectorId: 'rules.username' });
  if (fault === 'dropped') a.dropped = 1;
  return a;
}

function faultRedact(answer, fault) {
  const a = clone(answer);
  if (fault === 'recheck-found') a.recheck.found = { EMAIL: 1 };
  if (fault === 'recheck-dropped') a.recheck.dropped = 1;
  return a;
}

const REJECTS = new Set(['missing', 'timeout', 'not-ok']);

export function recordedAdapter(fixture, { preset = 'rules', samplesDir = SAMPLES, fault, hold = false } = {}) {
  const byText = new Map(fixture.documents.map((d) => [readFileSync(join(samplesDir, d.file), 'utf8'), d]));
  const calls = [];
  const held = [];
  const entryOf = (text) => {
    const d = byText.get(text);
    if (!d) throw new FactError('missing', 'no recorded answer for this text');
    return d;
  };
  return {
    preset,
    calls,
    locate: async (text, types) => {
      calls.push({ op: 'locate', types: [...types] });
      if (REJECTS.has(fault)) throw new FactError(fault);
      return faultLocate(entryOf(text).locate, fault);
    },
    redact: (text, types) => {
      calls.push({ op: 'redact', types: [...types] });
      const answer = () => {
        if (REJECTS.has(fault)) throw new FactError(fault);
        const r = entryOf(text).redact.find((x) => sameTypes(x.types, types));
        if (!r) throw new FactError('missing', 'no recorded redaction for these types');
        return faultRedact(r.answer, fault);
      };
      if (!hold) return (async () => answer())();
      return new Promise((resolveCall, rejectCall) => held.push(() => {
        try { resolveCall(answer()); } catch (e) { rejectCall(e); }
      }));
    },
    release: () => { for (const settle of held.splice(0)) settle(); },
    close: () => {},
  };
}
