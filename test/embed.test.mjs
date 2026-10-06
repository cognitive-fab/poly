// The embedded surface (PT2.5, S71; plan-m2 step 6). The printer and the reader agree on every conformance
// and example source: parse, print as TypeScript, read back, same AST digest. Three sources are written by
// hand in the embedded surface, which catches a mapping both directions would get wrong alike: each gives the
// digest and the verdict of its standalone twin, and `tsc --noEmit` passes on them against the combinators'
// declarations. Anything outside the subset is PL0301 at the offending node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { digest, stripped } from '@poly/core';
import { parse } from '@poly/lang';
import { printModule, readEmbedded } from '@poly/embed';
import { checkFile, checkProject, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const EMBED = join(ROOT, 'conformance', 'm2', 'embed');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const DECLS = join(ROOT, 'packages', 'poly-embed', 'embed', 'index.d.ts');
const walk = (d) => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.poly') ? [p] : []; });
// M8b step 2: the std modules are sources too, and print on both surfaces like any other.
const SOURCES = [...walk(join(ROOT, 'conformance')), ...walk(join(ROOT, 'examples')), ...walk(join(ROOT, 'std'))];
const TWINS = [
  ['turnstile.ts', join(ROOT, 'examples', 'field-studies', 'turnstile', 'turnstile.poly')],
  ['orders.ts', join(ROOT, 'examples', 'orders', 'orders.poly')],
  ['workshop.ts', join(EMBED, 'workshop.poly')],
];

/** The first place two ASTs differ, for a failure message. */
function firstDifference(a, b) {
  const x = JSON.stringify(stripped(a)), y = JSON.stringify(stripped(b));
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `standalone …${x.slice(Math.max(0, i - 100), i + 60)}\nembedded   …${y.slice(Math.max(0, i - 100), i + 60)}`;
}

const tsc = (project) => spawnSync(process.execPath, [TSC, '-p', project], { encoding: 'utf8' });
const tsconfig = (dir, include) => {
  const p = join(dir, 'tsconfig.json');
  writeFileSync(p, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: [], paths: { '@cognitive-fab/poly/embed': [DECLS] } }, include }, null, 2));
  return p;
};

