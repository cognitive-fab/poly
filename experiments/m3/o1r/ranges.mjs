// The M3-8 list (plan-m3 section 10): every action parameter a caller sets through the host interface whose brief
// states a range or a set of values, with the values outside it. O1-R (M3-10) is generated from this list: for each
// entry and each outside value, the command is refused and changes nothing, through the host interface only, so
// it runs the same on every arm's delivery. O1 is not edited (it was written before M3-7 and M3-8 amended the
// briefs); O1-R is a secondary measure beside it, never added into the escaped defects of S96.
//
// An entry: the task, the versions it applies to (from, and to when it stops), the command, what the brief states
// and the text that says so, a setup that brings the system to a state where the command would act (it throws when
// a step is refused), the call, the values outside the range, one value inside it (for the reference's own test),
// and the queries whose answers must not change.

/** A setup step that must take effect. */
const must = async (p, what) => {
  const r = await p;
  if (!r || r.ok !== true) throw new Error(`setup: ${what} was refused`);
};
const effects = (h) => h.pendingEffects();
const inFlight = (h) => h.inFlight();
const authorized = async (h) => {
  await must(h.authorize('p', 2), "authorize('p', 2)");
  const [e] = await h.pendingEffects();
  if (!e) throw new Error('setup: no authorisation request is pending');
  await h.completeEffect(e.id, 'ok');
};
const started = async (h) => must(h.start('r'), "start('r')");

export const RANGES = [
  { task: 'T2', from: 0, method: 'place', brief: 'qty: 1 or 2', says: ['Refused if `qty` is not 1 or 2'], setup: async () => {}, call: (h, x) => h.place('o', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.order('o'), (h) => h.stock(), inFlight] },
  { task: 'T3', from: 0, method: 'authorize', brief: 'amount: 1 or 2', says: ['Refused if `amount` is not 1 or 2'], setup: async () => {}, call: (h, x) => h.authorize('q', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('q'), effects] },
  { task: 'T3', from: 0, to: 0, method: 'capture', brief: 'amount: 1 or 2', says: ['takes `amount` (1 or 2 units) of an authorized payment', 'Refused otherwise.'], setup: authorized, call: (h, x) => h.capture('p', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  { task: 'T3', from: 1, method: 'capture (1 to 3)', brief: 'amount: 1 to 3 (change 1)', says: ['now takes 1 to 3 units', 'Refused otherwise.'], setup: authorized, call: (h, x) => h.capture('p', x), outside: [0, 4, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  { task: 'T3', from: 0, method: 'refund', brief: 'amount: 1 or 2', says: ['returns `amount` (1 or 2 units) of a captured payment', 'Refused otherwise.'], setup: async (h) => { await authorized(h); await must(h.capture('p', 2), "capture('p', 2)"); }, call: (h, x) => h.refund('p', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.payment('p'), effects] },
  ...['taskStarted', 'taskCompleted', 'taskFailed', 'taskEvicted', 'taskRequeued'].map((method) => ({ task: 'T5', from: 0, method, brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: started, call: (h, x) => h[method]('r', x), outside: [3, -1], inside: method === 'taskStarted' ? 0 : null, queries: [(h) => h.run('r')] })),
  { task: 'T5', from: 1, method: 'taskRetried', brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: started, call: (h, x) => h.taskRetried('r', x), outside: [3, -1], inside: null, queries: [(h) => h.run('r')] },
  { task: 'T5', from: 2, method: 'cancelTask', brief: 'task: 0, 1 or 2', says: ['a command naming a task other than 0, 1 or 2'], setup: started, call: (h, x) => h.cancelTask('r', x), outside: [3, -1], inside: 0, queries: [(h) => h.run('r')] },
  { task: 'T6', from: 0, method: 'submit', brief: 'maxTries: 1 to 3', says: ['Refused if `maxTries` is outside 1 to 3'], setup: async () => {}, call: (h, x) => h.submit('j', x), outside: [0, 4, -1], inside: 3, queries: [(h) => h.job('j')] },
  { task: 'T7', from: 2, method: 'taskTimeout', brief: 'task: 0 or 1 (change 2)', says: ['for task 0 or 1', 'Refused otherwise.'], setup: async (h) => must(h.start(), 'start()'), call: (h, x) => h.taskTimeout(x), outside: [2, -1], inside: 0, queries: [(h) => h.run(), inFlight] },
  { task: 'T7', from: 3, method: 'workDone', brief: 'items: 1 or 2 (change 3)', says: ['Refused if `items` is not 1 or 2'], setup: async (h) => { await must(h.start(), 'start()'); await h.deliverAll(); }, call: (h, x) => h.workDone('worker0', x), outside: [0, 3, -1], inside: 1, queries: [(h) => h.run(), (h) => h.worker('worker0'), inFlight] },
  { task: 'T8', from: 0, method: 'newerTermSeen', brief: 'term: 1 to 3', says: ['Refused when the term is outside 1 to 3'], setup: async () => {}, call: (h, x) => h.newerTermSeen(x), outside: [4, 0, -1], inside: 2, queries: [(h) => h.node()] },
  { task: 'T8', from: 1, method: 'voteRequested (term)', brief: 'term: 1 to 3 (change 1)', says: ['a request with any other candidate or term is refused'], setup: async () => {}, call: (h, x) => h.voteRequested('n1', x), outside: [0, 4, -1], inside: 1, queries: [(h) => h.node()] },
  { task: 'T8', from: 1, method: 'voteRequested (candidate)', brief: 'candidate: "n1" or "n2" (change 1)', says: ['a request with any other candidate or term is refused'], setup: async () => {}, call: (h, x) => h.voteRequested(x, 1), outside: ['n0', 'n3', 'itself', 'nobody'], inside: 'n2', queries: [(h) => h.node()] },
];

/** The entries that apply to version n of a task. */
export const rangesOf = (task, n) => RANGES.filter((r) => r.task === task && n >= r.from && n <= (r.to ?? Infinity));

/** The name of an O1-R test: the call it makes, as a caller writes it. */
export const testName = (r, x) => `${r.method.replace(/ \(.*\)$/, '')}(${typeof x === 'string' ? `'${x}'` : x}) is refused and changes nothing`;
