// pii-guard end to end (serial): admission and runs over the recorded adapter, a recorded egress and rt.putContent for
// documents. Written from docs/examples/pii-guard.md alone, before any code exists (rule 7a). No test calls a model, a
// mail server or the network; completions are dispatched by the runtime, never by hand. Covers PG4 and PG5 (a failed
// scan ends in scan Failed and no send), PG7 (a sensitive type leaves only through a verified redaction, and the gate
// denies the defect's early mail), PG8 (a model call is redacted first, the name left in as the README's limits state),
// PG9 (a failed re-check ends in RedactFailed and no send), PG10 (a new recipient is escalated, sent after a person's
// approval, then known), PG11 (no value in the journal) and PG12 (the real adapter, skipped with its reason). As
// amended by A1: the drafts take body and address, the state holds sensitive and personal, Redacted writes doc, and a
// Send that may not send writes held and stays Open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit, replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { acceptFindings, admitExample, loadExample, recordingEgress, settle } from '../ex-kit.mjs';
import { approvalFor, makeKey, project, signPolicies } from '../runtime-helpers.mjs';

const EX_DIR = join(ROOT, 'examples', 'pii-guard');
const HOST = join(EX_DIR, 'host');
const SAMPLES = join(EX_DIR, 'samples');
const ANSWERS = join(EX_DIR, 'recorded', 'answers.json');
const ADAPTER = join(ROOT, 'adapters', 'edgepii', 'adapter.py');
const PIN_FILE = join(ROOT, 'adapters', 'edgepii', 'PIN.json');
const MACHINE = 'pii.Outbound';
const MODEL_URL = 'https://model.example/v1/complete';
const MAIL_URL = 'https://mail.example/v1/send';
const RECIPIENT_KEY = 'test-recipient-key';
// Synthetic addresses, none of them in a sample.
const KNOWN = 'Known.Reader@Mail.Example';
const NEW_ADDRESS = 'new.reader@mail.example';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('pii-guard'));

/**
 * The defect admitted with the program's policy. Its PL3002 is the machine's whatever the policy, so it is admitted
 * only as an owner who accepted the finding would run it (PT12.5), on the pattern of the pr-reviewer's test.
 */
