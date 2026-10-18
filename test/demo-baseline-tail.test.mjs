import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowedWithTail, bashPatternMatches, isReadOnlyBash, checkToolCall } from '../demo/baseline/guard.mjs';
import { ALLOWED_TOOLS } from '../demo/baseline/arms.mjs';
import { runArm } from '../demo/baseline/procedure.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');
const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

const TS_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
const POLY_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';
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

test('DB15.6.1: bashPatternMatches with Bash(node *) pattern', () => {
  const patterns = ['Bash(node *)'];
  assert.equal(bashPatternMatches('node a.js', patterns), true);
  assert.equal(bashPatternMatches('node -e "1"', patterns), true);
  assert.equal(bashPatternMatches('node  --version', patterns), true);
  assert.equal(bashPatternMatches('node', patterns), false);
  assert.equal(bashPatternMatches('nodejs a.js', patterns), false);
  assert.equal(bashPatternMatches('npm test', patterns), false);
});

test('DB15.6.1: bashPatternMatches with Bash(npm test*) pattern', () => {
  const patterns = ['Bash(npm test*)'];
  assert.equal(bashPatternMatches('npm test', patterns), true);
  assert.equal(bashPatternMatches('npm test --x', patterns), true);
  assert.equal(bashPatternMatches('npm  test', patterns), true);
  assert.equal(bashPatternMatches('npm testing', patterns), true);
  assert.equal(bashPatternMatches('npm install', patterns), false);
  assert.equal(bashPatternMatches('npm', patterns), false);
});

test('DB15.6.1: bashPatternMatches with exact pattern Bash(pwd)', () => {
  const patterns = ['Bash(pwd)'];
  assert.equal(bashPatternMatches('pwd', patterns), true);
  assert.equal(bashPatternMatches('pwd -L', patterns), false);
  assert.equal(bashPatternMatches('pwd  ', patterns), false);
});

test('DB15.6.1: bashPatternMatches with empty pattern list', () => {
  const patterns = [];
  assert.equal(bashPatternMatches('node a.js', patterns), false);
  assert.equal(bashPatternMatches('npm test', patterns), false);
  assert.equal(bashPatternMatches('', patterns), false);
});

test('DB15.6.1: bashPatternMatches with multiple patterns', () => {
  const patterns = ['Bash(node *)', 'Bash(npm test*)'];
  assert.equal(bashPatternMatches('node a.js', patterns), true);
  assert.equal(bashPatternMatches('npm test', patterns), true);
  assert.equal(bashPatternMatches('npm install', patterns), false);
});

test('DB15.6.1: bashPatternMatches handles spaces between words', () => {
  const patterns = ['Bash(npm run poly check*)'];
  assert.equal(bashPatternMatches('npm run poly check f.poly', patterns), true);
  assert.equal(bashPatternMatches('npm  run  poly  check  f.poly', patterns), true);
  assert.equal(bashPatternMatches('npm run poly witness x', patterns), false);
});

test('DB15.6.2: isAllowedWithTail true for simple tail pipes with ts arm list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test 2>&1 | tail -40',
    'npm test 2>&1 | tail -n 40',
    'npm test 2>&1 | head -30',
    'npm test 2>&1 | wc -l',
    'npm test 2>&1 | tail -40 | head -5',
    'npm test 2>&1 | tail -n 30 | wc -c',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true, `failed for: ${command}`);
  }
});

test('DB15.6.2: isAllowedWithTail true for simple tail pipes with poly arm list', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const commands = [
    'npm test 2>&1 | tail -40',
    'npm test 2>&1 | head -30',
    'npm run poly check f.poly 2>&1 | tail -30',
    'npm run poly witness x 2>&1 | head -50',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true, `failed for: ${command}`);
  }
});

test('DB15.6.2: isAllowedWithTail true for pipes with multiple commands and tail', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const commands = [
    'npm install --save-dev x 2>&1 | tail -5; npm test 2>&1 | tail -30',
    'npm test 2>&1 | tail -40 && ls',
    'ls -a && npm test 2>&1 | tail -3',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true, `failed for: ${command}`);
  }
});

