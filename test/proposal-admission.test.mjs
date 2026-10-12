// Proposal admission (PS21.4, PS21.6, PT31.6): admission reads proposals/ and checks evidence
// against the sources. Every rule must be supported by its own history (PL6520), and every
// path property the evidence names must be in the machine (PL6521). The certificate's
// poly.proposals lists each one, and the evidence digest is certified provenance.
// Each test creates a fresh project with a proposal in proposals/<slug>.json and a
// corresponding src/<slug>.poly. Tests are independent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError } from '@poly/check';
import { makeKey, project } from './runtime-helpers.mjs';

// Helper to write a proposal evidence file at proposals/<slug>.json
function writeProposalEvidence(dir, slug, evidence) {
  mkdirSync(join(dir, 'proposals'), { recursive: true });
  const filename = `${slug}.json`;
  writeFileSync(join(dir, 'proposals', filename), JSON.stringify(evidence, null, 2));
  return join(dir, 'proposals', filename);
}

// Helper to compute SHA-256 digest of file contents
function fileDigest(filepath) {
  const content = readFileSync(filepath, 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

// Normative example evidence (from docs/m7/proposal-example.json)
const NORMATIVE_EVIDENCE = {
  v: 1,
  kind: 'poly.proposal',
  name: 'git-push',
  steps: ['npm-test', 'git-add', 'git-commit', 'git-push'],
  rules: [
    { name: 'git-push-implies-a-prior-git-add', pattern: 'implies-a-prior', support: { holds: 16, of: 16 }, window: 'run', provenance: 'own' },
    { name: 'git-push-implies-a-prior-git-commit', pattern: 'implies-a-prior', support: { holds: 16, of: 16 }, window: 'run', provenance: 'own' },
    { name: 'at-most-one-git-push-per-run', pattern: 'at-most-one-per-run', support: { holds: 14, of: 15 }, window: 'run', provenance: 'own' },
    { name: 'no-git-push-without-a-passing-verify', pattern: 'no-without-a-prior-verify', support: { holds: 14, of: 16 }, window: 'session', provenance: 'own' }
  ],
  notTranslatable: [
    { name: 'exactly-one-git-add-per-git-push-run', pattern: 'exactly-one-when-started', reason: 'exactly-one-when-started is not a prefix-closed form (PS5.4)' }
  ],
  thresholds: { minInstances: 5, ownSupport: 0.6 },
  tool: { name: 'polyness', version: '0.0.1', pin: 'sha256:' + 'a'.repeat(64) },
  corpus: { kind: 'synthetic', sessions: 15 }
};

// Normative proposal source (simplified, similar to docs/m7/proposal-example.poly)
const NORMATIVE_SOURCE = `module git_push

enum Phase { Idle, AwaitingNpmTest, AwaitingGitAdd, AwaitingGitCommit, AwaitingGitPush, Done, Blocked }

machine Run {
  state {
    phase : Phase = Idle
  }
  terminal phase in { Done, Blocked }

  action Start()
  action NpmTestDone()
  action NpmTestFailed()
  action GitAddDone()
  action GitAddFailed()
  action GitCommitDone()
  action GitCommitFailed()
  action GitPushDone()
  action GitPushFailed()

  on Start {
    require phase == Idle else reject "not-awaiting"
    phase' = AwaitingNpmTest
    emit npm_test()
  }
  on NpmTestDone {
    require phase == AwaitingNpmTest else reject "not-awaiting"
    phase' = AwaitingGitAdd
    emit git_add()
  }
  on NpmTestFailed {
    require phase == AwaitingNpmTest else reject "not-awaiting"
    phase' = Blocked
  }
  on GitAddDone {
    require phase == AwaitingGitAdd else reject "not-awaiting"
    phase' = AwaitingGitCommit
    emit git_commit()
  }
  on GitAddFailed {
    require phase == AwaitingGitAdd else reject "not-awaiting"
    phase' = Blocked
  }
  on GitCommitDone {
    require phase == AwaitingGitCommit else reject "not-awaiting"
    phase' = AwaitingGitPush
    emit git_push()
  }
  on GitCommitFailed {
    require phase == AwaitingGitCommit else reject "not-awaiting"
    phase' = Blocked
  }
  on GitPushDone {
    require phase == AwaitingGitPush else reject "not-awaiting"
    phase' = Done
  }
  on GitPushFailed {
    require phase == AwaitingGitPush else reject "not-awaiting"
    phase' = Blocked
  }

  // proposed: git-push-implies-a-prior-git-add
  path property git-push-implies-a-prior-git-add: before("git-add", "git-push")
  // proposed: git-push-implies-a-prior-git-commit
  path property git-push-implies-a-prior-git-commit: before("git-commit", "git-push")
  // proposed: at-most-one-git-push-per-run
  path property at-most-one-git-push-per-run: count("git-push") <= 1
  // proposed: no-git-push-without-a-passing-verify
  path property no-git-push-without-a-passing-verify: before("npm-test", "git-push")

  effect npm_test() {
    kind "npm-test"
    labels { exec }
  }
  effect git_add() {
    kind "git-add"
    labels { exec }
  }
  effect git_commit() {
    kind "git-commit"
    labels { exec }
  }
  effect git_push() {
    kind "git-push"
    labels { exec }
  }
}
`;


// A second, hand-derived proposal (PS21.2 by analogy with the normative one): two steps, one rule.
const SECOND_SOURCE = `module deploy

enum Phase { Idle, AwaitingLint, AwaitingDeploy, Done, Blocked }

machine Run {
  state {
    phase : Phase = Idle
  }
  terminal phase in { Done, Blocked }

  action Start()
  action LintDone()
  action LintFailed()
  action DeployDone()
  action DeployFailed()

  on Start {
    require phase == Idle else reject "not-awaiting"
    phase' = AwaitingLint
    emit lint()
  }
  on LintDone {
    require phase == AwaitingLint else reject "not-awaiting"
    phase' = AwaitingDeploy
    emit deploy()
  }
  on LintFailed {
    require phase == AwaitingLint else reject "not-awaiting"
    phase' = Blocked
  }
  on DeployDone {
    require phase == AwaitingDeploy else reject "not-awaiting"
    phase' = Done
  }
  on DeployFailed {
    require phase == AwaitingDeploy else reject "not-awaiting"
    phase' = Blocked
  }

  // proposed: at-most-one-deploy-per-run
  path property at-most-one-deploy-per-run: count("deploy") <= 1

  effect lint() {
    kind "lint"
    labels { exec }
  }
  effect deploy() {
    kind "deploy"
    labels { exec }
  }
}
`;

// A1: Test valid proposal with normative evidence
test('A1: a valid proposal admits CLEAN with certificate fields', async () => {
  const key = makeKey('a1-valid');
  const dir = project('a1-valid', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidencePath = writeProposalEvidence(dir, 'git-push', NORMATIVE_EVIDENCE);
  const evidenceDigest = fileDigest(evidencePath);

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN', 'admission should be CLEAN');
  assert.ok(Array.isArray(r.certificate.poly.proposals), 'certificate.poly.proposals should be an array');
  assert.equal(r.certificate.poly.proposals.length, 1);
  assert.equal(r.certificate.poly.proposals[0].name, 'git-push');
  assert.equal(r.certificate.poly.proposals[0].evidence, evidenceDigest);
  assert.equal(r.certificate.poly.proposals[0].tool.name, 'polyness');
  assert.equal(r.certificate.poly.proposals[0].tool.version, '0.0.1');
  assert.equal(r.certificate.poly.proposals[0].tool.pin, NORMATIVE_EVIDENCE.tool.pin);
});

// A1b: Project with no proposals/ has no poly.proposals field
test('A1b: a project with no proposals/ has no poly.proposals field in certificate', async () => {
  const key = makeKey('a1b-none');
  const dir = project('a1b-none', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'empty.poly'), 'module empty\n');

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.ok(!('proposals' in r.certificate.poly), 'certificate.poly.proposals should be absent');
});

// A2: PL6520 - provenance not 'own'
test('A2.1: PL6520 when rule provenance is "borrowed"', async () => {
  const key = makeKey('a2.1-prov-borrowed');
  const dir = project('a2.1-prov-borrowed', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].provenance = 'borrowed';

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message) && /git-push-implies-a-prior-git-add/.test(e.message) && /borrowed/.test(e.message)
  );
});

