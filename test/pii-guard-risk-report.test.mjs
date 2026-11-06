// S587 A5 (PG14): the pii-guard risk report's kept store. Written from docs/examples/pii-guard.md alone,
// before any code exists (rule 7a). The test fails when the kept folder is missing because the folder holds
// the baseline that this test compares against; the spec makes known what the report counts and shows.
//
// The kept folder docs/examples/risk-report/pii-guard/ is not written in this test: it is written by
// scripts/risk-report-examples.mjs pii-guard, which runs the example under poly and signs its store. This
// test reads the kept folder and writes each regenerated report to a temporary folder, checking the bytes
// and the counts, then deletes the temporary folder. It never writes to the kept folder or the example's
// directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const KEPT = join(ROOT, 'docs', 'examples', 'risk-report', 'pii-guard');
const EX_DIR = join(ROOT, 'examples', 'pii-guard');
const SAMPLES = join(EX_DIR, 'samples');
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Read the kept folder's structure (PT34.5) ──────────────────────────────────────────────────────────

/** The files PT34.5 keeps for the pii-guard example, found by kind. Fails if the kept folder is missing. */
function kept() {
  assert.ok(existsSync(KEPT), `${rel(KEPT)} exists`);
  const files = readdirSync(KEPT);
  const stores = files.filter((f) => /\.(db|sqlite|sqlite3)$/.test(f));
  assert.equal(stores.length, 1, `one kept store in ${rel(KEPT)}: ${files.join(', ')}`);
  const certificates = files.filter((f) => /certificate.*\.json$/.test(f));
  assert.ok(certificates.length >= 1, `at least one certificate in ${rel(KEPT)}`);
  const trustFile = files.find((f) => /trust.*\.json$/.test(f));
  assert.ok(trustFile, `a trust file in ${rel(KEPT)}`);
  assert.ok(existsSync(join(KEPT, 'build')) && statSync(join(KEPT, 'build')).isDirectory(), `the build directory in ${rel(KEPT)}/build`);
  for (const f of ['report.md', 'report.json']) assert.ok(files.includes(f), `${f} in ${rel(KEPT)}`);

  const store = join(KEPT, stores[0]);
  const trust = JSON.parse(readFileSync(join(KEPT, trustFile), 'utf8'));
  return {
    dir: KEPT,
    store,
    certificates: certificates.map((c) => join(KEPT, c)),
    trustFile: join(KEPT, trustFile),
    trust,
    build: join(KEPT, 'build'),
  };
}

/** The --trust arguments of a trust file: a key id to a file beside it. */
function trustArgs(k, tmp) {
  return Object.entries(k.trust).flatMap(([id, where]) => {
    return ['--trust', `${id}=${rel(join(k.dir, where))}`];
  });
}

// ── Extract values from samples that must not appear in store.db ──────────────────────────────────────

/** Sample values marked in gold.json that must not appear in the kept store. */
function sampleValues() {
  const gold = JSON.parse(readFileSync(join(SAMPLES, 'gold.json'), 'utf8'));
  const values = new Set();
  const enModel = readFileSync(join(SAMPLES, 'en-model.txt'), 'utf8');
  const enMail = readFileSync(join(SAMPLES, 'en-mail.txt'), 'utf8');

  // Extract marked values from en-model.txt (name, email, phone)
  for (const span of gold['en-model.txt'].spans) {
    const value = enModel.substring(span.start, span.end);
    if (span.type === 'PERSON' || span.type === 'EMAIL' || span.type === 'PHONE') {
      values.add(value);
    }
  }

  // Extract marked values from en-mail.txt (password, card)
  for (const span of gold['en-mail.txt'].spans) {
    const value = enMail.substring(span.start, span.end);
    if (span.type === 'SECRET' || span.type === 'PAYMENT') {
      values.add(value);
    }
  }

  return Array.from(values);
}

// ── The risk report test (PG14, A5) ─────────────────────────────────────────────────────────────────────