let cachedDefect;
const admittedDefect = () => (cachedDefect ??= (async () => {
  const key = makeKey('ex-pii-guard-defect');
  const p = project('ex-pii-guard-defect', [], key, 'test-examples-e2e');
  copyFileSync(join(EX_DIR, 'pii-guard-defect.poly'), join(p, 'src', 'pii-guard-defect.poly'));
  copyFileSync(join(EX_DIR, 'pii-guard.policy.poly'), join(p, 'src', 'pii-guard.policy.poly'));
  copyFileSync(join(HOST, 'handlers.ts'), join(p, 'src', 'handlers.ts'));
  await signPolicies(p);
  const accepted = await acceptFindings(p);
  const r = await admit(p);
  return { dir: p, key, build: join(p, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report, accepted };
})());

async function hostModules() {
  const imp = (f) => import(pathToFileURL(join(HOST, f)).href);
  const facts = await imp('facts.mjs');
  const providers = await imp('providers.mjs');
  const recorded = await imp('recorded.mjs');
  const recipients = await imp('recipients.mjs');
  return { ...facts, ...providers, ...recorded, ...recipients, table: facts.loadTable(join(HOST, 'facts.json')), fixture: recorded.loadRecorded(ANSWERS) };
}

const sample = (file) => readFileSync(join(SAMPLES, file), 'utf8');
const gold = () => JSON.parse(readFileSync(join(SAMPLES, 'gold.json'), 'utf8'));
/** The values the gold marks in a sample, by type. Offsets are code points; the samples keep to the BMP. */
const goldValues = (file, types = null) => {
  const text = sample(file);
  return gold()[file].spans.filter((s) => !types || types.includes(s.type)).map((s) => ({ type: s.type, value: text.slice(s.start, s.end) }));
};
const sameTypes = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const maskedOf = (h, file, target) => h.fixture.documents.find((d) => d.file === file).redact.find((r) => sameTypes(r.types, h.redactTypes(target))).answer.masked;
const bodyOf = (req) => (typeof req.body === 'string' ? JSON.parse(req.body) : req.body);

/**
 * A loaded runtime with the guard's providers over `client` (the recorded adapter by default) and the certified
 * handlers. The test plays the host: it owns the recipient table.
 */
async function start(a, { fault, hold = false, recipients, client } = {}) {
  const h = await hostModules();
  const egress = recordingEgress();
  const { rt } = await loadExample(a, { transports: egress.transports });
  const c = client ?? h.recordedAdapter(h.fixture, { samplesDir: SAMPLES, fault, hold });
  const table = recipients ?? h.recipientTable(RECIPIENT_KEY);
  h.provideGuard(rt, { client: c, table: h.table, recipients: table });
  const handlers = rt.handlerExports('src/handlers.ts');
  rt.handle('model.call', handlers.callModel);
  rt.handle('mail.send', handlers.sendMail);
  return { rt, egress, client: c, recipients: table, h, ids: [] };
}

async function stop(run) {
  if (!run) return;
  // A held redaction is released so that nothing stays pending after the runtime closes.
  run.client?.release?.();
  await run.rt.close();
}

let counter = 0;
/**
 * Creates an instance and dispatches DraftModel(body) or DraftMail(body, address) over a sample, the bodies stored with
 * rt.putContent (A1: the parameters are body and address; the decisions keep doc and to).
 */
async function draft(run, action, file, address) {
  const id = `pii-${process.pid}-${++counter}`;
  await run.rt.create(MACHINE, { id });
  run.ids.push(id);
  const data = { body: await run.rt.putContent(sample(file)) };
  if (address !== undefined) data.address = await run.rt.putContent(address);
  assert.equal((await run.rt.dispatch(id, action, data)).stepKind, 'accepted', `${action} is accepted`);
  return id;
}

const stateOf = async (run, id) => (await run.rt.getState(id)).state;

/** Settles until `pred` holds of the instance's state, a bounded number of rounds; returns the last state. */
async function settleUntil(run, id, pred, rounds = 40) {
  let s;
  for (let k = 0; k < rounds; k++) {
    await settle(run.rt, 5);
    s = await stateOf(run, id);
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s;
}

// The decisions a draft issues have all completed.
const decided = (s) => s.scan !== 'Pending' && s.redaction !== 'Redacting' && (s.target !== 'Mail' || s.recipient !== 'Unchecked');
// The scan and the recipient have completed while the redaction is held.
const heldRedacting = (s) => s.scan === 'Done' && s.redaction === 'Redacting' && (s.target !== 'Mail' || s.recipient !== 'Unchecked');

async function send(run, id) {
  assert.equal((await run.rt.dispatch(id, 'Send', {})).stepKind, 'accepted', 'Send is accepted from Open');
}

const verdicts = async (run, id, outcome) => (await run.rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.effectKind === 'mail.send' && e.body.outcome === outcome);

/**
 * PG11: no run leaves in the journal a value the gold marks in the samples it used, or a recipient address; nor a
 * sample's body or its masked text, which are only in the content store. Each is looked for raw and JSON-escaped, since
 * the journal's JSON writes a newline as \n.
 */
async function noValues(run, files, addresses = []) {
  const values = files.flatMap((f) => goldValues(f).map((v) => ({ what: `a ${v.type} value of ${f}`, value: v.value })));
  assert.ok(values.length > 0, 'the gold marks values in the samples used');
  for (const f of files) {
    values.push({ what: `the body of ${f}`, value: sample(f) });
    for (const target of ['Mail', 'Model']) {
      const masked = maskedOf(run.h, f, target);
      if (typeof masked === 'string') values.push({ what: `the masked text of ${f} for ${target}`, value: masked });
    }
  }
  for (const a of addresses) values.push({ what: 'a recipient address', value: a }, { what: 'a recipient address', value: a.toLowerCase() });
  const forms = (v) => [v, JSON.stringify(v).slice(1, -1)];
  for (const id of run.ids) {
    const json = JSON.stringify(await run.rt.chain(id));
    for (const v of values) for (const form of forms(v.value)) assert.ok(!json.includes(form), `${id}: the journal holds ${v.what}`);
  }
}

// ── admission ──

test('pii-guard: the program with its policy admits CLEAN', { timeout: 300_000 }, async () => {
  const a = await admitted();
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('pii-guard: the defect admits with the program\'s policy once its PL3002 is accepted', { timeout: 300_000 }, async () => {
  const a = await admittedDefect();
  assert.deepEqual(a.accepted, ['PL3002'], 'the one finding accepted is PL3002');
  assert.ok(a.certificate && existsSync(a.certificate), JSON.stringify(a.report?.diagnostics));
});

// ── runs ──

test('PG8: a model call over en-model.txt is redacted: the email and phone masked, the name left in, one POST, Sent', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admitted());
    const id = await draft(run, 'DraftModel', 'en-model.txt');
    let s = await settleUntil(run, id, decided);
    assert.equal(s.phase, 'Open');
    assert.equal(s.target, 'Model');
    assert.equal(s.scan, 'Done');
    // The scan finds the email and the phone, so personal is Found; the sample has no secret or card, and GOV_ID is never
    // found under rules, so sensitive is NotRuledOut, never Absent (PG6).
    assert.equal(s.personal, 'Found', 'the scan finds the email and the phone');
    assert.equal(s.sensitive, 'NotRuledOut');
    assert.equal(s.redaction, 'Verified');
    assert.equal(run.egress.sent.length, 0, 'nothing is posted before Send');
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(run.egress.sent.length, 1, 'one POST');
    const req = run.egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, MODEL_URL);
    assert.ok(req.headers['idempotency-key'], 'the idempotency-key header is set');
    const input = bodyOf(req).input;
    assert.equal(typeof input, 'string');
    assert.ok(input.includes('<EMAIL_1>') && input.includes('<PHONE_1>'), 'the placeholders are in the body');
    for (const v of goldValues('en-model.txt', ['EMAIL', 'PHONE'])) assert.ok(!input.includes(v.value), `the sample's ${v.type} is not in the body`);
    // PG15's second limit: rules finds no PERSON, so the redaction cannot mask the name, and it is there.
    const names = goldValues('en-model.txt', ['PERSON']);
    assert.ok(names.length > 0, 'the gold marks the sample\'s name');
    for (const v of names) assert.ok(input.includes(v.value), 'the name is still in the body, as the README\'s limits state');
    await noValues(run, ['en-model.txt']);
  } finally {
    await stop(run);
  }
});

