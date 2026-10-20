#!/usr/bin/env node
// DF25: state diagrams of the checked machines, for the pages. Mermaid `stateDiagram-v2`, drawn from the reachable graph that poly-ref
// explores for the checked instance (the graph the check itself walks: 226 states for the Ticket of poly-kept, 5762 for the Desk of the
// concierge), projected onto a field or two. A diagram is a projection of the checked model, not the model: many states of the instance
// draw as one box, and an edge is drawn once for each (from, action, to) of the projection. The files hold no date, so they are a function
// of the program and can be compared byte for byte (test/demo-diagrams.test.mjs).
//
//   node demo/scripts/make-diagrams.mjs <outdir> [--only ticket|desk]
//     poly-kept-ticket.mmd   the Ticket of demo/baseline/runs/poly-kept/tree/src/support.poly, projected onto `phase`
//     concierge-desk.mmd     the Desk of examples/concierge/concierge.poly, projected onto `phase` and `refund` (ids `<phase>_<refund>`)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUses } from '@poly/check';
import { parse } from '@poly/lang';
import { buildMachine, explore, isTerminal, machineSystem, statePlain } from '@poly/ref';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TARGETS = {
  ticket: {
    file: 'poly-kept-ticket.mmd',
    source: join(ROOT, 'demo', 'baseline', 'runs', 'poly-kept', 'tree', 'src', 'support.poly'),
    machine: 'Ticket',
    fields: ['phase'],
    title: 'support.Ticket of the kept poly build',
  },
  desk: {
    file: 'concierge-desk.mmd',
    source: join(ROOT, 'examples', 'concierge', 'concierge.poly'),
    machine: 'Desk',
    fields: ['phase', 'refund'],
    title: 'concierge.Desk of examples/concierge',
  },
};

/** The Mermaid lines of one machine's projection. */
export function diagramOf({ source, machine, fields, title }) {
  const { module } = parse(readFileSync(source, 'utf8'));
  if (!module) throw new Error(`${source} does not parse`);
  // The program the module is checked in: its channels use the standard library (PS15), which the machine's expansion reads.
  const M = buildMachine(module, machine, { program: resolveUses(module, source).program });
  const g = explore(machineSystem(M));
  if (g.capHit) throw new Error(`the exploration of ${machine} stopped at its bound: a diagram of part of the instance would be drawn as the whole`);
  const id = (state) => {
    const plain = statePlain(state);
    return fields.map((f) => String(plain[f])).join('_');
  };
  const body = new Set();
  body.add(`    [*] --> ${id(g.states[0])}`);
  const kinds = new Map();
  for (const e of g.edges) {
    if (e.label.verdict.kind !== 'accepted' || e.to === null || e.outcome.kind !== 'state') continue;
    const from = id(g.states[e.from]);
    const to = id(g.states[e.to]);
    const effects = e.label.effects.filter((i) => i.type === 'effect').map((i) => i.kind);
    // A step that leaves the projection where it was is drawn only when it does something: an effect, or a change of another field.
    if (from === to && effects.length === 0 && e.from === e.to) continue;
    const key = `${from} --> ${to} : ${e.label.action}`;
    const set = kinds.get(key) ?? new Set();
    for (const k of effects) set.add(k);
    kinds.set(key, set);
  }
  for (const [key, set] of kinds) body.add(`    ${key}${set.size ? ` / ${[...set].sort().join(', ')}` : ''}`);
  const terminal = new Set(g.states.filter((s) => isTerminal(M, s)).map(id));
  for (const t of terminal) body.add(`    ${t} --> [*]`);
  const head = [
    `%% A projection of the checked model of ${title}, onto ${fields.map((f) => `\`${f}\``).join(' and ')}: ${g.states.length} states of the checked instance drawn as the boxes they project to. It is not the model.`,
    '%% An edge is an accepted step, once for each (from, action, to), with the effects it emits after the slash.',
    'stateDiagram-v2',
  ];
  return `${[...head, ...[...body].sort()].join('\n')}\n`;
}

const fence = '```';

/** The README that embeds both diagrams; written only when both are, so that it is never out of step with them. */
function readme(ticket, desk) {
  return `# State diagrams of the checked machines

These two diagrams are drawn by \`demo/scripts/make-diagrams.mjs\` from the reachable graph that \`poly-ref\` explores for the checked instance, the same graph the check walks. They are projections of the checked model, not the model: many states of the instance are drawn as one box, and each edge is an accepted step, once for each (from, action, to). Regenerate them with \`node demo/scripts/make-diagrams.mjs docs/demo/diagrams\`. A test compares the files with a fresh run, byte for byte.

## The Ticket of poly-kept

One ticket is one order's refunds. The edge from \`Refunding\` to \`Review\` is the ambiguous end: every attempt ended without an answer, so a person decides, and \`Resolve\` is the only way out of \`Review\`. This is the design that keeps a second refund from being issued after an uncertain one (mutation (c) of Act 1 removes it).

${fence}mermaid
${ticket.trimEnd()}
${fence}

## The Desk of the concierge (v1.3.1)

The boxes are \`<phase>_<refund>\`. The second part is the ledger of DF19: \`None\` (no refund issued or open on this thread), \`Unknown\` (a refund in flight, waiting for approval, or ended without an answer) and \`Issued\`. A refund request leaves \`Extracting_None\` for \`Refunding_Unknown\`; \`Refunded\` makes the ledger \`Issued\`; \`RefundFailed\` (a definite refusal) makes it \`None\` again; \`RefundUnknown\` leaves it \`Unknown\`; and \`Resolve\`, signed by a person, moves \`Unknown\` to \`Issued\` or to \`None\`. While the ledger is not \`None\`, \`Amounted\` takes the \`Answering\` branch and emits no refund, which is the path property \`no-reissue\`. The ledger is per thread, not per order (\`Items\` is opaque, PS1.4b).

${fence}mermaid
${desk.trimEnd()}
${fence}

## Conclusion

The Ticket keeps its ambiguity in a phase of its own, and the Desk keeps it in a field. In both, the way out is a person's signed step, and the diagrams show it as the only edge that leaves the uncertain box.

## Glossary

- **Projection:** the checked states drawn as the value of one or two fields.
- **Ledger:** the Desk's record of its refunds: \`None\`, \`Unknown\`, \`Issued\`.
- **Unknown:** a refund whose outcome is not known to the program.
- **Resolve:** the step in which a person, with a signed record, says whether an unknown refund exists.
`;
}

/** Writes the diagrams named by `only` (all when null) under `out`; returns the file names. */
export function makeDiagrams(out, only = null) {
  mkdirSync(out, { recursive: true });
  const written = [];
  const texts = {};
  for (const [name, target] of Object.entries(TARGETS)) {
    if (only !== null && only !== name) continue;
    texts[name] = diagramOf(target);
    writeFileSync(join(out, target.file), texts[name]);
    written.push(target.file);
  }
  if (only === null) {
    writeFileSync(join(out, 'README.md'), readme(texts.ticket, texts.desk));
    written.push('README.md');
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args[0];
  const at = args.indexOf('--only');
  const only = at < 0 ? null : args[at + 1];
  if (!out || out.startsWith('--') || (at >= 0 && !Object.hasOwn(TARGETS, only))) {
    console.error('usage: node demo/scripts/make-diagrams.mjs <outdir> [--only ticket|desk]');
    process.exit(2);
  }
  for (const f of makeDiagrams(out, only)) console.log(join(out, f));
}
