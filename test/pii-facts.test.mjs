// pii-guard host code with no Python: the fact table, the providers over the recorded adapter, the adapter client's
// refusals, the recipient table and the skip message. Written from docs/examples/pii-guard.md alone, before any code
// exists (rule 7a). Covers PG3 (a key outside the protocol is refused), PG4 (an adapter.py whose digest differs from the
// pin is refused before any process starts), PG5 (each scan failure fails the scan), PG6 (a type a model finds or no rule
// can find is never Absent), PG9 (a failed re-check fails the redaction), PG10 (the recipient table) and PG12 (the skip
// message when the adapter is absent). As amended by A1: the scan answers the Exposure, exposureOf of the Findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const EX_DIR = join(ROOT, 'examples', 'pii-guard');
const HOST = join(EX_DIR, 'host');
const SAMPLES = join(EX_DIR, 'samples');
const ANSWERS = join(EX_DIR, 'recorded', 'answers.json');
const PIN = join(ROOT, 'examples', 'pii-guard', 'adapter', 'PIN.json');
const TMP = mkdtempSync(join(tmpdir(), 'poly-pii-facts-'));

const host = (file) => import(pathToFileURL(join(HOST, file)).href);
const TYPES = ['SECRET', 'GOV_ID', 'PAYMENT', 'EMAIL', 'PHONE', 'IP_ADDRESS', 'PERSON', 'ORG'];
const FIELD = { SECRET: 'secret', GOV_ID: 'govId', PAYMENT: 'payment', EMAIL: 'email', PHONE: 'phone', IP_ADDRESS: 'ip', PERSON: 'person', ORG: 'org' };
const RULE_TYPES = ['SECRET', 'PAYMENT', 'EMAIL', 'PHONE', 'IP_ADDRESS'];
const SAMPLE_FILES = ['en-model.txt', 'en-mail.txt', 'en-ids.txt', 'fr-model.txt', 'fr-mail.txt', 'clean.txt'];
// A sample with spans: the `text` fault adds a key to each span, so it shows only where there is a span.
const WITH_SPANS = 'en-model.txt';

async function modules() {
  const facts = await host('facts.mjs');
  const providers = await host('providers.mjs');
  const recorded = await host('recorded.mjs');
  const table = facts.loadTable(join(HOST, 'facts.json'));
  const fixture = recorded.loadRecorded(ANSWERS);
  return { ...facts, ...providers, ...recorded, table, fixture };
}

const sample = (file) => readFileSync(join(SAMPLES, file), 'utf8');
const docOf = (fixture, file) => { const d = fixture.documents.find((x) => x.file === file); assert.ok(d, `the fixture records ${file}`); return d; };
const sameTypes = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const clone = (x) => JSON.parse(JSON.stringify(x));
const noId = (x) => { const { id, ...rest } = x ?? {}; void id; return rest; };

/** The error a call throws or rejects with. Codes are compared, not classes: a FactError is an Error with a string code. */
async function failure(fn) {
  try { await fn(); } catch (e) { return e; }
  assert.fail('the call must fail');
}

// ── the table and its loader ──

test('facts.json is the table the spec gives; loadTable throws when fields or ruledOut is missing', async () => {
  const { loadTable } = await host('facts.mjs');
  const t = loadTable(join(HOST, 'facts.json'));
  assert.equal(t.taxonomy, '2026.11');
  assert.deepEqual(t.fields, FIELD);
  assert.deepEqual(t.ruledOut, { rules: RULE_TYPES, 'multi-open': RULE_TYPES });
  // PG6: GOV_ID, PERSON and ORG are ruled out by no preset.
  for (const p of Object.keys(t.ruledOut)) for (const ty of ['GOV_ID', 'PERSON', 'ORG']) assert.ok(!t.ruledOut[p].includes(ty), `${p} does not rule out ${ty}`);
  for (const drop of ['fields', 'ruledOut']) {
    const bad = clone(t);
    delete bad[drop];
    const file = join(TMP, `facts-no-${drop}.json`);
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadTable(file), `a table without ${drop} is refused`);
  }
});

