// plan-e3.md E3.5: a deterministic corpus of twelve recorded trajectories, written for the test (synthetic: no real
// repository, name, secret or model answer). Each is built from steps of a few kinds so that each mechanism has
// opportunities it should take and opportunities it should leave:
//
//   fuse        an edit then a declared runner, a small result       (Action Fusion should fire)
//   noRunner    an edit then a command that is not a declared runner (Action Fusion must not fire)
//   inspect     a command that reads a file, a result of n bytes      (ObservationPack fires when n is over 10 KiB)
//   build       an edit then a build whose log is n bytes              (the Evidence-Preserving Reducer fires from 4 KiB)
//   leak        a build log that holds a known secret                  (flagged: redacted, never read by the cheaper model)
//
// Sizes are bytes of tool output. The window of a run is 6,000 tokens (1,000 a bucket), so a 12 KiB file is three buckets.
import { createHash } from 'node:crypto';

const hashOf = (text) => `sha256:${createHash('sha256').update(Buffer.from(text)).digest('hex')}`;
const EDIT = (n) => ({ tool: 'edit', path: `src/m${n}.ts` });
const calls = (n, command) => JSON.stringify([EDIT(n), { tool: 'bash', command }]);

/** Text of about `bytes` bytes that reads like source code, the same for the same arguments. */
export function code(seed, bytes) {
  const lines = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const l = `export function f${seed}_${i}(x: number): number { return x * ${i + 3} + ${(seed * 7 + i) % 97}; }`;
    lines.push(l);
    size += l.length + 1;
  }
  return lines.join('\n').slice(0, bytes);
}

/** A build log of about `bytes` bytes ending in the error the agent needs, and a receipt (the cheaper model's reading) of it. */
export function buildLog(seed, bytes, { secret = null, badReceipt = false } = {}) {
  const head = ['> build'];
  let size = 8;
  for (let i = 0; size < bytes; i++) {
    const l = `src/m${seed}_${i}.ts: compiled in ${(i * 7) % 90} ms`;
    head.push(l);
    size += l.length + 1;
  }
  if (secret) head.push(`DEBUG token=${secret}`);
  const tail = [`src/m${seed}.ts(3,5): error TS2322: Type string is not assignable to type number.`, 'Found 1 error.'];
  const log = [...head, ...tail].join('\n');
  const quotes = badReceipt ? ['an invented line'] : [tail[0], tail[1]];
  return { log, receipt: JSON.stringify({ sourceHash: hashOf(log), status: 'fail', quotes }) };
}

export const step = {
  fuse: (n) => ({ spec: 'fuse', model: [{ calls: calls(n, 'npm test'), stop: 'Tool', usage: { output: 90 } }], tool: { output: `PASS src/m${n}.test.ts (${n + 3} tests)\n`, exitStatus: 0, log: true }, stage: { passed: true } }),
  noRunner: (n) => ({ spec: 'noRunner', model: [{ calls: calls(n, 'node scripts/check.js'), stop: 'Tool', usage: { output: 90 } }], tool: { output: 'checked 3 files\n', exitStatus: 0, log: false }, stage: { passed: true } }),
  inspect: (n, bytes) => ({ spec: 'inspect', model: [{ calls: JSON.stringify([{ tool: 'bash', command: `cat src/big${n}.ts` }]), stop: 'End', usage: { output: 60 } }], tool: { output: code(n, bytes), exitStatus: 0, log: false }, stage: { passed: true } }),
  build: (n, bytes, opts = {}) => {
    const { log, receipt } = buildLog(n, bytes, opts);
    return { spec: opts.secret ? 'leak' : 'build', model: [{ calls: calls(n, 'npm run build'), stop: 'Tool', usage: { output: 110 } }], tool: { output: log, exitStatus: 1, log: true }, stage: { passed: false }, receipt: opts.secret ? null : receipt };
  },
  cut: (n) => ({ spec: 'fuse', model: [{ calls: '[{"tool":"edit","path":"src/a.ts","new":"export const x = ', stop: 'Length', usage: { output: 400 } }, { calls: calls(n, 'npm test'), stop: 'Tool', usage: { output: 90 } }], tool: { output: 'PASS\n', exitStatus: 0, log: true }, stage: { passed: true } }),
};

/** The corpus: [name, features, steps]. `secret` is the known secret the leaking trajectory's log holds. */
export function trajectories(secret = 'canary-0000000000000000000000ab') {
  const defs = [
    ['t01-fix-tests', 'fuse x2', [step.fuse(1), step.fuse(2)]],
    ['t02-fix-build', 'inspect, build 6 KiB, fuse', [step.inspect(2, 1500), step.build(2, 6000), step.fuse(2)]],
    ['t03-read-big-file', 'inspect 12 KiB, fuse x2, inspect', [step.inspect(3, 12000), step.fuse(3), step.fuse(4), step.inspect(4, 800)]],
    ['t04-big-build-log', 'build 14 KiB, fuse', [step.build(4, 14000), step.fuse(5)]],
    ['t05-rejected-receipt', 'build 6 KiB with a receipt that quotes a line the log lacks, fuse', [step.build(5, 6000, { badReceipt: true }), step.fuse(6)]],
    ['t06-secret-log', 'build 6 KiB holding a known secret, fuse', [step.build(6, 6000, { secret }), step.fuse(7)]],
    ['t07-cutoff', 'a cut-off answer then its reprompt, fuse', [step.cut(7), step.fuse(8)]],
    ['t08-long-session', 'four steps of 5 KiB logs', [step.build(8, 5000), step.build(9, 5000), step.build(10, 5000), step.fuse(9)]],
    ['t09-inspect-only', 'three small reads', [step.inspect(9, 700), step.inspect(10, 900), step.inspect(11, 600)]],
    ['t10-mixed', 'big file, build 7 KiB, fuse, small read', [step.inspect(12, 11000), step.build(11, 7000), step.fuse(10), step.inspect(13, 500)]],
    ['t11-no-runner', 'edit then a command that is not a runner, fuse', [step.noRunner(11), step.fuse(12)]],
    ['t12-many-reads', 'three 11 KiB reads', [step.inspect(14, 11000), step.inspect(15, 11000), step.inspect(16, 11000)]],
  ];
  return defs.map(([name, features, steps]) => ({
    name,
    features,
    recording: {
      task: name.slice(0, 3),
      prompt: `Task ${name}: make the failing test pass.`,
      steps: steps.map(({ spec, receipt, ...s }) => s),
      receipts: steps.filter((s) => s.receipt).map((s) => s.receipt),
      summaries: Array.from({ length: 4 }, () => 'Summary: the files were edited, the build errors were read, the tests pass for the finished steps.'),
    },
    specs: steps.map((s) => s.spec),
  }));
}
