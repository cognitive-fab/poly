// M7.6 on the shop (M7-AC1, the conflict and the spurious legs): the whole loop with real polyx on SYNTHETIC corpora made
// for the purpose (test/fixtures/m7/make-shop-traces.mjs; the candidates say `synthetic`, and the promotions are cited
// by a test certificate only, PS20.5). Corpus -> mine -> adjudicate -> promote -> check -> admit, through the command line.
// The inbox has no mandate and no policy rule on a state field, so its conflict case cannot be made without adding a rule to
// its policy; the reviewer ruled (2026-10-11) that the conflict case then comes from a synthetic corpus and the
// acceptance record says so. This is that case; test/after/ex-inbox-loop.test.mjs is the inbox leg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { PERSON, admitted, signPolicies } from './runtime-helpers.mjs';
import { conflict, shop } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYX = process.env.POLY_POLYX_DIR ?? join(ROOT, '..', 'polyx');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

let tmp; let n = 0;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'poly-loop-shop-')); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== '.poly') walk(p); } else out[p.slice(dir.length)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};

/** A shop project, the person's key, the pinned polyx, and a mining of a corpus (synthetic: the corpus is made for the purpose). */
async function loop(corpusText) {
  assert.ok(existsSync(join(POLYX, 'bin', 'polyx.mjs')), `polyx is expected at ${POLYX}`);
  const a = await admitted(`loop-shop-${++n}`, ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly']);
  const key = join(tmp, `person-${n}.pem`);
  writeFileSync(key, PERSON.privateKeyPem);
  const traces = join(tmp, `corpus-${n}.ndjson`);
  writeFileSync(traces, corpusText);
  const pin = join(tmp, `pin-${n}.json`);
  assert.equal(poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', POLYX, '--polyx-pin', pin).code, 0);
  const candidates = join(tmp, `candidates-${n}.json`);
  const m = poly('mine', '--traces', traces, '--project', a.dir, '--polyx', POLYX, '--polyx-pin', pin, '--out', candidates, '--all', '--synthetic');
  assert.equal(m.code, 0, m.out);
  const file = JSON.parse(readFileSync(candidates, 'utf8'));
  assert.equal(file.corpus.kind, 'synthetic');
  const judge = (id, verdict) => {
    const out = join(tmp, `adjudication-${id}-${verdict}.json`);
    const r = poly('adjudicate', candidates, '--candidate', id, '--verdict', verdict, '--by', PERSON.keyId, '--key', key, '--project', a.dir, '--out', out);
    assert.equal(r.code, 0, r.out);
    return out;
  };
  const find = (re) => { const hit = file.candidates.filter((c) => c.promotable && re.test(c.source)); assert.equal(hit.length, 1, String(re)); return hit[0]; };
  return { a, candidates, file, judge, find };
}

test('M7-AC1 (shop, synthetic): a mined rule adjudicated real is promoted, checked, admitted, and the certificate cites it with its record, corpus kind and tool', async () => {
  const { a, candidates, file, judge, find } = await loop(shop());
  const rule = find(/^path property mined-r[0-9a-f]{16}: count\("payment\.charge"\) <= 1$/);
  assert.deepEqual(rule.support, { holds: 12, of: 12 });
  const real = judge(rule.id, 'real');
  const r = poly('promote', a.dir, '--candidates', candidates, '--adjudication', real);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`promoted ${rule.id} into src/orders\\.poly \\(promotions/0001-${rule.id}\\.json\\)`));
  const source = readFileSync(join(a.dir, 'src', 'orders.poly'), 'utf8');
  assert.ok(source.includes(`  path property mined-${rule.id}: count("payment.charge") <= 1`));
  await signPolicies(a.dir);
  const adm = await admit(a.dir);
  assert.equal(adm.verdict, 'CLEAN');
  const cert = JSON.parse(readFileSync(adm.certificatePath, 'utf8'));
  assert.equal(cert.poly.promotions.length, 1);
  const p = cert.poly.promotions[0];
  assert.equal(p.candidate, rule.digest);
  assert.equal(p.id, rule.id);
  assert.equal(p.corpus.kind, 'synthetic', 'the certificate says the corpus was made for the purpose');
  assert.equal(p.tool.name, 'polyx');
  assert.equal(p.tool.version, file.tool.version);
  assert.match(p.record, /^sha256:[0-9a-f]{64}$/);
  assert.equal(cert.poly.keyringChain.source, 'test');
  assert.ok(Object.keys(cert.poly.promotionFiles).length === 1);
});

test('M7-AC1 (shop, synthetic): a rule adjudicated spurious never reaches the program, and a real one beside it does', async () => {
  const { a, candidates, judge, find } = await loop(shop());
  const spurious = find(/count\("payment\.fee"\) <= 1$/);
  const real = find(/count\("stock\.reserve"\) <= 1$/);
  const before = snapshot(a.dir);
  const bad = poly('promote', a.dir, '--candidates', candidates, '--adjudication', judge(spurious.id, 'spurious'));
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /is spurious: only a real verdict reaches a program/);
  assert.deepEqual(snapshot(a.dir), before);
  assert.equal(poly('promote', a.dir, '--candidates', candidates, '--adjudication', judge(real.id, 'real')).code, 0);
  const after = readFileSync(join(a.dir, 'src', 'orders.poly'), 'utf8');
  assert.ok(after.includes(`mined-${real.id}`) && !after.includes(spurious.id), 'the spurious rule is nowhere in the sources');
  assert.deepEqual(readdirSync(join(a.dir, 'promotions')).filter((f) => f.includes(spurious.id)), []);
});

test('M7-AC1 (shop, synthetic): a mined rule that conflicts with the policy is refused with PL6501 naming the minimal conflicting subset, and the program is as it was', async () => {
  const { a, candidates, judge, find } = await loop(conflict());
  const rule = find(/effect\.kind == "stock\.reserve"[\s\S]*status in \{ Cancelled \} else deny/);
  assert.deepEqual(rule.support, { holds: 10, of: 10 });
  const before = snapshot(a.dir);
  const r = poly('promote', a.dir, '--candidates', candidates, '--adjudication', judge(rule.id, 'real'), '--scope', 'orders');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /PL6501/);
  assert.match(r.out, new RegExp(`orders-governance\\.reserved-by-end`));
  assert.match(r.out, new RegExp(`orders-governance\\.reserve-while-reserving`));
  assert.match(r.out, new RegExp(`orders-governance\\.mined-${rule.id}`));
  assert.doesNotMatch(r.out, /fee-free/, 'the unrelated rule is not in the subset');
  assert.deepEqual(snapshot(a.dir), before);
  assert.ok(!existsSync(join(a.dir, 'promotions')));
});
