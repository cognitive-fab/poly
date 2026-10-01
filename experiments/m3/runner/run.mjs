// One run of one arm on one task (plan-m3 section 6): a fresh workspace, the prompt skeleton filled with the
// arm's sections, the base brief and then each change as a further turn of the same session, the whole stream
// journaled, and the delivery copied out after every turn. Scoring is separate (score.mjs), outside the
// workspace.
//
// Usage: node experiments/m3/runner/run.mjs --arm 1..4 --task T1 --model <id> --tokens <budget> --wall <seconds>
//          --out <dir> [--run <index>] [--stub <script.json>] [--max-budget-usd <n>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { M3, versions } from '../lib/task.mjs';
import { currentEnvironment, environmentDiff, isExactModelId } from '../lib/environment.mjs';
import { changeSources, deliveryFiles, listFiles, makeWorkspace, takeDelivery } from './workspace.mjs';
import { runTurn } from './agent.mjs';

const sha = (t) => createHash('sha256').update(t).digest('hex');

/** The digest of a delivery's current files in the workspace, to snapshot it only when it changed. */
function deliveryDigest(ws, arm) {
  const h = createHash('sha256');
  for (const f of deliveryFiles(arm)) {
    if (!existsSync(join(ws, f))) continue;
    const files = statSync(join(ws, f)).isDirectory() ? listFiles(join(ws, f)).map((x) => join(f, x)) : [f];
    for (const x of files) h.update(x).update(readFileSync(join(ws, x)));
  }
  return h.digest('hex');
}

/** The arm's Language, Tools and Delivery sections, from prompts/arms/arm<n>.md. */
export function armSections(arm) {
  const text = readFileSync(join(M3, 'prompts', 'arms', `arm${arm}.md`), 'utf8');
  const part = (name) => {
    const m = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text);
    if (!m) throw new Error(`arm${arm}.md has no ${name} section`);
    return m[1].trim();
  };
  return { LANGUAGE: part('Language'), TOOLS: part('Tools'), DELIVERY: part('Delivery') };
}

const fill = (template, values) => template.replace(/\{\{([A-Z]+)\}\}/g, (_, k) => { if (!(k in values)) throw new Error(`no value for {{${k}}}`); return values[k]; });

/** The prompt of turn n: the skeleton for the base brief, the change template for a change. */
export function promptOf(arm, version) {
  const host = readFileSync(version.hostFile, 'utf8').trim();
  if (version.n === 0) return fill(readFileSync(join(M3, 'prompts', 'skeleton.md'), 'utf8'), { BRIEF: readFileSync(version.briefs[0], 'utf8').trim(), HOST: host, ...armSections(arm) });
  return fill(readFileSync(join(M3, 'prompts', 'change.md'), 'utf8'), { CHANGE: readFileSync(version.briefs[version.n], 'utf8').trim(), HOST: host });
}

export async function runOne({ arm, task, run = 1, model, tokens, wallMs, out, agent, maxBudgetUsd }) {
  const id = `${task}-arm${arm}-run${run}`;
  const dir = join(out, id);
  const ws = join(tmpdir(), 'poly-m3-ws', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const vs = versions(task);
  const { files } = makeWorkspace(ws, arm, vs[0]);
  const journal = join(dir, 'journal.jsonl');
  const record = { id, arm, task, run, model, budget: { tokens, wallMs }, agent: agent.kind, started: new Date().toISOString(), workspace: files, versions: [] };
  let sessionId = null;
  let spent = { tokens: 0, wallMs: 0 };
  let stopped = null;
  for (const v of vs) {
    if (v.n > 0) {
      for (const s of changeSources(v)) copyFileSync(s.from, join(ws, s.to));
    }
    const prompt = promptOf(arm, v);
    if (stopped) { record.versions.push({ n: v.n, attempted: false, reason: `the run's ${stopped} was spent` }); continue; }
    let last = deliveryDigest(ws, arm);
    let k = 0;
    const onToolResult = () => {
      const now = deliveryDigest(ws, arm);
      if (now === last) return;
      last = now;
      takeDelivery(ws, arm, join(dir, 'snapshots', `v${v.n}`, String(++k)));
    };
    const t = await runTurn({ agent, ws, journal, arm, model, prompt, sessionId, turn: v.n, maxBudgetUsd, onToolResult, limits: { tokens: tokens - spent.tokens, wallMs: wallMs - spent.wallMs } });
    sessionId = t.sessionId;
    spent = { tokens: spent.tokens + t.tokens, wallMs: spent.wallMs + t.wallMs };
    stopped = t.stopped;
    const taken = takeDelivery(ws, arm, join(dir, 'deliveries', `v${v.n}`));
    record.versions.push({ n: v.n, attempted: true, promptSha256: sha(prompt), usage: t.usage, tokens: t.tokens, wallMs: t.wallMs, stopped: t.stopped, exitCode: t.exitCode, delivered: taken, snapshots: k });
  }
  record.spent = spent;
  record.finished = new Date().toISOString();
  writeFileSync(join(dir, 'run.json'), JSON.stringify(record, null, 2) + '\n');
  rmSync(ws, { recursive: true, force: true });
  return { dir, record };
}

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arm = Number(flag('arm'));
  const task = flag('task');
  if (![1, 2, 3, 4].includes(arm) || !task || !flag('model') || !flag('tokens') || !flag('wall') || !flag('out')) {
    console.error('usage: run.mjs --arm 1..4 --task T1 --model <id> --tokens <budget> --wall <seconds> --out <dir> [--run <i>] [--stub <script.json>] [--max-budget-usd <n>]');
    process.exit(64);
  }
  const stub = flag('stub');
  const agent = stub ? { kind: 'stub', turns: JSON.parse(readFileSync(stub, 'utf8')).turns } : { kind: 'claude' };
  // A real run spends money: a pilot runs only on a practice task (P1, ...) once the owner writes
  // experiments/m3/PILOT, and a run of T1 to T10 only once the owner approves the freeze and writes FROZEN.
  // S116: a run, a pilot included, needs the environment freeze.json records, with the model given by its exact id.
  if (!stub) {
    const model = flag('model');
    const recorded = JSON.parse(readFileSync(join(M3, 'freeze.json'), 'utf8')).environment;
    const current = currentEnvironment({ model });
    const differs = environmentDiff(recorded, current);
    if (!isExactModelId(model) || differs.length) {
      if (!isExactModelId(model)) console.error(`environment: the model must be an exact id, never an alias: ${model}`);
      for (const k of differs) console.error(`environment differs from freeze.json in ${k}: recorded ${JSON.stringify(recorded?.[k])}, now ${JSON.stringify(current[k])}`);
      process.exit(2);
    }
  }
  const practice = /^P\d+$/.test(task);
  const gate = practice ? 'PILOT' : 'FROZEN';
  if (!stub && !existsSync(join(M3, gate))) { console.error(practice ? 'a pilot run needs the owner\'s approval (experiments/m3/PILOT)' : 'a real run needs the freeze (experiments/m3/FROZEN), which the owner approves'); process.exit(2); }
  const { dir } = await runOne({ arm, task, run: Number(flag('run') ?? 1), model: flag('model'), tokens: Number(flag('tokens')), wallMs: Number(flag('wall')) * 1000, out: flag('out'), agent, maxBudgetUsd: flag('max-budget-usd') ? Number(flag('max-budget-usd')) : undefined });
  console.log(dir);
}