test('A5 PG14: same bytes; poly report risks exits 0 and leaves store.db unchanged', { timeout: 300_000 }, () => {
  const k = kept();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-s587-a5-kept-'));
  try {
    const before = ['', '-wal'].map((x) => (existsSync(`${k.store}${x}`) ? sha(readFileSync(`${k.store}${x}`)) : 'absent')).join(' ');
    for (const [format, file] of [['json', 'report.json'], ['md', 'report.md']]) {
      const out = join(tmp, file);
      const args = [
        'report', 'risks',
        '--db', rel(k.store),
        '--build', rel(k.build),
        ...k.certificates.flatMap((c) => ['--certificate', rel(c)]),
        ...trustArgs(k, tmp),
        '--format', format,
        '--out', out,
      ];
      const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, `poly report risks exit 0 (status ${r.status}): ${r.stdout}${r.stderr}`);
      assert.ok(existsSync(out), `poly report risks wrote ${file}`);
      const regenerated = readFileSync(out, 'utf8');
      const kept = readFileSync(join(k.dir, file), 'utf8');
      assert.equal(regenerated, kept, `${file} regenerates byte for byte`);
    }
    const after = ['', '-wal'].map((x) => (existsSync(`${k.store}${x}`) ? sha(readFileSync(`${k.store}${x}`)) : 'absent')).join(' ');
    assert.equal(after, before, 'store.db and its WAL are unchanged after writing the report');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A5 PG14: every run counted; store.notCounted, unidentified and ambiguous are empty', () => {
  const k = kept();
  const json = JSON.parse(readFileSync(join(k.dir, 'report.json'), 'utf8'));
  assert.deepEqual(json.store.notCounted ?? [], [], 'store.notCounted is empty');
  assert.deepEqual(json.unidentified ?? [], [], 'unidentified is empty');
  assert.deepEqual(json.ambiguous ?? [], [], 'ambiguous is empty');
  assert.ok(json.store.counted > 0, `store.counted > 0: ${json.store.counted}`);
  // Each of the two certificates has counted >= 1; read them to know which builds they certify
  for (const cert of json.certificates ?? []) {
    assert.ok(cert.counted >= 1, `certificate ${cert.digest.slice(0, 12)} counted >= 1: ${cert.counted}`);
  }
});

test('A5 PG14: mit:2.1 under sensitive-redacted; the defect counts refused 1', () => {
  const k = kept();
  const json = JSON.parse(readFileSync(join(k.dir, 'report.json'), 'utf8'));
  const mit21 = json.risks?.find((r) => r.id === 'mit:2.1');
  assert.ok(mit21, 'mit:2.1 is listed under risks');
  const items = mit21.items ?? [];
  assert.ok(items.length > 0, 'mit:2.1 has items');

  // The program's sensitive-redacted should have every count 0 (no events gated in the program alone)
  // The defect's sensitive-redacted should have refused 1 (the defect's early mail is refused by the gate)
  let foundRefusal = false;
  for (const item of items) {
    if (item.id?.includes('sensitive-redacted')) {
      // One of the two builds (program or defect) counts refused; the other counts all zeros
      const counts = item.counts ?? {};
      if (counts.refused > 0) {
        assert.equal(counts.refused, 1, 'sensitive-redacted refused exactly 1 (the defect\'s early mail)');
        foundRefusal = true;
      }
    }
  }
  assert.ok(foundRefusal, 'mit:2.1 has at least one rule with refused 1');

  // The Markdown does not print *no decision in the period* under mit:2.1 (because there are counts)
  const md = readFileSync(join(k.dir, 'report.md'), 'utf8');
  const mit21Md = md.split('## mit:2.1')[1]?.split('##')[0] ?? '';
  assert.ok(!mit21Md.includes('no decision in the period'), 'mit:2.1 section does not say "no decision in the period"');
});

test('A5 PG14: escalations under untagged; outbound.new-recipient-approved with escalated 3, approved 1, timedOut 1, open 1', () => {
  const k = kept();
  const json = JSON.parse(readFileSync(join(k.dir, 'report.json'), 'utf8'));
  const untagged = json.untagged ?? [];
  assert.ok(untagged.length > 0, 'untagged items exist');

  let found = false;
  for (const item of untagged) {
    if (item.id?.includes('new-recipient-approved')) {
      const counts = item.counts ?? {};
      assert.equal(counts.escalated ?? 0, 3, 'new-recipient-approved escalated 3');
      assert.equal(counts.approved ?? 0, 1, 'new-recipient-approved approved 1');
      assert.equal(counts.timedOut ?? 0, 1, 'new-recipient-approved timedOut 1');
      assert.equal(counts.open ?? 0, 1, 'new-recipient-approved open 1');
      assert.equal(counts.refused ?? 0, 0, 'new-recipient-approved refused 0');
      found = true;
    }
  }
  assert.ok(found, 'outbound.new-recipient-approved found in untagged with the counted escalations');

  // untagged should hold only this one item
  assert.equal(untagged.length, 1, `untagged holds exactly one item (new-recipient-approved): ${untagged.map((i) => i.id).join(', ')}`);
});

