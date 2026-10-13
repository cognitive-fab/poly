// plan-e3.md E3.9, option A: the program that runs inside the no-network container. The host's exec transport (and the oracle)
// send it one JSON request on the standard input and read one JSON reply on the standard output:
//
//   { op: 'seed' }                           copy the build seeds (Go module and build caches) to the writable volume, once
//   { op: 'prepare', task, run }             a scratch copy of the task in its starting state -> { copy }
//   { op: 'calls', copy, calls }             a turn's tool calls, run in that copy -> { text, exitStatus }
//   { op: 'check', copy, task, stage }       the stage's check in that copy -> { passed, text, exitStatus }
//   { op: 'prove', task, run }               the oracle for one task -> { problems, stages }
//
// It is the same code as on the host (tasks.mjs and world.mjs), so the three rules hold the same way: scratch copies only, a
// built environment with no key and offline toolchains, and the list of declared runners. What the container adds is what the
// host cannot give: no network at all, a read-only root and no mount of the host. A copy must be under the scratch folder.
import { cpSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SCRATCH, prepare, prove, runCheck, taskOf } from '../host/tasks.mjs';
import { runCalls } from '../host/world.mjs';

const SEED = '/opt/seed';
const GOPATH = join(SCRATCH, '.gopath');

let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);

// the Go module cache is read with -mod=readonly and GOPROXY=off from the volume copy (tasks.mjs passes GOPATH on)
process.env.GOPATH = GOPATH;
// vitest writes a cache into node_modules/.vite, and the image is read-only: the copies link to a writable copy of the packages
const NODE_MODULES = join(SCRATCH, '.nm', 'node_modules'); // the real path must end in node_modules, or Node finds no package above it
process.env.E3_NODE_MODULES = NODE_MODULES;

const underScratch = (p) => {
  const r = resolve(String(p));
  if (!r.startsWith(SCRATCH + sep)) throw new Error(`${p} is outside the scratch folder`);
  return r;
};

async function handle(r) {
  switch (r.op) {
    case 'seed': {
      if (!existsSync(GOPATH)) cpSync(join(SEED, 'gopath'), GOPATH, { recursive: true });
      if (!existsSync(NODE_MODULES)) cpSync('/opt/todo-app/node_modules', NODE_MODULES, { recursive: true, verbatimSymlinks: true });
      if (!existsSync(join(SCRATCH, '.gocache'))) cpSync(join(SEED, 'gocache'), join(SCRATCH, '.gocache'), { recursive: true });
      return { seeded: true };
    }
    case 'prepare': {
      const { copy } = prepare(String(r.task), String(r.run));
      return { copy };
    }
    case 'calls':
      return runCalls(underScratch(r.copy), String(r.calls));
    case 'check': {
      const stage = taskOf(String(r.task)).stages[Number(r.stage)];
      if (!stage) throw new Error(`the task has no stage ${r.stage}`);
      const c = await runCheck(underScratch(r.copy), stage);
      return { passed: c.passed, text: `${c.stdout}${c.stderr}`, exitStatus: c.status ?? 1 };
    }
    case 'prove': {
      const p = await prove(String(r.task), { run: String(r.run) });
      return { problems: p.problems, stages: p.stages };
    }
    default:
      throw new Error(`unknown op ${JSON.stringify(r.op)}`);
  }
}

try {
  process.stdout.write(`${JSON.stringify(await handle(req))}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ error: e.message })}\n`);
  process.exitCode = 1;
}
