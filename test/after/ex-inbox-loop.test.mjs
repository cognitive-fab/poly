// M7.6 on the inbox (M7-AC1, the inbox leg). The inbox's recorded run (IAC9's sequence over both accounts, with its Gmail tapes and
// recorded model answers) is exported. The recorded run proposes nothing, and the record says why: polyx mines consequential actions
// with at least five instances, and the run holds one consequential effect instance, the draft (6 messages, 2 to-dos). So the loop
// continues on a SYNTHETIC amplification of the recorded run, labelled so in the candidates and the certificate: its to-do episode
// that reaches the draft, copied twelve times under fresh episode tokens, beside the recorded episodes. polyx proposes rules on it;
// one is adjudicated real and promoted into the inbox's own sources, the inbox project is checked (its machines and its policy)
// and admitted, and the certificate cites the rule; a rule adjudicated spurious never reaches the program. The conflict case is the
// shop's (test/loop-shop.test.mjs): the inbox's policy has no mandate and no rule on a state field, and the reviewer ruled that no
// rule is added to it to manufacture one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from '../helpers.mjs';
import { PERSON, approvalFor, signPolicies } from '../runtime-helpers.mjs';
import { ACCOUNTS, admittedInbox, host, inbox, tape } from '../ex-inbox-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYX = process.env.POLY_POLYX_DIR ?? join(ROOT, '..', 'polyx');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

const W1 = 'work/19a2f0c4d1e70a01';
const W2 = 'work/19a2f0c4d1e70a02';
const W3 = 'work/19a2f0c4d1e70a03';
const H1 = 'home/19a2f1aa00b30b01';
const TRIAGE = {
  [W1]: ['ActNowReply', 'Invoice'], [W2]: ['WeekReply', 'Invoice'], [W3]: ['Ignore', 'Newsletter'], 'work/19a2f0c4d1e70a04': ['Fyi', 'Other'],
  [H1]: ['WeekReply', 'Personal'], 'home/19a2f1aa00b30b02': ['Fyi', 'Notification'],
};
const DRAFT = 'Hello Alice, thank you: the invoice is approved and will be paid this week.';
const answering = () => (decision, ids) => {
  if (decision === 'triage') return { answer: TRIAGE[ids[0]][0], p: 0.97 };
  if (decision === 'kind') return { answer: TRIAGE[ids[0]][1], p: 0.97 };
  if (decision === 'summary') return { answer: `To do about ${ids.length} message(s).` };
  if (decision === 'when') return { answer: 'ThisWeek', p: 0.9 };
  if (decision === 'write') return { answer: DRAFT, cites: ids };
  throw new Error(`no recorded answer for ${decision}`);
};
const INVOICE = `todo:${W1.replace('/', ':')}`;
const intentOf = (rt, id, kind) => rt.store.db.prepare('SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = ?').all(id, kind).map((r) => r.intent_id);

async function throughDraft(i) {
  const { rt, source, accounts, settle } = i;
  const made = [];
  for (const acct of accounts) for (let k = 0; k < 2; k++) made.push(...(await host.syncAccount(rt, source, acct)).created);
  await settle();
  await host.openTodos(rt, made);
  await settle();
  await rt.dispatch(INVOICE, 'WriteDraft', {});
  await settle();
  await rt.dispatch(INVOICE, 'Propose', {});
  await settle();
  await rt.approve(await approvalFor(rt, intentOf(rt, INVOICE, 'gmail.createDraft')[0]));
  await settle();
  assert.equal((await rt.getState(INVOICE)).state.status, 'Created');
}

