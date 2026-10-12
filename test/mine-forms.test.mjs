// M7.2 (PT30.9, PT30.3, S525): the cases the separate auditor left open ("beyond scope", which the reviewer's rule does not
// allow): how a mined state rule is written for each type of field (an integer, a checked string, an enum with a sorted pair
// of values, a flag), a rule whose effect comes from two machines, tool.manifest, and the S525 limit. Written by the
// implementer, with real polyx on synthetic corpora (test/fixtures/m7/forms and make-shop-traces.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { canonicalize } from '@poly/core';
import { polyaxionPeer } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted } from './runtime-helpers.mjs';
import { forms } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYX = process.env.POLY_POLYX_DIR ?? join(ROOT, '..', 'polyx');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const slash = (p) => p.split(String.fromCharCode(92)).join('/');
let tmp; let n = 0; let project;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-mine-forms-'));
  project = await admitted('mine-forms', ['test/fixtures/m7/forms/forms.poly']);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function mine(corpus, polyx = POLYX, extra = []) {
  assert.ok(existsSync(join(polyx, 'bin', 'polyx.mjs')), `polyx is expected at ${polyx}`);
  const traces = join(tmp, `corpus-${++n}.ndjson`);
  writeFileSync(traces, corpus);
  const pin = join(tmp, `pin-${n}.json`);
  assert.equal(poly('mine', '--pin-polyx', '--project', project.dir, '--polyx', polyx, '--polyx-pin', pin).code, 0);
  const out = join(tmp, `out-${n}.json`);
  const r = poly('mine', '--traces', traces, '--project', project.dir, '--polyx', polyx, '--polyx-pin', pin, '--out', out, '--synthetic', ...extra);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(readFileSync(out, 'utf8'));
}

test('PT30.9: a state rule is written as the field\'s type writes its values: an integer bare, a checked string quoted, an enum bare, a flag as itself; a pair of values sorted', () => {
  const c = mine(forms());
  const promotable = c.candidates.filter((x) => x.promotable && x.pattern === 'no-X-unless-state');
  const rule = (field) => promotable.filter((x) => x.source.includes(`machine("forms.Gate").${field} in {`));
  const body = (x) => x.source.split('\n');
  const only = (field) => { const hit = rule(field); assert.equal(hit.length, 1, `${field}: ${promotable.map((x) => x.text).join(' | ')}`); return hit[0]; };
  const n = only('n');
  assert.equal(body(n)[2], '  require machine("forms.Gate").n in { 1 } else deny');
  assert.equal(n.text, 'gate.fire only while n is 1 (mined, 12 of 12 runs)');
  const w = only('w');
  assert.equal(body(w)[2], '  require machine("forms.Gate").w in { "b" } else deny');
  const ok = only('ok');
  assert.equal(body(ok)[2], '  require machine("forms.Gate").ok in { true } else deny');
  const lvl = only('lvl');
  assert.equal(body(lvl)[2], '  require machine("forms.Gate").lvl in { High, Mid } else deny', 'two values, sorted');
  assert.equal(lvl.text, 'gate.fire only while lvl is High or Mid (mined, 12 of 12 runs)');
  for (const x of [n, w, ok, lvl]) {
    assert.deepEqual(x.target, { machine: 'forms.Gate' });
    assert.equal(x.form, 'policy-rule');
    assert.deepEqual(body(x).slice(0, 2).map((l, i) => (i === 0 ? l.startsWith(`obligation mined-${x.id} "`) && l.endsWith('" rule {') : l === '  when proposal.kind == "effect" && effect.kind == "gate.fire"')), [true, true]);
    assert.equal(body(x)[3], '  on unknown escalate');
    assert.equal(body(x)[4], '}');
  }
});

test('PT30.9: a rule whose effect kind is emitted by two machines is listed, not promotable, and says so', () => {
  const c = mine(forms({ twoMachines: true }));
  const fire = c.candidates.filter((x) => x.pattern === 'no-X-unless-state' || x.pattern === 'at-most-one-X');
  assert.ok(fire.length >= 1);
  for (const x of fire) {
    assert.equal(x.promotable, false, x.text);
    assert.match(x.reason, /not emitted by one machine alone/);
    assert.ok(!('source' in x));
  }
  // The control: with one machine the same corpus gives promotable state rules.
  assert.ok(mine(forms()).candidates.some((x) => x.promotable && x.pattern === 'no-X-unless-state'));
});

