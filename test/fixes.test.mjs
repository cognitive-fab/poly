// Fixes (PT12.1, S69, S70; plan-m2 step 4, section 6). A source with twelve fixable diagnostics; its fixes
// are applied in at least 100 random orders from a recorded seed. Each attempt either applies with its
// precondition true and changes its target node only, or is refused with PL0201 STALE_FIX and leaves the
// text as it was. After every attempt the source parses. Comments survive every edit. Since M3-3 the same
// orders run over the embedded surface too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { digest } from '@poly/core';
import { parse } from '@poly/lang';
import { applyFix, checkFile, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const SOURCE = join(ROOT, 'conformance', 'm2', 'errors', 'fixes.poly');
// The recorded seed. A failure names the order it failed in, so it can be replayed.
const SEED = 20260930;
const ORDERS = 120;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The node with this id, found independently of poly-check's own walker. */
function nodeById(module, id) {
  let hit = null;
  const visit = (n) => {
    if (hit || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.id === id) { hit = n; return; }
    for (const [k, v] of Object.entries(n)) if (k !== 'span') visit(v);
  };
  visit(module);
  return hit;
}

/** The module's digest with the node of this id masked: equal before and after iff nothing else changed. */
function masked(module, id) {
  const copy = (n) => {
    if (Array.isArray(n)) return n.map(copy);
    if (!n || typeof n !== 'object') return n;
    if (n.id === id) return { kind: 'Masked' };
    const out = {};
    for (const [k, v] of Object.entries(n)) out[k] = copy(v);
    return out;
  };
  return digest(copy(module));
}

const targetOf = (fix) => fix.edit.node && fix.edit.op === 'replace-node' ? fix.edit.node : fix.edit.handler ?? fix.edit.block;
const allDiags = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];

test('S70: the fixable source has at least ten fixable diagnostics, each fix with a digest precondition and an S69 id', async () => {
  const r = await checkFile(SOURCE, { root: join(BUILD, 'fixes') });
  const fixable = allDiags(r).filter((d) => d.fixes?.length);
  assert.ok(fixable.length >= 10, `${fixable.length} fixable diagnostics`);
  assert.deepEqual([...new Set(fixable.map((d) => d.code))].sort(), ['PL1005', 'PL1202', 'PL1501', 'PL1504', 'PL2101']);
  const module = parse(readFileSync(SOURCE, 'utf8')).module;
  for (const d of fixable) for (const f of d.fixes) {
    assert.match(f.id, /^[a-z-]+@[0-9a-f]{12}$/);
    assert.equal(f.pre, digest(nodeById(module, targetOf(f))));
  }
});

/**
 * The random-order run of S70 over one surface. `read` parses the surface; `kept` are texts of the author's
 * (comments, and on the embedded surface a line in their own formatting) that must survive every order.
 */
function randomOrders(t, { fixes, original, read, file, kept }) {
  const rand = mulberry32(SEED);
  let ordersWithRefusal = 0, applied = 0, refused = 0;
  for (let o = 0; o < ORDERS; o++) {
    const order = [...fixes];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let text = original, refusedHere = false;
    for (const fix of order) {
      const where = `${file}, order ${o} (seed ${SEED}), fix ${fix.id}`;
      const before = read(text);
      const target = nodeById(before, targetOf(fix));
      const pre = target !== null && digest(target) === fix.pre;
      const out = applyFix(text, fix, file);
      if (out.status === 'applied') {
        applied++;
        assert.ok(pre, `${where}: applied with its precondition false`);
        const after = read(out.text);
        assert.ok(after, `${where}: the edited source does not parse`);
        assert.equal(masked(after, targetOf(fix)), masked(before, targetOf(fix)), `${where}: changed more than its target node`);
        assert.notEqual(digest(nodeById(after, targetOf(fix))), fix.pre, `${where}: applied and changed nothing`);
        text = out.text;
      } else {
        refused++;
        refusedHere = true;
        assert.equal(out.code, 'PL0201', where);
        // A refusal with the digest still true is the operation's own precondition failing, and says so.
        if (pre) assert.match(out.message, /no longer (writes|follows a write|in its block)/, `${where}: refused with its precondition true: ${out.message}`);
      }
      assert.ok(read(text), `${where}: the source no longer parses`);
    }
    for (const k of kept) assert.ok(text.includes(k), `${file}, order ${o}: lost ${k}`);
    if (refusedHere) ordersWithRefusal++;
  }
  assert.ok(ordersWithRefusal >= ORDERS / 3, `${ordersWithRefusal} of ${ORDERS} orders met a stale fix`);
  assert.ok(applied > 0 && refused > 0);
  t.diagnostic(`${file}: ${fixes.length} fixes, ${applied} applied, ${refused} refused PL0201, ${ordersWithRefusal} of ${ORDERS} orders met a stale fix`);
}

