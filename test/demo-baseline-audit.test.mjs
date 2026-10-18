import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditRun } from '../demo/baseline/audit.mjs';
import { auditEscapes } from '../demo/baseline/guard.mjs';
import { prepareCommit, buildRecord, RECORD } from '../demo/baseline/procedure.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SESSIONS = join(ROOT, 'demo', 'baseline', 'runs');

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'audit-git-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  for (const name of ['PROMPT.md', 'arm-ts.md', 'arm-poly.md', 'orders.json']) {
    try {
      readFileSync(join(ROOT, 'demo', 'baseline', name));
      writeFileSync(join(root, 'demo', 'baseline', name), readFileSync(join(ROOT, 'demo', 'baseline', name), 'utf8'));
    } catch {
      writeFileSync(join(root, 'demo', 'baseline', name), `test ${name}`);
    }
  }
  const base = buildRecord({ root: ROOT, version: '1.0', scaffolds: { ts: 'sha256:ts', poly: 'sha256:poly' }, reference: { files: ['README.md'], listSha256: 'sha256:list', treeSha256: 'sha256:tree' } });
  writeFileSync(join(root, RECORD), JSON.stringify(base, null, 2) + '\n');
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'pre-registration');
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

let toolUseCounter = 0;
const assistantEvent = (tool, input, id = null) => {
  if (id === null) {
    id = `tool-${++toolUseCounter}`;
  }
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id,
        name: tool,
        input
      }]
    }
  });
};

const toolResultEvent = (toolUseId, content, isError = false) => JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: isError,
      content
    }]
  }
});

const toolResultArrayEvent = (toolUseId, contentBlocks, isError = false) => JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: isError,
      content: contentBlocks
    }]
  }
});