test('DB15.6.2: isAllowedWithTail true for node with tail', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'node a.js 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB15.6.2: isAllowedWithTail true for ts arm npx tsc with tail', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npx tsc --noEmit 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB15.6.2: isAllowedWithTail true for redirects 2>/dev/null with head', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm test 2>/dev/null | head -c 100';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB15.6.2: isAllowedWithTail true for pipes into wc', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm test 2>&1 | wc -l';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB15.6.3: isAllowedWithTail false without pipe', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test 2>&1',
    'npm test',
    'npm install --save-dev x',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for left command outside allowed set and patterns', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'echo hi | tail -3',
    'grep x a | tail -3',
    'rm -rf x 2>&1 | tail',
    'curl http://x | tail',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for right side other than head/tail/wc', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test | node -e "1"',
    'npm test 2>&1 | sh',
    'npm test | grep x',
    'npm test | cat',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for tail with path argument', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test | tail out.txt',
    'npm test | tail -n 5 out.txt',
    'npm test | tail /c/Users/jjdub/y',
    'npm test | head file',
    'npm test | wc -l a.txt',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for tail without -n but with bare integer', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm test | tail 30';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
});

test('DB15.6.3: isAllowedWithTail true for tail with only -n flag', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm test | tail -n';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), true);
});

test('DB15.6.3: isAllowedWithTail false for other redirects and operators', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test > out.txt | tail',
    'npm test 2>out.txt | tail',
    'npm test || echo | tail',
    'npm test & | tail',
    'npm test 2>&1 | tail -3 > f',
    'npm test $(ls) | tail',
    'npm test | (tail -3)',
    'A=1 npm test | tail',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for empty and pipes with missing sides', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm test |',
    '| tail -3',
    'npm test | | tail',
    '',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for ts arm when poly-specific command is used', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const commands = [
    'npm run poly check f.poly 2>&1 | tail -30',
    'npm run poly witness x 2>&1 | head -50',
  ];
  for (const command of commands) {
    assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false, `failed for: ${command}`);
  }
});

test('DB15.6.3: isAllowedWithTail false for poly arm when ts-specific command is used', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('poly');
  const command = 'npx tsc --noEmit 2>&1 | tail -20';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
});

test('DB15.6.4: confinement applies to isAllowedWithTail with --prefix outside', () => {
  const workspace = DEMO_WORKSPACE;
  const allowedBash = bash('ts');
  const command = 'npm test --prefix ../x 2>&1 | tail -3';
  assert.equal(isAllowedWithTail(command, { workspace, allowedBash }), false);
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.6.4: confinement with cwd inside workspace allows tail', () => {
  const workspace = DEMO_WORKSPACE;
  const cwd = 'C:\\ws\\run\\sub';
  const allowedBash = bash('ts');
  const command = 'cd sub && npm test 2>&1 | tail -n 5';
  assert.equal(isAllowedWithTail(command, { workspace, cwd, allowedBash }), true);
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace, cwd });
  assert.equal(verdict.allow, true);
});

test('DB15.6.4: confinement with cd outside workspace denies', () => {
  const workspace = DEMO_WORKSPACE;
  const cwd = 'C:\\ws\\run\\sub';
  const command = 'cd ../.. && npm test 2>&1 | tail -3';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace, cwd });
  assert.equal(verdict.allow, false);
});

test('DB15.6.4: isAllowedWithTail throws for relative workspace', () => {
  const allowedBash = bash('ts');
  assert.throws(
    () => isAllowedWithTail('npm test 2>&1 | tail -3', { workspace: 'relative/path', allowedBash }),
    (e) => e instanceof Error && !(e instanceof TypeError) && /absolute path/i.test(e.message),
    'must throw Error with "absolute path" in message'
  );
});

test('DB15.6.5: recorded poly-pilot-1 calls have exactly 2 bash calls with tail and 3 occurrences', () => {
  const sessionFile = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');

  let bashCalls = [];
  let callsWithTail = [];
  let totalTailOccurrences = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const cmd = part.input?.command ?? '';
        bashCalls.push(cmd);
        if (cmd.includes('2>&1 | tail')) {
          callsWithTail.push(cmd);
        }
        const matches = cmd.match(/2>&1 \| tail/g);
        if (matches) {
          totalTailOccurrences += matches.length;
        }
      }
    }
  }

  assert.equal(callsWithTail.length, 2, 'should find exactly 2 bash calls with 2>&1 | tail');
  assert.equal(totalTailOccurrences, 3, 'should find exactly 3 total 2>&1 | tail occurrences');
});

test('DB15.6.5: recorded poly-pilot-1 tail calls are allowed by isAllowedWithTail', () => {
  const sessionFile = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');
  const allowedBash = bash('poly');

  let tailCalls = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const cmd = part.input?.command ?? '';
        if (cmd.includes('2>&1 | tail')) {
          tailCalls.push(cmd);
        }
      }
    }
  }

  for (const cmd of tailCalls) {
    assert.equal(isAllowedWithTail(cmd, { workspace: POLY_WORKSPACE, allowedBash }), true, `failed for: ${cmd}`);
  }
});

