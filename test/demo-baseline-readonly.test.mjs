import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isReadOnlyBash, checkToolCall, READ_ONLY_BASH, READ_ONLY_EXACT } from '../demo/baseline/guard.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');
const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

const TS_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
const POLY_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';

// Test 1: DB15.6 - READ_ONLY_BASH and READ_ONLY_EXACT exports have correct values
test('DB15.1: READ_ONLY_BASH deep-equals the fixed set', () => {
  assert.deepEqual(READ_ONLY_BASH, ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'cd']);
});

test('DB15.1: READ_ONLY_EXACT deep-equals the three exact commands', () => {
  assert.deepEqual(READ_ONLY_EXACT, ['node --version', 'npm --version', 'npx tsc --version']);
});

// Test 2: DB15.2 - isReadOnlyBash true for pipes and exact commands
test('DB15.2: isReadOnlyBash true for pipes between set commands', () => {
  const workspace = 'C:\\ws\\run';
  const validCommands = [
    'cat a.txt | head',
    'cat a.txt | head -n 5 | wc -l',
    'ls | wc -l',
    'ls src | head',
    'cat a.txt | tail -3 && pwd',
  ];
  for (const command of validCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), true, `failed for: ${command}`);
  }
});

test('DB15.2: isReadOnlyBash true for exact commands alone', () => {
  const workspace = 'C:\\ws\\run';
  const exactCommands = [
    'node --version',
    'npm --version',
    'npx tsc --version',
    'node  --version',
  ];
  for (const command of exactCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), true, `failed for: ${command}`);
  }
});

test('DB15.2: isReadOnlyBash true for exact commands joined with set commands', () => {
  const workspace = 'C:\\ws\\run';
  const joinedCommands = [
    'ls && node --version',
    'cd src ; npm --version',
    'node --version | head',
    'ls | npx tsc --version',
    'cd src && ls && npm --version && cat a.txt',
  ];
  for (const command of joinedCommands) {
    assert.equal(isReadOnlyBash(command, { workspace }), true, `failed for: ${command}`);
  }
});

test('DB15.2: isReadOnlyBash true for set commands with various flags and paths', () => {
  const workspace = 'C:\\ws\\run';
  const commands = [
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
  ];
  for (const command of commands) {
    assert.equal(isReadOnlyBash(command, { workspace }), true, `failed for: ${command}`);
  }
});

// Test 3: DB15.3 - isReadOnlyBash false for various disallowed commands
test('DB15.3: isReadOnlyBash false but guard allows for disallowed patterns', () => {
  const workspace = 'C:\\ws\\run';
  const disallowedButAllowed = [
    'node --version --foo',
    'node -v',
    'node src/a.js',
    'node -e "1"',
    'npm test',
    'npm --version --json',
    'npm run poly check f',
    'npx tsc',
    'npx tsc --noEmit',
    'npx tsc --version --pretty',
    'grep x a.txt',
    'echo hi',
    'cat a.txt > out.txt',
    'ls 2>/dev/null',
    'echo $(ls)',
    'A=1 ls',
    'ls &',
    '(ls)',
    'ls || pwd',
    'cd src && npm test',
    'ls ; rm a.txt',
  ];
  for (const command of disallowedButAllowed) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `isReadOnlyBash should be false for: ${command}`);
    const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.equal(verdict.allow, true, `checkToolCall should allow: ${command}`);
  }
});

test('DB15.3: isReadOnlyBash false for pipe out of outside-set command', () => {
  const workspace = 'C:\\ws\\run';
  const outsidePipes = [
    'npm run poly check f 2>&1 | tail -30',
    'find . -type f | head',
  ];
  for (const command of outsidePipes) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `isReadOnlyBash should be false for: ${command}`);
  }
});

test('DB15.3: isReadOnlyBash false for empty string and whitespace only', () => {
  const workspace = 'C:\\ws\\run';
  assert.equal(isReadOnlyBash('', { workspace }), false);
  assert.equal(isReadOnlyBash('   ', { workspace }), false);
  assert.equal(isReadOnlyBash('\n', { workspace }), false);
});