// ── factsOf (PG3, PG5, PG6) ──

/** The findings the spec's rule gives for an answer's spans under a preset. */
function expectedFindings(spans, preset, table) {
  const out = {};
  for (const [type, field] of Object.entries(table.fields)) {
    out[field] = spans.some((s) => s.type === type) ? 'Found' : table.ruledOut[preset].includes(type) ? 'Absent' : 'NotRuledOut';
  }
  return out;
}

test('PG6: factsOf on each recorded locate answer: Found for a type with a span, Absent for a rule type without, NotRuledOut otherwise', async () => {
  const { factsOf, table, fixture } = await modules();
  for (const file of SAMPLE_FILES) docOf(fixture, file);
  for (const d of fixture.documents) {
    if (d.locate?.ok !== true) continue;
    const f = factsOf(d.locate, table, 'rules');
    assert.deepEqual(f, expectedFindings(d.locate.spans, 'rules', table), `${d.file}`);
    // Under rules, GOV_ID and PERSON are never found, so they are never Absent.
    assert.equal(f.govId, 'NotRuledOut', `${d.file}: govId`);
    assert.equal(f.person, 'NotRuledOut', `${d.file}: person`);
  }
});

test('PG6: a span of each type gives Found; no span gives Absent for the five rule types and NotRuledOut for GOV_ID, PERSON and ORG', async () => {
  const { factsOf, table, fixture } = await modules();
  const base = clone(docOf(fixture, WITH_SPANS).locate);
  assert.equal(base.ok, true);
  const shape = base.spans[0];
  assert.ok(shape, `${WITH_SPANS} has a recorded span to copy`);
  for (const preset of ['rules', 'multi-open']) {
    for (const type of TYPES) {
      const a = { ...clone(base), spans: [{ ...shape, type }] };
      assert.equal(factsOf(a, table, preset)[FIELD[type]], 'Found', `${preset}: a ${type} span`);
    }
    const none = factsOf({ ...clone(base), spans: [] }, table, preset);
    for (const type of RULE_TYPES) assert.equal(none[FIELD[type]], 'Absent', `${preset}: no ${type} span`);
    for (const type of ['GOV_ID', 'PERSON', 'ORG']) assert.equal(none[FIELD[type]], 'NotRuledOut', `${preset}: no ${type} span`);
    assert.deepEqual(Object.keys(none).sort(), Object.values(FIELD).sort(), 'a Findings record has the eight fields');
  }
});

test('PG6: a span a model finds of a rule type gives Found', async () => {
  const { factsOf, table, fixture } = await modules();
  const base = clone(docOf(fixture, WITH_SPANS).locate);
  const span = { ...base.spans[0], type: 'EMAIL', detector: 'model', detectorId: 'gliner2' };
  for (const preset of ['rules', 'multi-open']) {
    const f = factsOf({ ...base, spans: [span] }, table, preset);
    assert.equal(f.email, 'Found');
    // The other rule types stay Absent; the model lane's silence on PERSON is not proof.
    assert.equal(f.phone, 'Absent');
    assert.equal(f.person, 'NotRuledOut');
  }
});