test('PG7: a mail with a secret to a known recipient: the body holds <SECRET>, no escalation, Sent', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admitted());
    run.recipients.add(KNOWN);
    const id = await draft(run, 'DraftMail', 'en-mail.txt', KNOWN);
    let s = await settleUntil(run, id, decided);
    assert.equal(s.target, 'Mail');
    assert.equal(s.recipient, 'Known');
    assert.equal(s.sensitive, 'Found', 'the scan finds the password and the card');
    assert.equal(s.redaction, 'Verified');
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(run.egress.sent.length, 1);
    const req = run.egress.sent[0];
    assert.equal(req.url, MAIL_URL);
    const body = bodyOf(req);
    assert.equal(body.to, KNOWN);
    assert.ok(body.body.includes('<SECRET>'), 'the secret is masked with <SECRET>');
    for (const v of goldValues('en-mail.txt', ['SECRET', 'PAYMENT'])) assert.ok(!body.body.includes(v.value), `the sample's ${v.type} is not in the body`);
    assert.deepEqual(await verdicts(run, id, 'escalated'), [], 'a known recipient is not escalated');
    await noValues(run, ['en-mail.txt'], [KNOWN]);
  } finally {
    await stop(run);
  }
});

test('PG7: a Send while the redaction is in flight is accepted and does nothing; after release and Redacted, Send posts the masked text', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admitted(), { hold: true });
    const id = await draft(run, 'DraftModel', 'en-model.txt');
    let s = await settleUntil(run, id, heldRedacting);
    assert.equal(s.scan, 'Done');
    assert.equal(s.redaction, 'Redacting', 'the redaction is held in flight');
    await send(run, id);
    await settle(run.rt, 20);
    s = await stateOf(run, id);
    assert.equal(run.egress.sent.length, 0, 'nothing is posted while Redacting');
    assert.equal(s.phase, 'Open');
    assert.equal(s.held, true, 'the held Send writes held (A1, PT4.4)');
    run.client.release();
    s = await settleUntil(run, id, (x) => x.redaction !== 'Redacting');
    assert.equal(s.redaction, 'Verified');
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(s.held, false, 'the Send that sends clears held');
    assert.equal(run.egress.sent.length, 1);
    assert.equal(bodyOf(run.egress.sent[0]).input, maskedOf(run.h, 'en-model.txt', 'Model'), 'the masked text is posted');
    await noValues(run, ['en-model.txt']);
  } finally {
    await stop(run);
  }
});