// A2: PL6520 - provenance is 'neither'
test('A2.2: PL6520 when rule provenance is "neither"', async () => {
  const key = makeKey('a2.2-prov-neither');
  const dir = project('a2.2-prov-neither', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].provenance = 'neither';

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message) && /git-push-implies-a-prior-git-add/.test(e.message)
  );
});

// A2: PL6520 - support.of below threshold (4 < 5)
test('A2.3: PL6520 when rule support.of is below minInstances threshold (4 < 5)', async () => {
  const key = makeKey('a2.3-support-below-min');
  const dir = project('a2.3-support-below-min', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].support = { holds: 4, of: 4 };

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message) && /git-push-implies-a-prior-git-add/.test(e.message) && /4 of 4/.test(e.message) && /5/.test(e.message)
  );
});

// A2: PL6520 - holds/of < 0.6 threshold
test('A2.4: PL6520 when rule holds/of is below ownSupport threshold (0.5 < 0.6)', async () => {
  const key = makeKey('a2.4-support-below-ratio');
  const dir = project('a2.4-support-below-ratio', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].support = { holds: 5, of: 10 };

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message) && /git-push-implies-a-prior-git-add/.test(e.message) && /5 of 10/.test(e.message) && /0.6/.test(e.message)
  );
});

// A2: PL6520 - holds > of (logically invalid)
test('A2.5: PL6520 when rule support.holds greater than support.of', async () => {
  const key = makeKey('a2.5-holds-gt-of');
  const dir = project('a2.5-holds-gt-of', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].support = { holds: 20, of: 15 };

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message)
  );
});

