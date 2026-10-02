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

const view = async (h, queries) => JSON.stringify(await Promise.all(queries.map((q) => q(h))));
const effects = (h) => h.pendingEffects();
const inFlight = (h) => h.inFlight();

const authorized = async (h) => {
  assert.equal((await h.authorize('p', 2)).ok, true);
  const [e] = await h.pendingEffects();
  await h.completeEffect(e.id, 'ok');
};

/** The M3-8 list: task, the versions it applies to, the method, how to reach a state where it would act, the values outside the brief's range, one value inside it. */
export const RANGES = [
  { task: 'T2', from: 0, method: 'place', brief: 'qty: 1 or 2', says: ['Refused if `qty` is not 1 or 2'], setup: async () => {}, call: (h, x) => h.place('o', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.order('o'), (h) => h.stock(), inFlight] },
  { task: 'T3', from: 0, method: 'authorize', brief: 'amount: 1 or 2', says: ['Refused if `amount` is not 1 or 2'], setup: async () => {}, call: (h, x) => h.authorize('q', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('q'), effects] },
  { task: 'T3', from: 0, to: 0, method: 'capture', brief: 'amount: 1 or 2', says: ['takes `amount` (1 or 2 units) of an authorized payment', 'Refused otherwise.'], setup: authorized, call: (h, x) => h.capture('p', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  { task: 'T3', from: 1, method: 'capture', brief: 'amount: 1 to 3 (change 1)', says: ['now takes 1 to 3 units', 'Refused otherwise.'], setup: authorized, call: (h, x) => h.capture('p', x), outside: [0, 4, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  { task: 'T3', from: 0, method: 'refund', brief: 'amount: 1 or 2', says: ['returns `amount` (1 or 2 units) of a captured payment', 'Refused otherwise.'], setup: async (h) => { await authorized(h); assert.equal((await h.capture('p', 2)).ok, true); }, call: (h, x) => h.refund('p', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  ...['taskStarted', 'taskCompleted', 'taskFailed', 'taskEvicted', 'taskRequeued'].map((method) => ({ task: 'T5', from: 0, method, brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: async (h) => { assert.equal((await h.start('r')).ok, true); }, call: (h, x) => h[method]('r', x), outside: [3, -1], inside: method === 'taskStarted' ? 0 : null, queries: [(h) => h.run('r')] })),
  { task: 'T5', from: 1, method: 'taskRetried', brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: async (h) => { assert.equal((await h.start('r')).ok, true); }, call: (h, x) => h.taskRetried('r', x), outside: [3, -1], inside: null, queries: [(h) => h.run('r')] },
  { task: 'T5', from: 2, method: 'cancelTask', brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: async (h) => { assert.equal((await h.start('r')).ok, true); }, call: (h, x) => h.cancelTask('r', x), outside: [3, -1], inside: 0, queries: [(h) => h.run('r')] },
  { task: 'T6', from: 0, method: 'submit', brief: 'maxTries: 1 to 3', says: ['Refused if `maxTries` is outside 1 to 3'], setup: async () => {}, call: (h, x) => h.submit('j', x), outside: [0, 4, -1], inside: 3, queries: [(h) => h.job('j')] },
  { task: 'T7', from: 2, method: 'taskTimeout', brief: 'task: 0 or 1 (change 2)', says: ['for task 0 or 1', 'Refused otherwise.'], setup: async (h) => { assert.equal((await h.start()).ok, true); }, call: (h, x) => h.taskTimeout(x), outside: [2, -1], inside: 0, queries: [(h) => h.run(), inFlight] },
  { task: 'T7', from: 3, method: 'workDone', brief: 'items: 1 or 2 (change 3)', says: ['Refused if `items` is not 1 or 2'], setup: async (h) => { assert.equal((await h.start()).ok, true); await h.deliverAll(); }, call: (h, x) => h.workDone('worker0', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.run(), (h) => h.worker('worker0'), inFlight] },
  { task: 'T8', from: 0, method: 'newerTermSeen', brief: 'term: 1 to 3', says: ['Refused when the term is outside 1 to 3'], setup: async () => {}, call: (h, x) => h.newerTermSeen(x), outside: [4, 0, -1], inside: 2, queries: [(h) => h.node()] },
  { task: 'T8', from: 1, method: 'voteRequested (term)', brief: 'term: 1 to 3 (change 1)', says: ['a request with any other candidate or term is refused'], setup: async () => {}, call: (h, x) => h.voteRequested('n1', x), outside: [0, 4, -1], inside: 1, queries: [(h) => h.node()] },
  { task: 'T8', from: 1, method: 'voteRequested (candidate)', brief: 'candidate: "n1" or "n2" (change 1)', says: ['a request with any other candidate or term is refused'], setup: async () => {}, call: (h, x) => h.voteRequested(x, 1), outside: ['n0', 'n3', 'itself', 'nobody'], inside: 'n2', queries: [(h) => h.node()] },
];

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
