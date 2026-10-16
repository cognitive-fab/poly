import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkToolCall, DISALLOWED_TOOLS, auditEscapes } from '../demo/baseline/guard.mjs';
import { hookSettings, claudeArgs } from '../demo/baseline/arms.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const isWindows = process.platform === 'win32';

// Catches a guard that accepts a relative workspace (DB11 item 1).
test('DB11.1: a relative workspace throws', () => {
  assert.throws(() => checkToolCall({ tool: 'Read', input: { file_path: 'file.txt' }, workspace: 'relative/path' }));
  assert.throws(() => checkToolCall({ tool: 'Read', input: { file_path: 'file.txt' }, workspace: '' }));
});

// Catches a guard that treats the null device as a path outside the workspace (a redirect to it is harmless).
test('DB11.7: redirects to the null device are not paths outside the workspace', () => {
  assert.deepEqual(checkToolCall({ tool: 'Bash', input: { command: 'npm test 2>/dev/null' }, workspace: 'C:\\ws\\run' }), { allow: true });
  assert.deepEqual(checkToolCall({ tool: 'Bash', input: { command: 'ls .poly > /dev/null 2>&1' }, workspace: 'C:\\ws\\run' }), { allow: true });
});

test('DB11.2: Containment - workspace allowed, child allowed, sibling denied, parent denied', () => {
  // Catches guard that allows paths outside workspace or siblings.
  const workspace = 'C:\\ws\\run';

  // Workspace itself is allowed.
  const resultWorkspace = checkToolCall({
    tool: 'Read',
    input: { file_path: workspace },
    workspace,
  });
  assert.deepEqual(resultWorkspace, { allow: true });

  // Child allowed.
  const resultChild = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run\\file.txt' },
    workspace,
  });
  assert.deepEqual(resultChild, { allow: true });

  // Sibling starting with workspace name is denied.
  const resultSibling = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run-other\\a' },
    workspace,
  });
  assert.equal(resultSibling.allow, false);
  assert(resultSibling.reason);
  assert(resultSibling.offending.length > 0);

  // Parent denied.
  const resultParent = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws' },
    workspace,
  });
  assert.equal(resultParent.allow, false);
  assert(resultParent.reason);
  assert(resultParent.offending.length > 0);
});

test('DB11.3: Path forms - C:\\x, C:/x, /c/x resolve same, case ignored on win32, .. normalised', () => {
  // Catches guard that does not normalise path forms or case.
  const workspace = 'C:\\ws\\run';

  // C:\x and C:/x and /c/x all resolve to same place.
  const result1 = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run\\file.txt' },
    workspace,
  });
  assert.deepEqual(result1, { allow: true });

  const result2 = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:/ws/run/file.txt' },
    workspace,
  });
  assert.deepEqual(result2, { allow: true });

  const result3 = checkToolCall({
    tool: 'Read',
    input: { file_path: '/c/ws/run/file.txt' },
    workspace,
  });
  assert.deepEqual(result3, { allow: true });

  if (isWindows) {
    // Case differences allowed on win32.
    const resultCase = checkToolCall({
      tool: 'Read',
      input: { file_path: 'C:\\WS\\RUN\\file.txt' },
      workspace,
    });
    assert.deepEqual(resultCase, { allow: true });
  }

  // .. segments normalised both ways: inside\\..\\inside allowed.
  const resultInside = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run\\sub\\..\\file.txt' },
    workspace,
  });
  assert.deepEqual(resultInside, { allow: true });

  // inside\\..\\..\\out denied.
  const resultOutside = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run\\sub\\..\\..\\file.txt' },
    workspace,
  });
  assert.equal(resultOutside.allow, false);
  assert(resultOutside.reason);
  assert(resultOutside.offending.length > 0);
});

