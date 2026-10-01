// S114: the manual the poly arms read (README, technical spec, semantics) is a snapshot taken at the freeze commit
// 04c62e8 into experiments/m3/manual/, in a part of its own, and the runner copies the manual from the snapshot
// only. A changed byte in the snapshot changes the `manual` part; the live docs/ are in no part and reach no
// workspace. Every file the runner copies into any arm's workspace is in a part, with the digest it is copied with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { changedParts, manifest } from '../experiments/m3/freeze.mjs';
import * as workspace from '../experiments/m3/runner/workspace.mjs';
import { M3, PRACTICE, taskIds, versions } from '../experiments/m3/lib/task.mjs';
import { ROOT } from './helpers.mjs';

const FREEZE_COMMIT = '04c62e8';
const MANUAL_FILES = ['README.md', 'docs/03-technical-spec.md', 'docs/04-semantics.md'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const walk = (d) => (statSync(d).isDirectory() ? readdirSync(d).flatMap((e) => walk(join(d, e))) : [d]);
const rel = (p, from = ROOT) => relative(from, p).split('\\').join('/');
const atFreeze = (p) => execFileSync('git', ['-C', ROOT, 'show', `${FREEZE_COMMIT}:${p}`]);
const withoutPT13 = (text) => text.slice(0, text.indexOf('## PT13.')) + text.slice(text.indexOf('## PT14.'));

const m = manifest();

test('S114: the manual part is README, spec and semantics as of the freeze commit', () => {
  assert.ok('manual' in m.parts);
  const frozen = Object.keys(m.files).filter((f) => f.startsWith('experiments/m3/manual/')).sort();
  assert.deepEqual(frozen, MANUAL_FILES.map((f) => `experiments/m3/manual/${f}`).sort());
  for (const f of MANUAL_FILES) assert.ok(readFileSync(join(M3, 'manual', f)).equals(atFreeze(f)), `${f} is not as of ${FREEZE_COMMIT}`);
});

test('S114: a changed byte in a snapshot file changes the manual part, and only it', () => {
  const copy = mkdtempSync(join(tmpdir(), 'poly-manual-'));
  try {
    cpSync(join(M3, 'manual'), copy, { recursive: true });
    assert.deepEqual(changedParts(m, manifest({ manualDir: copy })), []);
    const victim = join(copy, 'docs', '04-semantics.md');
    const text = readFileSync(victim);
    text[0] = text[0] === 0x23 ? 0x20 : 0x23;
    writeFileSync(victim, text);
    assert.deepEqual(changedParts(m, manifest({ manualDir: copy })), ['manual']);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('S114: the live docs are in no part, and the poly arms read the snapshot, not docs/', () => {
  // The O1 prompt under docs/m3/ is its own part; the live manual is in none, so a change to it changes no part.
  assert.deepEqual(Object.keys(m.files).filter((f) => f === 'README.md' || (f.startsWith('docs/') && f !== 'docs/m3/o1-prompt.md')), []);
  const v = versions('T1')[0];
  for (const arm of [3, 4]) {
    for (const s of workspace.workspaceSources(arm, v)) if (s.from) assert.ok(!MANUAL_FILES.some((f) => s.from === join(ROOT, f)), `arm ${arm}: ${s.to} is copied from the live ${rel(s.from)}`);
    const { ws } = workspace.makeWorkspace(join(tmpdir(), 'poly-m3-ws-test', `manual-arm${arm}`), arm, v);
    assert.ok(readFileSync(join(ws, 'tools', 'poly', 'README.md')).equals(atFreeze('README.md')));
    assert.ok(readFileSync(join(ws, 'tools', 'poly', 'docs', '04-semantics.md')).equals(atFreeze('docs/04-semantics.md')), `arm ${arm}: the semantics is not as of ${FREEZE_COMMIT}`);
    assert.equal(readFileSync(join(ws, 'tools', 'poly', 'docs', '03-technical-spec.md'), 'utf8'), withoutPT13(atFreeze('docs/03-technical-spec.md').toString('utf8')), `arm ${arm}: the spec is not as of ${FREEZE_COMMIT}`);
    rmSync(ws, { recursive: true, force: true });
  }
});

test('S114: every file the runner copies into any arm\'s workspace is in a part, with the digest it is copied with', () => {
  const practice = existsSync(PRACTICE) ? readdirSync(PRACTICE).filter((d) => /^P\d+$/.test(d)) : [];
  const outside = [];
  for (const id of [...taskIds(), ...practice]) {
    const vs = versions(id);
    for (const arm of [1, 2, 3, 4]) {
      const sources = [...workspace.workspaceSources(arm, vs[0]), ...vs.slice(1).flatMap((v) => workspace.changeSources(v))];
      for (const s of sources) {
        if (s.git) continue;
        for (const f of walk(s.from).filter(s.filter ?? (() => true))) if (m.files[rel(f)] !== sha(readFileSync(f))) outside.push(`${id} arm ${arm}: ${s.to} <- ${rel(f)}`);
      }
    }
  }
  assert.deepEqual([...new Set(outside)], []);
  // Arm 2's polygraph comes from git at the pinned commit; its part holds each file as the archive gives it.
  const into = mkdtempSync(join(tmpdir(), 'poly-polygraph-'));
  try {
    workspace.extractPolygraph(into);
    const files = walk(into);
    assert.ok(files.length > 0);
    for (const f of files) assert.equal(m.files[`polygraph@${workspace.POLYGRAPH.commit}/${rel(f, into)}`], sha(readFileSync(f)), rel(f, into));
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

test('S114: the list of sources is the whole workspace, besides the package.json and tsconfig.json the runner writes', () => {
  const v = versions('T1')[0];
  for (const arm of [1, 2, 3, 4]) {
    const { ws, files } = workspace.makeWorkspace(join(tmpdir(), 'poly-m3-ws-test', `sources-arm${arm}`), arm, v);
    const listed = new Set();
    for (const s of workspace.workspaceSources(arm, v)) {
      const root = join(ws, s.to);
      for (const f of statSync(root).isDirectory() ? walk(root) : [root]) listed.add(rel(f, ws));
    }
    assert.deepEqual(files.filter((f) => !listed.has(f)), arm === 4 ? ['package.json', 'tsconfig.json'] : ['package.json'], `arm ${arm}`);
    rmSync(ws, { recursive: true, force: true });
  }
});