test('PT30.3: tool.manifest is the SHA-256 of the canonical JSON of the manifest\'s alphabetVersion, thresholds, seed, codeCommit, segmenter and corpusRevision, and tool.commit its codeCommit', () => {
  const dir = join(tmp, `stand-in-${++n}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.2.1' }));
  const manifest = { alphabetVersion: 7, thresholds: { minInstances: 5, ownSupport: 0.6, impliesSupport: 0.9, other: 1 }, seed: 42, codeCommit: 'abcdef0123456789abcdef0123456789abcdef01', segmenter: 'null', corpusRevision: 'rev-9', runId: 'differs-every-run', at: 123 };
  writeFileSync(join(dir, 'bin', 'polyx.mjs'), `console.log(${JSON.stringify(JSON.stringify({ manifest, rules: [] }))});`);
  const c = mine(forms(), dir);
  const expected = `sha256:${createHash('sha256').update(canonicalize({ alphabetVersion: 7, thresholds: manifest.thresholds, seed: 42, codeCommit: manifest.codeCommit, segmenter: 'null', corpusRevision: 'rev-9' }), 'utf8').digest('hex')}`;
  assert.equal(c.tool.manifest, expected);
  assert.equal(c.tool.commit, manifest.codeCommit);
  assert.equal(c.tool.version, '3.2.1');
  assert.equal(c.tool.name, 'polyx');
  assert.deepEqual(c.thresholds, { minInstances: 5, ownSupport: 0.6, impliesSupport: 0.9 });
  assert.deepEqual(c.candidates, []);
  assert.ok(slash(JSON.stringify(c)).indexOf('differs-every-run') < 0, 'the run id and time of polyx are not in the file: the file is the same on every run');
});

// ── S525 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;
const MANDATE = `  obligation reserved-by-end "Every session reserves stock before it ends." machine {
    states waiting, reserved
    initial waiting
    from waiting when effect.kind == "stock.reserve" -> reserved
    end reserved
  }
`;
const RULE = (name, values) => `  obligation ${name} "reserve only while ${values}" rule {
    when proposal.kind == "effect" && effect.kind == "stock.reserve"
    require machine("orders.Order").status in { ${values} } else deny
    on unknown escalate
  }
`;
async function consistency(rules) {
  const dir = join(tmp, `s525-${++n}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'test', 'fixtures', 'm7', 'shop', 'orders.poly'), join(dir, 'src', 'orders.poly'));
  writeFileSync(join(dir, 'src', 'orders.policy.poly'), `module orders_policy\n\npolicy orders-governance {\n  scope "orders"\n${MANDATE}${rules}}\n`);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: `s525-${n}`, modules: ['src/*.poly'] }));
  const p = await checkProject(dir);
  const scope = p.files.flatMap((f) => f.policies ?? []).find((s) => s.scope === 'orders');
  return { scope, codes: scope.diagnostics.map((d) => d.code), stage: scope.stages.find((s) => s.stage === 'consistency') };
}

test('S525 (PT30.11): a lone state rule leaves the mandate dischargeable, whatever it says; two rules on one field that disagree make it PL6501', { skip }, async () => {
  const lone = await consistency(RULE('lone-cancelled', 'Cancelled'));
  assert.ok(!lone.codes.includes('PL6501'), 'the state read is a free variable, so a lone rule cannot trap the mandate');
  assert.equal(lone.stage.verdict, 'CLEAN');
  const alone2 = await consistency(RULE('lone-open', 'Open'));
  assert.ok(!alone2.codes.includes('PL6501'));
  const both = await consistency(RULE('reserving', 'Reserving') + RULE('cancelled', 'Cancelled'));
  assert.ok(both.codes.includes('PL6501'));
  assert.equal(both.stage.verdict, 'FINDINGS');
  // Two rules that agree do not conflict.
  const agree = await consistency(RULE('reserving', 'Reserving') + RULE('reserving-again', 'Reserving, Open'));
  assert.ok(!agree.codes.includes('PL6501'));
});
