// PT14a: the result cache never changes a verdict. Every example is checked cold (filling a cache), warm (reading it)
// and with no cache, and the three reports must agree exactly once timings, build directories and the cache's own notes
// are set aside. Those three runs read one program, so they cannot show a key that misses an input: the second half
// warms the cache on a program, edits it (a handler body, another machine's action, an enum value, a configuration's
// instances, lines shifted above a machine) and compares the warm check of the edited program with a check of it that
// has no cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { exampleFiles } from './examples-expected.mjs';
import { comparable, sweep } from './check-cache-helpers.mjs';
import { serial } from './serial-sources.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'poly-cache-test-'));

// The heavy examples (test/serial-sources.mjs) are swept in test/after/check-cache-serial.test.mjs, one at a time.
for (const file of exampleFiles(join(ROOT, 'examples')).filter((f) => !serial(f))) {
  test(`PT14a: cold, warm and with no cache, the same report: ${relative(ROOT, file)}`, { timeout: 1_800_000 }, () => sweep(file));
}

const CHECKOUT = join(ROOT, 'examples', 'checkout', 'checkout.poly');
const HELLO = join(ROOT, 'examples', 'hello', 'hello.poly');

/** Replaces one text, found exactly once. */
function once(src, find, replace) {
  assert.equal(src.split(find).length - 1, 1, `the edit's text is found once: ${find}`);
  return src.replace(find, () => replace);
}

// Each edit is applied to a program whose cache is warm; the warm check of the edited program must equal its check with
// no cache. `hits` and `misses` say which units the key must keep and which it must check again.
const EDITS = [
  {
    name: 'a handler body of one machine (Order confirms on OutOfStock): Inventory is read back, Order and the configuration are not',
    file: CHECKOUT,
    edit: (s) => once(s, `on OutOfStock { require st is Taking else reject "not-taking"  st' = Refused }`, `on OutOfStock { require st is Taking else reject "not-taking"  st' = Done }`),
    hits: ['Inventory'], misses: ['Order', 'two-buyers'],
  },
  {
    name: 'another machine\'s action (Inventory gains Ping): every unit is checked again',
    file: CHECKOUT,
    edit: (s) => once(s, `  action Take(from: Ref<Order>)\n`, `  action Take(from: Ref<Order>)\n  action Ping()\n`),
    hits: [], misses: ['Inventory', 'Order', 'two-buyers'],
  },
  {
    name: 'an enum value added',
    file: CHECKOUT,
    edit: (s) => once(s, `type OrderState = Idle | Asked | Taking | Done | Refused`, `type OrderState = Idle | Asked | Taking | Done | Refused | Lost`),
    hits: [], misses: ['Inventory', 'Order', 'two-buyers'],
  },
  {
    name: 'a configuration\'s instances changed (one buyer in place of two)',
    file: CHECKOUT,
    edit: (s) => once(s, `  order[2]  : Order { inv: inv }`, `  order[1]  : Order { inv: inv }`),
    hits: [], misses: ['Inventory', 'Order', 'two-buyers'],
  },
  {
    name: 'lines shifted above a machine with a finding: the finding is read back and points at its new line',
    file: HELLO,
    edit: (s) => once(s, `\nmodule hello\n`, `\nmodule hello\n\n\n// three lines that move every declaration below\n`),
    hits: ['*'], misses: [],
  },
];

for (const e of EDITS) {
  test(`PT14a: a warm cache gives a no-cache check's report after an edit: ${e.name}`, { timeout: 600_000 }, async () => {
    const cache = scratch();
    const roots = scratch();
    try {
      const base = readFileSync(e.file, 'utf8').replace(/\r\n/g, '\n');
      const edited = e.edit(base);
      await checkFile(e.file, { root: join(roots, 'base'), cache, text: base });
      const warm = await checkFile(e.file, { root: join(roots, 'warm'), cache, text: edited });
      const none = await checkFile(e.file, { root: join(roots, 'none'), text: edited });
      assert.deepEqual(comparable(warm), comparable(none));
      const units = new Map([...warm.machines.map((m) => [m.machine, m.cache]), ...warm.configurations.map((c) => [c.configuration, c.cache])]);
      for (const [n, c] of units) {
        if (e.hits.includes('*') || e.hits.includes(n)) assert.equal(c?.hit, true, `${n} is read from the cache`);
        if (e.misses.includes(n)) assert.equal(c?.hit, false, `${n} is checked again`);
      }
      if (e.file === HELLO) {
        const lines = (r) => r.machines.flatMap((m) => m.diagnostics.map((d) => d.at.line));
        assert.ok(lines(warm).length > 0, 'hello has a finding');
        assert.deepEqual(lines(warm), lines(none));
      }
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(roots, { recursive: true, force: true });
    }
  });
}

test('PT14a: an entry that does not parse, or names another key, is a miss and is checked again, never a pass', async () => {
  const cache = scratch();
  const roots = scratch();
  try {
    const cold = await checkFile(HELLO, { root: join(roots, 'a'), cache });
    const { readdirSync, writeFileSync } = await import('node:fs');
    const dir = join(cache, 'v1', 'machine');
    const [first, second] = readdirSync(dir).map((f) => join(dir, f));
    writeFileSync(first, '{ not json');
    if (second) writeFileSync(second, JSON.stringify({ key: 'sha256:00', value: {} }));
    const again = await checkFile(HELLO, { root: join(roots, 'b'), cache });
    assert.deepEqual(comparable(again), comparable(cold));
    assert.ok(again.machines.every((m) => !m.cache || m.cache.hit === false), 'the broken entries are misses');
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(roots, { recursive: true, force: true });
  }
});

test('PT14a: --config checks the configurations named and lists the others as not run; an unknown name is a usage error', async () => {
  const roots = scratch();
  try {
    const OMS = join(ROOT, 'examples', 'delivery', 'delivery.poly');
    const all = await checkFile(OMS, { root: join(roots, 'all') });
    const names = all.configurations.map((c) => c.configuration);
    if (names.length >= 1) {
      const one = await checkFile(OMS, { root: join(roots, 'one'), configs: [names[0]] });
      assert.deepEqual(one.configurations.map((c) => c.configuration), [names[0]]);
      assert.deepEqual(one.notSelected ?? [], names.slice(1));
      assert.deepEqual(comparable(one.configurations[0]), comparable(all.configurations[0]));
    }
    await assert.rejects(checkFile(OMS, { root: join(roots, 'x'), configs: ['no-such-configuration'] }), /declares no configuration no-such-configuration/);
  } finally {
    rmSync(roots, { recursive: true, force: true });
  }
});