test('M7-AC1 (inbox): the recorded run proposes nothing; a synthetic amplification gives rules; one real rule is promoted, checked and admitted with the certificate citing it, and a spurious one never reaches the program', { timeout: 3_600_000 }, async () => {
  assert.ok(existsSync(join(POLYX, 'bin', 'polyx.mjs')), `polyx is expected at ${POLYX}`);
  const tmp = mkdtempSync(join(tmpdir(), 'poly-inbox-loop-'));
  try {
    const a = await admittedInbox('ex-inbox-loop');
    const w = tape('work');
    const db = join(tmp, 'inbox.db');
    const i = await inbox(a, { db, tapes: { work: [...w.initial, ...w.poll], home: [...tape('home').initial, ...tape('home').quiet] }, answers: answering(), accounts: ACCOUNTS.filter((x) => x.label !== 'club') });
    try { await throughDraft(i); } finally { await i.rt.close(); }
    writeFileSync(join(a.dir, 'admission.pub'), a.key.publicKey);
    const traces = join(tmp, 'inbox.traces.ndjson');
    const e = poly('export', 'traces', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', traces);
    assert.equal(e.code, 0, e.out);
    const eps = readFileSync(traces, 'utf8').trim().split(String.fromCharCode(10)).slice(1).map((l) => JSON.parse(l));
    const count = {};
    for (const ep of eps) for (const s of ep.steps) { count[`${ep.machine} ${s.action}${s.effects.length ? ' -> ' + s.effects.map((f) => f.kind).join('+') : ''}`] = (count[`${ep.machine} ${s.action}${s.effects.length ? ' -> ' + s.effects.map((f) => f.kind).join('+') : ''}`] ?? 0) + 1; }
    // The recorded run holds one consequential effect instance (the draft), and polyx mines consequential actions with at least five
    // instances, so it proposes nothing. The inbox leg therefore uses a SYNTHETIC amplification of the recorded run: its Todo
    // episode that reaches the draft, copied twelve times under fresh episode tokens, beside the recorded episodes.
    const lines = readFileSync(traces, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
    const draft = lines.slice(1).find((ep) => ep.steps.some((s) => s.effects.some((f) => f.kind === 'gmail.createDraft')));
    assert.ok(draft, 'the recorded run reached the draft');
    const copies = Array.from({ length: 12 }, (_, k) => ({ ...draft, episode: 'd:' + createHash('sha256').update(draft.episode + k).digest('hex').slice(0, 32) }));
    const amplified = join(tmp, 'inbox.amplified.ndjson');
    writeFileSync(amplified, [{ ...lines[0], episodes: lines.length - 1 + copies.length }, ...lines.slice(1), ...copies].map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    const pin = join(tmp, 'pin.json');
    assert.equal(poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', POLYX, '--polyx-pin', pin).code, 0);
    const candidates = join(tmp, 'candidates.json');
    // The recorded run alone: no candidate.
    const recorded = join(tmp, 'recorded.candidates.json');
    const r0 = poly('mine', '--traces', traces, '--project', a.dir, '--polyx', POLYX, '--polyx-pin', pin, '--out', recorded, '--all');
    assert.equal(r0.code, 0, r0.out);
    const none = JSON.parse(readFileSync(recorded, 'utf8'));
    assert.equal(none.corpus.kind, 'recorded');
    assert.deepEqual(none.candidates, [], 'the recorded run holds one consequential effect instance, below the floor of five');
    // The amplification.
    const m = poly('mine', '--traces', amplified, '--project', a.dir, '--polyx', POLYX, '--polyx-pin', pin, '--out', candidates, '--all', '--synthetic');
    assert.equal(m.code, 0, m.out);
    const file = JSON.parse(readFileSync(candidates, 'utf8'));
    assert.equal(file.corpus.kind, 'synthetic');
    const promotable = file.candidates.filter((c) => c.promotable);
    console.log(`INBOX corpus ${JSON.stringify(file.corpus)}: ${file.candidates.length} candidates, ${promotable.length} promotable`);
    const pick = (re) => { const hit = promotable.filter((c) => re.test(c.source)); assert.equal(hit.length, 1, String(re)); return hit[0]; };
    const real = pick(/require machine\("inbox\.Todo"\)\.status in \{ Proposed \} else deny/);
    const spurious = pick(/require machine\("inbox\.Todo"\)\.due in \{ ThisWeek \} else deny/);
    assert.deepEqual(real.target, { machine: 'inbox.Todo' });
    assert.equal(real.text, 'gmail.createDraft only while status is Proposed (mined, 13 of 13 runs)');
    // The path property the same corpus gives, at most one draft per to-do, is the program's to answer for: see the result in decisions-m7.md.
    assert.deepEqual(real.support, { holds: 13, of: 13 });
    // A person's verdicts.
    const key = join(tmp, 'person.pem');
    writeFileSync(key, PERSON.privateKeyPem);
    const judge = (c, verdict) => { const out = join(tmp, `adjudication-${c.id}-${verdict}.json`); const r = poly('adjudicate', candidates, '--candidate', c.id, '--verdict', verdict, '--by', PERSON.keyId, '--key', key, '--project', a.dir, '--out', out); assert.equal(r.code, 0, r.out); return out; };
    const sources = () => Object.fromEntries(readdirSync(join(a.dir, 'src')).filter((f) => f.endsWith('.poly')).map((f) => [f, readFileSync(join(a.dir, 'src', f), 'utf8')]));
    const before = sources();
    // The spurious rule is refused, and the program is as it was.
    const refused = poly('promote', a.dir, '--candidates', candidates, '--adjudication', judge(spurious, 'spurious'), '--scope', 'inbox');
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /is spurious: only a real verdict reaches a program/);
    assert.deepEqual(sources(), before);
    assert.ok(!existsSync(join(a.dir, 'promotions')));
    // The real rule is promoted: the project is checked (machines and policy) and the promotion stands.
    const t0 = Date.now();
    const promoted = poly('promote', a.dir, '--candidates', candidates, '--adjudication', judge(real, 'real'), '--scope', 'inbox');
    assert.equal(promoted.code, 0, promoted.out);
    console.log(`INBOX promote took ${Math.round((Date.now() - t0) / 1000)} s: ${promoted.out.trim().split(String.fromCharCode(10))[0]}`);
    const after = sources();
    assert.deepEqual(Object.keys(after).filter((f) => after[f] !== before[f]), ['inbox.policy.poly'], "only the policy's source changed");
    const was = before['inbox.policy.poly'].split(String.fromCharCode(10));
    const nowLines = after['inbox.policy.poly'].split(String.fromCharCode(10));
    assert.equal(nowLines.length - was.length, 6, 'six lines were inserted');
    const start = nowLines.findIndex((l, k) => l !== was[k]);
    assert.deepEqual([...nowLines.slice(0, start), ...nowLines.slice(start + 6)], was, 'the rest of the file is byte for byte as it was');
    const added = nowLines.slice(start, start + 6);
    assert.match(added[0], /^ {2}\/\/ promoted: r[0-9a-f]{16} sha256:[0-9a-f]{64}$/);
    assert.equal(added[1], `  obligation mined-${real.id} "gmail.createDraft only while status is Proposed (mined, 13 of 13 runs)" rule {`);
    assert.equal(added[3], '    require machine("inbox.Todo").status in { Proposed } else deny');
    assert.ok(!after['inbox.policy.poly'].includes(spurious.id) && !JSON.stringify(readdirSync(join(a.dir, 'promotions'))).includes(spurious.id), 'the spurious rule is nowhere');
    // The policy changed, so the scope is signed again by a person (PT30.6); then admission.
    await signPolicies(a.dir);
    // Admission: CLEAN, and the certificate cites the rule, its record, the corpus kind and the tool.
    const adm = await admit(a.dir);
    assert.equal(adm.verdict, 'CLEAN');
    const cert = JSON.parse(readFileSync(adm.certificatePath, 'utf8'));
    assert.equal(cert.poly.promotions.length, 1);
    const p = cert.poly.promotions[0];
    assert.deepEqual([p.candidate, p.id, p.corpus.kind, p.tool.name], [real.digest, real.id, 'synthetic', 'polyx']);
    assert.match(p.record, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.keys(cert.poly.promotionFiles).length, 1);
  } finally { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store may stay locked a moment on Windows */ } }
});
