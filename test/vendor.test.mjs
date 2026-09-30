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
  { dir: 'polygraph', source: 'C:/Users/jjdub/code/polygraph', commit: '583b82c' },
  { dir: 'sam-pattern', source: 'C:/Users/jjdub/code/sam/sam-lib', commit: '3047024' },
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