test('DB11.4: DISALLOWED_TOOLS Agent, Task, WebFetch, WebSearch always denied', () => {
  // Catches guard that allows disallowed tools or deep-equal mismatch.
  assert.deepEqual(DISALLOWED_TOOLS, ['Agent', 'Task', 'WebFetch', 'WebSearch']);

  const workspace = 'C:\\ws\\run';

  // Each denied with empty input.
  for (const tool of DISALLOWED_TOOLS) {
    const result = checkToolCall({
      tool,
      input: {},
      workspace,
    });
    assert.equal(result.allow, false, `${tool} should be denied`);
    assert(result.reason);
    assert(result.offending.length > 0);
  }

  // Each denied with harmless input.
  for (const tool of DISALLOWED_TOOLS) {
    const result = checkToolCall({
      tool,
      input: { harmless: 'input' },
      workspace,
    });
    assert.equal(result.allow, false, `${tool} should be denied with input`);
    assert(result.reason);
    assert(result.offending.length > 0);
  }

  // Read inside file allowed.
  const resultRead = checkToolCall({
    tool: 'Read',
    input: { file_path: 'C:\\ws\\run\\file.txt' },
    workspace,
  });
  assert.deepEqual(resultRead, { allow: true });
});

test('DB11.5: File tools path inside allowed, outside denied, relative resolved against cwd', () => {
  // Catches guard that allows files outside workspace or does not resolve relative paths.
  const workspace = 'C:\\ws\\run';
  const inside = 'C:\\ws\\run\\sub\\file.txt';
  const outside = 'C:\\ws\\other\\file.txt';

  // Read inside allowed.
  const resultRead = checkToolCall({
    tool: 'Read',
    input: { file_path: inside },
    workspace,
  });
  assert.deepEqual(resultRead, { allow: true });

  // Write inside allowed.
  const resultWrite = checkToolCall({
    tool: 'Write',
    input: { file_path: inside },
    workspace,
  });
  assert.deepEqual(resultWrite, { allow: true });

  // Edit inside allowed.
  const resultEdit = checkToolCall({
    tool: 'Edit',
    input: { file_path: inside },
    workspace,
  });
  assert.deepEqual(resultEdit, { allow: true });

  // NotebookEdit inside allowed.
  const resultNotebook = checkToolCall({
    tool: 'NotebookEdit',
    input: { notebook_path: inside },
    workspace,
  });
  assert.deepEqual(resultNotebook, { allow: true });

  // Read outside denied.
  const resultReadOut = checkToolCall({
    tool: 'Read',
    input: { file_path: outside },
    workspace,
  });
  assert.equal(resultReadOut.allow, false);
  assert(resultReadOut.reason);

  // Relative path resolved against cwd inside, stays inside.
  const cwd = 'C:\\ws\\run\\sub';
  const resultRelInside = checkToolCall({
    tool: 'Read',
    input: { file_path: '../file.txt' },
    workspace,
    cwd,
  });
  assert.deepEqual(resultRelInside, { allow: true });

  // Relative path resolved against cwd leaves and is denied.
  const resultRelOutside = checkToolCall({
    tool: 'Read',
    input: { file_path: '../../file.txt' },
    workspace,
    cwd,
  });
  assert.equal(resultRelOutside.allow, false);
  assert(resultRelOutside.reason);

  // cwd defaults to workspace.
  const resultDefault = checkToolCall({
    tool: 'Read',
    input: { file_path: './file.txt' },
    workspace,
  });
  assert.deepEqual(resultDefault, { allow: true });
});

