#!/usr/bin/env node
// The launcher of the demo (DF1 to DF9): the concierge's demo copy, checked and admitted, the room page served, the local stand-in
// for Stripe, the staff panel, and the presenter's prompt.
//
//   node demo/launch.mjs [--recorded | --live --cap-usd <dollars> | --stub-model --cap-usd <dollars>] [--port 8080] [--lan] [--size 40]
//
// --recorded (the default) answers every model call from the recorded fixture, which holds seven messages; a message it does not hold
// fails the call, as a provider with no answer does. --live uses the model providers of DF6: it refuses to start while the price tables
// are placeholders (the owner reads the vendor's page first), and it reads the model key from the environment once, here, and sends it
// as a header, nowhere else. Neither mode touches a payment provider: Stripe is a local stand-in at every stage, labelled a mock-up.
//
// The room listens on the loopback unless --lan is given; the presenter's routes answer the loopback only, with a token made at start
// and shown here and nowhere else. The presenter's prompt: status, staff, approve <intent>, kill, quit.
//
// DF10: --live and --stub-model need --cap-usd, at most 10 dollars. The spend never exceeds it, the room stops when it is reached, and a
// spend line follows each reply. --stub-model runs the live path over a local stub: no key, no network.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assembleDemo, LaunchRefused, modelSide } from './host/assemble.mjs';
import { formatLatency, measureLatency } from './host/latency.mjs';
import { recordedOrdersOf } from './host/recorded-orders.mjs';
import { formatSpend, parseCap } from './host/spend.mjs';
import { openRunLog } from './host/run-log.mjs';
import { runApprove } from './host/approval.mjs';
import { runResolve } from './host/resolve.mjs';
import { startRoomServer } from './host/server.mjs';
import { liveTransport } from './host/live-transport.mjs';
import { DEMO_TIMEOUTS, makeDemoConcierge } from './scripts/make-demo-concierge.mjs';
import { runAgainWithHeap } from './scripts/heap-reexec.mjs';