test('DB15.6.5: recorded poly-pilot-1 tail calls are NOT allowed for ts arm', () => {
  const sessionFile = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');
  const allowedBash = bash('ts');

  let tailCalls = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const cmd = part.input?.command ?? '';
        if (cmd.includes('2>&1 | tail') && cmd.includes('npm run poly')) {
          tailCalls.push(cmd);
        }
      }
    }
  }

  assert.equal(tailCalls.length, 2, 'should find exactly 2 poly-specific tail calls');
  for (const cmd of tailCalls) {
    assert.equal(isAllowedWithTail(cmd, { workspace: POLY_WORKSPACE, allowedBash }), false, `should fail for ts arm: ${cmd}`);
  }
});

test('DB15.6.5: ts-pilot-1 first bash call is still allowed', () => {
  const sessionFile = join(SESSIONS, 'ts-pilot-1', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');

  let firstBashCommand = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        firstBashCommand = part.input?.command;
        break;
      }
    }
    if (firstBashCommand) break;
  }

  assert.ok(firstBashCommand, 'found first Bash call');
  assert.equal(
    firstBashCommand,
    'cd "C:/Users/jjdub/.poly-demo/runs/ts-pilot-1/workspace" && ls -la && cat orders.json | head -80 && node --version && npm --version'
  );
  assert.equal(isReadOnlyBash(firstBashCommand, { workspace: TS_WORKSPACE }), true);
  assert.deepEqual(checkToolCall({ tool: 'Bash', input: { command: firstBashCommand }, workspace: TS_WORKSPACE }), { allow: true });
});

test('DB15.6.5: poly-pilot-1 escaping bash calls are denied', () => {
  const workspace = POLY_WORKSPACE;
  const escapingCalls = [
    'ls ../..',
    'ls /c/Users/jjdub',
  ];
  for (const cmd of escapingCalls) {
    const verdict = checkToolCall({ tool: 'Bash', input: { command: cmd }, workspace });
    assert.equal(verdict.allow, false, `should deny: ${cmd}`);
    assert.equal(isAllowedWithTail(cmd, { workspace, allowedBash: bash('poly') }), false, `should fail for isAllowedWithTail: ${cmd}`);

    const cmdWithTail = `${cmd} 2>&1 | tail -3`;
    const verdictWithTail = checkToolCall({ tool: 'Bash', input: { command: cmdWithTail }, workspace });
    assert.equal(verdictWithTail.allow, false, `tail does not hide escape: ${cmdWithTail}`);
  }
});

test('DB15.6.6: hook allows npm test with tail for both arms', () => {
  const command = 'npm test 2>&1 | tail -40';
  const bashEnv = bash('ts');

  const { output: out1, status: s1 } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bashEnv),
  });
  assert.equal(s1, 0);
  assert.deepEqual(Object.keys(out1), ['hookSpecificOutput']);
  assert.equal(out1.hookSpecificOutput.permissionDecision, 'allow');

  const bashEnvPoly = bash('poly');
  const { output: out2, status: s2 } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bashEnvPoly),
  });
  assert.equal(s2, 0);
  assert.deepEqual(Object.keys(out2), ['hookSpecificOutput']);
  assert.equal(out2.hookSpecificOutput.permissionDecision, 'allow');
});

test('DB15.6.6: hook denies pipe into command outside set', () => {
  const commands = [
    'npm test | node -e "1"',
    'cat x | tail /c/Users/jjdub/y',
  ];
  for (const command of commands) {
    const { output, status } = runHook('Bash', { command }, {
      POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
      POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('ts')),
    });
    assert.equal(status, 0);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `should deny: ${command}`);
  }
});

test('DB15.6.6: hook abstains for npm test | tail with missing env (fail closed)', () => {
  const command = 'npm test 2>&1 | tail -40';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.deepEqual(output, {});
});

test('DB15.6.6: hook abstains for npm test | tail with invalid JSON in env', () => {
  const command = 'npm test 2>&1 | tail -40';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: 'not json',
  });
  assert.equal(status, 0);
  assert.deepEqual(output, {});
});

test('DB15.6.6: hook abstains for npm test | tail with empty array in env', () => {
  const command = 'npm test 2>&1 | tail -40';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: '[]',
  });
  assert.equal(status, 0);
  assert.deepEqual(output, {});
});