// A2: PL6520 - support not numbers
test('A2.6: PL6520 when rule support values are not numbers', async () => {
  const key = makeKey('a2.6-support-not-number');
  const dir = project('a2.6-support-not-number', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].support = { holds: 'fifteen', of: '16' };

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message)
  );
});

// A2: PL6520 - window not 'run' or 'session'
test('A2.7: PL6520 when rule window is not "run" or "session"', async () => {
  const key = makeKey('a2.7-window-invalid');
  const dir = project('a2.7-window-invalid', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules[0].window = 'invalid';

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6520/.test(e.message)
  );
});

// A3: PL6521 - evidence names a property not in source
test('A3.1: PL6521 when evidence names a path property the source does not have', async () => {
  const key = makeKey('a3.1-prop-not-in-source');
  const dir = project('a3.1-prop-not-in-source', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.rules.push({
    name: 'extra-rule-not-in-source',
    pattern: 'at-most-one-per-run',
    support: { holds: 10, of: 10 },
    window: 'run',
    provenance: 'own'
  });

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message) && /extra-rule-not-in-source/.test(e.message)
  );
});

// A3: PL6521 - source has a property not in evidence
test('A3.2: PL6521 when source has a path property the evidence does not name', async () => {
  const key = makeKey('a3.2-source-prop-no-evidence');
  const dir = project('a3.2-source-prop-no-evidence', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  const sourceWithExtra = NORMATIVE_SOURCE.replace(
    '  // proposed: no-git-push-without-a-passing-verify',
    '  // proposed: no-git-push-without-a-passing-verify\n  path property extra-property-no-evidence: count("git-push") <= 2'
  );
  writeFileSync(join(dir, 'src', 'git_push.poly'), sourceWithExtra);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message) && /extra-property-no-evidence/.test(e.message)
  );
});

// A4: Ordinary check violation - source violates its own path property
test('A4: ordinary check refusal when source violates a path property', async () => {
  const key = makeKey('a4-path-violated');
  const dir = project('a4-path-violated', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  const sourceWithViolation = NORMATIVE_SOURCE.replace(
    'path property at-most-one-git-push-per-run: count("git-push") <= 1',
    'path property at-most-one-git-push-per-run: before("git-push", "git-add")'
  );
  writeFileSync(join(dir, 'src', 'git_push.poly'), sourceWithViolation);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL4001/.test(e.message) && !/PL6520/.test(e.message)
  );
});