test('DB11.6: Glob and Grep path inside allowed, outside denied, patterns checked', () => {
  // Catches guard that allows Glob/Grep outside workspace or patterns that escape.
  const workspace = 'C:\\ws\\run';

  // Glob path inside allowed.
  const resultGlobInside = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: '**/*.js' },
    workspace,
  });
  assert.deepEqual(resultGlobInside, { allow: true });

  // Glob path outside denied.
  const resultGlobOut = checkToolCall({
    tool: 'Glob',
    input: { path: 'C:\\ws\\other', pattern: '**/*.js' },
    workspace,
  });
  assert.equal(resultGlobOut.allow, false);

  // Glob pattern **/*.js allowed.
  const resultGlobStar = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: '**/*.js' },
    workspace,
  });
  assert.deepEqual(resultGlobStar, { allow: true });

  // Glob pattern src/{a,b}/*.ts allowed.
  const resultGlobBrace = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: 'src/{a,b}/*.ts' },
    workspace,
  });
  assert.deepEqual(resultGlobBrace, { allow: true });

  // Glob pattern ../x/* denied.
  const resultGlobDotdot = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: '../x/*' },
    workspace,
  });
  assert.equal(resultGlobDotdot.allow, false);

  // Glob pattern C:/Users/** denied.
  const resultGlobAbs = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: 'C:/Users/**' },
    workspace,
  });
  assert.equal(resultGlobAbs.allow, false);

  // Glob pattern /c/Users/*/x denied.
  const resultGlobCdrive = checkToolCall({
    tool: 'Glob',
    input: { path: workspace, pattern: '/c/Users/*/x' },
    workspace,
  });
  assert.equal(resultGlobCdrive.allow, false);

  // Grep glob likewise.
  const resultGrepGlob = checkToolCall({
    tool: 'Grep',
    input: { path: workspace, glob: '**/*.js', pattern: 'test' },
    workspace,
  });
  assert.deepEqual(resultGrepGlob, { allow: true });

  // Static prefix resolved against path outside is denied.
  const resultGrepOutside = checkToolCall({
    tool: 'Grep',
    input: { path: 'C:\\ws\\other', glob: 'sub/*.js', pattern: 'test' },
    workspace,
  });
  assert.equal(resultGrepOutside.allow, false);
});

