import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowedWithTail, bashPatternMatches, checkToolCall } from '../demo/baseline/guard.mjs';
import { ALLOWED_TOOLS, claudeArgs } from '../demo/baseline/arms.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');
const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

const POLY_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\work\\poly-pilot-2';
const DEMO_WORKSPACE = 'C:\\ws\\run';

function bash(arm) {
  return ALLOWED_TOOLS[arm].filter((p) => p.startsWith('Bash('));
}

function runHook(tool_name, tool_input, env) {
  const hookEnv = {};
  if (env) Object.assign(hookEnv, env);
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name, tool_input }),
    encoding: 'utf8',
    env: hookEnv,
  });
  let output;
  try {
    output = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
  } catch {
    output = {};
  }
  return { output, status: result.status };
}

// ---- Task 1, DB16.6 item 6: the poly arm's tool list gains admit and lint -----

test('DB16.6 (H7): ALLOWED_TOOLS.poly deep-equals the exact list with admit and lint appended', () => {
  const expected = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash(node *)', 'Bash(npm test*)', 'Bash(npm install*)',
    'Bash(npm run poly check*)', 'Bash(npm run poly witness*)', 'Bash(npm run poly fix*)',
    'Bash(npm run poly fmt*)', 'Bash(npm run poly edit-check*)',
    'Bash(npm run poly admit*)', 'Bash(npm run poly lint*)',
  ];
  assert.deepEqual(ALLOWED_TOOLS.poly, expected);
});

test('DB16.6 (H7): ALLOWED_TOOLS.ts deep-equals the exact list unchanged with no poly entries', () => {
  const expected = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash(node *)', 'Bash(npm test*)', 'Bash(npm install*)',
    'Bash(npx tsc*)',
  ];
  assert.deepEqual(ALLOWED_TOOLS.ts, expected);
  assert.ok(!ALLOWED_TOOLS.ts.some((t) => /poly/.test(t)), 'ts list contains no poly');
});

test('DB16.6 (H7): bashPatternMatches false for model-calling commands with poly patterns', () => {
  const polyBash = bash('poly');
  assert.ok(polyBash.length > 0, 'poly has Bash patterns');
  assert.equal(bashPatternMatches('npm run poly new "x"', polyBash), false);
  assert.equal(bashPatternMatches('npm run poly explain x', polyBash), false);
  assert.equal(bashPatternMatches('npm run poly accept x', polyBash), false);
  assert.equal(bashPatternMatches('npm run poly approve x', polyBash), false);
  // Positive control: a command that is allowed
  assert.equal(bashPatternMatches('npm run poly check f.poly', polyBash), true);
});

test('DB16.6 (H7): bashPatternMatches true for the new admit and lint patterns', () => {
  const polyBash = bash('poly');
  assert.equal(bashPatternMatches('npm run poly admit .', polyBash), true);
  assert.equal(bashPatternMatches('npm run poly lint handlers .', polyBash), true);
});

test('DB16.6 (H7): isAllowedWithTail true for npm run poly admit with tail under poly list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const command = 'npm run poly admit . 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB16.6 (H7): isAllowedWithTail true for npm run poly lint with tail under poly list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const command = 'npm run poly lint handlers . 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB16.6 (H7): isAllowedWithTail false for npm run poly admit with tail under ts list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm run poly admit . 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
});

test('DB16.6 (H7): isAllowedWithTail false for npm run poly lint with tail under ts list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm run poly lint handlers . 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
});

test('DB16.6 (H7): isAllowedWithTail false for tail with path argument', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const command = 'npm run poly admit . | tail /c/Users/jjdub/y';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
});

test('DB16.6 (H7): hook allows npm run poly admit with tail under poly list', () => {
  const command = 'npm run poly admit . 2>&1 | tail -20';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('poly')),
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'allow');
});

test('DB16.6 (H7): hook allows npm run poly lint with tail under poly list', () => {
  const command = 'npm run poly lint handlers . 2>&1 | tail -20';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('poly')),
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'allow');
});

test('DB16.6 (H7): hook abstains for npm run poly admit with ts list', () => {
  const command = 'npm run poly admit . 2>&1 | tail -20';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('ts')),
  });
  assert.equal(status, 0);
  assert.deepEqual(output, {});
});

test('DB16.6 (H7): hook abstains for npm run poly lint with ts list', () => {
  const command = 'npm run poly lint handlers . 2>&1 | tail -20';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('ts')),
  });
  assert.equal(status, 0);
  assert.deepEqual(output, {});
});

test('DB16.6 (H7): claudeArgs poly --allowedTools contains admit and lint entries', () => {
  const optionOf = (args, name) => args[args.indexOf(name) + 1];
  const args = claudeArgs({ arm: 'poly', prompt: 'test' });
  const allowedTools = optionOf(args, '--allowedTools').split(',');
  assert.ok(allowedTools.includes('Bash(npm run poly admit*)'), 'admit entry present');
  assert.ok(allowedTools.includes('Bash(npm run poly lint*)'), 'lint entry present');
});

test('DB16.6 (H7): claudeArgs ts --allowedTools does not contain admit or lint entries', () => {
  const optionOf = (args, name) => args[args.indexOf(name) + 1];
  const args = claudeArgs({ arm: 'ts', prompt: 'test' });
  const allowedTools = optionOf(args, '--allowedTools').split(',');
  assert.ok(!allowedTools.some((t) => /admit|lint/.test(t)), 'no admit or lint in ts list');
});

test('DB16.6 (H7): replay recorded poly-pilot-2 npm run poly lint handlers command is now allowed', () => {
  const sessionFile = join(SESSIONS, 'poly-pilot-2', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');

  let foundCommand = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const cmd = part.input?.command ?? '';
        if (cmd.includes('lint handlers')) {
          foundCommand = cmd;
          break;
        }
      }
    }
    if (foundCommand) break;
  }

  assert.ok(foundCommand, 'found recorded lint handlers command');
  assert.equal(isAllowedWithTail(foundCommand, { workspace: POLY_WORKSPACE, allowedBash: bash('poly') }), true, `${foundCommand}`);
  assert.deepEqual(checkToolCall({ tool: 'Bash', input: { command: foundCommand }, workspace: POLY_WORKSPACE }), { allow: true }, `${foundCommand}`);
});
