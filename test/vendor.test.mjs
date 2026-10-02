// The vendored engines (vendor/*/PROVENANCE.md): poly relies on the Poly stack conceptually, not
// physically, so the engine files it runs are copied into this repository unchanged. Each copy is
// pinned by the SHA-256 of its bytes; where the source checkout exists, each file must equal the
// file at the recorded commit, so a copy cannot drift into a fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

const VENDORED = [
  { dir: 'polygraph', source: 'C:/Users/jjdub/code/polygraph', commit: '4949de4' },
  { dir: 'sam-pattern', source: 'C:/Users/jjdub/code/sam/sam-lib', commit: '3047024' },
  { dir: 'polyflow', source: 'C:/Users/jjdub/code/polyflow', commit: '5170add' },
];

const table = (dir) => {
  const text = readFileSync(join(ROOT, 'vendor', dir, 'PROVENANCE.md'), 'utf8');
  return [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ file: m[1], sha: m[2] }));
};

for (const v of VENDORED) {
  test(`vendor/${v.dir}: every file matches its PROVENANCE.md hash`, () => {
    const rows = table(v.dir);
    assert.ok(rows.length > 0);
    for (const { file, sha } of rows) {
      const got = createHash('sha256').update(readFileSync(join(ROOT, 'vendor', v.dir, file))).digest('hex');
      assert.equal(got, sha, file);
    }
    assert.match(readFileSync(join(ROOT, 'vendor', v.dir, 'PROVENANCE.md'), 'utf8'), new RegExp(`commit \`${v.commit}\``));
  });

  test(`vendor/${v.dir}: every file equals the source at ${v.commit}, where the checkout exists`, { skip: existsSync(v.source) ? false : 'source checkout not present' }, () => {
    for (const { file } of table(v.dir)) {
      const upstream = execFileSync('git', ['-C', v.source, 'show', `${v.commit}:${file}`], { maxBuffer: 1 << 26 });
      assert.ok(upstream.equals(readFileSync(join(ROOT, 'vendor', v.dir, file))), file);
    }
  });
}

test('poly resolves the engines to the vendored copies', () => {
  const req = createRequire(join(ROOT, 'packages', 'poly-check', 'package.json'));
  assert.equal(req.resolve('@cognitive-fab/sam-pattern').split('\\').join('/'), join(ROOT, 'vendor', 'sam-pattern', 'dist', 'SAM.js').split('\\').join('/'));
  assert.ok(req.resolve('@cognitive-fab/polygraph/scripts/check.mjs').split('\\').join('/').startsWith(join(ROOT, 'vendor', 'polygraph').split('\\').join('/')));
  for (const pkg of ['@cognitive-fab/polyflow-kernel', '@cognitive-fab/polyflow-verify']) {
    assert.ok(req.resolve(pkg).split('\\').join('/').startsWith(join(ROOT, 'vendor', 'polyflow').split('\\').join('/')), pkg);
  }
});

// Review finding P1: a pinned file that is ignored by git exists only on the disk that vendored it.
test('every vendored file is tracked by git, and none is ignored', () => {
  for (const v of VENDORED) {
    for (const { file } of table(v.dir)) {
      const path = `vendor/${v.dir}/${file}`;
      const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--', path], { encoding: 'utf8' }).trim();
      assert.equal(tracked, path, `${path} is not tracked`);
    }
  }
});

// S145: Polyaxion, polyman and polysec-core are an optional peer, pinned like a vendored engine but not copied in.
// Where the sibling checkout is absent, the checks are listed as not run, never passed.
const PEER = { table: join(ROOT, 'peers', 'polyaxion', 'PROVENANCE.md'), commit: 'c37c60e' };
const peerRows = () => [...readFileSync(PEER.table, 'utf8').matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ file: m[1], sha: m[2] }));

test('peers/polyaxion: the pins name the commit and cover the three packages', () => {
  const text = readFileSync(PEER.table, 'utf8');
  assert.match(text, new RegExp(`commit \`${PEER.commit}\``));
  const rows = peerRows();
  for (const pkg of ['packages/polyaxion/src/engine.mjs', 'packages/polysec-core/src/polysec-harden.mjs', 'packages/polysec/polyman/src/kernel.ts']) assert.ok(rows.some((r) => r.file === pkg), pkg);
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'peers/polyaxion/PROVENANCE.md'], { encoding: 'utf8' }).trim();
  assert.equal(tracked, 'peers/polyaxion/PROVENANCE.md');
});

test('peers/polyaxion: the checkout matches every pin, and each pin is the file at the commit', async () => {
  const { polyaxionPeer, pinDigest } = await import('@poly/runtime');
  const peer = polyaxionPeer();
  if (!peer.ok) { assert.match(peer.reason, /not run|absent|differs/); return; }
  for (const { file, sha } of peerRows()) {
    // A Windows checkout may hold CRLF where the commit holds LF: the pin reads CRLF as LF (peers.ts pinDigest).
    assert.equal(pinDigest(readFileSync(join(peer.dir, file))), sha, file);
    assert.equal(pinDigest(execFileSync('git', ['-C', peer.dir, 'show', `${PEER.commit}:${file}`], { maxBuffer: 1 << 26 })), sha, file);
  }
});

// S161: polycheck, a second optional peer, pinned the same way.
test('peers/polycheck: the checkout matches every pin, and each pin is the file at the commit', async () => {
  const { polycheckPeer, pinDigest } = await import('@poly/runtime');
  const text = readFileSync(join(ROOT, 'peers', 'polycheck', 'PROVENANCE.md'), 'utf8');
  assert.match(text, /commit `678b120`/);
  const rows = [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ file: m[1], sha: m[2] }));
  assert.deepEqual(rows.map((r) => r.file), ['src/check.mjs', 'data/regions.json', 'package.json', 'LICENSE']);
  const p = polycheckPeer();
  if (!p.ok) { assert.match(p.reason, /not run/); return; }
  for (const { file, sha } of rows) {
    assert.equal(pinDigest(readFileSync(join(p.dir, file))), sha, file);
    assert.equal(pinDigest(execFileSync('git', ['-C', p.dir, 'show', `678b120:${file}`])), sha, file);
  }
});