test('DB11.7: Bash allowed for safe commands, denied for escapes and env vars', () => {
  // Catches guard that allows home folder access, env vars, escapes in Bash.
  const workspace = 'C:\\ws\\run';

  // npm test allowed.
  const resultNpm = checkToolCall({
    tool: 'Bash',
    input: { command: 'npm test' },
    workspace,
  });
  assert.deepEqual(resultNpm, { allow: true });

  // npm install --save-dev ./unrelated allowed.
  const resultUnrelated = checkToolCall({
    tool: 'Bash',
    input: { command: 'npm install --save-dev ./unrelated' },
    workspace,
  });
  assert.deepEqual(resultUnrelated, { allow: true });

  // node src/server.js allowed.
  const resultNode = checkToolCall({
    tool: 'Bash',
    input: { command: 'node src/server.js' },
    workspace,
  });
  assert.deepEqual(resultNode, { allow: true });

  // ls -la allowed.
  const resultLs = checkToolCall({
    tool: 'Bash',
    input: { command: 'ls -la' },
    workspace,
  });
  assert.deepEqual(resultLs, { allow: true });

  // cat package.json && ls src allowed.
  const resultChain = checkToolCall({
    tool: 'Bash',
    input: { command: 'cat package.json && ls src' },
    workspace,
  });
  assert.deepEqual(resultChain, { allow: true });

  // curl http://localhost:3000/webhook allowed.
  const resultCurl = checkToolCall({
    tool: 'Bash',
    input: { command: 'curl http://localhost:3000/webhook' },
    workspace,
  });
  assert.deepEqual(resultCurl, { allow: true });

  // curl -X POST with body denied if path is outside.
  const resultCurlPath = checkToolCall({
    tool: 'Bash',
    input: { command: 'curl -X POST https://api.example.com/v1/x -d @body.json' },
    workspace,
  });
  assert.deepEqual(resultCurlPath, { allow: true });

  // cat ~/.ssh/id_rsa denied.
  const resultSsh = checkToolCall({
    tool: 'Bash',
    input: { command: 'cat ~/.ssh/id_rsa' },
    workspace,
  });
  assert.equal(resultSsh.allow, false);

  // ls $HOME denied.
  const resultHome1 = checkToolCall({
    tool: 'Bash',
    input: { command: 'ls $HOME' },
    workspace,
  });
  assert.equal(resultHome1.allow, false);

  // ls ${HOME} denied.
  const resultHome2 = checkToolCall({
    tool: 'Bash',
    input: { command: 'ls ${HOME}' },
    workspace,
  });
  assert.equal(resultHome2.allow, false);

  // echo $USERPROFILE denied.
  const resultUser1 = checkToolCall({
    tool: 'Bash',
    input: { command: 'echo $USERPROFILE' },
    workspace,
  });
  assert.equal(resultUser1.allow, false);

  // type %USERPROFILE%\\x denied.
  const resultUser2 = checkToolCall({
    tool: 'Bash',
    input: { command: 'type %USERPROFILE%\\x' },
    workspace,
  });
  assert.equal(resultUser2.allow, false);

  // cat ../outside.txt denied.
  const resultDotdot = checkToolCall({
    tool: 'Bash',
    input: { command: 'cat ../outside.txt' },
    workspace,
  });
  assert.equal(resultDotdot.allow, false);

  // ls /c/Users/x denied.
  const resultCdrive = checkToolCall({
    tool: 'Bash',
    input: { command: 'ls /c/Users/x' },
    workspace,
  });
  assert.equal(resultCdrive.allow, false);

  // cd .. && ls denied.
  const resultCdEscape = checkToolCall({
    tool: 'Bash',
    input: { command: 'cd .. && ls' },
    workspace,
  });
  assert.equal(resultCdEscape.allow, false);

  // cd sub && cat ../../x denied.
  const resultCdSub = checkToolCall({
    tool: 'Bash',
    input: { command: 'cd sub && cat ../../x' },
    workspace,
  });
  assert.equal(resultCdSub.allow, false);

  // cd sub && cat ../a ALLOWED (stays inside).
  const resultCdOk = checkToolCall({
    tool: 'Bash',
    input: { command: 'cd sub && cat ../a' },
    workspace,
  });
  assert.deepEqual(resultCdOk, { allow: true });

  // pushd .. && ls denied.
  const resultPushd = checkToolCall({
    tool: 'Bash',
    input: { command: 'pushd .. && ls' },
    workspace,
  });
  assert.equal(resultPushd.allow, false);

  // ls -la && cat C:\\Users\\x\\y denied.
  const resultMulti = checkToolCall({
    tool: 'Bash',
    input: { command: 'ls -la && cat C:\\Users\\x\\y' },
    workspace,
  });
  assert.equal(resultMulti.allow, false);

  // echo $(cat /c/Users/x/y) denied.
  const resultSub1 = checkToolCall({
    tool: 'Bash',
    input: { command: 'echo $(cat /c/Users/x/y)' },
    workspace,
  });
  assert.equal(resultSub1.allow, false);

  // echo `cat /etc/passwd` denied.
  const resultSub2 = checkToolCall({
    tool: 'Bash',
    input: { command: 'echo `cat /etc/passwd`' },
    workspace,
  });
  assert.equal(resultSub2.allow, false);

  // tool --out=/c/Users/x/y denied (flag=value checked as value).
  const resultFlag = checkToolCall({
    tool: 'Bash',
    input: { command: 'tool --out=/c/Users/x/y' },
    workspace,
  });
  assert.equal(resultFlag.allow, false);

  // tool --out=./ok allowed.
  const resultFlagOk = checkToolCall({
    tool: 'Bash',
    input: { command: 'tool --out=./ok' },
    workspace,
  });
  assert.deepEqual(resultFlagOk, { allow: true });

  // node -e "require('fs').readFileSync('C:/Users/x/y')" denied.
  const resultNodeQuote = checkToolCall({
    tool: 'Bash',
    input: { command: 'node -e "require(\'fs\').readFileSync(\'C:/Users/x/y\')"' },
    workspace,
  });
  assert.equal(resultNodeQuote.allow, false);

  // grep x '/etc/hosts' denied.
  const resultGrepQuote1 = checkToolCall({
    tool: 'Bash',
    input: { command: 'grep x \'/etc/hosts\'' },
    workspace,
  });
  assert.equal(resultGrepQuote1.allow, false);

  // cat "/home/u/x" denied.
  const resultCatQuote = checkToolCall({
    tool: 'Bash',
    input: { command: 'cat "/home/u/x"' },
    workspace,
  });
  assert.equal(resultCatQuote.allow, false);

  // cat /tmp/x denied.
  const resultTmp = checkToolCall({
    tool: 'Bash',
    input: { command: 'cat /tmp/x' },
    workspace,
  });
  assert.equal(resultTmp.allow, false);
});