/** The launcher's arguments, strictly: an unknown flag or a bad port is an error. */
export function parseArgs(argv) {
  const out = { mode: 'recorded', port: 8080, lan: false, size: 40, standInFault: null };
  let chose = null;
  let cap = null;
  let stubLatency = null;
  let runs = null;
  let measure = false;
  let logFile = null;
  const whole = (flag, v, lo, hi) => {
    if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw new LaunchRefused(`${flag} is a whole number of ${lo} to ${hi}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recorded' || a === '--live' || a === '--stub-model') {
      if (chose && chose !== a) throw new LaunchRefused('give either --recorded, --live or --stub-model, not several');
      chose = a;
      out.mode = a.slice(2);
    } else if (a === '--lan') out.lan = true;
    else if (a === '--cap-usd') cap = parseCap(argv[++i]);
    else if (a === '--stub-latency') stubLatency = whole(a, argv[++i], 0, 60000);
    else if (a === '--measure-latency') measure = true;
    else if (a === '--stand-in-fault') {
      const v = argv[++i];
      if (v !== 'lost-all' && v !== 'down') throw new LaunchRefused(`--stand-in-fault names lost-all or down, not ${v}`);
      out.standInFault = v;
    }
    else if (a === '--runs') runs = whole(a, argv[++i], 1, 20);
    else if (a === '--log') {
      const v = argv[++i];
      if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw new LaunchRefused('--log needs the path of a file: --log <file>');
      logFile = v;
    }
    else if (a === '--port' || a === '--size') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || (a === '--port' && n > 65535) || (a === '--size' && n > 99)) throw new Error(`${a} is a whole number${a === '--port' ? ' of 1 to 65535: the port' : ' of 1 to 99: the personas'}`);
      out[a.slice(2)] = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out.mode !== 'recorded' && cap === null) throw new LaunchRefused('a live or stub launch needs a spend cap: --cap-usd <dollars>, at most 10');
  if (cap !== null && out.mode === 'recorded') throw new LaunchRefused('--cap-usd applies to a live or stub launch: a recorded run spends nothing');
  if (out.standInFault !== null && out.mode === 'live') throw new LaunchRefused('--stand-in-fault applies to --recorded or --stub-model: a live show has no fault');
  if (logFile !== null && measure) throw new LaunchRefused('--log applies to a room launch, not to --measure-latency');
  if (logFile !== null && !existsSync(dirname(resolvePath(logFile)))) throw new LaunchRefused(`--log: the folder of ${logFile} does not exist`);
  if (stubLatency !== null && out.mode !== 'stub-model') throw new LaunchRefused('--stub-latency applies to --stub-model alone');
  if (measure && out.mode === 'recorded') throw new LaunchRefused('--measure-latency applies to --live or --stub-model');
  if (runs !== null && !measure) throw new LaunchRefused('--runs applies to --measure-latency alone');
  if (cap !== null) out.capUsd = cap;
  if (stubLatency !== null) out.stubLatencyMs = stubLatency;
  if (logFile !== null) out.logFile = logFile;
  if (measure) { out.measureLatency = true; out.runs = runs ?? 5; }
  return out;
}

const DEMO_SOURCE = fileURLToPath(new URL('./concierge', import.meta.url));
const RECORDED_ANSWERS = fileURLToPath(new URL('../test/fixtures/concierge/answers.json', import.meta.url));

const lanAddresses = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

export async function main(argv, io = {}) {
  io = { out: (s) => console.log(s), err: (s) => console.error(s), env: process.env, ...io };
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof LaunchRefused) { io.err(`refused: ${e.message}`); return 2; }
    throw e;
  }
  let apiKey = null;
  if (args.mode === 'live') apiKey = io.env.ANTHROPIC_API_KEY ?? null;

  // DF12 item 6: the latency of a whole call of each tier, from the owner's own run. No copy is admitted and no room is started.
  if (args.measureLatency) {
    try {
      const side = modelSide({ mode: args.mode, source: DEMO_SOURCE, apiKey, modelTransport: args.mode === 'live' ? liveTransport() : null, capUsd: args.capUsd, stubLatencyMs: args.stubLatencyMs ?? 0 });
      io.out(`Measuring ${args.runs} whole calls of each tier (a vote of 5 asks, as the room makes it).`);
      for (const line of formatLatency(await measureLatency({ providers: side.providers, models: side.models, runs: args.runs }), DEMO_TIMEOUTS)) io.out(line);
      io.out(formatSpend(side.meter));
      return 0;
    } catch (e) {
      if (e instanceof LaunchRefused) { io.err(`refused: ${e.message}`); return 2; }
      io.err(`measurement stopped: ${e.message}`);
      return 1;
    }
  }
  const workdir = mkdtempSync(join(tmpdir(), 'poly-demo-run-'));

  io.out('Printing what differs from examples/concierge (the demo copy is produced by demo/scripts/make-demo-concierge.mjs):');
  const scratch = mkdtempSync(join(tmpdir(), 'poly-demo-copy-'));
  try { io.out(makeDemoConcierge({ out: scratch }).diff); } finally { rmSync(scratch, { recursive: true, force: true }); }

  // DF15 item 5: the run log. Each line the launcher prints for a failure, a spend or a status is also written to the owner's file.
  const log = args.logFile ? openRunLog(args.logFile) : null;
  const onFailureLine = (line) => { io.err(line); log?.line(line); };
  const spendLine = (text) => { io.out(text); log?.line(text); };
  let demo;
  try {
    io.out('Checking and admitting the demo copy (this takes a few minutes) ...');
    demo = await assembleDemo({
      // DF11 item 3: the recorded room's first two guests own the orders its recorded answers cite.
      ordersOf: args.mode === 'recorded' ? recordedOrdersOf(JSON.parse(readFileSync(RECORDED_ANSWERS, 'utf8'))) : null,
      mode: args.mode, workdir, apiKey, modelTransport: args.mode === 'live' ? liveTransport() : null, size: args.size, standInFault: args.standInFault ?? 'none', startWorkers: true, capUsd: args.capUsd ?? null, stubLatencyMs: args.stubLatencyMs ?? 0,
      onFailure: onFailureLine,
      onReply: () => { if (demo?.meter) spendLine(formatSpend(demo.meter)); },
      onKill: (by) => { if (by === 'spend-cap' && demo?.meter) spendLine(`spend cap reached: ${formatSpend(demo.meter)}. The room has stopped.`); },
    });
  } catch (e) {
    rmSync(workdir, { recursive: true, force: true });
    if (e instanceof LaunchRefused) { io.err(`refused: ${e.message}`); return 2; }
    throw e;
  }
  const { report } = demo.admission;
  const machines = report.files.flatMap((f) => f.machines ?? []);
  io.out(`The demo copy is ${report.verdict}. Instance: ${machines.map((m) => `${m.machine} ${m.instance?.states ?? '?'} states`).join(', ')}.`);
  io.out(args.mode === 'live' ? `Model calls: LIVE, over the provider named in the price tables. Spend cap: $${args.capUsd.toFixed(2)}.`
    : args.mode === 'stub-model' ? `Model calls: STUB. No model is called and no network is used. Spend is priced from the placeholder tables. Spend cap: $${args.capUsd.toFixed(2)}.${args.stubLatencyMs > 0 ? ` Stub latency: ${args.stubLatencyMs} ms.` : ''}`
      : 'Model calls: RECORDED answers only; no model is called.');
  io.out('Payments: a local mock-up of Stripe on this machine; no real money moves and no Stripe key exists anywhere.');

  const presenterToken = randomBytes(24).toString('hex');
  const server = await startRoomServer({ room: demo.room, staff: demo.staff, presenterToken, host: args.lan ? '0.0.0.0' : '127.0.0.1', port: args.port, limiter: demo.limiter });
  io.out(`Room page:    ${[`http://127.0.0.1:${server.port}/`, ...(args.lan ? lanAddresses().map((a) => `http://${a}:${server.port}/`) : [])].join('   ')}`);
  io.out(`Staff panel:  http://127.0.0.1:${server.port}/presenter/staff?t=${presenterToken}   (this machine only; the token is shown here and nowhere else)`);
  io.out('Presenter prompt: status | staff | approve <intent> | resolve <desk> done|not-done | kill | quit');
  if (args.standInFault) io.out(`The Stripe mock-up has the fault ${args.standInFault}: every refund request is ${args.standInFault === 'down' ? 'answered 503 and applies nothing' : 'applied once and its answer lost'} (a rehearsal; the show has none).`);

  const noticing = setInterval(() => { demo.pumpStaff().catch(() => {}); }, 1000);
  noticing.unref?.();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const statusOf = () => demo.status();
  const stop = async () => { clearInterval(noticing); rl.close(); await server.close(); await demo.close(); rmSync(workdir, { recursive: true, force: true }); };
  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const [cmd, arg, arg2] = line.trim().split(/\s+/);
      try {
        if (cmd === 'status') { const st = await statusOf(); io.out(JSON.stringify(st)); log?.status(st); }
        else if (cmd === 'staff') for (const e of demo.staff.entries()) io.out(`${new Date(e.at).toLocaleTimeString()}  ${e.text}`);
        else if (cmd === 'approve') { const r = await runApprove(demo, arg); io.out(r.line); log?.line(r.line); }
        else if (cmd === 'resolve') { const r = await runResolve(demo, arg, arg2); io.out(r.line); log?.line(r.line); }
        else if (cmd === 'kill') { demo.room.kill('presenter'); io.out('The room has stopped. Nothing more reaches the concierge.'); }
        else if (cmd === 'quit') resolve();
        else if (cmd) io.out('status | staff | approve <intent> | resolve <desk> done|not-done | kill | quit');
      } catch (e) { io.err(`${cmd}: ${e.message}`); }
    });
    rl.on('close', resolve);
  });
  log?.status(await statusOf()); // the final status
  await stop();
  return 0;
}

/**
 * DF26: the check of the Desk (5762 states) runs in this process, and with Node's default heap (about 4.3 GB) it ran out of memory. Below
 * 7000 MB the launcher starts itself again with 8 GB; once re-executed (POLY_DEMO_HEAP_REEXEC) it never does so again.
 */
export function heapArgsFor(limitMb, env = {}) {
  if (limitMb >= 7000 || env.POLY_DEMO_HEAP_REEXEC === '1') return [];
  return ['--max-old-space-size=8192'];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const heap = heapArgsFor(Math.floor(getHeapStatistics().heap_size_limit / (1024 * 1024)), process.env);
  if (heap.length > 0) {
    runAgainWithHeap(process.argv[1], process.argv.slice(2), heap);
  } else {
    main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
  }
}
