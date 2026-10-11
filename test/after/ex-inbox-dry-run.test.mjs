// plan-ex.md E2, "Run it yourself": the dry run, in the serial group because its admission checks the inbox, which takes
// minutes and a large heap. It reads the dry run's steps from examples/inbox/README.md and runs each as a child process,
// as the owner would run it (the scaffold, the anchor, the policy signature, the admission, the signed grant requests, the
// host on recorded traffic), with only a larger heap and a preload that keeps the per-user keyring configuration out of
// the real user's (test/ex-inbox-readme.mjs). The fake Google issues made-up tokens and consents for the owner; the model
// is recorded; no key is read and nothing leaves the machine.
//
// What it holds: every step exits clean; the host links both accounts, syncs them, triages their mail and prints a
// digest; and in the read-only run the outbox holds no `gmail.createDraft`, no `decision.write` and no envelope
// retrieval, so no draft intent was ever emitted. Then a command to draft is left for a second read-only run, which
// refuses it and still emits none.
//
// STATUS: written with the README's steps and not yet run (the steps are not tested end to end until it has been).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../helpers.mjs';
import { fill, readmeSteps, runCommand } from '../ex-inbox-readme.mjs';

const outbox = (store) => {
  const db = new DatabaseSync(store, { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM pr_outbox GROUP BY kind').all().map((r) => [r.kind, r.n])); } finally { db.close(); }
};
const instances = (store, machine) => {
  const db = new DatabaseSync(store, { readOnly: true });
  try { return db.prepare('SELECT instance_id FROM pr_instance WHERE machine_id = ? ORDER BY instance_id').all(machine).map((r) => r.instance_id); } finally { db.close(); }
};

test('the dry run: the README\'s steps run clean on recorded traffic, and the read-only host emits no draft intent', { timeout: 1_800_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'poly-inbox-dry-'));
  const vars = { REPO: ROOT, DRY_PROJECT: join(base, 'project'), DRY_KEYS: join(base, 'keys') };
  const anchors = join(base, 'anchors');
  try {
    const { steps } = readmeSteps();
    let run;
    for (const step of steps) {
      for (const command of step.commands) {
        const r = runCommand(fill(command, vars), { anchors });
        assert.equal(r.status, 0, `${step.name}: ${command}\n${r.stdout}\n${r.stderr}`);
        if (step.name === 'dry-6-run') run = r;
      }
    }
    // The host linked both accounts, synced them, triaged their mail and printed its digest, read-only.
    assert.match(run.stdout, /inbox host started: read-only; one pass/);
    for (const label of ['work', 'home']) assert.match(run.stdout, new RegExp(`dry run: consent for ${label} \\(gmail_read\\): granted`));
    assert.match(run.stdout, /read-only: no draft is proposed/);
    assert.match(run.stdout, /work: \d+ message\(s\): \d+ to do/);
    assert.match(run.stdout, /home: \d+ message\(s\)/);
    assert.ok(!/sync failed|not linked yet/.test(run.stdout), run.stdout);

    // The outbox: mail was triaged, and no draft intent was ever emitted.
    const store = join(vars.DRY_PROJECT, '.poly', 'run', 'store.sqlite');
    const kinds = outbox(store);
    assert.ok((kinds['decision.triage'] ?? 0) > 0 && (kinds['decision.kind'] ?? 0) > 0, JSON.stringify(kinds));
    for (const never of ['gmail.createDraft', 'decision.write', 'source.mail.envelope']) assert.equal(kinds[never] ?? 0, 0, `${never} in ${JSON.stringify(kinds)}`);
    assert.ok(instances(store, 'inbox.Message').length >= 4);
    // The compose credential was never requested: only the read requests were dropped and taken.
    assert.deepEqual(readdirSync(join(vars.DRY_PROJECT, 'approvals', 'applied')).sort(), ['link-home-gmail_read.json', 'link-work-gmail_read.json']);

    // A command to draft is refused by a read-only host, and still no draft intent is emitted.
    const todo = /<(todo:[^>]+)>/.exec(run.stdout)?.[1];
    assert.ok(todo, `a to-do in the digest:\n${run.stdout}`);
    const ask = runCommand(`node ${join(ROOT, 'examples', 'inbox', 'host', 'run.mjs')} ask --project ${vars.DRY_PROJECT} --todo ${todo} --do draft`, { anchors });
    assert.equal(ask.status, 0, ask.stderr);
    const again = runCommand(fill(steps.find((s) => s.name === 'dry-6-run').commands[0], vars), { anchors });
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.match(again.stdout, /read-only: WriteDraft of todo:[^\n]* is refused; start the host with --drafts to allow drafts/);
    const after = outbox(store);
    for (const never of ['gmail.createDraft', 'decision.write', 'source.mail.envelope']) assert.equal(after[never] ?? 0, 0, `${never} after the command: ${JSON.stringify(after)}`);
    assert.ok(existsSync(join(vars.DRY_PROJECT, 'commands', 'refused')), 'the refused command is kept');

    // Nothing of the owner's is in the project: no private key, and no token.
    for (const f of readdirSync(vars.DRY_PROJECT, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(json|poly|ts)$/.test(e.name))) {
      assert.ok(!/PRIVATE KEY|fixture-at-|fixture-rt-/.test(readFileSync(join(f.parentPath, f.name), 'utf8')), f.name);
    }
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});
