#!/usr/bin/env node
// demo replay: drives a build of the baseline against the local Stripe stand-in and prints the five numbers (DB6).
//
//   node demo/demo.mjs replay --build <dir> --start "<the command its README gives>" [--fault lost-answer|hold]
//        [--webhook-path /webhook] [--test-command "npm test"] [--quiet-ms 3000] [--json]
//
// Inside the container (container/) the names are mapped by the container, the stand-in listens on 443, and POLY_DEMO_IN_CONTAINER=1
// is set. Exit status: 0 when the build refunded once (O2), 1 when it refunded twice (O1), 3 when it could not be driven (O3), 4 when
// the stand-in failed its own check. Nothing here reaches the network.
import { format, replay } from './driver/replay.mjs';

const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i < 0 ? fallback : rest[i + 1]; };

if (command !== 'replay' || !flag('build') || !flag('start')) {
  console.error('usage: demo replay --build <dir> --start "<command>" [--fault lost-answer|hold] [--webhook-path /webhook] [--test-command "<cmd>"] [--quiet-ms N] [--json]');
  process.exit(2);
}

const inContainer = process.env.POLY_DEMO_IN_CONTAINER === '1';
const result = await replay({
  build: flag('build'),
  start: flag('start'),
  fault: flag('fault', 'lost-answer'),
  webhookPath: flag('webhook-path', '/webhook'),
  testCommand: flag('test-command', null),
  quietMs: Number(flag('quiet-ms', 3000)),
  mapNames: !inContainer,
  ...(inContainer ? { standInPort: 443, standInHost: '0.0.0.0' } : {}),
});
console.log(rest.includes('--json') ? JSON.stringify(result, null, 2) : format(result));
process.exit({ O2: 0, O1: 1, O3: 3, 'stand-in-invalid': 4 }[result.outcome] ?? 5);