test('DB15.3: isReadOnlyBash false for pipe edge cases', () => {
  const workspace = 'C:\\ws\\run';
  const edgeCases = [
    'ls |',
    '| ls',
    'ls | | head',
  ];
  for (const command of edgeCases) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `failed for: ${command}`);
  }
});

// Test 4: DB15.4 - Pipe into command outside the set is refused
test('DB15.4: checkToolCall denies pipe into command outside set', () => {
  const workspace = 'C:\\ws\\run';
  const deniedPipes = [
    'cat x | node -e "console.log(1)"',
    'cat x | sh',
    'cat x | bash -s',
    'cat x | node script.js',
    'ls | xargs rm',
    'find src -type f | grep -v node_modules',
    'cat a | head | grep b',
    'ls && cat x | node -e "1"',
    'cat x | npm test',
  ];
  for (const command of deniedPipes) {
    const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.equal(verdict.allow, false, `should deny: ${command}`);
    assert.ok(verdict.reason, `should have reason for: ${command}`);
    assert.ok(verdict.offending && verdict.offending.length > 0, `should have offending for: ${command}`);
    assert.equal(isReadOnlyBash(command, { workspace }), false, `isReadOnlyBash should be false for: ${command}`);
  }
});

test('DB15.4: checkToolCall allows pipe into command in set', () => {
  const workspace = 'C:\\ws\\run';
  const allowedPipes = [
    'cat x | head',
    'npm run poly check f 2>&1 | tail -30',
    'ls | node --version',
    'echo a | head',
  ];
  for (const command of allowedPipes) {
    const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.deepEqual(verdict, { allow: true }, `should allow: ${command}`);
  }
});

// Test 5: DB15.5 - Paths must be inside workspace
test('DB15.5: isReadOnlyBash and checkToolCall both deny outside paths', () => {
  const workspace = 'C:\\ws\\run';
  const outsidePaths = [
    'ls ..',
    'ls ../..',
    'ls /c/Users/jjdub',
    'cat C:\\Users\\x\\y',
    'cd .. && ls',
    'cat ../x | head',
    'ls ~',
    'ls $HOME',
    'cat /etc/passwd | head',
  ];
  for (const command of outsidePaths) {
    assert.equal(isReadOnlyBash(command, { workspace }), false, `isReadOnlyBash should deny: ${command}`);
    const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
    assert.equal(verdict.allow, false, `checkToolCall should deny: ${command}`);
  }
});

test('DB15.5: isReadOnlyBash false for outside paths from cwd', () => {
  const workspace = 'C:\\ws\\run';
  const cwd = 'C:\\ws\\run\\sub';
  assert.equal(isReadOnlyBash('cat ../../x | head', { workspace, cwd }), false);
});

test('DB15.5: isReadOnlyBash throws for relative workspace', () => {
  assert.throws(
    () => isReadOnlyBash('ls', { workspace: 'relative/path' }),
    (e) => e instanceof Error && !(e instanceof TypeError) && /absolute path/i.test(e.message),
    'must throw Error with "absolute path" in message'
  );
});

// Test 6: DB15.6 - Recorded replay ts-pilot-1
test('DB15.6: ts-pilot-1 first Bash command is in set and allowed', () => {
  const tsPilotSession = join(SESSIONS, 'ts-pilot-1', 'session.jsonl');
  const lines = readFileSync(tsPilotSession, 'utf8').split('\n');

  let firstBashCommand = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        firstBashCommand = part.input.command;
        break;
      }
    }
    if (firstBashCommand) break;
  }

  assert.ok(firstBashCommand, 'found first Bash call');
  assert.equal(
    firstBashCommand,
    'cd "C:/Users/jjdub/.poly-demo/runs/ts-pilot-1/workspace" && ls -la && cat orders.json | head -80 && node --version && npm --version',
    'first command is verbatim as expected'
  );
  assert.equal(isReadOnlyBash(firstBashCommand, { workspace: TS_WORKSPACE }), true);
  const verdict = checkToolCall({ tool: 'Bash', input: { command: firstBashCommand }, workspace: TS_WORKSPACE });
  assert.equal(verdict.allow, true);
});