test(`S71: every conformance and example source (${SOURCES.length}) prints as TypeScript and reads back to the same digest`, () => {
  let compared = 0;
  for (const f of SOURCES) {
    const p = parse(readFileSync(f, 'utf8'));
    if (!p.module) continue; // a syntax-error case has no AST to print
    // PT1.1a: a policy has no embedded form; its module is a .policy.poly file.
    if (p.module.decls.some((d) => d.kind === 'Policy')) continue;
    const r = readEmbedded(printModule(p.module), f);
    assert.ok(r.module, `${f}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(digest(r.module), digest(p.module), `${f}\n${firstDifference(p.module, r.module)}`);
    compared++;
  }
  assert.ok(compared >= 80, `${compared} sources compared`);
});

test('S71, S84: every printed source passes tsc --noEmit against the declarations', () => {
  const dir = join(BUILD, 'embed', 'printed');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  SOURCES.forEach((f, i) => {
    const p = parse(readFileSync(f, 'utf8'));
    if (p.module && !p.module.decls.some((d) => d.kind === 'Policy')) writeFileSync(join(dir, `${String(i).padStart(3, '0')}-${basename(f, '.poly')}.ts`), printModule(p.module));
  });
  const r = tsc(tsconfig(dir, ['*.ts']));
  // S84: a record or map literal as an operand is lit({ … }), so no exemption is needed.
  assert.equal(r.status, 0, r.stdout);
});

test('S84: a record literal as an operand is lit({ … }), and only there', () => {
  const src = readFileSync(join(ROOT, 'conformance', 'm1', 'records.poly'), 'utf8');
  const ts = printModule(parse(src).module);
  assert.match(ts, /\$\.box !== lit\(\{ size: \$\.Small, count: 0 \}\)/);
  assert.equal(digest(readEmbedded(ts).module), digest(parse(src).module));
  // A bare object literal as an operand, and lit() anywhere else, are outside the subset.
  const bare = readEmbedded(ts.replace('$.box !== lit({ size: $.Small, count: 0 })', '$.box !== { size: $.Small, count: 0 }'));
  assert.equal(bare.diagnostics[0]?.code, 'PL0301');
  assert.match(bare.diagnostics[0].message, /lit\(/);
});

for (const [ts, poly] of TWINS) {
  test(`S71: the hand-written ${ts} has the digest and the verdict of ${poly.slice(ROOT.length + 1)}`, async () => {
    const e = readEmbedded(readFileSync(join(EMBED, ts), 'utf8'), ts);
    assert.ok(e.module, JSON.stringify(e.diagnostics));
    const p = parse(readFileSync(poly, 'utf8')).module;
    assert.equal(digest(e.module), digest(p), firstDifference(p, e.module));
    const a = await checkFile(poly, { root: join(BUILD, 'embed', 'poly') });
    const b = await checkFile(join(EMBED, ts), { root: join(BUILD, 'embed', 'ts') });
    assert.equal(b.verdict, a.verdict, render(b));
    const codes = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => `${d.code}:${d.property ?? d.field ?? ''}`).sort();
    assert.deepEqual(codes(b), codes(a));
    assert.deepEqual(b.machines.map((m) => m.instance?.states), a.machines.map((m) => m.instance?.states));
  });
}

test('S71: tsc --noEmit passes on the hand-written sources, and fails on a misspelled combinator', () => {
  const ok = tsc(join(EMBED, 'tsconfig.json'));
  assert.equal(ok.status, 0, ok.stdout);
  const dir = join(BUILD, 'embed', 'typo');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'typo.ts'), readFileSync(join(EMBED, 'turnstile.ts'), 'utf8').replace("require($.state", "requires($.state"));
  const bad = tsc(tsconfig(dir, ['*.ts']));
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /Cannot find name 'requires'/);
});

test('PT2.5: anything outside the embedded subset is PL0301, at the offending node', () => {
  const base = readFileSync(join(EMBED, 'turnstile.ts'), 'utf8');
  const cases = [
    ["set('coins', $.coins + 1)", "set('coins', Math.max($.coins, 1))", /poly combinator/],
    ["set('coins', $.coins + 1)", "set('coins', ($.coins = 1))", /=/],
    ["set('coins', $.coins + 1)", "set('coins', $.coins == 1)", /===/],
    ["set('coins', $.coins + 1)", "set('coins', coins + 1)", /\$\.coins/],
    ["on('COIN', ($) => [set('state', $.UNLOCKED), set('coins', $.coins + 1)])", "on('COIN', ($) => { for (;;) { break; } return [set('state', $.UNLOCKED)]; })", /block/],
    ["import { module,", "import { readFileSync } from 'node:fs';\nimport { module,", /imports only/],
  ];
  for (const [from, to, why] of cases) {
    const src = base.replace(from, to);
    assert.notEqual(src, base, from);
    const r = readEmbedded(src, 'm.ts');
    assert.equal(r.module, null, to);
    const d = r.diagnostics[0];
    assert.equal(d.code, 'PL0301', to);
    assert.match(d.message, why, to);
    assert.ok(d.at.line > 0 && d.at.col > 0);
  }
});

test('S71: a project may name .ts modules, which poly-embed reads', async () => {
  const dir = join(BUILD, 'embed', 'project');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  copyFileSync(join(EMBED, 'workshop.ts'), join(dir, 'src', 'workshop.ts'));
  copyFileSync(join(ROOT, 'conformance', 'm2', 'detached.poly'), join(dir, 'src', 'detached.poly'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 'mixed', modules: ['src/*.poly', 'src/*.ts'] }));
  const p = await checkProject(dir, { root: dir });
  assert.deepEqual(p.files.map((f) => basename(f.file)).sort(), ['detached.poly', 'workshop.ts']);
  assert.ok(p.files.every((f) => f.verdict === 'CLEAN'), p.files.map((f) => render(f)).join('\n'));
});
