import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isReadOnlyBash, checkToolCall, READ_ONLY_BASH } from '../demo/baseline/guard.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');
const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

const TS_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
const POLY_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';

// Test 1: DB15.1 - READ_ONLY_BASH exports the correct list.
test('DB15.1: READ_ONLY_BASH deep-equals the fixed set', () => {
  assert.deepEqual(READ_ONLY_BASH, ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'cd']);
});

// Test 2: DB15.2 - isReadOnlyBash returns true for valid commands in the set.
test('DB15.2: isReadOnlyBash true for read-only commands', () => {
  const workspace = 'C:\\ws\\run';
  const validCommands = [
    'ls',
    'ls -la',
    'ls src tests',
    'pwd',
    'cat package.json',
    'cat a.txt b.txt',
    'head -n 20 README.md',
    'tail -n 5 log.txt',
    'wc -l src/a.js',
    'cd src',
    'cd src && ls',
    'cd src ; ls -la ; pwd',
    'ls && cat package.json && wc -l package.json',
    'cat "C:\\ws\\run\\orders.json"',
    'ls src/*',
  ];
  for (const command of validCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), true, `failed for: ${command}`);
  }
});

// Test 3: DB15.2 with cwd - isReadOnlyBash respects relative paths within workspace.
test('DB15.2: isReadOnlyBash true with cwd inside workspace', () => {
  const workspace = 'C:\\ws\\run';
  const cwd = 'C:\\ws\\run\\sub';
  assert.equal(isReadOnlyBash('cat ../a.txt', { workspace, cwd }), true);
});

// Test 4: DB15.3 - isReadOnlyBash false for commands not in the set, guard allows them.
test('DB15.3: isReadOnlyBash false for disallowed commands, guard allows them', () => {
  const workspace = 'C:\\ws\\run';
  const disallowedCommands = [
    'npm test',
    'node src/a.js',
    'grep x a.txt',
    'echo hi',
    'cat a.txt | head',
    'cat a.txt > out.txt',
    'ls > files.txt',
    'ls 2>/dev/null',
    'echo $(ls)',
    'ls `pwd`',
    'A=1 ls',
    'ls &',
    '(ls)',
    'ls || pwd',
    'cd src && npm test',
    'ls ; rm a.txt',
    'ls && node --version',
  ];
  for (const command of disallowedCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `failed for: ${command}`);
    const guardCheck = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.equal(guardCheck.allow, true, `guard should allow: ${command}`);
  }
});

// Test 5: DB15.3 - isReadOnlyBash false for empty string and spaces only.
test('DB15.3: isReadOnlyBash false for empty and whitespace-only commands', () => {
  const workspace = 'C:\\ws\\run';
  assert.equal(isReadOnlyBash('', { workspace }), false);
  assert.equal(isReadOnlyBash('   ', { workspace }), false);
});

// Test 6: DB15.4 - isReadOnlyBash false for paths outside, and checkToolCall denies them.
test('DB15.4: isReadOnlyBash false for outside paths, checkToolCall denies them', () => {
  const workspace = 'C:\\ws\\run';
  const outsideCommands = [
    'ls ..',
    'ls ../..',
    'ls /c/Users/jjdub',
    'cat C:\\Users\\x\\y',
    'cd .. && ls',
    'cd src && cat ../../x',
    'ls ~',
    'ls $HOME',
    'cat /etc/passwd',
    'ls ../ws2/x',
  ];
  for (const command of outsideCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `failed for: ${command}`);
    const guardCheck = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.equal(guardCheck.allow, false, `guard should deny: ${command}`);
  }
});

// Test 7: DB15.4 with cwd - isReadOnlyBash and checkToolCall both deny outside from cwd.
test('DB15.4: isReadOnlyBash and checkToolCall both deny outside paths from cwd', () => {
  const workspace = 'C:\\ws\\run';
  const cwd = 'C:\\ws\\run\\sub';
  assert.equal(isReadOnlyBash('cat ../../x', { workspace, cwd }), false);
  const guardCheck = checkToolCall({ tool: 'Bash', input: { command: 'cat ../../x' }, workspace, cwd });
  assert.equal(guardCheck.allow, false);
});

// Test 8: DB15.5 - isReadOnlyBash throws for relative workspace.
test('DB15.5: isReadOnlyBash throws for relative workspace', () => {
  // The error must be about the workspace, so an unrelated failure (a TypeError, say) does not pass.
  assert.throws(() => isReadOnlyBash('ls', { workspace: 'relative/path' }), (e) => e instanceof Error && !(e instanceof TypeError) && /absolute path/i.test(e.message));
});