test('DB15.6.6: hook allows read-only command without POLY_DEMO_ALLOWED_BASH', () => {
  const command = 'cat x | head';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('DB15.6.6: hook output key structure is correct for allow', () => {
  const { output, status } = runHook('Bash', { command: 'cat x | head' }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  const sorted = Object.keys(output.hookSpecificOutput).sort();
  assert.deepEqual(sorted, ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
});

test('DB15.6.6: hook does not depend on POLY_DEMO_ARM env variable', () => {
  const command = 'npm run poly check f.poly 2>&1 | tail -30';

  const { output: out1 } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: POLY_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('poly')),
  });

  const { output: out2 } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: POLY_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('poly')),
    POLY_DEMO_ARM: 'ts',
  });

  assert.equal(out1.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out2.hookSpecificOutput.permissionDecision, 'allow');
});

test('DB15.6.6: hook denies tail with path argument', () => {
  const command = 'cat x | tail /c/Users/jjdub/y';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: JSON.stringify(bash('ts')),
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.6.6: poly-pilot-1 recorded tail calls are allowed by hook with correct pipes', () => {
  const sessionFile = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  const lines = readFileSync(sessionFile, 'utf8').split('\n');
  const allowedBash = bash('poly');

  let tailCalls = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const cmd = part.input?.command ?? '';
        if (cmd.includes('2>&1 | tail')) {
          tailCalls.push(cmd);
        }
      }
    }
  }

  assert.equal(tailCalls.length, 2, 'should find exactly 2 recorded tail calls');


  assert.equal(tailCalls[0].startsWith('npm run poly check tools/poly/examples/hello/hello.poly 2>&1 | tail'), true);
  assert.equal(tailCalls[1].startsWith('npm install --save-dev typescript@~5.9.3 2>&1 | tail'), true);

  let totalPipes = 0;
  for (const cmd of tailCalls) {
    const pipes = (cmd.match(/2>&1 \| tail/g) || []).length;
    totalPipes += pipes;
  }
  assert.equal(totalPipes, 3, 'should find exactly 3 total 2>&1 | tail pipes');

  for (const cmd of tailCalls) {
    const { output, status } = runHook('Bash', { command: cmd }, {
      POLY_DEMO_WORKSPACE: POLY_WORKSPACE,
      POLY_DEMO_ALLOWED_BASH: JSON.stringify(allowedBash),
    });
    assert.equal(status, 0, `hook failed for: ${cmd}`);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow', `hook should allow: ${cmd}`);
  }
});

test('DB15.6.7: runArm gives agent POLY_DEMO_ALLOWED_BASH environment variable for both arms', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const workDirRoot = mkdtempSync(join(tmpdir(), 'baseline-work-'));

  const stub = join(runsDir, 'stub.cjs');
  writeFileSync(stub, `
const fs = require('node:fs');
console.log(JSON.stringify({
  type: 'system',
  subtype: 'init',
  env: {
    POLY_DEMO_WORKSPACE: process.env.POLY_DEMO_WORKSPACE,
    POLY_DEMO_ALLOWED_BASH: process.env.POLY_DEMO_ALLOWED_BASH,
  }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'test',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 }
}));
`);

  try {
    for (const arm of ['ts', 'poly']) {
      const { dir, workspace } = await runArm({
        arm,
        run: 'pilot-1',
        bin: process.execPath,
        binArgs: [stub],
        root: ROOT,
        runsDir,
        workDir: workDirRoot,
        configDir: join(runsDir, 'cfg'),
        checks: () => [],
        deps: {},
      });

      const sessionFile = join(dir, 'session.jsonl');
      const lines = readFileSync(sessionFile, 'utf8').split('\n');

      let initEvent = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') {
            initEvent = event;
            break;
          }
        } catch {
          continue;
        }
      }

      assert.ok(initEvent, `found init event for ${arm}`);
      assert.equal(typeof initEvent.env.POLY_DEMO_ALLOWED_BASH, 'string', `POLY_DEMO_ALLOWED_BASH is a string for ${arm}`);
      assert.equal(initEvent.env.POLY_DEMO_WORKSPACE, workspace, `workspace matches for ${arm}`);

      const allowedBashArray = JSON.parse(initEvent.env.POLY_DEMO_ALLOWED_BASH);
      const expectedArray = bash(arm);
      assert.deepEqual(allowedBashArray, expectedArray, `POLY_DEMO_ALLOWED_BASH matches ALLOWED_TOOLS[${arm}] Bash entries`);
    }

    const tsAllowedBash = bash('ts');
    const polyAllowedBash = bash('poly');
    assert.notDeepEqual(tsAllowedBash, polyAllowedBash, 'ts and poly ALLOWED_BASH arrays differ');
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(workDirRoot, { recursive: true, force: true });
  }
});
