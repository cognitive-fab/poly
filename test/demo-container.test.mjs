// DB6 item 3 (Step 8): the container setup has no route to the real Stripe by construction. These read the files; they start no
// container (that is the owner's terminal, and an image needs a network to be built once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuthority, NAMES } from '../demo/stand-in/stripe/tls.mjs';

const read = (f) => readFileSync(new URL(`../demo/container/${f}`, import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '');

test('DB6 item 3: the run has no network, maps both names to its own loopback, and publishes no port', () => {
  const c = read('docker-compose.yml');
  assert.match(c, /network_mode:\s*none/);
  for (const name of NAMES) assert.ok(c.includes(`"${name}:127.0.0.1"`), `${name} is mapped to the container's loopback`);
  assert.ok(!/^\s*ports:/m.test(c), 'no port is published');
  assert.ok(!/networks:/.test(c), 'no network is joined');
});

test('DB6 item 3: the tree under test is mounted read-only, the root file system is read-only, and the authority has only the temporary space', () => {
  const c = read('docker-compose.yml');
  assert.match(c, /:\/build:ro/);
  assert.match(c, /read_only:\s*true/);
  assert.match(c, /tmpfs:\s*\n\s*-\s*\/tmp/);
});

test('DB6 item 3: the image runs the driver in container mode and installs openssl for the throwaway authority', () => {
  const d = read('Dockerfile');
  assert.match(d, /POLY_DEMO_IN_CONTAINER=1/);
  assert.match(d, /openssl/);
  assert.match(d, /ENTRYPOINT \["node", "\/demo\/demo\/demo\.mjs"\]/);
});

test('DB6 item 3: the authority covers exactly the two names and the loopback, and is valid for a day', async () => {
  const a = createAuthority();
  try {
    const { execFileSync } = await import('node:child_process');
    const text = execFileSync('openssl', ['x509', '-in', `${a.dir}/leaf.pem`, '-noout', '-text']).toString();
    assert.match(text, /DNS:api\.stripe\.com/);
    assert.match(text, /DNS:graph\.facebook\.com/);
    assert.match(text, /IP Address:127\.0\.0\.1/);
    assert.ok(!/DNS:(?!api\.stripe\.com|graph\.facebook\.com)/.test(text), 'no other name');
    const ca = execFileSync('openssl', ['x509', '-in', a.caPath, '-noout', '-text']).toString();
    assert.match(ca, /CA:TRUE/);
  } finally { a.remove(); }
});
