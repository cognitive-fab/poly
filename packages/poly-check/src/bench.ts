// `poly bench gate` (PT9.6, AC4, M5a step 10): the gate's latency and throughput, measured and reported with no pass
// threshold. The program is AC4's (conformance/m5/orders.poly under orders.policy.poly), admitted into a directory
// outside the repository with an admission key generated for the run (S126). Each order takes Reserve then Charge, so
// each instance proposes two effects, both allowed.
//
//   latency     p50 and p99 of propose (PT9.1 to PT9.3), settle (PT9.4), and the whole path from the proposal to the
//               end of its settle, which includes the handler;
//   throughput  effects per second from the first dispatch to the last settle, for 1, 8 and 64 instances:
//               `runtime` runs the program with no policy (the allow-all gate), so the runtime's own path is the
//               baseline; `session` runs it under the policy gate. The program has one trust scope, so every run is
//               in the one session `scope:orders`, and the `session` series is PT9.6's per-session throughput.
//
// Without the Polyaxion peer the `session` series and the gate latencies are listed as not run, never left out.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { admit } from './admit.js';

export const BENCH_SIZES = [1, 8, 64] as const;
const SOURCES = ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly'];
const KINDS = ['stock.reserve', 'payment.charge', 'payment.fee'];

export interface Percentiles { n: number; p50: number; p99: number }
export interface Throughput { instances: number; effects: number; allowed: number; ms: number; perSecond: number }
export interface GateBench {
  bench: 'gate';
  at: string;
  machine: { cpu: string; cores: number; platform: string; arch: string; memoryGb: number };
  node: string;
  program: { sources: string[]; digest: string; scope: string; session: string };
  sizes: number[];
  latencyMs: { propose: Percentiles; settle: Percentiles; path: Percentiles } | { notRun: string };
  throughput: { runtime: Throughput[]; session: Throughput[] | { notRun: string } };
  note: string;
}

const pct = (xs: number[]): Percentiles => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))].toFixed(3)) : 0);
  return { n: s.length, p50: at(0.5), p99: at(0.99) };
};

async function project(root: string, name: string, sources: string[], repo: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const s of sources) copyFileSync(join(repo, s), join(dir, 'src', s.split('/').pop()!));
  writeFileSync(join(dir, 'src', 'handlers.ts'), 'export async function handle(): Promise<unknown> { return {}; }\n');
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'], handlers: ['src/handlers.ts'] }, null, 2));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = `bench-${name}`;
  const r = await admit(dir, { key: { id, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  return { build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [id]: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
}

/** One run of n orders; the gate's calls are timed by wrapping the worker's gate. */
async function series(admitted: Awaited<ReturnType<typeof project>>, n: number, timings: { propose: number[]; settle: number[]; path: number[] } | null): Promise<Throughput> {
  const { load } = await import('@poly/runtime');
  const rt = await load(admitted.build, { certificate: admitted.certificate, trust: admitted.trust, worker: { batch: 4 * n + 8 } });
  try {
    const handle = rt.handlerExports('src/handlers.ts').handle as never;
    for (const k of KINDS) rt.handle(k, handle);
    const w = rt.worker as unknown as { gate: { propose: (p: { idempotencyKey: string }, s: unknown) => unknown; settle: (o: unknown, p: { idempotencyKey: string }) => unknown } };
    const inner = w.gate;
    const started = new Map<string, number>();
    w.gate = {
      propose: async (p, s) => {
        const t = performance.now();
        const r = await inner.propose(p, s);
        if (timings) { timings.propose.push(performance.now() - t); started.set(p.idempotencyKey, t); }
        return r;
      },
      settle: async (o, p) => {
        const t = performance.now();
        const r = await inner.settle(o, p);
        const end = performance.now();
        if (timings) { timings.settle.push(end - t); const s0 = started.get(p.idempotencyKey); if (s0 !== undefined) timings.path.push(end - s0); }
        return r;
      },
    };
    const ids = Array.from({ length: n }, (_, i) => `o${i}`);
    for (const id of ids) await rt.create('orders.Order', { id });
    const t0 = performance.now();
    for (const id of ids) await rt.dispatch(id, 'Reserve', {});
    for (const id of ids) await rt.dispatch(id, 'Charge', {});
    for (let guard = 0; guard < 100 && (await rt.worker.tick()) > 0; guard++);
    const ms = performance.now() - t0;
    let allowed = 0;
    for (const id of ids) allowed += (await rt.chain(id)).filter((e: { kind: string; body?: { outcome?: string } }) => e.kind === 'verdict' && e.body?.outcome === 'allowed').length;
    return { instances: n, effects: 2 * n, allowed, ms: Number(ms.toFixed(3)), perSecond: Number(((2 * n) / (ms / 1000)).toFixed(1)) };
  } finally { await rt.close(); }
}

/** Runs the bench; `repo` is the checkout holding the AC4 sources. Writes the result to `out` when given. */
export async function benchGate(opts: { repo: string; sizes?: readonly number[]; out?: string }): Promise<GateBench> {
  const sizes = [...(opts.sizes ?? BENCH_SIZES)];
  const { polyaxionPeer } = await import('@poly/runtime');
  const peer = polyaxionPeer();
  const root = mkdtempSync(join(tmpdir(), 'poly-bench-'));
  try {
    const plain = await project(root, 'bench-runtime', [SOURCES[0]], opts.repo);
    const runtime: Throughput[] = [];
    for (const n of sizes) runtime.push(await series(plain, n, null));
    let latencyMs: GateBench['latencyMs'] = { notRun: `the gate engine is not available: ${peer.ok ? '' : peer.reason}` };
    let session: GateBench['throughput']['session'] = { notRun: `the gate engine is not available: ${peer.ok ? '' : peer.reason}` };
    if (peer.ok) {
      const gated = await project(root, 'bench-gate', SOURCES, opts.repo);
      const timings = { propose: [] as number[], settle: [] as number[], path: [] as number[] };
      session = [];
      for (const n of sizes) session.push(await series(gated, n, timings));
      latencyMs = { propose: pct(timings.propose), settle: pct(timings.settle), path: pct(timings.path) };
    }
    const digest = createHash('sha256');
    for (const s of SOURCES) digest.update(readFileSync(join(opts.repo, s)));
    const result: GateBench = {
      bench: 'gate',
      at: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, platform: platform(), arch: arch(), memoryGb: Math.round(totalmem() / 2 ** 30) },
      node: process.version,
      program: { sources: SOURCES, digest: `sha256:${digest.digest('hex')}`, scope: 'orders', session: 'scope:orders' },
      sizes,
      latencyMs,
      throughput: { runtime, session },
      note: 'A measurement with no pass threshold (AC4). In-memory SQLite stores, one process, one worker; each tick claims every pending intent and runs them in turn. Latencies are over every proposal of every size. The program has one trust scope, so the session series is per-session throughput (PT9.6).',
    };
    if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