// Test 9: DB15.6 - Recorded replay: ts-pilot-1 first Bash command.
test('DB15.6: ts-pilot-1 first Bash command: prefix in set, whole command outside', () => {
  const tsPilotSession = join(SESSIONS, 'ts-pilot-1', 'session.jsonl');
  const lines = readFileSync(tsPilotSession, 'utf8').split('\n');
  let firstBashCommand = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        firstBashCommand = part.input.command;
        break;
      }
    }
    if (firstBashCommand) break;
  }
  assert.ok(firstBashCommand, 'first Bash command found');
  const marker = firstBashCommand.indexOf('&& ls -la');
  assert.ok(marker >= 0, 'the recorded first Bash call holds the segment && ls -la');
  const endOfPrefix = marker + '&& ls -la'.length;
  const prefix = firstBashCommand.substring(0, endOfPrefix);
  assert.equal(isReadOnlyBash(prefix, { workspace: TS_WORKSPACE }), true, `prefix should be in set: ${prefix}`);
  assert.equal(isReadOnlyBash(firstBashCommand, { workspace: TS_WORKSPACE }), false, `whole command should be outside: ${firstBashCommand}`);
  assert.equal(checkToolCall({ tool: 'Bash', input: { command: firstBashCommand }, workspace: TS_WORKSPACE }).allow, true, 'guard should allow whole command');
});

// Test 10: DB15.6 - Recorded replay: poly-pilot-1 outside commands.
test('DB15.6: poly-pilot-1 outside commands denied by both isReadOnlyBash and checkToolCall', () => {
  const polyPilotSession = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  assert.equal(isReadOnlyBash('ls ../..', { workspace: POLY_WORKSPACE }), false);
  assert.equal(isReadOnlyBash('ls /c/Users/jjdub', { workspace: POLY_WORKSPACE }), false);
  const guard1 = checkToolCall({ tool: 'Bash', input: { command: 'ls ../..' }, workspace: POLY_WORKSPACE });
  const guard2 = checkToolCall({ tool: 'Bash', input: { command: 'ls /c/Users/jjdub' }, workspace: POLY_WORKSPACE });
  assert.equal(guard1.allow, false);
  assert.equal(guard2.allow, false);
  let foundDotdot = false;
  let foundHome = false;
  const lines = readFileSync(polyPilotSession, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        const command = part.input.command;
        if (command.includes('..')) foundDotdot = true;
        if (command.includes('/c/Users/jjdub')) foundHome = true;
        if (command.includes('..') || command.includes('/c/Users/jjdub')) {
          assert.equal(isReadOnlyBash(command, { workspace: POLY_WORKSPACE }), false, `found outside: ${command}`);
        }
      }
    }
  }
  assert.ok(foundDotdot || foundHome, 'at least one outside command found in poly-pilot-1');
});

// Test 11: DB15.7 - The hook: PreToolUse output for allowed read-only Bash.
test('DB15.7: hook allows read-only Bash with PreToolUse output', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd src && ls -la' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, `hook exits 0: ${child.stderr}`);
  const output = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(typeof output.hookSpecificOutput.permissionDecisionReason, 'string');
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.length > 0);
});

// Test 12: DB15.7 - The hook: abstain (empty output) for non-read-only Bash allowed by guard.
test('DB15.7: hook abstains (prints {}) for Bash outside set but allowed by guard', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, `hook exits 0: ${child.stderr}`);
  const output = JSON.parse(child.stdout);
  assert.deepEqual(output, {});
});

// Test 13: DB15.7 - The hook: abstain for other non-read-only commands.
test('DB15.7: hook abstains for other non-read-only Bash commands', () => {
  const commands = ['node --version && npm --version', 'cat a.txt | head'];
  for (const command of commands) {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\ws\\run' });
    const child = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.deepEqual(output, {}, `hook should abstain for: ${command}`);
  }
});

// Test 14: DB15.7 - The hook: deny for outside paths.
test('DB15.7: hook denies Bash with paths outside workspace', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls ../..' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.length > 0);
});

// Test 15: DB15.7 - The hook: allow for Read of inside file.
test('DB15.7: hook allows Read inside workspace', () => {
  const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\ws\\run\\file.txt' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

// Test 16: DB15.7 - The hook: deny for Read outside.
test('DB15.7: hook denies Read outside workspace', () => {
  const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\x\\y' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

// Test 17: DB15.7 - The hook: fail closed without POLY_DEMO_WORKSPACE.
test('DB15.7: hook fails closed without POLY_DEMO_WORKSPACE', () => {
  const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\ws\\run\\file.txt' }, cwd: 'C:\\ws\\run' });
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

// Test 18: DB15.7 - The hook: fail closed on invalid JSON input.
test('DB15.7: hook fails closed on invalid JSON input', () => {
  const stdin = 'this is not json';
  const child = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

// Test 19: DB15.8 - Both arms identical: hook output same with different POLY_DEMO_ARM values.
test('DB15.8: hook output identical regardless of POLY_DEMO_ARM environment variable', () => {
  const commands = ['cd src && ls', 'npm test'];
  for (const command of commands) {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\ws\\run' });
    const output1 = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run', POLY_DEMO_ARM: 'ts' },
      encoding: 'utf8',
    });
    const output2 = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run', POLY_DEMO_ARM: 'poly' },
      encoding: 'utf8',
    });
    assert.equal(output1.status, 0);
    assert.equal(output2.status, 0);
    const result1 = JSON.parse(output1.stdout);
    const result2 = JSON.parse(output2.stdout);
    assert.deepEqual(result1, result2, `hook output should match for: ${command}`);
  }
});
