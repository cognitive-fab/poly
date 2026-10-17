// M3-6 to M3-8: every action parameter a caller sets through the host interface, whose brief states a range or a
// set of values, is refused outside it, in the reference and the mutant of every version, and the refusal changes
// nothing. A type range alone does not refuse: PT3.4a makes a parameter's domain `strict` only when its value
// reaches an irreversible or compensable effect, and `disclosed` elsewhere, which accepts the value. The references
// therefore declare these parameters `int check { ... } strict` (or an enum with a strict check), and the briefs
// say that out-of-range values are refused (M3-7, M3-8). Parameters only another machine sets (Reserve, Granted
// and the like) are not caller inputs and are not listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adapterOf, versions } from '../experiments/m3/lib/task.mjs';
import { RANGES } from '../experiments/m3/o1r/ranges.mjs';

const view = async (h, queries) => JSON.stringify(await Promise.all(queries.map((q) => q(h))));

for (const r of RANGES) {
  for (const v of versions(r.task).filter((x) => x.n >= r.from && x.n <= (r.to ?? 3))) {
    test(`M3-7, M3-8: ${r.task} v${v.n}: the brief says ${r.method} refuses values outside ${r.brief}`, () => {
      const brief = v.briefs.map((b) => readFileSync(b, 'utf8')).join('\n');
      for (const text of r.says) assert.ok(brief.includes(text), `the brief of v${v.n} does not say: ${text}`);
    });
  }
  for (const v of versions(r.task).filter((x) => x.n >= r.from && x.n <= (r.to ?? 3))) {
    for (const which of ['reference', 'mutant']) {
      test(`M3-8: ${r.task} v${v.n} ${which}: ${r.method} refuses values outside ${r.brief}`, async () => {
        const create = await adapterOf(v, which);
        for (const x of r.outside) {
          const h = await create();
          try {
            await r.setup(h);
            const before = await view(h, r.queries);
            const out = await r.call(h, x);
            assert.equal(out.ok, false, `${r.method}(${JSON.stringify(x)}) was accepted`);
            assert.equal(await view(h, r.queries), before, `${r.method}(${JSON.stringify(x)}) changed the state`);
          } finally {
            h.__dispose?.();
          }
        }
        if (r.inside !== null) {
          const h = await create();
          try {
            await r.setup(h);
            assert.equal((await r.call(h, r.inside)).ok, true, `${r.method}(${JSON.stringify(r.inside)}) was refused`);
          } finally {
            h.__dispose?.();
          }
        }
      });
    }
  }
}

// The frozen sources of M3 are evidence and are not edited (test/m3-freeze-eol.test.mjs). They predate PL6304, so the build takes a migrated copy
// (experiments/m3/lib/task.mjs). Catches an edit of a frozen file, a migration that adds a second class, and one that touches an effect that needs none.
import { join } from 'node:path';
import { moduleOf, migrateClasses } from '../experiments/m3/lib/task.mjs';

test('M3 freeze: the frozen T3 reference stays classless on disk, and the build uses a copy with class reversible on its one effect', () => {
  const dir = join(import.meta.dirname, '..', 'experiments', 'm3', 'tasks', 'T3', 'reference');
  const original = readFileSync(join(dir, 'payments.poly'), 'utf8');
  assert.ok(!/^ *class /m.test(original), 'the frozen file says no class');
  const used = moduleOf(dir);
  assert.notEqual(used, join(dir, 'payments.poly'));
  const copy = readFileSync(used, 'utf8');
  assert.equal(copy.split('class reversible').length - 1, 1);
  assert.equal(copy.replace('    class reversible\n', ''), original, 'the copy differs from the frozen file by that one line');
});

test('M3 freeze: the migration adds a class only to an egress effect that has none', () => {
  const effect = (body) => `module m\nmachine M {\n  effect e() {\n    kind "k"\n${body}  }\n}\n`;
  const classless = effect('    labels { egress:external }\n');
  assert.equal(migrateClasses(classless), effect('    labels { egress:external }\n    class reversible\n'));
  const classed = effect('    class irreversible\n    labels { egress:external }\n');
  assert.equal(migrateClasses(classed), classed, 'a class before the labels is kept, and no second one is added');
  const inside = effect('    labels { write:store }\n');
  assert.equal(migrateClasses(inside), inside, 'an effect that does not reach outside needs no class');
  assert.equal(migrateClasses(migrateClasses(classless)), migrateClasses(classless), 'the migration is idempotent');
});