test('DB11.8: Real junction inside pointing outside denied, inside pointing inside allowed', (t) => {
  // Catches guard that does not follow junctions or real paths.
  if (!isWindows) {
    t.skip('Junctions are Windows only');
    return;
  }

  const tempDir = mkdtempSync(resolve(tmpdir(), 'poly-demo-'));
  try {
    const workspace = resolve(tempDir, 'workspace');
    const outside = resolve(tempDir, 'outside');
    const outsideFile = resolve(outside, 'secret.txt');

    // Create directories and file.
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(outsideFile, 'secret');

    // Create a junction inside pointing outside.
    const junctionPath = resolve(workspace, 'junction');
    symlinkSync(outside, junctionPath, 'junction');

    // Read of junction\\file is denied.
    const resultJunction = checkToolCall({
      tool: 'Read',
      input: { file_path: resolve(junctionPath, 'secret.txt') },
      workspace,
    });
    assert.equal(resultJunction.allow, false);

    // Create a junction inside pointing inside.
    const junctionInside = resolve(workspace, 'sub', 'junction');
    mkdirSync(resolve(workspace, 'sub'));
    const insideTarget = resolve(workspace, 'target');
    mkdirSync(insideTarget);
    symlinkSync(insideTarget, junctionInside, 'junction');

    // Junction inside pointing inside is allowed.
    const resultInside = checkToolCall({
      tool: 'Read',
      input: { file_path: resolve(junctionInside, 'file.txt') },
      workspace,
    });
    assert.deepEqual(resultInside, { allow: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- DB11 items 7 and 8: the hook as a child process ------------------------------------------------

const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

/** Runs the hook with the given stdin and environment. The spec says it always exits 0 and prints one JSON object. */
function runHook(stdin, env) {
  const child = spawnSync(process.execPath, [HOOK], { input: stdin, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(child.status, 0, `the hook exits 0: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

const hookCall = (tool_name, tool_input, workspace) => JSON.stringify({ tool_name, tool_input, cwd: workspace });

// Catches a hook that denies inside paths, or whose output does not have the PreToolUse shape.
test('DB11.9: the hook allows a Read inside the workspace with the PreToolUse output shape', () => {
  const workspace = 'C:\\ws\\run';
  const out = runHook(hookCall('Read', { file_path: 'C:\\ws\\run\\file.txt' }, workspace), { POLY_DEMO_WORKSPACE: workspace });
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(typeof out.hookSpecificOutput.permissionDecisionReason, 'string');
});

// Catches a hook that does not call the guard, or that denies without a reason.
test('DB11.9: the hook denies a Read outside the workspace and the Agent tool, with a reason', () => {
  const workspace = 'C:\\ws\\run';
  for (const [tool, input] of [['Read', { file_path: 'C:\\Users\\x\\y' }], ['Agent', { prompt: 'find things' }], ['Bash', { command: 'ls /c/Users/x' }]]) {
    const out = runHook(hookCall(tool, input, workspace), { POLY_DEMO_WORKSPACE: workspace });
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse', tool);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', tool);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0, tool);
  }
});

// Catches a hook that fails open when its configuration or its input is wrong (DB11 item 7).
test('DB11.9: the hook fails closed: no workspace, a relative workspace, input that is not JSON, empty input', () => {
  const good = hookCall('Read', { file_path: 'C:\\ws\\run\\file.txt' }, 'C:\\ws\\run');
  for (const [label, stdin, env] of [
    ['no workspace variable', good, {}],
    ['relative workspace', good, { POLY_DEMO_WORKSPACE: 'relative/path' }],
    ['input not JSON', 'this is not json', { POLY_DEMO_WORKSPACE: 'C:\\ws\\run' }],
    ['empty input', '', { POLY_DEMO_WORKSPACE: 'C:\\ws\\run' }],
  ]) {
    const out = runHook(stdin, env);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', label);
  }
});

// ---- DB11 item 8: how it is installed ---------------------------------------------------------------

// Catches settings of the wrong shape, a command that keeps backslashes, or arms that differ.
test('DB11.8: hookSettings has the PreToolUse shape with forward slashes, and claudeArgs adds the same three options for both arms', () => {
  assert.deepEqual(hookSettings('C:\\a\\hook.mjs'), { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "C:/a/hook.mjs"' }] }] } });
  const optionOf = (args, name) => args[args.indexOf(name) + 1];
  const ts = claudeArgs({ arm: 'ts', prompt: 'P' });
  const poly = claudeArgs({ arm: 'poly', prompt: 'P' });
  for (const args of [ts, poly]) {
    assert.ok(args.includes('--settings') && args.includes('--tools') && args.includes('--disallowedTools'));
    const settings = JSON.parse(optionOf(args, '--settings'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(command.startsWith('node "') && command.endsWith('hook.mjs"'), command);
    assert.ok(!command.includes('\\'), 'no backslash in the command');
    assert.equal(optionOf(args, '--tools'), 'Read,Write,Edit,Glob,Grep,Bash');
    assert.equal(optionOf(args, '--disallowedTools'), 'Agent,Task,WebFetch,WebSearch');
  }
  for (const name of ['--settings', '--tools', '--disallowedTools']) assert.equal(optionOf(ts, name), optionOf(poly, name), name);
});

// ---- DB11 item 9: the recorded sessions -------------------------------------------------------------

const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');
const TS_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
const POLY_WORKSPACE = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';

/** Every tool_use of a recorded session, in order. */
function toolUses(arm) {
  const calls = [];
  for (const line of readFileSync(join(SESSIONS, `${arm}-pilot-1`, 'session.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) if (part.type === 'tool_use') calls.push({ tool: part.name, input: part.input });
  }
  return calls;
}

const flat = (text) => text.toLowerCase().replace(/\\+/g, '/');
/** The classifier of DB11 item 9: a call is expected denied if it is Agent, or names a place under the home folder, C:\dev or C:\src other than the arm's own workspace. */
function expectedDenied(call, workspace) {
  if (call.tool === 'Agent') return true;
  // A Bash word that is '..' (or starts with '../') names the folder above the workspace.
  if (call.tool === 'Bash' && /(^|[\s"'=;&|(<>])\.\.([\s/\\"';&|)]|$)/.test(call.input.command ?? '')) return true;
  const text = flat(JSON.stringify(call.input));
  const own = flat(workspace);
  const ownShort = own.replace('c:/', '/c/');
  const outside = ['c:/users/jjdub', '/c/users/jjdub', 'c:/dev', 'c:/src'];
  return outside.some((place) => {
    let rest = text;
    // Remove the arm's own workspace first: it sits under the home folder and is allowed.
    rest = rest.split(own).join('').split(ownShort).join('');
    return rest.includes(place);
  });
}

const show = (call) => `${call.tool} ${JSON.stringify(call.input).slice(0, 120)}`;

// Catches a guard that denies something the first pilot legitimately did.
test('DB11.11: every call of ts-pilot-1 is allowed in its workspace', () => {
  const calls = toolUses('ts');
  assert.ok(calls.length > 25, `calls: ${calls.length}`);
  for (const call of calls) assert.deepEqual(checkToolCall({ tool: call.tool, input: call.input, workspace: TS_WORKSPACE }), { allow: true }, show(call));
});

// Catches a guard that allows what poly-pilot-1 reached, denies what it was allowed to do, or denies everything or nothing.
test('DB11.12: every call of poly-pilot-1 is allowed or denied as the classifier says, with counts, and three named calls', () => {
  const calls = toolUses('poly');
  let denied = 0;
  let allowed = 0;
  for (const call of calls) {
    const result = checkToolCall({ tool: call.tool, input: call.input, workspace: POLY_WORKSPACE });
    assert.equal(result.allow === false, expectedDenied(call, POLY_WORKSPACE), show(call));
    if (result.allow) allowed++; else denied++;
  }
  assert.ok(denied >= 30, `denied: ${denied}`);
  assert.ok(allowed >= 10, `allowed: ${allowed}`);
  assert.equal(calls.filter((call) => call.tool === 'Agent').length, 1);
  const named = (tool, wanted) => {
    const found = calls.filter((call) => call.tool === tool && wanted(call.input));
    assert.ok(found.length >= 1, `a recorded ${tool} call exists`);
    return found;
  };
  for (const call of named('Glob', (input) => input.path === 'C:\\Users\\jjdub\\AppData\\Roaming\\npm\\node_modules')) assert.equal(checkToolCall({ tool: call.tool, input: call.input, workspace: POLY_WORKSPACE }).allow, false);
  for (const call of named('Glob', (input) => input.path === 'C:\\Users\\jjdub\\.poly-demo')) assert.equal(checkToolCall({ tool: call.tool, input: call.input, workspace: POLY_WORKSPACE }).allow, false);
  for (const call of named('Read', (input) => input.file_path === `${POLY_WORKSPACE}\\tools\\poly\\README.md`)) assert.deepEqual(checkToolCall({ tool: call.tool, input: call.input, workspace: POLY_WORKSPACE }), { allow: true });
});

// ---- DB11 item 10: the audit ------------------------------------------------------------------------

const event = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });

// Catches an audit that calls an unclean session clean, or a clean one escaped, or that drops the fields of a call.
test('DB11.13: auditEscapes on synthetic sessions: clean, escaped with three calls, junk lines ignored, cwd tracked within a command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [event('Read', { file_path: 'C:\\ws\\run\\a.txt' }), 'this line is not json', event('Bash', { command: 'cd sub && cat ../a' })].join('\n'));
    assert.deepEqual(auditEscapes(file, workspace), { status: 'clean', calls: [] });
    writeFileSync(file, [event('Read', { file_path: 'C:\\other\\file.txt' }), 'junk', event('Bash', { command: 'cd .. && cat x' }), event('Agent', {})].join('\n'));
    const audit = auditEscapes(file, workspace);
    assert.equal(audit.status, 'escaped');
    assert.deepEqual(audit.calls.map((call) => call.tool), ['Read', 'Bash', 'Agent']);
    for (const call of audit.calls) {
      assert.ok(call.reason.length > 0 && Array.isArray(call.offending) && call.offending.length > 0 && typeof call.excerpt === 'string', JSON.stringify(call));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Catches an audit that misreads the real first pilot (which must be clean) or the real second one (which must be escaped, with the Agent call).
test('DB11.14: auditEscapes on the recorded sessions: ts-pilot-1 clean, poly-pilot-1 escaped with exactly the expected-denied calls', () => {
  assert.deepEqual(auditEscapes(join(SESSIONS, 'ts-pilot-1', 'session.jsonl'), TS_WORKSPACE), { status: 'clean', calls: [] });
  const audit = auditEscapes(join(SESSIONS, 'poly-pilot-1', 'session.jsonl'), POLY_WORKSPACE);
  assert.equal(audit.status, 'escaped');
  const expected = toolUses('poly').filter((call) => expectedDenied(call, POLY_WORKSPACE));
  assert.equal(audit.calls.length, expected.length);
  assert.equal(audit.calls.filter((call) => call.tool === 'Agent').length, 1);
});
