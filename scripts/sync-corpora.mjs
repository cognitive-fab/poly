#!/usr/bin/env node
// The field-study corpora, copied into conformance/field-studies/ (PT17, S17).
//
//   node scripts/sync-corpora.mjs --copy     copy from the local sources and write PROVENANCE.md
//   node scripts/sync-corpora.mjs            verify: every copy matches the SHA-256 in its PROVENANCE.md,
//                                            and, where the local source exists, the source still matches too
//
// CI reads only the copies. A copy that no longer matches its recorded hash
// fails verification; a local source that drifted from the copy is reported,
// never silently re-copied.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = process.env.POLY_CODE_ROOT ?? 'C:/Users/jjdub/code';
export const DEST = join(ROOT, 'conformance', 'field-studies');

export const STUDIES = [
  {
    name: 'turnstile',
    source: 'polygraph/examples/turnstile-v2',
    files: ['README.md', 'contract.json', 'traces', 'specs/reference.js', 'specs-mutant/mutant.js'],
    sourceRepo: 'polygraph',
    study: 'The turnstile example of the polygraph engine: a reference SAM v2 module, its mutant, and a hand-written trace corpus.',
    upstream: 'cognitive-fab/polygraph (https://github.com/cognitive-fab/polygraph), examples/turnstile-v2. The traces are hand-written for the example; no third-party code produced them.',
    licence: 'Apache-2.0 (polygraph/LICENSE)',
    controls: { reference: 'specs/reference.js', broken: 'specs-mutant/mutant.js' },
  },
  {
    name: 'raft',
    source: 'osssm/polygraph-raft',
    files: ['REPORT.md', 'contract.json', 'invariants.mjs', 'traces', 'specs/reference.js', 'specs_broken/reference.js'],
    sourceRepo: 'osssm/raft',
    study: 'The raft role-transition field study (osssm/polygraph-raft; not a git repository, so the hashes below pin it).',
    upstream: 'hashicorp/raft (https://github.com/hashicorp/raft). The traces were captured from a live three-node cluster of a local clone, through trace_capture_test.go added to the clone (not upstream); see REPORT.md.',
    licence: 'MPL-2.0 for hashicorp/raft (osssm/raft/LICENSE). The study directory carries no licence file of its own.',
    controls: { reference: 'specs/reference.js', broken: 'specs_broken/reference.js' },
  },
  {
    name: 'hatchet',
    source: 'osssm/polygraph-hatchet',
    files: ['REPORT.md', 'contract.json', 'invariants.mjs', 'traces', 'specs/reference.js', 'specs_broken/reference.js'],
    sourceRepo: 'osssm/hatchet',
    study: 'The hatchet workflow-status field study (osssm/polygraph-hatchet; not a git repository, so the hashes below pin it).',
    upstream: 'hatchet-dev/hatchet (https://github.com/hatchet-dev/hatchet), DeriveWorkflowRunStatus. The traces were captured through internal/statusutils/trace_capture_test.go added to a local clone (not upstream); see REPORT.md.',
    licence: 'MIT for hatchet-dev/hatchet (osssm/hatchet/LICENSE). The study directory carries no licence file of its own.',
    controls: { reference: 'specs/reference.js', broken: 'specs_broken/reference.js' },
  },
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function expand(base, entries) {
  const out = [];
  for (const e of entries) {
    const p = join(base, e);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) out.push(`${e}/${f}`);
    else out.push(e);
  }
  return out;
}

function gitHead(dir) {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = join(dir, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = readFileSync(join(dir, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    return packed ? packed.split(' ')[0] : 'unknown';
  } catch {
    return 'not a git repository';
  }
}

/** The hashes recorded in a study's PROVENANCE.md. */
export function recorded(name) {
  const text = readFileSync(join(DEST, name, 'PROVENANCE.md'), 'utf8');
  const map = new Map();
  for (const m of text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) map.set(m[1], m[2]);
  return map;
}

function copy(study) {
  const src = join(CODE, study.source);
  const dst = join(DEST, study.name);
  const files = expand(src, study.files);
  const rows = [];
  for (const f of files) {
    mkdirSync(dirname(join(dst, f)), { recursive: true });
    copyFileSync(join(src, f), join(dst, f));
    rows.push(`| \`${f}\` | \`${sha256(join(dst, f))}\` |`);
  }
  const sourceCommit = gitHead(join(CODE, study.source.split('/')[0] === 'polygraph' ? 'polygraph' : study.source));
  const upstreamCommit = gitHead(join(CODE, study.sourceRepo));
  const text = [
    `# Provenance: ${study.name}`,
    '',
    study.study,
    '',
    '| Item | Value |',
    '|---|---|',
    `| Source path | \`${study.source}\` (under the owner's code root) |`,
    `| Source commit | ${sourceCommit === 'not a git repository' ? 'not a git repository' : `\`${sourceCommit}\``} |`,
    `| Upstream project | ${study.upstream} |`,
    `| Upstream commit | \`${upstreamCommit}\` |`,
    `| Licence | ${study.licence} |`,
    `| Positive control | \`${study.controls.reference}\` |`,
    `| Negative control | \`${study.controls.broken}\` |`,
    '',
    'These are data for the M0 gate (PT18): the traces, contract and hand-written controls of the study. No engine code is copied. `scripts/sync-corpora.mjs` re-verifies every hash below against the copies, and against the local source when it exists.',
    '',
    '| File | SHA-256 |',
    '|---|---|',
    ...rows,
    '',
    '## Conclusion',
    '',
    'The copies are pinned by their hashes. A change to a corpus is a new copy with a new provenance record, never an edit in place.',
    '',
  ].join('\n');
  writeFileSync(join(dst, 'PROVENANCE.md'), text);
  return files.length;
}

/** Problems with the copies (and, when present, the local sources). Empty means verified. */
export function verify({ sources = true } = {}) {
  const problems = [];
  const notes = [];
  for (const s of STUDIES) {
    let rec;
    try { rec = recorded(s.name); } catch { problems.push(`${s.name}: no PROVENANCE.md`); continue; }
    if (rec.size === 0) problems.push(`${s.name}: PROVENANCE.md records no file`);
    for (const [f, h] of rec) {
      const p = join(DEST, s.name, f);
      if (!existsSync(p)) problems.push(`${s.name}/${f}: missing`);
      else if (sha256(p) !== h) problems.push(`${s.name}/${f}: hash differs from PROVENANCE.md`);
    }
    const onDisk = expand(join(DEST, s.name), s.files).map((f) => f.split(sep).join('/'));
    for (const f of onDisk) if (!rec.has(f)) problems.push(`${s.name}/${f}: present but not recorded`);
    const src = join(CODE, s.source);
    if (!sources) continue;
    if (!existsSync(src)) { notes.push(`${s.name}: local source ${s.source} not present; copies verified alone`); continue; }
    for (const [f, h] of rec) {
      const p = join(src, f);
      if (!existsSync(p)) problems.push(`${s.name}/${f}: missing from the local source`);
      else if (sha256(p) !== h) problems.push(`${s.name}/${f}: the local source drifted from the copy`);
    }
    for (const f of expand(src, s.files)) if (!rec.has(f)) problems.push(`${s.name}/${f}: new in the local source, not copied`);
  }
  return { problems, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--copy')) {
    for (const s of STUDIES) console.log(`${s.name}: copied ${copy(s)} files`);
  }
  const { problems, notes } = verify();
  for (const n of notes) console.log(n);
  for (const p of problems) console.error(`corpora: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`corpora verified: ${STUDIES.map((s) => `${s.name} ${recorded(s.name).size} files`).join(', ')}`);
  void relative;
}