test('PG3, PG5: each row of the error table gives its code, in the table\'s order', async () => {
  const { factsOf, table, fixture } = await modules();
  const base = clone(docOf(fixture, WITH_SPANS).locate);
  const span = base.spans[0];
  const a = (over) => ({ ...clone(base), ...over });
  const s = (over) => a({ spans: [{ ...span, ...over }] });
  const noKey = (k) => { const x = { ...span }; delete x[k]; return a({ spans: [x] }); };
  const rows = [
    ['not-ok', null], ['not-ok', 'text'], ['not-ok', 7], ['not-ok', a({ ok: false })], ['not-ok', a({ ok: 'true' })],
    ['malformed', a({ text: 'x' })], ['malformed', a({ masked: 'x' })],
    ['malformed', a({ dropped: -1 })], ['malformed', a({ dropped: 1.5 })], ['malformed', a({ dropped: '0' })],
    ['malformed', (() => { const x = clone(base); delete x.spans; return x; })()], ['malformed', a({ spans: {} })],
    // PG3: a span with text, raw_label or a score is malformed.
    ['malformed', s({ text: 'x' })], ['malformed', s({ raw_label: 'email' })], ['malformed', s({ score: 0.9 })],
    ['malformed', s({ start: -1 })], ['malformed', s({ start: 4, end: 4 })], ['malformed', s({ start: 5, end: 4 })],
    ['malformed', s({ start: 1.5 })], ['malformed', s({ end: '9' })], ['malformed', noKey('start')],
    ['malformed', s({ detector: 'regex' })],
    ['unknown-type', s({ type: 'USERNAME' })],
    ['dropped', a({ dropped: 1 })],
  ];
  for (const [code, answer] of rows) {
    const e = await failure(() => factsOf(answer, table, 'rules'));
    assert.ok(e instanceof Error, 'a FactError is an Error');
    assert.equal(e.code, code, `${JSON.stringify(answer)} gives ${code}; got ${e.code}`);
  }
  assert.equal((await failure(() => factsOf(clone(base), table, 'no-such-preset'))).code, 'unknown-preset');
  // The order: not-ok before malformed, malformed before unknown-type, unknown-type before dropped, dropped before
  // unknown-preset.
  assert.equal((await failure(() => factsOf({ ...a({ ok: false }), spans: 'x' }, table, 'rules'))).code, 'not-ok');
  assert.equal((await failure(() => factsOf(s({ type: 'USERNAME', text: 'x' }), table, 'rules'))).code, 'malformed');
  assert.equal((await failure(() => factsOf({ ...s({ type: 'USERNAME' }), dropped: 1 }, table, 'rules'))).code, 'unknown-type');
  assert.equal((await failure(() => factsOf(a({ dropped: 1 }), table, 'no-such-preset'))).code, 'dropped');
});

// ── the exposure (A1, PG6) ──

const PRESENCES = ['Absent', 'Found', 'NotRuledOut'];
/** The spec's join of one group: Found when one field is, else NotRuledOut when one is, else Absent. */
const join3 = (xs) => (xs.includes('Found') ? 'Found' : xs.includes('NotRuledOut') ? 'NotRuledOut' : 'Absent');

test('PG6: exposureOf joins secret, govId and payment into sensitive, and person, email and phone into personal; ip and org change nothing', async () => {
  const { exposureOf } = await host('providers.mjs');
  const triples = PRESENCES.flatMap((a) => PRESENCES.flatMap((b) => PRESENCES.map((c) => [a, b, c])));
  for (const [secret, govId, payment] of triples) {
    for (const [person, email, phone] of triples) {
      for (const [ip, org] of [['Absent', 'Absent'], ['Found', 'Found'], ['NotRuledOut', 'Found'], ['Found', 'NotRuledOut']]) {
        const findings = { secret, govId, payment, email, phone, ip, person, org };
        assert.deepEqual(exposureOf(findings), { sensitive: join3([secret, govId, payment]), personal: join3([person, email, phone]) }, JSON.stringify(findings));
      }
    }
  }
});

// ── the providers over the recorded adapter (PG3, PG5, PG9) ──

test('SCAN_TYPES and redactTypes are the spec\'s lists; any other target throws', async () => {
  const { SCAN_TYPES, redactTypes } = await host('providers.mjs');
  assert.deepEqual(SCAN_TYPES, TYPES);
  assert.deepEqual(redactTypes('Mail'), ['SECRET', 'GOV_ID', 'PAYMENT']);
  assert.deepEqual(redactTypes('Model'), ['SECRET', 'GOV_ID', 'PAYMENT', 'PERSON', 'EMAIL', 'PHONE']);
  for (const t of ['mail', 'Phone', '', undefined]) assert.throws(() => redactTypes(t), `${t} is refused`);
});