test('PG7: the gate refuses the defect\'s mail while Redacting (denied, NotDelivered, Open), then allows it once Redacted', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admittedDefect(), { hold: true });
    run.recipients.add(KNOWN);
    const id = await draft(run, 'DraftMail', 'en-mail.txt', KNOWN);
    let s = await settleUntil(run, id, heldRedacting);
    assert.equal(s.recipient, 'Known');
    assert.equal(s.redaction, 'Redacting');
    // The defect's Send emits sendMail here; the gate denies it and the worker delivers the failed completion.
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase !== 'Sending');
    const denied = await verdicts(run, id, 'denied');
    assert.equal(denied.length, 1, `one denied verdict for mail.send; got ${JSON.stringify(denied.map((e) => e.body))}`);
    assert.equal(run.egress.sent.length, 0, 'nothing is posted');
    assert.equal(s.phase, 'Open', 'NotDelivered returns the instance to Open');
    run.client.release();
    s = await settleUntil(run, id, (x) => x.redaction !== 'Redacting');
    assert.equal(s.redaction, 'Verified');
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(run.egress.sent.length, 1);
    assert.equal(bodyOf(run.egress.sent[0]).body, maskedOf(run.h, 'en-mail.txt', 'Mail'), 'the masked text is posted');
    await noValues(run, ['en-mail.txt'], [KNOWN]);
  } finally {
    await stop(run);
  }
});

test('PG9: a failed re-check (recheck-found, then recheck-dropped) ends RedactFailed, and Send posts nothing', { timeout: 300_000 }, async () => {
  for (const fault of ['recheck-found', 'recheck-dropped']) {
    let run;
    try {
      run = await start(await admitted(), { fault });
      const id = await draft(run, 'DraftModel', 'en-model.txt');
      let s = await settleUntil(run, id, decided);
      assert.equal(s.scan, 'Done', `${fault}: the scan is left alone`);
      assert.equal(s.redaction, 'RedactFailed', fault);
      await send(run, id);
      await settle(run.rt, 20);
      s = await stateOf(run, id);
      assert.equal(run.egress.sent.length, 0, `${fault}: nothing is posted`);
      assert.equal(s.phase, 'Open', fault);
      assert.equal(s.held, true, `${fault}: the Send is held`);
      await noValues(run, ['en-model.txt']);
    } finally {
      await stop(run);
    }
  }
});

test('PG5: a failed scan (missing, then dropped) ends scan Failed, and Send posts nothing', { timeout: 300_000 }, async () => {
  for (const fault of ['missing', 'dropped']) {
    let run;
    try {
      run = await start(await admitted(), { fault });
      const id = await draft(run, 'DraftModel', 'en-model.txt');
      let s = await settleUntil(run, id, (x) => x.scan !== 'Pending');
      assert.equal(s.scan, 'Failed', fault);
      await send(run, id);
      await settle(run.rt, 20);
      s = await stateOf(run, id);
      assert.equal(run.egress.sent.length, 0, `${fault}: nothing is posted`);
      assert.equal(s.phase, 'Open', fault);
      assert.equal(s.held, true, `${fault}: the Send is held`);
      await noValues(run, ['en-model.txt']);
    } finally {
      await stop(run);
    }
  }
});

/** A mail to a new recipient, escalated and approved by a person; the host then adds the recipient. Returns the id. */
async function newRecipientApproved(run) {
  const id = await draft(run, 'DraftMail', 'en-mail.txt', NEW_ADDRESS);
  let s = await settleUntil(run, id, decided);
  assert.equal(s.recipient, 'New');
  assert.equal(s.redaction, 'Verified');
  const before = run.egress.sent.length;
  await send(run, id);
  await settle(run.rt, 20);
  assert.ok((await verdicts(run, id, 'escalated')).length >= 1, 'the mail to a new recipient is escalated');
  assert.equal(run.egress.sent.length, before, 'nothing is posted before the approval');
  const rows = run.rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'mail.send'").all(id);
  assert.equal(rows.length, 1, 'the escalated mail waits in the outbox');
  await run.rt.approve(await approvalFor(run.rt, rows[0].intent_id));
  s = await settleUntil(run, id, (x) => x.phase === 'Sent');
  assert.equal(s.phase, 'Sent');
  assert.equal(run.egress.sent.length, before + 1, 'one POST after the approval');
  assert.equal(bodyOf(run.egress.sent.at(-1)).to, NEW_ADDRESS);
  // The host adds the recipient when a mail to a New recipient is Sent.
  if (s.recipient === 'New' && s.phase === 'Sent') run.recipients.add(NEW_ADDRESS);
  assert.equal(run.recipients.has(NEW_ADDRESS), true);
  return id;
}

