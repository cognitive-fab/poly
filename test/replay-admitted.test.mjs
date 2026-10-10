// PS11.4 (ruled 2026-10-10): replay takes what the checker admits. Every conformance and example program the checker
// admits replays its recorded runs: δ on replay is the δ the checker explored, so a step poly-ref takes and replay
// refuses is a fault of replay, never of the program. The runs here are recorded without a runtime: a seeded walk over
// poly-ref's δ, each step journaled in the runtime's form (PT10l: an Items as { ref, count }), then folded by replayRun.
// The fixture test/fixtures/replay-count/concierge-count.poly is walked too: no conformance or example program reads
// the count of an Items in a handler, and that read is the case PS11.4 was ruled over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@poly/lang';
import { resolveUses, replayRun } from '@poly/check';
import { buildMachine, initialState, transition, dataDomain, flatten, flattenData } from '@poly/ref';
import { ROOT, polyFiles } from './helpers.mjs';

const VERDICTS = JSON.parse(readFileSync(join(ROOT, 'docs', 'v1', 'verdicts-after-rulings.json'), 'utf8')).files;
const COUNT_FIXTURE = join(ROOT, 'test', 'fixtures', 'replay-count', 'concierge-count.poly');
const STEPS = 30;
// The program as poly check resolves it: its uses from std/, where the channel kinds of conformance/m8 live. The tests'
// own std (stdFor) holds only the test channel kind, which no conformance or example program uses.
const STD = join(ROOT, 'std');

/** A seeded linear congruential generator, so every run of the test walks the same paths. */
function lcg(seed) {
  let x = seed >>> 0;
  return (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
}

/** A string seed from the file and machine, so adding a file does not change another file's walk. */
const seedOf = (s) => createHash('sha256').update(s).digest().readUInt32LE(0);

/**
 * The runtime's journal form of a step's data (PT10l): poly-ref's flattened data, with each Items parameter given a
 * ref beside its count, as the runtime records { ref: 'items:<id>', count }.
 */
function journalData(data, action, M, tag) {
  const flat = flattenData(data, action.name, M);
  for (const p of action.params ?? []) {
    if (p.type?.k === 'items' && flat[p.name] && typeof flat[p.name] === 'object') {
      flat[p.name] = { ref: `items:${createHash('sha256').update(`${tag}:${p.name}`).digest('hex')}`, ...flat[p.name] };
    }
  }
  return flat;
}

/** A recorded run of `steps` picks over M, journaled as the runtime journals it, with counts of what the walk skipped. */
function walk(M, seed) {
  const pick = lcg(seed);
  const skipped = { domain: new Set(), refused: 0 };
  const domains = new Map();
  for (const a of M.actions) {
    try { const d = dataDomain(a, M); if (d.length) domains.set(a.name, d); } catch { skipped.domain.add(a.name); }
  }
  const actions = M.actions.filter((a) => domains.has(a.name));
  let s = initialState(M);
  const rows = [{ seq: 0, action: '$create', action_id: '$create', data: {}, pre: flatten(s, M), post: flatten(s, M), step_kind: 'accepted', reject_reason: null }];
  if (!actions.length) return { rows, skipped };
  for (let k = 0, tries = 0; k < STEPS && tries < STEPS * 8; tries++) {
    const action = actions[pick(actions.length)];
    const dom = domains.get(action.name);
    const data = dom[pick(dom.length)];
    let r;
    // Poly-ref itself refusing a pick (a transition that throws) is not what this test is about: try another.
    try { r = transition(M, s, action.name, data, 'run-1'); } catch { skipped.refused++; continue; }
    const seq = rows.length;
    const next = r.next ?? s;
    rows.push({
      seq, action: action.name, action_id: `${action.name}:${seq}`, data: journalData(data, action, M, `${seed}:${seq}`),
      pre: flatten(s, M), post: flatten(next, M), step_kind: r.verdict.kind, reject_reason: r.verdict.reason ?? null,
    });
    s = next;
    k++;
  }
  return { rows, skipped };
}

/** Every .poly file under conformance/ and examples/ (polyFiles leaves out errors/), and the Items count fixture. */
function programs() {
  return [...polyFiles(join(ROOT, 'conformance')), ...polyFiles(join(ROOT, 'examples')), COUNT_FIXTURE];
}

test('PS11.4: every conformance and example program the checker admits replays its recorded runs', async (t) => {
  const diagnostics = [];
  const unbuilt = [];
  const replayed = { files: new Set(), machines: 0, steps: 0, refused: 0, domainSkips: [] };
  for (const file of programs()) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (VERDICTS[rel]?.verdict === 'REFUSED') continue;
    const parsed = parse(readFileSync(file, 'utf8'));
    if (!parsed.module || parsed.diagnostics.some((d) => d.severity === undefined || d.severity === 'error')) continue;
    const module = parsed.module;
    const machines = (module.decls ?? []).filter((d) => d.kind === 'Machine').map((d) => d.name);
    if (!machines.length) continue;
    let program;
    try {
      const uses = resolveUses(module, file, undefined, STD);
      program = uses.program;
    } catch (e) { unbuilt.push(`${rel}: uses: ${e.message}`); continue; }
    for (const name of machines) {
      let M;
      try { M = buildMachine(module, name, { program }); } catch (e) { unbuilt.push(`${rel} ${name}: ${e.message}`); continue; }
      const { rows, skipped } = walk(M, seedOf(`${rel}#${name}`));
      replayed.refused += skipped.refused;
      for (const a of skipped.domain) replayed.domainSkips.push(`${rel} ${name}.${a}`);
      let out;
      try { out = await replayRun(module, `${module.name}.${name}`, 'run-1', rows, { program }); } catch (e) {
        diagnostics.push(`${rel} ${name}: replayRun threw: ${e.message}`);
        continue;
      }
      for (const d of out?.diagnostics ?? []) diagnostics.push(`${rel} ${name}: ${d.code} ${d.message}`);
      if (out && out.folded !== out.rows) diagnostics.push(`${rel} ${name}: ${out.folded} of ${out.rows} rows folded`);
      replayed.files.add(rel);
      replayed.machines++;
      replayed.steps += rows.length - 1;
    }
  }
  // What the walk could not give is counted and printed, never hidden: picks poly-ref refused, and actions with no domain.
  t.diagnostic(`replayed ${replayed.files.size} files, ${replayed.machines} machines, ${replayed.steps} steps; ${replayed.refused} picks refused by poly-ref; actions with no domain: ${replayed.domainSkips.length ? replayed.domainSkips.join(', ') : 'none'}`);
  assert.deepEqual(unbuilt, [], 'every machine of an admitted program is built by poly-ref');
  assert.deepEqual(diagnostics, [], 'every recorded run replays with no diagnostic');
  // Not vacuous: the walk replayed most of the corpus, and the Items count fixture among it.
  assert.ok(replayed.files.size >= 100, `files replayed: ${replayed.files.size}`);
  assert.ok(replayed.machines >= 120, `machines replayed: ${replayed.machines}`);
  assert.ok(replayed.steps >= replayed.machines * 10, `steps replayed: ${replayed.steps}`);
  assert.ok(replayed.files.has('test/fixtures/replay-count/concierge-count.poly'));
});
