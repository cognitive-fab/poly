// plan-e3.md E3.9 gate item: the check made from inside the isolated environment. Here it is tested on the loopback only (a
// test must not touch the network): its positive control, its verdicts against a listener that is open and a port that is
// closed, its credential and host-mount findings, and that it never passes when it could not look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { ALWAYS_UNREACHABLE, checkIsolation, credentialsIn, hostMountsIn, probe } from '../../examples/harness/host/isolation-check.mjs';

const LINUX_MOUNTS = 'overlay / overlay rw 0 0\nproc /proc proc rw 0 0\ntmpfs /dev tmpfs rw 0 0\n/dev/sda1 /work ext4 rw 0 0';

async function listener() {
  const s = net.createServer((c) => c.end());
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => s.close() };
}
async function closedPort() {
  const l = await listener();
  l.close();
  return l.port;
}

test('the probe tells an open port from a closed one', async () => {
  const l = await listener();
  assert.equal(await probe('127.0.0.1', l.port), 'open');
  l.close();
  assert.equal(await probe('127.0.0.1', await closedPort()), 'refused');
});

test('a barrier passes and a breach fails: reachable open, unreachable closed', async () => {
  const open = await listener();
  const shut = await closedPort();
  const good = await checkIsolation({ reachable: [`127.0.0.1:${open.port}`], unreachable: [`127.0.0.1:${shut}`], env: {}, mounts: LINUX_MOUNTS, always: [] });
  assert.equal(good.ok, true, JSON.stringify(good.findings.filter((f) => !f.ok)));
  assert.ok(good.findings.some((f) => /^control/.test(f.check) && f.ok), 'the control ran');
  // a breach: an address that is meant to be unreachable accepts the connection
  const breach = await checkIsolation({ unreachable: [`127.0.0.1:${open.port}`], env: {}, mounts: LINUX_MOUNTS, always: [] });
  assert.equal(breach.ok, false);
  assert.deepEqual(breach.findings.filter((f) => !f.ok).map((f) => f.check), [`unreachable: 127.0.0.1:${open.port}`]);
  // the model API's route is closed: the run could not reach it
  const cut = await checkIsolation({ reachable: [`127.0.0.1:${shut}`], env: {}, mounts: LINUX_MOUNTS, always: [] });
  assert.equal(cut.ok, false);
  assert.deepEqual(cut.findings.filter((f) => !f.ok).map((f) => f.check), [`reachable: 127.0.0.1:${shut}`]);
  open.close();
});

test('the always-unreachable list names the public hosts, the registries, a raw public IP and the metadata address', () => {
  for (const a of ['1.1.1.1:443', '8.8.8.8:53', 'example.com:443', 'github.com:443', 'registry.npmjs.org:443', 'proxy.golang.org:443', '169.254.169.254:80']) {
    assert.ok(ALWAYS_UNREACHABLE.includes(a), a);
  }
});

test('a credential-looking variable with a value fails; an empty one and an ordinary name do not', async () => {
  assert.deepEqual(credentialsIn({ ANTHROPIC_API_KEY: 'x', PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'y', MY_PASSWORD: '', SESSION_COOKIE: 'c' }), ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SESSION_COOKIE']);
  const r = await checkIsolation({ env: { ANTHROPIC_API_KEY: 'sk-x' }, mounts: LINUX_MOUNTS, always: [] });
  assert.equal(r.ok, false);
  assert.match(r.findings.find((f) => !f.ok).detail, /ANTHROPIC_API_KEY/);
});

test('a mount of the Windows host fails, and an unreadable mount table is a failure, not a pass', async () => {
  assert.equal(hostMountsIn(LINUX_MOUNTS).length, 0);
  for (const line of ['C:\ /mnt/c 9p rw 0 0', 'drvfs /mnt/d drvfs rw 0 0', '//host/share /data cifs rw 0 0', 'none /run/desktop/mnt/host/c virtiofs rw 0 0', '/dev/x /host_mnt/c ext4 rw 0 0']) {
    assert.equal(hostMountsIn(`${LINUX_MOUNTS}\n${line}`).length, 1, line);
  }
  const bad = await checkIsolation({ env: {}, mounts: `${LINUX_MOUNTS}\ndrvfs /mnt/c drvfs rw 0 0`, always: [] });
  assert.equal(bad.ok, false);
  // mounts: null reads /proc/mounts; where that is absent (this Windows host) the finding fails
  if (process.platform === 'win32') {
    const none = await checkIsolation({ env: {}, always: [] });
    assert.equal(none.ok, false);
    assert.match(none.findings.find((f) => !f.ok).detail, /could not be read/);
  }
});

test('the check is dependency-free node, so it can be copied into the environment', () => {
  const src = readFileSync(join(ROOT, 'examples', 'harness', 'host', 'isolation-check.mjs'), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:net', 'node:fs', 'node:url']);
});
