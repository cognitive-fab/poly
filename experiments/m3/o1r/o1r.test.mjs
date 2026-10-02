// O1-R (M3-10): the out-of-range refusals the amended briefs state, for one task and version, generated from the
// M3-8 list in ranges.mjs. It loads the implementation from M3_IMPL and the version from M3_TASK and M3_VERSION,
// and uses the host interface only. A setup step the implementation refuses skips its test: O1-R measures the
// range refusal, and a failure to reach the state is O1's to count, not O1-R's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { rangesOf, testName } from './ranges.mjs';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);
const view = async (h, queries) => JSON.stringify(await Promise.all(queries.map((q) => q(h))));

for (const r of rangesOf(process.env.M3_TASK, Number(process.env.M3_VERSION))) {
  for (const x of r.outside) {
    test(testName(r, x), async (t) => {
      const h = await createHost();
      try {
        try {
          await r.setup(h);
        } catch (e) {
          t.skip(String(e.message));
          return;
        }
        const before = await view(h, r.queries);
        const out = await r.call(h, x);
        assert.equal(out?.ok, false, `${testName(r, x)}: it was accepted`);
        assert.equal(await view(h, r.queries), before, `${testName(r, x)}: the state changed`);
      } finally {
        h.__dispose?.();
      }
    });
  }
}
