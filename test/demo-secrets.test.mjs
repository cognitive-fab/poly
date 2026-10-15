// Step 9 (DF9, DAC13): no secret in the repository, no read of a payment provider's environment, and the boundary over demo/. The
// shapes of known credentials are built from parts at run time, so this file holds none itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoViolationsOf, checkRepository } from '../scripts/check-boundaries.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.poly', 'dist', '.git']);
const walk = (d) => (statSync(d).isDirectory() ? readdirSync(d).filter((e) => !SKIP.has(e)).flatMap((e) => walk(join(d, e))) : [d]);
const rel = (f) => relative(ROOT, f).split(sep).join('/');
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|zip|gz|pdf|sqlite|db|bin|wasm)$/i;

/** The shapes of known credentials, assembled so that no line of this file is one. */
const J = (...p) => p.join('');
export const SHAPES = {
  'a Stripe secret or restricted key': new RegExp(`\\b(${J('s', 'k')}|${J('r', 'k')})_(${J('l', 'ive')}|${J('t', 'est')})_[0-9A-Za-z]{16,}`),
  'a Stripe webhook secret': new RegExp(`\\b${J('wh', 'sec')}_[0-9A-Za-z]{16,}`),
  'a Slack token': new RegExp(`\\b${J('xo', 'x')}[bpa]-[0-9A-Za-z-]{20,}`),
  'an AWS access key id': new RegExp(`\\b${J('AK', 'IA')}[0-9A-Z]{16}\\b`),
  'a GitHub token': new RegExp(`\\b${J('gh', 'p')}_[0-9A-Za-z]{30,}`),
  'an Anthropic key': new RegExp(`\\b${J('sk', '-ant')}-[0-9A-Za-z_-]{20,}`),
  'a private key block': new RegExp(`-----BEGIN [A-Z ]*${J('PRIV', 'ATE KEY')}-----`),
  'a JSON web token': new RegExp(`\\b${J('ey', 'J')}[0-9A-Za-z_-]{10,}\\.${J('ey', 'J')}[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}`),
};

const scanned = () => ['demo', 'docs/demo', 'test/fixtures/demo', 'examples/concierge', 'examples/retry'].flatMap((d) => walk(join(ROOT, d))).filter((f) => !BINARY.test(f));

test('DF9: the scan reads files, and each shape is shown to detect its own kind', () => {
  assert.ok(scanned().length > 20, `the scan reads the demo's files (${scanned().length})`);
  const samples = {
    'a Stripe secret or restricted key': `${J('s', 'k')}_${J('t', 'est')}_${'a1B2'.repeat(6)}`,
    'a Stripe webhook secret': `${J('wh', 'sec')}_${'a1B2'.repeat(6)}`,
    'a Slack token': `${J('xo', 'x')}b-${'1234567890'.repeat(3)}`,
    'an AWS access key id': `${J('AK', 'IA')}${'ABCDEFGHIJ'}${'KLMNOP'}`,
    'a GitHub token': `${J('gh', 'p')}_${'a1B2c3'.repeat(6)}`,
    'an Anthropic key': `${J('sk', '-ant')}-${'a1B2c3'.repeat(5)}`,
    'a private key block': `-----BEGIN RSA ${J('PRIV', 'ATE KEY')}-----`,
    'a JSON web token': `${J('ey', 'J')}${'abcdefghij'}.${J('ey', 'J')}${'abcdefghij'}.${'abcdefghij'}`,
  };
  for (const [name, re] of Object.entries(SHAPES)) assert.ok(re.test(samples[name]), name);
});

test('DF9: no file of the demo, its fixtures, its records or the examples it copies holds the shape of a known credential', () => {
  const hits = [];
  for (const f of scanned()) {
    const text = readFileSync(f, 'utf8');
    for (const [name, re] of Object.entries(SHAPES)) if (re.test(text)) hits.push(`${rel(f)}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test('DAC13: the only code under demo/ that reads the environment is on the list, and none reads a payment provider\'s variable', () => {
  const ALLOWED = new Set(['demo/demo.mjs', 'demo/launch.mjs', 'demo/driver/replay.mjs', 'demo/driver/map-hosts.cjs', 'demo/baseline/procedure.mjs', 'demo/stand-in/stripe/tls.mjs']);
  const code = walk(join(ROOT, 'demo')).filter((f) => /\.(mjs|cjs|js|ts)$/.test(f));
  assert.ok(code.length >= 10, 'the scan reads the demo\'s code');
  const PAYMENT = /process\.env(\.|\[\s*['"`])(\w*)(STRIPE|PAYPAL|ADYEN|BRAINTREE|SQUARE|CHECKOUT|PAYMENT|MOLLIE|RAZORPAY)/i;
  const offenders = [];
  for (const f of code) {
    const text = readFileSync(f, 'utf8');
    if (PAYMENT.test(text)) offenders.push(`${rel(f)} reads a payment provider's variable`);
    if (/process\.env/.test(text) && !ALLOWED.has(rel(f))) offenders.push(`${rel(f)} reads the environment and is not on the list`);
  }
  assert.deepEqual(offenders, []);
});

test('DF6, DAC13: the model key is read once, by the launcher, and by name; no other file names it', () => {
  const named = walk(join(ROOT, 'demo')).filter((f) => /\.(mjs|cjs|js|ts)$/.test(f)).filter((f) => /ANTHROPIC_API_KEY/.test(readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(named, ['demo/launch.mjs']);
  const launch = readFileSync(join(ROOT, 'demo', 'launch.mjs'), 'utf8');
  assert.equal(launch.split('process.env.ANTHROPIC_API_KEY').length - 1, 1, 'read once');
});

// ---- the boundary over demo/ (DAC13) -----------------------------------------------------------------------------------------

test('DAC13: the repository passes the boundary check with demo/ in it', () => {
  assert.deepEqual(checkRepository(ROOT), []);
});

test('DAC13: demo/ may import no model SDK, name the model API only where the live transport is, or start a process outside the driver and the scripts', () => {
  const v = (file, text) => demoViolationsOf(file, text).length;
  assert.ok(v('demo/host/room.mjs', "import Anthropic from '@anthropic-ai/sdk'\n") >= 1);
  assert.ok(v('demo/host/room.mjs', "import OpenAI from 'openai'\n") >= 1);
  assert.ok(v('demo/host/room.mjs', "const u = 'https://api.' + 'anthropic.com'\nfetch('https://api.anthropic.com/v1/messages')\n") >= 1);
  assert.equal(v('demo/host/live-transport.mjs', "const HOST = 'api.anthropic.com'\n"), 0, 'the live transport is where the model API is named');
  assert.ok(v('demo/host/room.mjs', "import { spawn } from 'node:child_process'\n") >= 1);
  assert.equal(v('demo/driver/replay.mjs', "import { spawn } from 'node:child_process'\n"), 0);
  assert.equal(v('demo/scripts/make-demo-concierge.mjs', "import { execFileSync } from 'node:child_process'\n"), 0);
  assert.ok(v('demo/host/room.mjs', "const r = await fetch('https://example.com/')\n") >= 1, 'a global fetch is for the live transport alone');
  assert.deepEqual(demoViolationsOf('demo/host/room.mjs', "import { createHmac } from 'node:crypto'\nimport http from 'node:http'\n"), []);
});