test('DB15.6: ts-pilot-1 every Bash call is allowed by checkToolCall', () => {
  const tsPilotSession = join(SESSIONS, 'ts-pilot-1', 'session.jsonl');
  const lines = readFileSync(tsPilotSession, 'utf8').split('\n');

  let bashCallCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        bashCallCount++;
        const verdict = checkToolCall({ tool: 'Bash', input: { command: part.input.command }, workspace: TS_WORKSPACE });
        assert.equal(verdict.allow, true, `Bash call ${bashCallCount} should be allowed`);
      }
    }
  }

  assert.ok(bashCallCount >= 1, 'at least one Bash call found');
});

// Test 7: DB15.6 - Recorded replay poly-pilot-1
// Catches a guard that lets the escaping Bash calls of poly-pilot-1 through, denies one that stays in the workspace, or does not apply the pipe rule to the recorded find | grep.
test('DB15.7: poly-pilot-1: its Bash calls that name a place outside, or pipe into a command outside the set, are denied, and the others are allowed; none of its pipe-outs is in the set', () => {
  const calls = [];
  for (const line of readFileSync(join(SESSIONS, 'poly-pilot-1', 'session.jsonl'), 'utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) if (part.type === 'tool_use' && part.name === 'Bash') calls.push(part.input.command);
  }
  assert.ok(calls.length >= 8, `poly-pilot-1 has its Bash calls: ${calls.length}`);
  const outsideWord = (cmd) => /(^|[\s;&|"'])\.\.(\/|\\|\s|$|;)/.test(cmd) || /\/c\/users\/jjdub|c:[\\/]users[\\/]jjdub/i.test(cmd);
  const pipesIntoOutside = (cmd) => /\|\s*grep\b/.test(cmd);
  const wrong = [];
  let denied = 0;
  let allowed = 0;
  for (const cmd of calls) {
    const expectDenied = outsideWord(cmd) || pipesIntoOutside(cmd);
    const verdict = checkToolCall({ tool: 'Bash', input: { command: cmd }, workspace: POLY_WORKSPACE });
    if (verdict.allow === expectDenied) wrong.push(`${expectDenied ? 'allowed' : 'denied'}: ${cmd.slice(0, 120)}`);
    if (verdict.allow) allowed++; else denied++;
    assert.equal(isReadOnlyBash(cmd, { workspace: POLY_WORKSPACE }) && expectDenied, false, `not in the set: ${cmd.slice(0, 80)}`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(denied >= 4 && allowed >= 4, `denied ${denied}, allowed ${allowed}`);
  // The recorded find piped into grep is denied by the pipe rule, with the command named.
  const findGrep = calls.filter((c) => c.startsWith('cat poly.json; find src tools -type f | grep -v node_modules'));
  assert.equal(findGrep.length, 1);
  const verdict = checkToolCall({ tool: 'Bash', input: { command: findGrep[0] }, workspace: POLY_WORKSPACE });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /grep/);
  // The calls that pipe only into head or tail, from commands outside the set, are allowed by the guard and are not in the set.
  const pipeOuts = calls.filter((c) => /\|\s*(head|tail)\b/.test(c) && !outsideWord(c) && !pipesIntoOutside(c));
  assert.ok(pipeOuts.length >= 3, `pipe-outs found: ${pipeOuts.length}`);
  for (const cmd of pipeOuts) {
    assert.deepEqual(checkToolCall({ tool: 'Bash', input: { command: cmd }, workspace: POLY_WORKSPACE }), { allow: true }, cmd.slice(0, 80));
    assert.equal(isReadOnlyBash(cmd, { workspace: POLY_WORKSPACE }), false, cmd.slice(0, 80));
  }
});

test('DB15.8: hook allows read-only Bash and prints allow', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd "C:\\ws\\run" && ls -la && cat orders.json | head -80 && node --version && npm --version' }, cwd: 'C:\\ws\\run' });
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.length > 0);
});

test('DB15.8: hook abstains ({}) for Bash outside set but allowed by guard', () => {
  const commands = ['npm test', 'npm run poly check f 2>&1 | tail -30', 'node script.js', 'ls | head && npm test', 'npm --version --json'];
  for (const command of commands) {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\ws\\run' });
    const result = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {}, `hook should abstain for: ${command}`);
  }
});

test('DB15.8: hook denies pipes into commands outside the set', () => {
  const commands = [
    'cat x | node -e "1"',
    'cat x | sh',
    'find . -type f | grep y',
  ];
  for (const command of commands) {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\ws\\run' });
    const result = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `hook should deny: ${command}`);
  }
});