test(`S70: ${ORDERS} random orders from seed ${SEED}: every fix applies with its precondition true and changes only its target, or is refused PL0201`, async (t) => {
  const r = await checkFile(SOURCE, { root: join(BUILD, 'fixes') });
  randomOrders(t, {
    fixes: allDiags(r).flatMap((d) => d.fixes ?? []), original: readFileSync(SOURCE, 'utf8'), read: (x) => parse(x).module, file: 'fixes.poly',
    kept: ['// the guard', '// the write', '// B: two ambiguous constructors'],
  });
});

// M3-3: the same source printed as an embedded module, with the author's comments and one line in their own
// formatting. It is offered the same fixes, by id, and the same random orders hold on it: each fix is spliced
// in at its node's span, and the rest of the text is left as the author wrote it.
test(`M3-3: the same ${ORDERS} random orders over the embedded surface, with the same fixes`, async (t) => {
  const { printModule, readEmbedded } = await import('@poly/embed');
  let original = printModule(parse(readFileSync(SOURCE, 'utf8')).module);
  const put = (anchor, text) => { assert.equal(original.split(anchor).length, 2, anchor); original = original.split(anchor).join(text); };
  put('        require(primed("n") < 3, "full"),\n', '        // the guard\n        require(primed("n") < 3, "full"),\n');
  put('        set("m", 2),\n', '        set("m", 2), // the write\n');
  put('      on("B", ', '      // B: two ambiguous constructors, and a binder no one reads.\n      on("B", ');
  put('      action("A", {}),', '      action( "A",   {} ),');
  const dir = join(BUILD, 'fixes', 'embedded');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fixes.ts');
  writeFileSync(file, original);
  const r = await checkFile(file, { root: dir });
  const fixes = allDiags(r).flatMap((d) => d.fixes ?? []);
  const std = allDiags(await checkFile(SOURCE, { root: join(BUILD, 'fixes') })).flatMap((d) => d.fixes ?? []);
  assert.equal(fixes.length, 15);
  assert.deepEqual(fixes.map((f) => f.id).sort(), std.map((f) => f.id).sort(), 'the embedded surface is offered the fixes of the standalone one');
  randomOrders(t, {
    fixes, original, read: (x) => readEmbedded(x, 'fixes.ts').module, file: 'fixes.ts',
    kept: ['// the guard', '// the write', '// B: two ambiguous constructors', 'action( "A",   {} ),'],
  });
});

test('S70: after the fixes of one order, checking again leaves none of the fixed codes', async () => {
  const r = await checkFile(SOURCE, { root: join(BUILD, 'fixes') });
  let text = readFileSync(SOURCE, 'utf8');
  // Fixes go stale as others apply; the loop checks again and applies the fixes of the new report, as an agent would.
  const dir = join(BUILD, 'fixes', 'loop');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fixes.poly');
  let report = r;
  for (let round = 0; round < 10; round++) {
    const fixes = allDiags(report).flatMap((d) => (d.fixes ?? []).slice(0, 1));
    if (!fixes.length) break;
    for (const f of fixes) { const out = applyFix(text, f); if (out.status === 'applied') text = out.text; }
    await import('node:fs').then((fs) => fs.writeFileSync(file, text));
    report = await checkFile(file, { root: dir });
  }
  assert.deepEqual(allDiags(report).filter((d) => ['PL1005', 'PL1202', 'PL1501', 'PL1504', 'PL2101'].includes(d.code)).map((d) => `${d.code} ${d.message}`), []);
});