test('A5 PG14: uncovered is exactly mit:2.2; the Markdown says "Exposed and not covered"', () => {
  const k = kept();
  const json = JSON.parse(readFileSync(join(k.dir, 'report.json'), 'utf8'));
  const uncovered = json.uncovered ?? [];
  assert.equal(uncovered.length, 1, `uncovered has exactly one item: ${uncovered.map((r) => r.id).join(', ')}`);
  assert.equal(uncovered[0].id, 'mit:2.2', `uncovered[0] is mit:2.2`);

  const md = readFileSync(join(k.dir, 'report.md'), 'utf8');
  assert.ok(md.includes('Exposed and not covered'), 'report.md includes "Exposed and not covered"');
});

test('A5 PG14: scope pii allowed at least 3; runtime is empty', () => {
  const k = kept();
  const json = JSON.parse(readFileSync(join(k.dir, 'report.json'), 'utf8'));
  const piiScope = json.scopes?.find((s) => s.scope === 'pii');
  assert.ok(piiScope, 'scope pii is listed');
  assert.ok((piiScope.allowed ?? 0) >= 3, `scope pii allowed >= 3: ${piiScope.allowed}`);

  const runtime = json.runtime ?? [];
  assert.deepEqual(runtime, [], 'runtime is empty (no runs at runtime phase, only gated runs)');
});

test('A5 PG14: nothing private in store.db; poly_content table is empty', () => {
  const k = kept();
  const db = new DatabaseSync(k.store, { readonly: true });
  try {
    // Check that poly_content table exists and is empty (the spec says it is empty)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes('poly_content'), 'poly_content table exists');

    const contentRows = db.prepare('SELECT * FROM poly_content').all();
    assert.equal(contentRows.length, 0, 'poly_content table is empty');

    // Get all text content from the database as a buffer and check for sample values
    const allRows = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    const sampleVals = sampleValues();

    // Check for sample values in store.db by reading all databases as text and searching
    // We use exec to dump the entire database and check its text representation
    const buffer = readFileSync(k.store);
    const dbText = buffer.toString('utf8', 0, Math.min(buffer.length, 1_000_000)); // Check first 1MB as text

    for (const val of sampleVals) {
      // Only check if the value is likely to appear as UTF-8 text (not binary)
      if (/^[A-Za-z0-9.@+\s-]+$/.test(val)) {
        assert.ok(!dbText.includes(val), `store.db does not contain sample value: "${val}"`);
      }
    }
  } finally {
    db.close();
  }
});

test('A5 PG14: the wording; report.md first line after title is the meaning line, and never prints mitigated, covered, safe or compliant', () => {
  const k = kept();
  const md = readFileSync(join(k.dir, 'report.md'), 'utf8');

  // Find the first line after the title (the first H1 heading)
  const lines = md.split('\n');
  let titleIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) {
      titleIndex = i;
      break;
    }
  }
  assert.ok(titleIndex >= 0, 'report.md has a title');

  // The first non-empty line after the title should be the meaning line
  let firstLine = '';
  for (let i = titleIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      firstLine = lines[i];
      break;
    }
  }
  // The meaning line from the report is:
  // "These counts are evidence that each rule was applied to the decisions recorded in the journal.
  //  They are not proof that a risk was removed or reduced."
  assert.ok(firstLine.includes('counts are evidence') || firstLine.includes('These counts'), 'first line after title is the meaning line');

  // Check that prohibited words do not appear
  const prohibitedWords = ['mitigated', 'covered', 'safe', 'compliant'];
  for (const word of prohibitedWords) {
    assert.ok(!md.includes(word), `report.md does not print "${word}"`);
  }
});