test('PG10: a new recipient is escalated, sent once after a person approves, then known; a failed recipient decision gives New and an escalation', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admitted());
    await newRecipientApproved(run);
    // A second instance to the same address is Known and not escalated.
    const id2 = await draft(run, 'DraftMail', 'en-mail.txt', NEW_ADDRESS);
    let s = await settleUntil(run, id2, decided);
    assert.equal(s.recipient, 'Known');
    await send(run, id2);
    s = await settleUntil(run, id2, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(run.egress.sent.length, 2);
    assert.deepEqual(await verdicts(run, id2, 'escalated'), [], 'a known recipient is not escalated');
    await noValues(run, ['en-mail.txt'], [NEW_ADDRESS]);
  } finally {
    await stop(run);
  }
  // A recipient decision that fails reads as a new recipient (Q6).
  let failing;
  try {
    const down = { has() { throw new Error('the recipient table is down'); }, add() {}, digests() { return []; } };
    failing = await start(await admitted(), { recipients: down });
    const id = await draft(failing, 'DraftMail', 'en-mail.txt', NEW_ADDRESS);
    const s = await settleUntil(failing, id, decided);
    assert.equal(s.recipient, 'New', 'CheckFailed sets the recipient New');
    await send(failing, id);
    await settle(failing.rt, 20);
    assert.ok((await verdicts(failing, id, 'escalated')).length >= 1, 'the mail is escalated');
    assert.equal(failing.egress.sent.length, 0, 'nothing is posted');
    await noValues(failing, ['en-mail.txt'], [NEW_ADDRESS]);
  } finally {
    await stop(failing);
  }
});

test('the journal replays with no divergence (replayRuntime, replaySessions)', { timeout: 300_000 }, async () => {
  let run;
  try {
    run = await start(await admitted());
    const m = await draft(run, 'DraftModel', 'en-model.txt');
    await settleUntil(run, m, decided);
    await send(run, m);
    assert.equal((await settleUntil(run, m, (x) => x.phase === 'Sent')).phase, 'Sent');
    await newRecipientApproved(run);
    await noValues(run, ['en-model.txt', 'en-mail.txt'], [NEW_ADDRESS]);
    const replays = await replayRuntime(run.rt);
    for (const r of replays) assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    assert.ok(replays.some((r) => r.machine === MACHINE), `${MACHINE} is replayed; got ${replays.map((r) => r.machine).join(', ')}`);
    const sessions = await replaySessions(run.rt);
    assert.ok(sessions.length > 0, 'the gate sessions are replayed');
    for (const x of sessions) assert.deepEqual([x.diagnostics.length, x.notRun.length], [0, 0], `session divergence: ${JSON.stringify(x.diagnostics)}`);
    console.log(`pii-guard replay: ${replays.length} runs, ${sessions.length} gate sessions, no divergence`);
  } finally {
    await stop(run);
  }
});

test('PG12: the real adapter: one model call over en-model.txt, redacted, skipped with adapterStatus\'s reason when absent', { timeout: 300_000 }, async (t) => {
  const { adapterStatus, defaultPython, loadPin, startAdapter } = await import(pathToFileURL(join(HOST, 'edgepii.mjs')).href);
  const python = defaultPython();
  const pin = loadPin(PIN_FILE);
  const status = await adapterStatus({ python, pin, preset: 'rules' });
  if (!status.ok) { t.skip(status.reason); return; }
  const client = await startAdapter({ python, script: ADAPTER, pin, preset: 'rules' });
  let run;
  try {
    run = await start(await admitted(), { client });
    const id = await draft(run, 'DraftModel', 'en-model.txt');
    // The real process answers in its own time: settle with a short wait between rounds.
    let s = await settleUntil(run, id, decided, 400);
    assert.equal(s.scan, 'Done');
    assert.equal(s.redaction, 'Verified');
    await send(run, id);
    s = await settleUntil(run, id, (x) => x.phase === 'Sent');
    assert.equal(s.phase, 'Sent');
    assert.equal(run.egress.sent.length, 1);
    const input = bodyOf(run.egress.sent[0]).input;
    assert.ok(input.includes('<EMAIL_1>') && input.includes('<PHONE_1>'));
    for (const v of goldValues('en-model.txt', ['EMAIL', 'PHONE'])) assert.ok(!input.includes(v.value), `the sample's ${v.type} is not in the body`);
    await noValues(run, ['en-model.txt']);
  } finally {
    if (run) await run.rt.close();
    await client.close();
  }
});