test('DB17.1: a session with only allowed calls is clean, escaped=[], refused=[]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [
      assistantEvent('Read', { file_path: 'C:\\ws\\run\\a.txt' }),
      assistantEvent('Bash', { command: 'npm test' })
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'clean', 'status is clean');
    assert.deepEqual(result.escaped, [], 'escaped is empty');
    assert.deepEqual(result.refused, [], 'refused is empty');
    assert.deepEqual(result.calls, [], 'calls is empty (same as escaped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.2: a Bash call with pipe into command outside the set inside the workspace is refused by guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, assistantEvent('Bash', { command: 'cat x | node -e "1"' }));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'clean', 'status stays clean');
    assert.deepEqual(result.escaped, [], 'escaped is empty');
    assert.deepEqual(result.calls, [], 'calls is empty');
    assert.equal(result.refused.length, 1, 'refused has one entry');
    assert.equal(result.refused[0].by, 'guard', 'refused entry is by guard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.3: Read outside, Glob with path outside, Agent call, Bash ls ../.. are each in escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [
      assistantEvent('Read', { file_path: 'C:\\Users\\jjdub\\secret.txt' }),
      assistantEvent('Glob', { path: 'C:\\Users\\jjdub', pattern: '*.txt' }),
      assistantEvent('Agent', {}),
      assistantEvent('Bash', { command: 'ls ../../..' })
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'escaped', 'status is escaped');
    assert.equal(result.escaped.length, 4, 'escaped has 4 entries');
    assert.deepEqual(result.escaped, result.calls, 'calls deep-equals escaped');
    assert.deepEqual(result.escaped.map(c => c.tool), ['Read', 'Glob', 'Agent', 'Bash']);
    for (const call of result.escaped) {
      assert.ok(typeof call.reason === 'string' && call.reason.length > 0, `${call.tool}: reason is non-empty string`);
      assert.ok(Array.isArray(call.offending), `${call.tool}: offending is array`);
      assert.ok(typeof call.excerpt === 'string', `${call.tool}: excerpt is string`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.4: Bash call guard allows but tool_result is permission refusal is in refused with by=tool-list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'npm run typecheck' }, 'typecheck-1'),
      toolResultEvent('typecheck-1', refusalMessage, true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'clean', 'status stays clean');
    assert.deepEqual(result.escaped, [], 'escaped is empty');
    assert.equal(result.refused.length, 1, 'refused has one entry');
    assert.equal(result.refused[0].by, 'tool-list', 'refused entry is by tool-list');
    assert.equal(result.refused[0].reason, refusalMessage, 'reason equals first line of tool result');
    assert.deepEqual(result.refused[0].offending, [], 'offending is empty');
    assert.deepEqual(result.calls, [], 'calls is empty (same as escaped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.5: Bash call guard denies for place outside workspace AND tool_result is refusal is in escaped only, not refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'ls ../../..' }, 'ls-outside-1'),
      toolResultEvent('ls-outside-1', refusalMessage, true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'escaped', 'status is escaped');
    assert.equal(result.escaped.length, 1, 'escaped has 1 entry');
    assert.equal(result.escaped[0].tool, 'Bash', 'tool is Bash');
    assert.deepEqual(result.refused, [], 'refused is empty');
    assert.equal(result.calls.length, 1, 'calls has 1 entry (same as escaped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.6: Bash cat ../x | grep y (outside AND pipe) is in escaped, not refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, assistantEvent('Bash', { command: 'cat ../x | grep y' }));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'escaped', 'status is escaped');
    assert.equal(result.escaped.length, 1, 'escaped has 1 entry');
    assert.equal(result.escaped[0].tool, 'Bash', 'tool is Bash');
    assert.deepEqual(result.refused, [], 'refused is empty');
    assert.equal(result.calls.length, 1, 'calls has 1 entry (same as escaped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.7: non-refusal error result does not make a refused entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'npm test' }),
      toolResultEvent('x', 'Exit code 2: test failed', true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'clean', 'status is clean');
    assert.deepEqual(result.escaped, [], 'escaped is empty');
    assert.deepEqual(result.refused, [], 'refused is empty');
    assert.deepEqual(result.calls, [], 'calls is empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.8: escaped and refused entries keep session order interleaved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'cat ../escape1.txt' }, 'e1'),
      assistantEvent('Bash', { command: 'npm run test' }, 'r1'),
      toolResultEvent('r1', refusalMessage, true),
      assistantEvent('Read', { file_path: 'C:\\escape2.txt' }, 'e2'),
      assistantEvent('Bash', { command: 'npm run check' }, 'r2'),
      toolResultEvent('r2', refusalMessage, true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.escaped.length, 2, 'escaped has 2 entries');
    assert.equal(result.refused.length, 2, 'refused has 2 entries');
    assert.ok(result.escaped[0].excerpt.includes('escape1'), 'first escaped is escape1');
    assert.ok(result.escaped[1].excerpt.includes('escape2'), 'second escaped is escape2');
    assert.ok(result.refused[0].excerpt.includes('npm run test'), 'first refused is npm run test');
    assert.ok(result.refused[1].excerpt.includes('npm run check'), 'second refused is npm run check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.9: each entry has required keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Read', { file_path: 'C:\\secret.txt' }, 'read-1'),
      assistantEvent('Bash', { command: 'npm run test' }, 'bash-1'),
      toolResultEvent('bash-1', refusalMessage, true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.escaped.length, 1, 'one escaped entry');
    const escaped = result.escaped[0];
    assert.ok('tool' in escaped, 'escaped: has tool');
    assert.ok('reason' in escaped, 'escaped: has reason');
    assert.ok('offending' in escaped, 'escaped: has offending');
    assert.ok('excerpt' in escaped, 'escaped: has excerpt');
    assert.equal(typeof escaped.tool, 'string', 'escaped: tool is string');
    assert.equal(typeof escaped.reason, 'string', 'escaped: reason is string');
    assert.ok(Array.isArray(escaped.offending), 'escaped: offending is array');
    assert.equal(typeof escaped.excerpt, 'string', 'escaped: excerpt is string');
    assert.equal(result.refused.length, 1, 'one refused entry');
    const refused = result.refused[0];
    assert.ok('tool' in refused, 'refused: has tool');
    assert.ok('reason' in refused, 'refused: has reason');
    assert.ok('offending' in refused, 'refused: has offending');
    assert.ok('excerpt' in refused, 'refused: has excerpt');
    assert.ok('by' in refused, 'refused: has by');
    assert.equal(typeof refused.by, 'string', 'refused: by is string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.10: cwd rule - first call cd, second call inside, third call outside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'cd sub && ls' }, 'cd-ls'),
      assistantEvent('Bash', { command: 'cat ../orders.json' }, 'cat-inside'),
      assistantEvent('Bash', { command: 'cat ../../x' }, 'cat-outside')
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'escaped', 'status is escaped');
    assert.equal(result.escaped.length, 1, 'one escaped call');
    assert.equal(result.escaped[0].tool, 'Bash', 'the escaped call is Bash');
    assert.ok(/cat.*\.\.\/\.\.\/x|cat \.\.\/\.\.\/x|\.\.\/\.\.\/x/.test(result.escaped[0].excerpt), 'excerpt mentions ../../x');
    assert.ok(!result.escaped.some(e => e.excerpt && /orders\.json/.test(e.excerpt)), 'no escaped excerpt contains orders.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.11: auditRun does not modify the session file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const content = [
      assistantEvent('Read', { file_path: 'C:\\ws\\run\\a.txt' }, 'read-ok'),
      assistantEvent('Bash', { command: 'npm test' }, 'bash-ok')
    ].join('\n');
    writeFileSync(file, content);
    const before = readFileSync(file, 'utf8');
    auditRun(file, workspace);
    const after = readFileSync(file, 'utf8');
    assert.equal(before, after, 'file contents unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.4 variation: tool result content as array of blocks is in refused by tool-list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalText = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'npm run test' }, 'bash-1'),
      toolResultArrayEvent('bash-1', [{ type: 'text', text: refusalText }], true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.status, 'clean', 'status is clean');
    assert.equal(result.refused.length, 1, 'refused has one entry');
    assert.equal(result.refused[0].by, 'tool-list', 'refused entry is by tool-list');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.4 variation: multiline tool result reason is first line only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const firstLine = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    const multilineRefusal = firstLine + '\nIMPORTANT: You may attempt to accomplish this using other tools.';
    writeFileSync(file, [
      assistantEvent('Bash', { command: 'npm run test' }, 'bash-1'),
      toolResultEvent('bash-1', multilineRefusal, true)
    ].join('\n'));
    const result = auditRun(file, workspace);
    assert.equal(result.refused.length, 1, 'refused has one entry');
    assert.equal(result.refused[0].reason, firstLine, 'reason is first line only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.12: ts-pilot-1 clean, poly-pilot-1 escaped with grep pipe refused by guard', () => {
  const tsWorkspace = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
  const audit = auditRun(join(SESSIONS, 'ts-pilot-1', 'session.jsonl'), tsWorkspace);
  assert.equal(audit.status, 'clean', 'ts-pilot-1 is clean');
  assert.deepEqual(audit.escaped, [], 'ts-pilot-1 escaped is empty');
  assert.deepEqual(audit.calls, [], 'ts-pilot-1 calls is empty');

  const polyWorkspace = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';
  const polyAudit = auditRun(join(SESSIONS, 'poly-pilot-1', 'session.jsonl'), polyWorkspace);
  assert.equal(polyAudit.status, 'escaped', 'poly-pilot-1 is escaped');
  assert.ok(polyAudit.escaped.length > 0, 'poly-pilot-1 has escaped calls');
  assert.deepEqual(polyAudit.calls, polyAudit.escaped, 'calls equals escaped');

  const grepVCall = polyAudit.refused.find(c => c.excerpt && /grep.*-v.*node_modules/.test(c.excerpt));
  assert.ok(grepVCall, 'grep -v node_modules pipe is in refused');
  assert.equal(grepVCall.by, 'guard', 'grep -v pipe is refused by guard, not in escaped');
});

test('DB17.12: ts-pilot-2 clean with 2 tool-list refused calls', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\work\\ts-pilot-2';
  const audit = auditRun(join(SESSIONS, 'ts-pilot-2', 'session.jsonl'), workspace);
  assert.equal(audit.status, 'clean', 'ts-pilot-2 status is clean');
  assert.deepEqual(audit.escaped, [], 'ts-pilot-2 escaped is empty');
  assert.equal(audit.refused.length, 2, 'ts-pilot-2 has exactly 2 refused calls');
  assert.ok(audit.refused.every(c => c.reason && typeof c.reason === 'string'), 'all refused have reason');
  assert.ok(audit.refused.every(c => c.by === 'tool-list'), 'all refused are by tool-list');
  const excerpts = audit.refused.map(c => c.excerpt);
  assert.ok(excerpts.some(e => /mkdir -p src test/.test(e)), 'one excerpt contains mkdir -p src test');
  assert.ok(excerpts.some(e => /npm run typecheck|npx tsc/.test(e)), 'one excerpt contains npm run typecheck or equivalent');
});

test('DB17.12: poly-pilot-2 clean, escaped=[], refused with 4 calls of mixed by values', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\work\\poly-pilot-2';
  const audit = auditRun(join(SESSIONS, 'poly-pilot-2', 'session.jsonl'), workspace);
  assert.equal(audit.status, 'clean', 'poly-pilot-2 status is clean');
  assert.deepEqual(audit.escaped, [], 'poly-pilot-2 escaped is empty');
  assert.equal(audit.refused.length, 4, 'poly-pilot-2 refused has 4 calls');

  const byValues = audit.refused.map(c => c.by);
  const toolListCount = byValues.filter(b => b === 'tool-list').length;
  const guardCount = byValues.filter(b => b === 'guard').length;
  assert.equal(guardCount, 1, 'one refused is by guard');
  assert.equal(toolListCount, 3, 'three refused are by tool-list');

  const grepCall = audit.refused.find(c => c.excerpt && /grep.*-v/.test(c.excerpt));
  assert.ok(grepCall, 'grep -v call is in refused');
  assert.equal(grepCall.by, 'guard', 'grep -v is by guard');

  const forCall = audit.refused.find(c => c.excerpt && /for p in poly/.test(c.excerpt));
  assert.ok(forCall, 'for p in poly call is in refused');
  assert.equal(forCall.by, 'tool-list', 'for p in poly is by tool-list');

  const lintCall = audit.refused.find(c => c.excerpt && /lint handlers/.test(c.excerpt));
  assert.ok(lintCall, 'lint handlers call is in refused');
  assert.equal(lintCall.by, 'tool-list', 'lint handlers is by tool-list');

  const mktempCall = audit.refused.find(c => c.excerpt && /mktemp/.test(c.excerpt));
  assert.ok(mktempCall, 'mktemp call is in refused');
  assert.equal(mktempCall.by, 'tool-list', 'mktemp is by tool-list');
});

test('DB17.c: auditRun.calls equals auditRun.escaped and consistency with auditEscapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const workspace = 'C:\\ws\\run';
    const file = join(dir, 'session.jsonl');
    const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
    writeFileSync(file, [
      assistantEvent('Read', { file_path: 'C:\\secret.txt' }, 'read-1'),
      assistantEvent('Bash', { command: 'npm test' }, 'bash-1'),
      toolResultEvent('bash-1', refusalMessage, true)
    ].join('\n'));
    const auditRunResult = auditRun(file, workspace);
    const auditEscapesResult = auditEscapes(file, workspace);
    assert.equal(auditRunResult.escaped.length, 1, 'escaped has one entry (Read outside)');
    assert.equal(auditRunResult.refused.length, 1, 'refused has one entry (tool-list Bash)');
    assert.deepEqual(auditRunResult.calls, auditRunResult.escaped, 'calls equals escaped');
    assert.equal(auditRunResult.calls.length, 1, 'calls has the Read outside, not the tool-list refused Bash');
    assert.equal(auditEscapesResult.calls.length, auditRunResult.escaped.length, 'auditEscapes.calls matches auditRun.escaped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB17.6c: ts-pilot-1 escaped + guard-refused == auditEscapes.calls', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\runs\\ts-pilot-1\\workspace';
  const file = join(SESSIONS, 'ts-pilot-1', 'session.jsonl');
  const auditRunResult = auditRun(file, workspace);
  const auditEscapesResult = auditEscapes(file, workspace);
  const guardRefusedCount = auditRunResult.refused.filter(c => c.by === 'guard').length;
  assert.equal(auditRunResult.escaped.length + guardRefusedCount, auditEscapesResult.calls.length, 'ts-pilot-1: escaped + guard-refused == auditEscapes.calls');
});

test('DB17.6c: poly-pilot-1 escaped + guard-refused == auditEscapes.calls', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\runs\\poly-pilot-1\\workspace';
  const file = join(SESSIONS, 'poly-pilot-1', 'session.jsonl');
  const auditRunResult = auditRun(file, workspace);
  const auditEscapesResult = auditEscapes(file, workspace);
  const guardRefusedCount = auditRunResult.refused.filter(c => c.by === 'guard').length;
  assert.equal(auditRunResult.escaped.length + guardRefusedCount, auditEscapesResult.calls.length, 'poly-pilot-1: escaped + guard-refused == auditEscapes.calls');
});

test('DB17.6c: ts-pilot-2 escaped + guard-refused == auditEscapes.calls', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\work\\ts-pilot-2';
  const file = join(SESSIONS, 'ts-pilot-2', 'session.jsonl');
  const auditRunResult = auditRun(file, workspace);
  const auditEscapesResult = auditEscapes(file, workspace);
  const guardRefusedCount = auditRunResult.refused.filter(c => c.by === 'guard').length;
  assert.equal(auditRunResult.escaped.length + guardRefusedCount, auditEscapesResult.calls.length, 'ts-pilot-2: escaped + guard-refused == auditEscapes.calls');
});

test('DB17.6c: poly-pilot-2 escaped + guard-refused == auditEscapes.calls', () => {
  const workspace = 'C:\\Users\\jjdub\\.poly-demo\\work\\poly-pilot-2';
  const file = join(SESSIONS, 'poly-pilot-2', 'session.jsonl');
  const auditRunResult = auditRun(file, workspace);
  const auditEscapesResult = auditEscapes(file, workspace);
  const guardRefusedCount = auditRunResult.refused.filter(c => c.by === 'guard').length;
  assert.equal(auditRunResult.escaped.length + guardRefusedCount, auditEscapesResult.calls.length, 'poly-pilot-2: escaped + guard-refused == auditEscapes.calls');
});

test('DB12/DB17.d: prepareCommit writes RECORD.json with audit.status, audit.calls, audit.refused (pipe inside, no escapes)', async () => {
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'audit-preparecommit-runs-'));
  const workDir = mkdtempSync(join(tmpdir(), 'audit-preparecommit-work-'));
  const workspace = join(workDir, 'test-test-run');
  const runDir = join(runsDir, 'test-test-run');

  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(join(workspace, 'package.json'), '{}');
  writeFileSync(join(runDir, 'initial.json'), JSON.stringify({
    'package.json': sha('{}')
  }));

  const refusalMessage = 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.';
  const sessionContent = [
    assistantEvent('Bash', { command: 'cat x | grep -v node_modules' }, 'pipe-1'),
    assistantEvent('Bash', { command: 'npm test' }, 'bash-1'),
    toolResultEvent('bash-1', refusalMessage, true)
  ].join('\n');
  writeFileSync(join(runDir, 'session.jsonl'), sessionContent);

  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    arm: 'test', run: 'test-run', exit: 0, startedWith: {}, sdkResult: 'success',
    finalMessage: 'test', workspace, costUsd: 1.5, usage: { input_tokens: 10, output_tokens: 5 },
    stderrTail: '', error: null, modelCallFlags: {}
  }));

  try {
    const commands = await prepareCommit({ arm: 'test', run: 'test-run', runsDir, workDir, root: r.root });
    assert.ok(Array.isArray(commands), 'returns array');
    const recordPath = join(r.root, 'demo', 'baseline', 'runs', 'test-test-run', 'RECORD.json');
    assert.ok(existsSync(recordPath), 'RECORD.json created');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));

    assert.ok('audit' in record, 'record has audit field');
    assert.equal(record.audit.status, 'clean', 'status is clean (pipe inside)');
    assert.deepEqual(record.audit.calls, [], 'calls is empty');
    assert.equal(record.audit.refused.length, 2, 'refused has 2 entries');
    const byValues = record.audit.refused.map(c => c.by).sort();
    assert.deepEqual(byValues, ['guard', 'tool-list'], 'by values are guard and tool-list');
  } finally {
    r.clean();
    try { rmSync(runsDir, { recursive: true, force: true }); } catch {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('DB12/DB17.d: prepareCommit audit.status escaped for Read outside workspace', async () => {
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'audit-preparecommit-runs2-'));
  const workDir = mkdtempSync(join(tmpdir(), 'audit-preparecommit-work2-'));
  const workspace = join(workDir, 'test2-test-run');
  const runDir = join(runsDir, 'test2-test-run');

  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(join(workspace, 'package.json'), '{}');
  writeFileSync(join(runDir, 'initial.json'), JSON.stringify({
    'package.json': sha('{}')
  }));

  const sessionContent = [
    assistantEvent('Read', { file_path: 'C:\\Users\\secret.txt' }, 'read-1')
  ].join('\n');
  writeFileSync(join(runDir, 'session.jsonl'), sessionContent);

  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    arm: 'test2', run: 'test-run', exit: 0, startedWith: {}, sdkResult: 'success',
    finalMessage: 'test', workspace, costUsd: 1.5, usage: { input_tokens: 10, output_tokens: 5 },
    stderrTail: '', error: null, modelCallFlags: {}
  }));

  try {
    const commands = await prepareCommit({ arm: 'test2', run: 'test-run', runsDir, workDir, root: r.root });
    assert.ok(Array.isArray(commands), 'returns array');
    const recordPath = join(r.root, 'demo', 'baseline', 'runs', 'test2-test-run', 'RECORD.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));

    assert.equal(record.audit.status, 'escaped', 'status is escaped');
    assert.equal(record.audit.calls.length, 1, 'calls has 1 entry');
    assert.deepEqual(record.audit.refused, [], 'refused is empty');
  } finally {
    r.clean();
    try { rmSync(runsDir, { recursive: true, force: true }); } catch {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

