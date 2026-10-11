// plan-ex.md E2, "Run it yourself" (examples/inbox/README.md): the README is the owner's only guide, so the test reads it.
// Light: it holds that the dry run's steps are in the README in order, that every command names a script that exists and
// no placeholder is left unfilled, that the README holds no key, token, id or environment value, and it runs the two steps
// of the dry run that need no check (the scaffold, and the owner's signed grant requests) exactly as written. The rest of
// the dry run, which admits the project, is test/after/ex-inbox-dry-run.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { README, argumentsOf, fill, readmeSteps, runCommand } from './ex-inbox-readme.mjs';

const TEXT = readFileSync(README, 'utf8');
const DRY = ['dry-1-setup', 'dry-2-anchor', 'dry-3-sign', 'dry-4-admit', 'dry-5-link', 'dry-6-run'];

test('the dry run\'s steps are in the README, in order, and every command is a node script that exists with its placeholders filled', () => {
  const { steps, live } = readmeSteps(TEXT);
  assert.deepEqual(steps.map((s) => s.name), DRY);
  assert.deepEqual(live, ['environment, bash', 'environment, PowerShell', 'setup', 'anchor', 'sign', 'admit', 'link', 'run', 'drafts', 'ask', 'approve']);
  const vars = { REPO: ROOT, DRY_PROJECT: join(tmpdir(), 'p'), DRY_KEYS: join(tmpdir(), 'k') };
  for (const s of steps) {
    assert.ok(s.commands.length >= 1, s.name);
    for (const c of s.commands) {
      const [node, script] = argumentsOf(fill(c, vars));
      assert.equal(node, 'node', c);
      assert.ok(existsSync(script), `${script} (${c})`);
    }
  }
  // The scripts are the ones the README names: the scaffold, the CLI, and the host.
  assert.deepEqual([...new Set(steps.flatMap((s) => s.commands).map((c) => /(setup\.mjs|cli\.js|run\.mjs)/.exec(c)?.[1]))].sort(), ['cli.js', 'run.mjs', 'setup.mjs']);
  // The live steps use only the placeholders the README explains.
  const explained = new Set(['REPO', 'PROJECT', 'KEYS', 'id', 'intent']);
  for (const m of TEXT.matchAll(/<([A-Za-z_]+)>/g)) if (/^[A-Z_]+$/.test(m[1]) || ['id', 'intent'].includes(m[1])) assert.ok(explained.has(m[1]) || ['DRY_PROJECT', 'DRY_KEYS'].includes(m[1]), `${m[0]} is not explained`);
});

test('the README holds no key, token, id or environment value: where a value is set it is a placeholder, and no secret-shaped string appears', () => {
  assert.ok(!/sk-ant-|sk_live_|sk_test_|AIza[0-9A-Za-z_-]{10}|ya29\.|GOCSPX-|xox[bp]-|PRIVATE KEY|[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/.test(TEXT), 'a secret-shaped string');
  for (const line of TEXT.split('\n')) {
    const set = /(INBOX_GOOGLE_CLIENT_ID|INBOX_GOOGLE_CLIENT_SECRET|ANTHROPIC_API_KEY)\s*=\s*(.+)$/.exec(line);
    if (set) assert.match(set[2], /^['"]?<[^>]+>/, `${set[1]} is set to a value, not a placeholder: ${line}`);
  }
  // House style: no em dash, and none of the three banned words (written apart here so this file keeps the rule).
  assert.ok(!TEXT.includes(String.fromCharCode(0x2014)) && !new RegExp(['hon', 'est'].join(''), 'i').test(TEXT), 'house style');
  assert.match(TEXT.trimEnd().split('\n').at(-1), /^- \*\*/, 'the README ends with its glossary');
  assert.match(TEXT, /\n## Glossary\n/);
});

test('the scaffold and the owner\'s signed grant requests run exactly as the README writes them', () => {
  const base = mkdtempSync(join(tmpdir(), 'poly-inbox-readme-'));
  const vars = { REPO: ROOT, DRY_PROJECT: join(base, 'project'), DRY_KEYS: join(base, 'keys') };
  const anchors = join(base, 'anchors');
  try {
    const { steps } = readmeSteps(TEXT);
    const by = (name) => steps.find((s) => s.name === name);
    for (const c of by('dry-1-setup').commands) {
      const r = runCommand(fill(c, vars), { anchors });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /no key is printed/);
    }
    for (const c of by('dry-5-link').commands) {
      const r = runCommand(fill(c, vars), { anchors });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    }
    const dir = join(vars.DRY_PROJECT, 'approvals');
    assert.deepEqual(readdirSync(dir).sort(), ['link-home-gmail_read.json', 'link-work-gmail_read.json']);
    for (const [label, owner] of [['work', 'me-work'], ['home', 'me-home']]) {
      const req = JSON.parse(readFileSync(join(dir, `link-${label}-gmail_read.json`), 'utf8'));
      assert.deepEqual([req.kind, req.credential, req.holder, req.record.kind, req.record.by], ['grant-request', 'gmail_read', owner, 'grant-request', 'inbox-owner']);
    }
    assert.ok(!existsSync(join(tmpdir(), 'anchors.json')), 'nothing was written to a per-user configuration');
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});
