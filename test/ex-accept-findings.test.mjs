// test/ex-kit.mjs `acceptFindings` writes a person's signed acceptance of every finding of a project, so that a seeded defect
// can be run in an end-to-end test (PT12.5). It must be a test tool and nothing else: it signs with the tests' throwaway
// person key, it is reached from no command line and from no admission path, and an acceptance signed with that key is
// refused by admission in a process that is not a test process (S194). Light: one small project, one child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { ANCHORS, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { acceptFindings } from './ex-kit.mjs';

const EX = join(ROOT, 'examples', 'pr-reviewer');
const NOT_SOURCES = new Set(['node_modules', '.poly', '.git', 'dist']);

/** Every file of the repository that mentions a name, by path from the root (build output and installed packages left out). */
function mentions(name) {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (NOT_SOURCES.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|ts|json|md|poly)$/.test(e.name)) continue;
      if (readFileSync(p, 'utf8').includes(name)) found.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  for (const d of ['packages', 'scripts', 'examples', 'adapters', 'std', 'test', 'docs']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return found.sort();
}

test('acceptFindings is defined in test/ex-kit.mjs alone, and no package, script, example or adapter mentions it', () => {
  const files = mentions('acceptFindings');
  assert.ok(files.includes('test/ex-kit.mjs'));
  const outside = files.filter((f) => !f.startsWith('test/') && !f.startsWith('docs/'));
  assert.deepEqual(outside, [], 'nothing outside test/ and the documents names it');
  const definitions = files.filter((f) => /^export (async )?function acceptFindings/m.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(definitions, ['test/ex-kit.mjs']);
});

test('it signs with the tests\' throwaway person key, which is generated in memory and never written', () => {
  const kit = readFileSync(join(ROOT, 'test', 'ex-kit.mjs'), 'utf8');
  const body = kit.slice(kit.indexOf('export async function acceptFindings'));
  assert.match(body, /signRecord\(\{ kind: 'acceptance', subject, by: PERSON\.keyId, at: [^}]*\}, PERSON\.privateKeyPem\)/);
  const helpers = readFileSync(join(ROOT, 'test', 'runtime-helpers.mjs'), 'utf8');
  const makePerson = helpers.slice(helpers.indexOf('export function makePerson'), helpers.indexOf('export const PERSON'));
  assert.match(makePerson, /generateKeyPairSync\('ed25519'\)/);
  assert.ok(!/writeFileSync|createWriteStream/.test(makePerson), 'the person key is never written to disk');
  // The only keys the repository's real people use are the owner's, outside the repository (S126): none is in test/.
  assert.ok(!/-----BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY-----/.test(kit + helpers), 'no private key is written in the tools');
});

test('no command and no admission path calls it: the CLI\'s commands name no such helper, and admission reads acceptances only from accepted/', () => {
  const cli = readFileSync(join(ROOT, 'packages', 'poly-check', 'src', 'cli.ts'), 'utf8');
  assert.ok(!/ex-kit|acceptFindings|test\/ex-/.test(cli));
  const admitSrc = readFileSync(join(ROOT, 'packages', 'poly-check', 'src', 'admit.ts'), 'utf8');
  assert.ok(!/ex-kit|acceptFindings|runtime-helpers/.test(admitSrc));
  assert.match(admitSrc, /const folder = join\(c\.dir, 'accepted'\)/);
});

test('admission refuses a test-key acceptance outside the test anchors: in a bare process the same project is not admitted', { timeout: 120_000 }, async () => {
  const key = makeKey('accept-findings');
  const dir = project('accept-findings', [], key, 'test-accept-findings');
  for (const f of ['pr-reviewer-defect.poly', 'pr-reviewer-defect.policy.poly']) copyFileSync(join(EX, f), join(dir, 'src', f));
  cpSync(join(EX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  await signPolicies(dir);
  // Without an acceptance the defect is not admitted, even in a test process.
  await assert.rejects(admit(dir), /no signed acceptance/);
  const codes = await acceptFindings(dir);
  assert.deepEqual(codes, ['PL4001']);
  // Control: with the acceptance, in this test process (which accepts the test anchors), it is admitted and the acceptance is bound.
  const ok = await admit(dir);
  assert.deepEqual(ok.certificate.boundAccepted.map((x) => x.code), ['PL4001']);

  // The same project, admitted again by the command line in a process that is not a test process, with the test anchors named
  // and with a home that holds none of the owner's configuration: refused, and nothing is admitted.
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const bare = spawnSync(process.execPath, [cli, 'admit', dir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, POLY_ANCHORS_CONFIG: join(ANCHORS, 'anchors.json'), USERPROFILE: dir, HOME: dir } });
  assert.notEqual(bare.status, 0, `the bare process admitted it:\n${bare.stdout}\n${bare.stderr}`);
  assert.match(`${bare.stdout}${bare.stderr}`, /PL6410|KEYRING_NOT_SIGNED|not honoured outside a test process|no anchor/i);
});