// add-require removes the finding. widen-range admits the escaped value; on this counter the next value
// escapes the wider range, so the finding moves up by one and names 5 (a fix is a proposal, PT12.1).
// M3-3: the same on the embedded surface, where add-require inserts a call its import must gain.
test('S70: PL3102 offers add-require and widen-range; add-require removes the finding, widen-range admits the escaped value', async () => {
  const { printModule } = await import('@poly/embed');
  const seed = join(ROOT, 'conformance', 'm2', 'seeded', 'domain-escape', 'unfixed.poly');
  for (const [name, ext] of [['add-require', 'poly'], ['widen-range', 'poly'], ['add-require', 'ts'], ['widen-range', 'ts']]) {
    const dir = join(BUILD, 'fixes', `${name}-${ext}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `m.${ext}`);
    if (ext === 'poly') copyFileSync(seed, file);
    else writeFileSync(file, printModule(parse(readFileSync(seed, 'utf8')).module));
    const r = await checkFile(file, { root: dir });
    const d = allDiags(r).find((x) => x.code === 'PL3102');
    assert.deepEqual(d.fixes.map((f) => f.id.split('@')[0]), ['add-require', 'widen-range']);
    const out = applyFix(readFileSync(file, 'utf8'), d.fixes.find((f) => f.id.startsWith(name)), file);
    assert.equal(out.status, 'applied');
    await import('node:fs').then((fs) => fs.writeFileSync(file, out.text));
    const again = await checkFile(file, { root: dir });
    const left = allDiags(again).filter((x) => x.code === 'PL3102');
    if (name === 'add-require') assert.deepEqual(left, [], name);
    else assert.deepEqual(left.map((x) => x.witness.trace.at(-1).post.items), [5]);
    if (ext === 'poly') assert.match(out.text, name === 'add-require' ? /require items \+ 1 <= 3 else reject "items-range"/ : /items : 0\.\.4 = 0/);
    else assert.match(out.text, name === 'add-require' ? /require\(\$\.items \+ 1 <= 3, "items-range"\)/ : /t\.range\(0, 4\)/);
  }
});

// M3-3: an author's embedded module need not look printed. Here the arrows name their parameter `s`, `set` is
// imported as `assign`, `require` is not imported, and a handler is on one line.
test('M3-3: an embedded fix reads through the author\'s parameter, and adds the import it needs', async () => {
  const dir = join(BUILD, 'fixes', 'embedded-author');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'basket.ts');
  writeFileSync(file, [
    "import { action, field, machine, module, on, set as assign, t } from '@cognitive-fab/poly/embed';",
    '',
    '// A basket that counts past its range.',
    'export default module("seeded", [',
    '  machine("Basket", {',
    '    service: true,',
    '    state: { items: field(t.range(0, 3), (s) => 0) },',
    '    items: [',
    '      action("Add", {}), action("Clear", {}),',
    '      on("Add", (s) => [assign("items", s.items + 1)]), // one line',
    '      on("Clear", (s) => [assign("items", 0)]),',
    '    ],',
    '  }),',
    ']);',
    '',
  ].join('\n'));
  const r = await checkFile(file, { root: dir });
  const d = allDiags(r).find((x) => x.code === 'PL3102');
  assert.ok(d, render(r));
  const out = applyFix(readFileSync(file, 'utf8'), d.fixes.find((f) => f.id.startsWith('add-require')), file);
  assert.equal(out.status, 'applied', out.message);
  assert.match(out.text, /^import \{ action, field, machine, module, on, set as assign, t, require \} from/);
  assert.match(out.text, /on\("Add", \(s\) => \[ require\(s\.items \+ 1 <= 3, "items-range"\),assign\("items", s\.items \+ 1\)\]\), \/\/ one line/);
  assert.ok(out.text.includes('// A basket that counts past its range.'));
  writeFileSync(file, out.text);
  assert.deepEqual(allDiags(await checkFile(file, { root: dir })).filter((x) => x.code === 'PL3102'), []);
});

test('the CLI: poly fix applies a fix once, refuses it stale the second time (PL0201, exit 2), and rejects an unknown id', () => {
  const dir = join(BUILD, 'fixes', 'cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'm.poly');
  copyFileSync(join(ROOT, 'conformance', 'm0', 'errors', 'PL2101-write-before-require.poly'), file);
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  assert.equal(spawnSync(process.execPath, [cli, 'check', file, '--root', dir], { encoding: 'utf8' }).status, 2);
  const report = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8'));
  const id = report.diagnostics.find((d) => d.code === 'PL2101').fixes[0].id;
  const first = spawnSync(process.execPath, [cli, 'fix', id, '--root', dir], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(file, 'utf8'), /require x < 3 else reject "full"\s+x' = 1/);
  const second = spawnSync(process.execPath, [cli, 'fix', id, '--root', dir], { encoding: 'utf8' });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /PL0201/);
  assert.equal(spawnSync(process.execPath, [cli, 'fix', 'move-require@000000000000', '--root', dir], { encoding: 'utf8' }).status, 64);
});
