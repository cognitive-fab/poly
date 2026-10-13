// plan-e3.md E3.9, option A: the host's control of the no-network container. One command per step, so that each is run, and read,
// on its own:
//
//   node ctl.mjs build       verify the originals' digests, assemble the build context, build the image (the one step that
//                            uses the network: it fetches the locked packages and modules)
//   node ctl.mjs up          create the volume and start the container: --network none, read-only root, no host mount, no
//                            key, a non-root user, memory, cpu and process limits
//   node ctl.mjs oracle      the 31-stage oracle for all 12 tasks, run inside the container, one task at a time
//   node ctl.mjs isolation   host/isolation-check.mjs run inside the container, as the user the commands run as
//   node ctl.mjs down        remove the container and the volume
//
// Nothing here calls a model, and nothing here reads or passes a key. The container is started with an explicit, empty
// environment apart from the variables the image sets.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TASKS_DIR, digestOf, originalOf, originalsUnchanged, repos, snapshot, taskIds } from '../host/tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT = join(ROOT, '.poly', 'e3-image');
export const NAME = 'e3-run';
export const VOLUME = 'e3-work';
export const IMAGE = 'poly-e3-runner';
const SCRATCH_IN = '/opt/poly/.poly';
const RUNNER = '/opt/poly/examples/harness/container/runner.mjs';

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const must = (r, what) => {
  if (r.error || r.status !== 0) throw new Error(`${what} failed: ${r.error?.message ?? ''}${r.stderr ?? ''}${r.stdout ?? ''}`.trim());
  return r;
};

/** The image tag names the digests of the two originals, so a changed original is a new image. */
export const tag = () => `${IMAGE}:${digestOf(Object.keys(repos()).sort().map((n) => [n, repos()[n].digest])).slice(0, 12)}`;

/** The build context: the two originals (the files the digest covers, nothing else), and the host code the runner needs. */
export function assembleContext() {
  const ok = originalsUnchanged();
  for (const [name, same] of Object.entries(ok)) if (!same) throw new Error(`the original ${name} has changed since the tasks were written; no image is built`);
  rmSync(CONTEXT, { recursive: true, force: true });
  for (const name of Object.keys(repos())) {
    for (const [rel] of snapshot(originalOf(name))) {
      const to = join(CONTEXT, 'repos', repos()[name].dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(originalOf(name), rel), to);
    }
  }
  const h = join(CONTEXT, 'poly', 'examples', 'harness');
  for (const f of ['host/tasks.mjs', 'host/world.mjs', 'host/handlers/classify.mjs', 'host/isolation-check.mjs', 'container/runner.mjs']) {
    mkdirSync(dirname(join(h, f)), { recursive: true });
    cpSync(join(ROOT, 'examples', 'harness', f), join(h, f));
  }
  cpSync(TASKS_DIR, join(h, 'tasks'), { recursive: true });
  cpSync(join(HERE, 'Dockerfile'), join(CONTEXT, 'Dockerfile'));
  return CONTEXT;
}

export function build() {
  must(docker(['version', '--format', '{{.Server.Version}}']), 'docker (is Docker Desktop started?)');
  const ctx = assembleContext();
  const r = docker(['build', '--tag', tag(), ctx], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('docker build failed');
  return tag();
}

export function up() {
  down();
  must(docker(['volume', 'create', VOLUME]), 'volume create');
  must(docker([
    'run', '--detach', '--name', NAME, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--mount', `type=volume,source=${VOLUME},target=${SCRATCH_IN}`, '--user', '10001', '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', tag(),
  ]), 'run');
  const seeded = send({ op: 'seed' });
  if (!seeded.seeded) throw new Error(`seed failed: ${JSON.stringify(seeded)}`);
}

export function down() {
  docker(['rm', '--force', NAME]);
  docker(['volume', 'rm', '--force', VOLUME]);
}

/** One request to the runner inside the container. */
export function send(req) {
  const r = docker(['exec', '--interactive', NAME, 'node', RUNNER], { input: JSON.stringify(req) });
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`the runner gave no JSON (status ${r.status}): ${(r.stderr ?? '') + (r.stdout ?? '')}`.slice(0, 2000));
  }
}

export function oracle() {
  const out = [];
  for (const id of taskIds()) {
    const r = send({ op: 'prove', task: id, run: 'oracle' });
    out.push({ id, ...r });
    console.log(`${r.error || r.problems?.length ? 'FAILED' : 'ok    '} ${id} (${r.stages ?? '?'} stages)${r.error ? ` ${r.error}` : ''}${r.problems?.length ? ` ${JSON.stringify(r.problems)}` : ''}`);
  }
  const stages = out.reduce((a, r) => a + (r.stages ?? 0), 0);
  const ok = out.every((r) => !r.error && r.problems?.length === 0);
  console.log(`${ok ? 'oracle passed' : 'oracle FAILED'}: ${out.filter((r) => !r.error && r.problems?.length === 0).length} of ${out.length} tasks, ${stages} stages`);
  return ok;
}

export function isolation() {
  // the container has no route at all; the host's names are added to the always-unreachable list of the check
  const r = docker(['exec', NAME, 'node', '/opt/poly/examples/harness/host/isolation-check.mjs', '--unreachable', 'host.docker.internal:443', '--unreachable', 'host.docker.internal:2375']);
  process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const run = { build: () => { console.log(`built ${build()}`); return true; }, up: () => { up(); console.log(`up: ${NAME}`); return true; }, down: () => { down(); console.log('down'); return true; }, oracle, isolation }[cmd];
  if (!run) {
    console.log('usage: node ctl.mjs build | up | oracle | isolation | down');
    process.exit(2);
  }
  process.exit((await run()) ? 0 : 1);
}