test('the recorded fixture: one locate per sample with SCAN_TYPES and one redact per target, and no span text', async () => {
  const { fixture, redactTypes } = await modules();
  assert.ok(fixture.hello && fixture.hello.ok === true, 'the fixture holds the hello answer');
  assert.equal(fixture.hello.preset, 'rules', 'the fixture is written with the rules preset');
  for (const file of SAMPLE_FILES) {
    const d = docOf(fixture, file);
    assert.ok(d.locate, `${file}: one locate`);
    for (const target of ['Mail', 'Model']) assert.equal(d.redact.filter((r) => sameTypes(r.types, redactTypes(target))).length, 1, `${file}: one redact for ${target}`);
    for (const sp of d.locate.spans ?? []) assert.deepEqual(Object.keys(sp).sort(), ['detector', 'detectorId', 'end', 'start', 'type'], `${file}: a span holds no text`);
  }
});

test('the recorded adapter: calls record op and types only; another text rejects missing; hold keeps redact pending until release', async () => {
  const { recordedAdapter, fixture, SCAN_TYPES, redactTypes } = await modules();
  const c = recordedAdapter(fixture, { samplesDir: SAMPLES });
  assert.equal(c.preset, 'rules');
  const text = sample(WITH_SPANS);
  const live = await c.locate(text, SCAN_TYPES);
  // The request id is the connection's counter, which the spec leaves to the client: answers are compared without it.
  assert.deepEqual(noId(live), noId(docOf(fixture, WITH_SPANS).locate));
  assert.equal((await failure(() => c.locate('a text that is no sample', SCAN_TYPES))).code, 'missing');
  for (const call of c.calls) assert.deepEqual(Object.keys(call).sort(), ['op', 'types'], 'a call holds no text');
  assert.deepEqual(c.calls[0], { op: 'locate', types: SCAN_TYPES });
  // hold: a redact stays pending until release(); a locate is never held.
  const h = recordedAdapter(fixture, { samplesDir: SAMPLES, hold: true });
  let settled = false;
  const pending = h.redact(text, redactTypes('Model')).then((x) => { settled = true; return x; });
  assert.deepEqual(noId(await h.locate(text, SCAN_TYPES)), noId(docOf(fixture, WITH_SPANS).locate), 'locate answers while a redact is held');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, 'the redact is held');
  h.release();
  const expected = docOf(fixture, WITH_SPANS).redact.find((r) => sameTypes(r.types, redactTypes('Model'))).answer;
  assert.deepEqual(noId(await pending), noId(expected));
});

const question = (decision, payload = {}) => ({ decision, payload });

test('PG5, PG6: scanProvider answers the exposure of the recorded findings for each sample, never Absent under rules, with probability 1', async () => {
  const { scanProvider, recordedAdapter, factsOf, exposureOf, table, fixture, SCAN_TYPES } = await modules();
  for (const file of SAMPLE_FILES) {
    const client = recordedAdapter(fixture, { samplesDir: SAMPLES });
    const provider = scanProvider(client, table);
    const recorded = docOf(fixture, file).locate;
    if (recorded.ok !== true) {
      await failure(() => provider(question('scan'), { bodies: { doc: sample(file) } }));
      continue;
    }
    const r = await provider(question('scan'), { bodies: { doc: sample(file) } });
    const exposure = exposureOf(factsOf(recorded, table, 'rules'));
    assert.deepEqual(r.answer, exposure, file);
    // Under rules, govId and person are never Absent, so neither group is.
    assert.notEqual(r.answer.sensitive, 'Absent', `${file}: sensitive`);
    assert.notEqual(r.answer.personal, 'Absent', `${file}: personal`);
    assert.deepEqual(r.distribution, [[exposure, 1]], `${file}: one answer, probability 1 (Q2)`);
    assert.deepEqual(r.usage, {});
    assert.equal(r.reported, 'edgepii-0.3.1/rules');
    assert.equal(typeof r.latencyMs, 'number');
    assert.deepEqual(client.calls, [{ op: 'locate', types: SCAN_TYPES }], `${file}: one locate with SCAN_TYPES, no text`);
  }
  // No document to read fails the scan.
  const provider = scanProvider(recordedAdapter(fixture, { samplesDir: SAMPLES }), table);
  await failure(() => provider(question('scan'), { bodies: {} }));
});

