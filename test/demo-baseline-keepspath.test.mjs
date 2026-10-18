// Tests for DB13 item 3: a key of keeps may be a path of field names joined by dots.
// Spec section: DB13 item 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveRecord, RECORD } from '../demo/baseline/procedure.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Committed data: amendment 1 and the base record.
function readCommittedAmendment(n) {
  const hash = n === 1 ? '1b9493fc' : null;
  if (!hash) throw new Error('only amendment 1 is committed');
  const output = git(['show', `${hash}:demo/baseline/PREREGISTRATION.amendment-${n}.json`]);
  return JSON.parse(output);
}

function readCommittedRecord() {
  const output = git(['show', `1b9493fc:${RECORD}`]);
  return JSON.parse(output);
}

// Helper: build a throwaway git repository with base record, amendment 1, and optional further amendments.
function gitRepoWithAmendments({ amendments = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-keepspath-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  for (const name of ['PROMPT.md', 'arm-ts.md', 'arm-poly.md', 'orders.json']) {
    copyFileSync(join(ROOT, 'demo', 'baseline', name), join(root, 'demo', 'baseline', name));
  }
  const base = readCommittedRecord();
  writeFileSync(join(root, RECORD), JSON.stringify(base, null, 2) + '\n');
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'pre-registration');

  // Commit amendment 1 if requested.
  if (amendments.length > 0) {
    const amend1 = amendments[0];
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-1.json`), JSON.stringify(amend1, null, 2) + '\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'amendment 1');
  }

  // Commit further amendments.
  for (let i = 1; i < amendments.length; i++) {
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-${i + 1}.json`), JSON.stringify(amendments[i], null, 2) + '\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', `amendment ${i + 1}`);
  }

  const gitHelper = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, base, git: gitHelper, clean: () => rmSync(root, { recursive: true, force: true }) };
}

// (1) keeps with dotted path 'allowedTools.ts' equal to the ts list in the record: no problems.
test('(1) keeps with dotted path allowedTools.ts equal to ts list: no problems', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that changes allowedTools and keeps allowedTools.ts.
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps dotted path',
      findings: {},
      keeps: {
        'allowedTools.ts': amend1.set.allowedTools.ts,
      },
      set: {
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: [...amend1.set.allowedTools.poly, 'Bash(npm run poly admit*)', 'Bash(npm run poly lint*)'],
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, [], `expected no problems, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});

// (2) keeps with dotted path 'allowedTools.ts' has an extra entry: exactly one problem with specific text.
test('(2) keeps with dotted path allowedTools.ts with extra entry: exactly one problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that changes allowedTools and keeps allowedTools.ts with an extra entry.
    const keepsTsList = [...amend1.set.allowedTools.ts, 'Bash(rm *)'];
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps dotted path with mismatch',
      findings: {},
      keeps: {
        'allowedTools.ts': keepsTsList,
      },
      set: {
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: [...amend1.set.allowedTools.poly, 'Bash(npm run poly admit*)', 'Bash(npm run poly lint*)'],
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.equal(eff.problems.length, 1, `expected exactly one problem, got ${eff.problems.length}: ${eff.problems.join('; ')}`);
    const problem = eff.problems[0];
    assert.ok(problem.startsWith('amendment 2 keeps allowedTools.ts as '), `problem does not start with expected prefix: ${problem}`);
    assert.ok(problem.includes(', but the record has '), `problem does not include expected separator: ${problem}`);
    assert.ok(problem.includes('Bash(rm *)'), `problem does not include the extra entry: ${problem}`);
  } finally {
    r.clean();
  }
});

// (3) keeps path where first field exists and second does not ('allowedTools.nope'): assert that a non-undefined keeps value is a problem.
test('(3) keeps path with nonexistent second field: keeping nope as string x is a problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that tries to keep allowedTools.nope as the string 'x'.
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps nonexistent nested field',
      findings: {},
      keeps: {
        'allowedTools.nope': 'x',
      },
      set: {
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: amend1.set.allowedTools.poly,
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.length > 0, `expected at least one problem, got none`);
    const problem = eff.problems.find(p => p.includes('allowedTools.nope'));
    assert.ok(problem, `expected problem mentioning allowedTools.nope, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});

// (4) keeps path into 'scaffolds.ts': no problem if equal, problem if different.
test('(4) keeps path scaffolds.ts equal to record: no problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that keeps scaffolds.ts equal to amendment 1's.
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps scaffolds.ts',
      findings: {},
      keeps: {
        'scaffolds.ts': amend1.set.scaffolds.ts,
      },
      set: {
        scaffolds: {
          ts: amend1.set.scaffolds.ts,
          poly: 'sha256:different123456789abcdef123456789abcdef123456789abcdef123456789abc',
        },
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: amend1.set.allowedTools.poly,
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, [], `expected no problems, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});

test('(4) keeps path scaffolds.ts different from record: problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that keeps scaffolds.ts but with a different value.
    const differentScaffold = 'sha256:different123456789abcdef123456789abcdef123456789abcdef123456789abc';
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps scaffolds.ts mismatch',
      findings: {},
      keeps: {
        'scaffolds.ts': differentScaffold,
      },
      set: {
        scaffolds: {
          ts: amend1.set.scaffolds.ts,
          poly: 'sha256:another1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
        },
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: amend1.set.allowedTools.poly,
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.length > 0, `expected at least one problem, got none`);
    const problem = eff.problems.find(p => p.includes('scaffolds.ts'));
    assert.ok(problem, `expected problem mentioning scaffolds.ts, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});

// (5) Plain keys still work (regression): 'pilots' kept equal and different.
test('(5) plain key pilots kept equal to record: no problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that keeps pilots (a plain key, not a dotted path) equal to amendment 1's.
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps plain key pilots',
      findings: {},
      keeps: {
        pilots: amend1.set.pilots,
      },
      set: {
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: amend1.set.allowedTools.poly,
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, [], `expected no problems, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});

test('(5) plain key pilots kept different from record: problem', () => {
  const amend1 = readCommittedAmendment(1);
  const base = readCommittedRecord();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Create amendment 2 that keeps pilots but with a different value.
    const amend2 = {
      v: 1,
      amendment: 2,
      reason: 'test keeps plain key pilots mismatch',
      findings: {},
      keeps: {
        pilots: { ts: 9, poly: 9 },
      },
      set: {
        allowedTools: {
          ts: amend1.set.allowedTools.ts,
          poly: amend1.set.allowedTools.poly,
        },
      },
      excluded: [],
      limits: [],
    };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.length > 0, `expected at least one problem, got none`);
    const problem = eff.problems.find(p => p.includes('pilots'));
    assert.ok(problem, `expected problem mentioning pilots, got: ${eff.problems.join('; ')}`);
  } finally {
    r.clean();
  }
});