// A5.1: Malformed JSON in evidence
test('A5.1: PL6521 when evidence file is malformed JSON', async () => {
  const key = makeKey('a5.1-malformed-json');
  const dir = project('a5.1-malformed-json', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  mkdirSync(join(dir, 'proposals'), { recursive: true });
  writeFileSync(join(dir, 'proposals', 'git-push.json'), '{invalid json}');

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message) && /proposals\/git-push\.json/.test(e.message)
  );
});

// A5.2: Evidence kind is not 'poly.proposal'
test('A5.2: PL6521 when evidence kind is not "poly.proposal"', async () => {
  const key = makeKey('a5.2-wrong-kind');
  const dir = project('a5.2-wrong-kind', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.kind = 'wrong.kind';

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message)
  );
});

// A5.3: Evidence v is not 1
test('A5.3: PL6521 when evidence v is not 1', async () => {
  const key = makeKey('a5.3-wrong-v');
  const dir = project('a5.3-wrong-v', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.v = 2;

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message)
  );
});

// A5.4: Evidence name does not match source module slug
test('A5.4: PL6521 when evidence name does not match module slug', async () => {
  const key = makeKey('a5.4-name-mismatch');
  const dir = project('a5.4-name-mismatch', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence.name = 'different-name';

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message)
  );
});

// A5.5: Proposals file with no matching src source
test('A5.5: PL6521 when proposals file has no matching src source', async () => {
  const key = makeKey('a5.5-no-src');
  const dir = project('a5.5-no-src', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });

  const evidence = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));

  writeProposalEvidence(dir, 'git-push', evidence);

  await assert.rejects(
    admit(dir),
    (e) => e instanceof AdmitError && /PL6521/.test(e.message) && /proposals\/git-push\.json/.test(e.message)
  );
});

// A6: Certificate provenance - evidence digest changes
test('A6: evidence file digest is certified provenance and changes when file changes', async () => {
  const key = makeKey('a6-provenance');
  const dir = project('a6-provenance', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  const evidence1 = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  const path1 = writeProposalEvidence(dir, 'git-push', evidence1);
  const digest1 = fileDigest(path1);

  const r1 = await admit(dir);
  assert.equal(r1.verdict, 'CLEAN');
  assert.equal(r1.certificate.poly.proposals[0].evidence, digest1);

  rmSync(join(dir, '.poly'), { recursive: true, force: true });

  const evidence2 = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence2.rules[0].support.holds = 15;

  const path2 = writeProposalEvidence(dir, 'git-push', evidence2);
  const digest2 = fileDigest(path2);

  const r2 = await admit(dir);
  assert.equal(r2.verdict, 'CLEAN');
  assert.equal(r2.certificate.poly.proposals[0].evidence, digest2);
  assert.notEqual(digest1, digest2, 'evidence digest should change when file changes');
});

// A7: Two proposals
test('A7: two proposals in one project are both listed in file order', async () => {
  const key = makeKey('a7-two-proposals');
  const dir = project('a7-two-proposals', [], key);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'git_push.poly'), NORMATIVE_SOURCE);

  writeFileSync(join(dir, 'src', 'deploy.poly'), SECOND_SOURCE);

  const evidence1 = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence1.name = 'git-push';

  const evidence2 = JSON.parse(JSON.stringify(NORMATIVE_EVIDENCE));
  evidence2.name = 'deploy';
  evidence2.steps = ['lint', 'deploy'];
  evidence2.rules = [{ name: 'at-most-one-deploy-per-run', pattern: 'at-most-one-per-run', support: { holds: 10, of: 10 }, window: 'run', provenance: 'own' }];
  evidence2.notTranslatable = [];

  writeProposalEvidence(dir, 'git-push', evidence1);
  writeProposalEvidence(dir, 'deploy', evidence2);

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.certificate.poly.proposals.length, 2);
  assert.equal(r.certificate.poly.proposals[0].name, 'deploy');
  assert.equal(r.certificate.poly.proposals[1].name, 'git-push');
});