test('PG3, PG5: scanProvider fails for every fault but recheck-found and recheck-dropped, which change only a redact answer', async () => {
  const { scanProvider, recordedAdapter, factsOf, exposureOf, table, fixture } = await modules();
  const doc = { bodies: { doc: sample(WITH_SPANS) } };
  // A fault in the answer reaches factsOf, whose code the spec fixes; a failed call is asserted to fail only.
  const failing = { missing: null, timeout: null, 'not-ok': null, malformed: 'malformed', text: 'malformed', 'unknown-type': 'unknown-type', dropped: 'dropped' };
  for (const [fault, code] of Object.entries(failing)) {
    const provider = scanProvider(recordedAdapter(fixture, { samplesDir: SAMPLES, fault }), table);
    const e = await failure(() => provider(question('scan'), doc));
    if (code) assert.equal(e.code, code, `${fault} fails the scan with ${code}; got ${e.code}`);
  }
  for (const fault of ['recheck-found', 'recheck-dropped']) {
    const provider = scanProvider(recordedAdapter(fixture, { samplesDir: SAMPLES, fault }), table);
    const r = await provider(question('scan'), doc);
    assert.deepEqual(r.answer, exposureOf(factsOf(docOf(fixture, WITH_SPANS).locate, table, 'rules')), `${fault} leaves the scan alone`);
  }
});

/** Whether a recorded redact answer passes the provider's own check (the redaction contract). */
const verified = (ans) => ans?.ok === true && ans.recheck?.dropped === 0 && Object.keys(ans.recheck?.found ?? { x: 1 }).length === 0;

test('PG9: redactProvider answers the masked text for each sample and target, asking for redactTypes of the payload\'s target', async () => {
  const { redactProvider, recordedAdapter, fixture, redactTypes } = await modules();
  for (const file of SAMPLE_FILES) {
    for (const target of ['Mail', 'Model']) {
      const client = recordedAdapter(fixture, { samplesDir: SAMPLES });
      const provider = redactProvider(client);
      const entry = docOf(fixture, file).redact.find((r) => sameTypes(r.types, redactTypes(target)));
      const materials = { bodies: { doc: sample(file) } };
      if (!verified(entry.answer)) {
        await failure(() => provider(question('redact', { target }), materials));
        continue;
      }
      const r = await provider(question('redact', { target }), materials);
      assert.equal(r.answer, entry.answer.masked, `${file} for ${target}`);
      assert.deepEqual(r.distribution, [[entry.answer.masked, 1]]);
      assert.deepEqual(r.usage, {});
      assert.equal(r.reported, 'edgepii-0.3.1/rules');
      assert.equal(typeof r.latencyMs, 'number');
      assert.deepEqual(client.calls, [{ op: 'redact', types: redactTypes(target) }], `${file}: the target's types, no text`);
    }
  }
  const provider = redactProvider(recordedAdapter(fixture, { samplesDir: SAMPLES }));
  await failure(() => provider(question('redact', { target: 'Model' }), { bodies: {} }));
});

test('PG9: redactProvider fails for recheck-found and recheck-dropped (code recheck) and for each failing call; a locate fault leaves it alone', async () => {
  const { redactProvider, recordedAdapter, fixture, redactTypes } = await modules();
  const materials = { bodies: { doc: sample(WITH_SPANS) } };
  const entry = docOf(fixture, WITH_SPANS).redact.find((r) => sameTypes(r.types, redactTypes('Model')));
  assert.ok(verified(entry.answer), `the recorded redaction of ${WITH_SPANS} for Model is verified`);
  for (const fault of ['recheck-found', 'recheck-dropped']) {
    const provider = redactProvider(recordedAdapter(fixture, { samplesDir: SAMPLES, fault }));
    assert.equal((await failure(() => provider(question('redact', { target: 'Model' }), materials))).code, 'recheck', fault);
  }
  for (const fault of ['missing', 'timeout', 'not-ok']) {
    const provider = redactProvider(recordedAdapter(fixture, { samplesDir: SAMPLES, fault }));
    await failure(() => provider(question('redact', { target: 'Model' }), materials));
  }
  for (const fault of ['malformed', 'text', 'unknown-type', 'dropped']) {
    const provider = redactProvider(recordedAdapter(fixture, { samplesDir: SAMPLES, fault }));
    assert.equal((await provider(question('redact', { target: 'Model' }), materials)).answer, entry.answer.masked, `${fault} changes only a locate answer`);
  }
});

