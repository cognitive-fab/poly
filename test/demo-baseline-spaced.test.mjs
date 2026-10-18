import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkToolCall, isReadOnlyBash } from '../demo/baseline/guard.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOOK = join(ROOT, 'demo', 'baseline', 'hook.mjs');

const DEMO_WORKSPACE = 'C:\\ws\\run';

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

test('DB15.8: checkToolCall denies cd with quoted path that has space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "sub dir/../../out"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: checkToolCall denies cat with quoted path that has space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cat "a b/../../x"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: checkToolCall denies ls with quoted path that has space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'ls "sub dir/../../out"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: isReadOnlyBash returns false for cd with space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "sub dir/../../out"';
  const result = isReadOnlyBash(command, { workspace });
  assert.equal(result, false);
});

test('DB15.8: isReadOnlyBash returns false for cat with space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cat "a b/../../x"';
  const result = isReadOnlyBash(command, { workspace });
  assert.equal(result, false);
});

test('DB15.8: isReadOnlyBash returns false for ls with space and .. segment', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'ls "sub dir/../../out"';
  const result = isReadOnlyBash(command, { workspace });
  assert.equal(result, false);
});

test('DB15.8: checkToolCall denies cd and cat with && joining and space/.. in cd target', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "ok dir" && cd "sub dir/../../../out"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: checkToolCall allows cd and cat with && and space but no escape', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "ok dir" && cat "a b/../../x"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, true);
});

test('DB15.8: checkToolCall denies cd and cat with && joining and space/.. in cat argument', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "ok dir" && cat "a b/../../../x"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: checkToolCall denies cd and ls with && joining and space/.. in ls argument', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "ok dir" && ls "sub dir/../../../out"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, false);
});

test('DB15.8: hook denies cd with space and .. segment from workspace root', () => {
  const command = 'cd "sub dir/../../out"';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook denies cat with space and .. segment from workspace root', () => {
  const command = 'cat "a b/../../x"';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: hook denies ls with space and .. segment from workspace root', () => {
  const command = 'ls "sub dir/../../out"';
  const { output, status } = runHook('Bash', { command }, {
    POLY_DEMO_WORKSPACE: DEMO_WORKSPACE,
  });
  assert.equal(status, 0);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('DB15.8: checkToolCall allows cd with quoted path that has space and a .. segment that stays inside', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "sub dir/../x"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, true);
});

test('DB15.8: checkToolCall allows cat with quoted path that has space and a .. segment that stays inside', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cat "a b/../x"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, true);
});

test('DB15.8: isReadOnlyBash returns true for cd with space and a .. segment that stays inside', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cd "sub dir/../x"';
  const result = isReadOnlyBash(command, { workspace });
  assert.equal(result, true);
});

test('DB15.8: isReadOnlyBash returns true for cat with space and a .. segment that stays inside', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'cat "a b/../x"';
  const result = isReadOnlyBash(command, { workspace });
  assert.equal(result, true);
});

test('DB15.8: checkToolCall allows node -e with prose (space but no path-like content)', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'node -e "a / b"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, true);
});

test('DB15.8: checkToolCall allows word with space and .. but not as path (prose)', () => {
  const workspace = DEMO_WORKSPACE;
  const command = 'echo "x .. y"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace });
  assert.equal(verdict.allow, true);
});

test('DB15.8: checkToolCall denies quoted space and .. segment via cd with non-root cwd', () => {
  const workspace = DEMO_WORKSPACE;
  const cwd = 'C:\\ws\\run\\subdir';
  const command = 'cd "ok dir/../../../out"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace, cwd });
  assert.equal(verdict.allow, false);
});

test('DB15.8: checkToolCall allows quoted space and .. inside workspace via relative path', () => {
  const workspace = DEMO_WORKSPACE;
  const cwd = 'C:\\ws\\run\\sub';
  const command = 'cd "ok dir/../a"';
  const verdict = checkToolCall({ tool: 'Bash', input: { command }, workspace, cwd });
  assert.equal(verdict.allow, true);
});
