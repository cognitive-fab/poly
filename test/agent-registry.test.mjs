// M6 step 5 (PF9.1, PF9.2, S167): every command poly has is defined once, in the registry, with its input and output
// schemas; the command line dispatches through it; every command of PT14 is either in the registry or listed as not
// built, with when; the schemas are published under schemas/ exactly as the registry states them; and each command's
// JSON output on the conformance fixtures fits its published schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_BUILT, commandNamed } from '@poly/check';
import { agentCommands } from '@poly/agent';

// The agent's commands: the registry's and poly-new's `new` (S169).
const COMMANDS = agentCommands();
import { ROOT } from './helpers.mjs';
import { schemaProblems } from './json-schema.mjs';

// PT14's table, by command (poly run and poly dispatch share one row and one tool).
const PT14 = ['new', 'fmt', 'check', 'explain', 'witness', 'fix', 'grade', 'admit', 'accept', 'deploy', 'dispatch', 'approve', 'journal', 'export', 'mine', 'propose'];

test('PF9.1: every PT14 command is in the registry or listed as not built, with when; none is both', () => {
  const have = new Set(COMMANDS.map((c) => c.name));
  const later = new Set(NOT_BUILT.map((c) => c.name));
  for (const name of PT14) assert.ok(have.has(name) !== later.has(name), `${name}: ${have.has(name) ? 'built' : ''} ${later.has(name) ? 'not built' : ''}`);
  for (const c of NOT_BUILT) assert.match(c.when, /\S/, c.name);
  // A person's key never crosses MCP (PT14, PT12.5).
  for (const name of ['approve', 'accept', 'admit-witness']) assert.equal(commandNamed(name).mcp, null, name);
  assert.equal(new Set(COMMANDS.map((c) => c.mcp).filter(Boolean)).size, COMMANDS.filter((c) => c.mcp).length, 'one tool per command');
});

test('PF9.2: the schemas under schemas/ are the registry\'s, one input and one output schema per command', () => {
  const dir = join(ROOT, 'schemas');
  const want = Object.fromEntries(COMMANDS.flatMap((c) => [[`${c.name}.input.json`, c.input], [`${c.name}.output.json`, c.output]]));
  assert.deepEqual(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [], Object.keys(want).sort());
  for (const [f, s] of Object.entries(want)) assert.deepEqual(JSON.parse(readFileSync(join(dir, f), 'utf8')), s, `${f}: run node scripts/publish-schemas.mjs`);
});

test('PF9.2: each command\'s JSON output on the fixtures fits its published schema', async () => {
  const dir = join(ROOT, '.poly', 'test-registry');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const fits = (name, result) => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}.output.json`), 'utf8'));
    assert.deepEqual(schemaProblems(schema, result), [], name);
  };
  for (const file of ['conformance/m6/brief.poly', 'conformance/m1/effects.poly', 'conformance/m0/errors/PL6804-workflow-unchecked.poly', 'examples/hello/hello.poly']) {
    const o = await commandNamed('check').run({ target: join(ROOT, file), root: dir });
    fits('check', o.result);
  }
  copyFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), join(dir, 'brief.poly'));
  writeFileSync(join(dir, 'brief.poly'), readFileSync(join(dir, 'brief.poly'), 'utf8').replace('module brief', 'module   brief'));
  const f = await commandNamed('fmt').run({ file: join(dir, 'brief.poly') });
  assert.equal(f.result.changed, true);
  fits('fmt', f.result);
  const fixed = await commandNamed('fix').run({ id: 'f-none', root: dir });
  fits('fix', fixed.result);
});