test('DB15.8: hook denies paths outside workspace', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls ../..' }, cwd: 'C:\\ws\\run' });
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook allows Read inside workspace, denies outside', () => {
  const stdin1 = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\ws\\run\\file.txt' }, cwd: 'C:\\ws\\run' });
  const result1 = spawnSync(process.execPath, [HOOK], {
    input: stdin1,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0);
  const output1 = JSON.parse(result1.stdout);
  assert.equal(output1.hookSpecificOutput.permissionDecision, 'allow');

  const stdin2 = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\x\\y' }, cwd: 'C:\\ws\\run' });
  const result2 = spawnSync(process.execPath, [HOOK], {
    input: stdin2,
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(result2.status, 0);
  const output2 = JSON.parse(result2.stdout);
  assert.equal(output2.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook fails closed without POLY_DEMO_WORKSPACE', () => {
  const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\ws\\run\\file.txt' }, cwd: 'C:\\ws\\run' });
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook fails closed on invalid JSON', () => {
  const result = spawnSync(process.execPath, [HOOK], {
    input: 'not json at all',
    env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook output identical regardless of POLY_DEMO_ARM', () => {
  const commands = ['cd src && ls', 'npm test'];
  for (const command of commands) {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\ws\\run' });
    const result1 = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run', POLY_DEMO_ARM: 'ts' },
      encoding: 'utf8',
    });
    const result2 = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: 'C:\\ws\\run', POLY_DEMO_ARM: 'poly' },
      encoding: 'utf8',
    });
    assert.equal(result1.status, 0);
    assert.equal(result2.status, 0);
    const output1 = JSON.parse(result1.stdout);
    const output2 = JSON.parse(result2.stdout);
    assert.deepEqual(output1, output2, `hook output should match for: ${command}`);
  }
});

// Catches a set that reads a relative path from the workspace and not from the folder the shell is in.
test('DB15.2: with the shell in a folder of the workspace, a relative path that stays inside is in the set', () => {
  const workspace = 'C:\\ws\\run';
  const cwd = 'C:\\ws\\run\\sub';
  assert.equal(isReadOnlyBash('cat ../a.txt | head', { workspace, cwd }), true);
  assert.equal(isReadOnlyBash('cat ../../a.txt | head', { workspace, cwd }), false);
});

// Catches a hook that abstains on, or denies, the whole recorded first Bash call of ts-pilot-1 (the call whose refusal is H4).
test('DB15.8: the hook allows the whole recorded first Bash call of ts-pilot-1 in its own workspace', () => {
  let first = null;
  for (const line of readFileSync(join(SESSIONS, 'ts-pilot-1', 'session.jsonl'), 'utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) if (!first && part.type === 'tool_use' && part.name === 'Bash') first = part.input.command;
  }
  assert.ok(first, 'found the first Bash call');
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: first }, cwd: TS_WORKSPACE }), env: { PATH: process.env.PATH, POLY_DEMO_WORKSPACE: TS_WORKSPACE }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);
});
