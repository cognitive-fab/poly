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
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assembleDemo, LaunchRefused } from './host/assemble.mjs';
import { formatSpend, parseCap } from './host/spend.mjs';
import { startRoomServer } from './host/server.mjs';
import { liveTransport } from './host/live-transport.mjs';
import { makeDemoConcierge } from './scripts/make-demo-concierge.mjs';

/** The launcher's arguments, strictly: an unknown flag or a bad port is an error. */
export function parseArgs(argv) {
  const out = { mode: 'recorded', port: 8080, lan: false, size: 40 };
  let chose = null;
  let cap = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recorded' || a === '--live' || a === '--stub-model') {
      if (chose && chose !== a) throw new LaunchRefused('give either --recorded, --live or --stub-model, not several');
      chose = a;
      out.mode = a.slice(2);
    } else if (a === '--lan') out.lan = true;
    else if (a === '--cap-usd') cap = parseCap(argv[++i]);
    else if (a === '--port' || a === '--size') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || (a === '--port' && n > 65535) || (a === '--size' && n > 99)) throw new Error(`${a} is a whole number${a === '--port' ? ' of 1 to 65535: the port' : ' of 1 to 99: the personas'}`);
      out[a.slice(2)] = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out.mode !== 'recorded' && cap === null) throw new LaunchRefused('a live or stub launch needs a spend cap: --cap-usd <dollars>, at most 10');
  if (cap !== null && out.mode === 'recorded') throw new LaunchRefused('--cap-usd applies to a live or stub launch: a recorded run spends nothing');
  if (cap !== null) out.capUsd = cap;
  return out;
}

const lanAddresses = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

export async function main(argv, io = {}) {
  io = { out: (s) => console.log(s), err: (s) => console.error(s), env: process.env, ...io };
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof LaunchRefused) { io.err(`refused: ${e.message}`); return 2; }
    throw e;
  }
  const workdir = mkdtempSync(join(tmpdir(), 'poly-demo-run-'));
  let apiKey = null;
  if (args.mode === 'live') apiKey = io.env.ANTHROPIC_API_KEY ?? null;

  io.out('Printing what differs from examples/concierge (the demo copy is produced by demo/scripts/make-demo-concierge.mjs):');
  const scratch = mkdtempSync(join(tmpdir(), 'poly-demo-copy-'));
  try { io.out(makeDemoConcierge({ out: scratch }).diff); } finally { rmSync(scratch, { recursive: true, force: true }); }

  let demo;
  try {
    io.out('Checking and admitting the demo copy (this takes a few minutes) ...');
    demo = await assembleDemo({
      mode: args.mode, workdir, apiKey, modelTransport: args.mode === 'live' ? liveTransport() : null, size: args.size, startWorkers: true, capUsd: args.capUsd ?? null,
      onReply: () => { if (demo?.meter) io.out(formatSpend(demo.meter)); },
      onKill: (by) => { if (by === 'spend-cap' && demo?.meter) io.out(`spend cap reached: ${formatSpend(demo.meter)}. The room has stopped.`); },
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
    : args.mode === 'stub-model' ? `Model calls: STUB. No model is called and no network is used. Spend is priced from the placeholder tables. Spend cap: $${args.capUsd.toFixed(2)}.`
      : 'Model calls: RECORDED answers only; no model is called.');
  io.out('Payments: a local mock-up of Stripe on this machine; no real money moves and no Stripe key exists anywhere.');

  const presenterToken = randomBytes(24).toString('hex');
  const server = await startRoomServer({ room: demo.room, staff: demo.staff, presenterToken, host: args.lan ? '0.0.0.0' : '127.0.0.1', port: args.port, limiter: demo.limiter });
  io.out(`Room page:    ${[`http://127.0.0.1:${server.port}/`, ...(args.lan ? lanAddresses().map((a) => `http://${a}:${server.port}/`) : [])].join('   ')}`);
  io.out(`Staff panel:  http://127.0.0.1:${server.port}/presenter/staff?t=${presenterToken}   (this machine only; the token is shown here and nowhere else)`);
  io.out('Presenter prompt: status | staff | approve <intent> | kill | quit');

  const noticing = setInterval(() => { demo.pumpStaff().catch(() => {}); }, 1000);
  noticing.unref?.();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = async () => { clearInterval(noticing); rl.close(); await server.close(); await demo.close(); rmSync(workdir, { recursive: true, force: true }); };
  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const [cmd, arg] = line.trim().split(/\s+/);
      try {
        if (cmd === 'status') io.out(JSON.stringify({ ...demo.room.stats(), stripe: demo.standIn.report(), ...(demo.meter ? { spend: formatSpend(demo.meter) } : {}) }));
        else if (cmd === 'staff') for (const e of demo.staff.entries()) io.out(`${new Date(e.at).toLocaleTimeString()}  ${e.text}`);
        else if (cmd === 'approve' && arg) io.out(JSON.stringify(await demo.approve(arg)));
        else if (cmd === 'kill') { demo.room.kill('presenter'); io.out('The room has stopped. Nothing more reaches the concierge.'); }
        else if (cmd === 'quit') resolve();
        else if (cmd) io.out('status | staff | approve <intent> | kill | quit');
      } catch (e) { io.err(`${cmd}: ${e.message}`); }
    });
    rl.on('close', resolve);
  });
  await stop();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
