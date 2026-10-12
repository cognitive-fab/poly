// plan-e3.md E3.4: recordings and a runner shared by the loop tests. A recording is a task as one recorded run saw it
// (examples/harness/host/loop.mjs); the model, the tool and the stage checks are all recorded, so nothing here calls out.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { admittedHarness, loaded } from './e3-runtime-helpers.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { runTask } from '../../examples/harness/host/loop.mjs';
import { hashOf } from '../../examples/harness/host/handlers/verify.mjs';

/** The cache write/read price ratio of the main tier's price table: what the pay-gate prices a cache rewrite with (SoL-Pi, 2.4). */
const MAIN_PRICES = JSON.parse(readFileSync(join(ROOT, 'examples', 'harness', 'prices', 'main.json'), 'utf8')).perMillionTokens;
export const CACHE_RATIO = MAIN_PRICES.cache_write / MAIN_PRICES.cache_read;

export const MODELS = { main: 'main-tier-placeholder', cheap: 'cheap-tier-placeholder' };
const edit = { tool: 'edit', path: 'src/a.ts' };
export const FUSED = JSON.stringify([edit, { tool: 'bash', command: 'npm test' }]);
export const APART = JSON.stringify([{ tool: 'bash', command: 'cat src/a.ts' }]);
export const CUT = '[{"tool":"edit","path":"src/a.ts","new":"export const x = ';

/** A build log over the reader's threshold, with its receipt: the cheaper model's reading, with exact quotes. */
export function buildLog(extra = '') {
  const log = ['> build', ...Array.from({ length: 220 }, (_, i) => `src/m${i}.ts: compiled in ${i} ms`), extra, 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.', 'Found 1 error.'].filter((l) => l !== '').join('\n');
  const receipt = JSON.stringify({ sourceHash: hashOf(Buffer.from(log)), status: 'fail', quotes: ['error TS2322: Type string is not assignable to type number.', 'Found 1 error.'] });
  return { log, receipt };
}

/** Three steps: a fused edit and test; a cut-off answer, a reprompt and a failing build read by the cheaper model; a command that inspects. */
export function recording(over = {}) {
  const { log, receipt } = buildLog();
  return {
    task: 't1',
    prompt: 'Make the failing test pass.',
    steps: [
      { model: [{ calls: FUSED, stop: 'Tool', grew: 1, usage: { input: 900, output: 120 } }], tool: { output: 'PASS a\nPASS b\n', exitStatus: 0 }, stage: { passed: true } },
      { model: [{ calls: CUT, stop: 'Length', grew: 1 }, { calls: FUSED, stop: 'Tool', grew: 1 }], tool: { output: log, exitStatus: 1 }, stage: { passed: false } },
      { model: [{ calls: APART, stop: 'End', grew: 0 }], tool: { output: 'export const x = 1;\n', exitStatus: 0 }, stage: { passed: true } },
    ],
    summaries: ['summary of the work so far'],
    receipts: [receipt],
    ...over,
  };
}

/** Admits the harness, loads it over a memory store, and runs a recording to its end. */
let shared = null;
/** One admission of the unedited module, shared by the tests that need no variant (admission is most of a run's time). */
export const sharedBuild = () => (shared ??= admittedHarness(`e3-shared-${process.pid}`));

export async function run(name, rec = recording(), { edit: editProgram, secrets = [], mechanisms, windowTokens, preamble, cacheRatio = CACHE_RATIO } = {}) {
  const a = editProgram ? await admittedHarness(name, { edit: editProgram }) : await sharedBuild();
  const host = makeHost({ known: secrets });
  const { rt } = await loaded(a, { transports: host.transports });
  const store = host.store;
  const result = await runTask({ rt, host, recording: rec, models: MODELS, ...(mechanisms ? { mechanisms } : {}), ...(windowTokens ? { windowTokens } : {}), ...(preamble ? { preamble } : {}), cacheRatio });
  return { rt, store, host, result, a };
}

/** A canary token and its four encodings (AC18, S554). */
export const canary = () => `canary-${randomBytes(12).toString('hex')}`;
export const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];

/** Every text a run left: each column of each row of the runtime's store, the host's tables, and each file of the project and its build. */
export function outputs(rt, store, dir) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push([`table ${name}`, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]);
  }
  out.push(...store.dump());
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push([p, readFileSync(p, 'latin1')]); } };
  walk(dir);
  return out;
}
/** Where a token, in any of its four encodings, is found. */
export const found = (texts, tokens) => texts.flatMap(([where, text]) => tokens.flatMap((t) => (encodings(t).some((e) => text.includes(e)) ? [where] : [])));