test('PG3: redactProvider checks the answer itself and refuses a key outside the protocol or a count it did not ask for', async () => {
  const { redactProvider, fixture, redactTypes } = await modules();
  const entry = docOf(fixture, WITH_SPANS).redact.find((r) => sameTypes(r.types, redactTypes('Model')));
  // A client stand-in that answers one given object: the provider never trusts ok alone.
  const stub = (answer) => ({ preset: 'rules', calls: [], locate: async () => { throw new Error('not used'); }, redact: async () => answer, close: async () => {} });
  const materials = { bodies: { doc: sample(WITH_SPANS) } };
  const bad = [
    { ...clone(entry.answer), vault: {} },
    { ...clone(entry.answer), text: 'x' },
    { ...clone(entry.answer), masked: 7 },
    { ...clone(entry.answer), redacted: { USERNAME: 1 } },
    { ...clone(entry.answer), redacted: { EMAIL: 0 } },
  ];
  for (const answer of bad) {
    const e = await failure(() => redactProvider(stub(answer))(question('redact', { target: 'Model' }), materials));
    assert.equal(e.code, 'malformed', JSON.stringify(Object.keys(answer)));
  }
  // A Mail redaction answering a count for EMAIL, which Mail did not ask for, is malformed.
  const mail = { ...clone(entry.answer), redacted: { EMAIL: 1 } };
  assert.equal((await failure(() => redactProvider(stub(mail))(question('redact', { target: 'Mail' }), materials))).code, 'malformed');
});

test('PG10: recipientProvider answers Known for an address in the table and New otherwise', async () => {
  const { recipientProvider } = await host('providers.mjs');
  const { recipientTable } = await host('recipients.mjs');
  const t = recipientTable('test-key-recipients');
  t.add('kept@mail.example');
  const p = recipientProvider(t);
  const ask = async (to) => (await p(question('recipient'), { bodies: { to } })).answer;
  assert.equal(await ask('kept@mail.example'), 'Known');
  assert.equal(await ask('other@mail.example'), 'New');
});

// ── the adapter client's refusals (PG4, PG12) ──

/** A script that, if a process ever ran it under node, would write a marker file. */
function markerScript() {
  const dir = mkdtempSync(join(TMP, 'script-'));
  const marker = join(dir, 'ran.marker');
  const script = join(dir, 'adapter.js');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const digest = `sha256:${createHash('sha256').update(readFileSync(script)).digest('hex')}`;
  return { dir, marker, script, digest };
}

test('PG4: startAdapter with a pin.adapter that differs from the script\'s digest rejects pin-mismatch and starts no process', async () => {
  const { startAdapter, loadPin } = await host('edgepii.mjs');
  const pin = loadPin(PIN);
  const { marker, script, digest } = markerScript();
  const other = { ...pin, adapter: `sha256:${'0'.repeat(64)}` };
  assert.notEqual(other.adapter, digest);
  // The python is node itself: had a process started, it would have run the script and written the marker.
  const e = await failure(() => startAdapter({ python: process.execPath, script, pin: other, preset: 'rules', timeoutMs: 2000 }));
  assert.equal(e.code, 'pin-mismatch');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(marker), false, 'no process ran the script');
});

test('PG4: startAdapter with a python that does not exist rejects missing', async () => {
  const { startAdapter, loadPin } = await host('edgepii.mjs');
  const { dir, script, digest } = markerScript();
  const pin = { ...loadPin(PIN), adapter: digest };
  const e = await failure(() => startAdapter({ python: join(dir, 'no-python', 'python.exe'), script, pin, preset: 'rules', timeoutMs: 2000 }));
  assert.equal(e.code, 'missing');
});

test('PG12: adapterStatus with a missing python gives the exact skip message', async () => {
  const { adapterStatus, loadPin } = await host('edgepii.mjs');
  const python = join(TMP, 'no-venv', 'Scripts', 'python.exe');
  const s = await adapterStatus({ python, pin: loadPin(PIN), preset: 'rules' });
  assert.deepEqual(s, { ok: false, reason: `not run: edgepii 0.3.1 is not installed at ${python}; run node examples/pii-guard/adapter/setup.mjs` });
});

test('loadPin reads PIN.json and throws when a field is missing; defaultPython takes POLY_EDGEPII_PYTHON when set', async () => {
  const { loadPin, defaultPython } = await host('edgepii.mjs');
  const pin = loadPin(PIN);
  assert.equal(pin.edgepii, '0.3.1');
  assert.equal(pin.wheel, 'sha256:620f9b3c47491e337dc51d2265480625e743563de42e7ff9b324827853e2b52f');
  assert.equal(pin.source, 'sha256:66137817a819d6fd751d5c2f0453a4a1cb648dd1bde29b36145da1cff80d65a9');
  assert.equal(pin.taxonomy, '2026.11');
  assert.match(pin.adapter, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(pin.presets.rules, { revision: 'rules', detectors: ['rules'] });
  assert.deepEqual(pin.presets['multi-open'], { revision: '1cb4166094dc58fa8d836429f060d6c95f62b495', detectors: ['rules', 'gliner2'], repo: 'fastino/gliner2-privacy-filter-PII-multi' });
  for (const field of ['edgepii', 'wheel', 'source', 'taxonomy', 'adapter', 'presets']) {
    const bad = clone(pin);
    delete bad[field];
    const file = join(TMP, `pin-no-${field}.json`);
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadPin(file), `a pin without ${field} is refused`);
  }
  const before = process.env.POLY_EDGEPII_PYTHON;
  try {
    process.env.POLY_EDGEPII_PYTHON = join(TMP, 'chosen-python');
    assert.equal(defaultPython(), join(TMP, 'chosen-python'));
  } finally {
    if (before === undefined) delete process.env.POLY_EDGEPII_PYTHON; else process.env.POLY_EDGEPII_PYTHON = before;
  }
});

// ── the recipient table (PG10, Q6) ──

test('PG10: recipientTable: has after add, case and surrounding space ignored; digests() holds no address; two keys differ', async () => {
  const { recipientTable } = await host('recipients.mjs');
  const address = 'Reader.One@Mail.Example';
  const t = recipientTable('key-one');
  assert.equal(t.has(address), false);
  t.add(`  ${address}\t`);
  assert.equal(t.has(address.toLowerCase()), true);
  assert.equal(t.has(` ${address.toUpperCase()} `), true);
  assert.equal(t.has('reader.two@mail.example'), false);
  const digests = t.digests();
  const expected = createHmac('sha256', 'key-one').update(address.trim().toLowerCase()).digest('hex');
  assert.deepEqual(digests, [expected], 'the address is held only as the lowercase hex HMAC-SHA256 of its normal form');
  const json = JSON.stringify(digests);
  assert.ok(!json.includes(address) && !json.includes(address.toLowerCase()), 'no address in the digests');
  // A host keeps the digests, and a table built from them knows the address.
  assert.equal(recipientTable('key-one', digests).has(address), true);
  // Two keys give different digests.
  const u = recipientTable('key-two');
  u.add(address);
  assert.notDeepEqual(u.digests(), digests);
  assert.equal(recipientTable('key-two', digests).has(address), false);
  // digests() is sorted.
  t.add('aaa@mail.example');
  t.add('zzz@mail.example');
  const all = t.digests();
  assert.deepEqual(all, [...all].sort());
});
