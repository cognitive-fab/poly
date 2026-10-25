// v1.3 Step 2 (docs/history/plan-demo.md): the read-only scan behind docs/demo/impact-s526.md. It reads every poly source, the
// embedded TypeScript sources and the inline sources of the tests, and lists what PS23 and PT33 would change:
//   - each effect of class irreversible, its retry bound (the written-out default 5, lower.ts DEFAULT_RETRY, when none),
//     its completions and the guarantee it has today (PS23.4);
//   - each effect with an egress label and no class (PS23.6);
//   - for each program, the standard-library modules it pulls in (uses.ts: a channel of kind k uses std.channels.k, a
//     credential uses std.credentials, a route or budget uses std.routing) and the irreversible effects among them.
// It writes the markdown to standard output and nothing to disk. It runs no check and calls no model.
// The hand-written sections (8 onwards) live in docs/demo/impact-s526.tail.md and are appended when the file exists.
// usage: node scripts/scan-retry-safe.mjs > docs/demo/impact-s526.md
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP = new Set(['node_modules', 'vendor', 'experiments', '.git', '.poly', 'dist']);
const DEFAULT_ATTEMPTS = 5;

const rel = (f) => relative(ROOT, f).split(sep).join('/');

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const f = join(dir, name);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, ext, out);
    else if (ext.some((e) => name.endsWith(e))) out.push(f);
  }
  return out;
}

/** The text of the block that opens at the first `{` at or after `from`, with its end. */
function block(text, from) {
  const open = text.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; }
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: text.slice(open + 1, i), end: i };
  }
  return null;
}

/** Line comments removed, leaving a `//` inside a string alone. */
function stripComments(t) {
  let o = '';
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { o += c; if (c === '\\') o += t[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; o += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; o += '\n'; continue; }
    o += c;
  }
  return o;
}

/** The effects of one poly source: machine, name, kind, class, labels, retry, completions, uses. */
function effectsOf(text) {
  const out = [];
  const re = /^[ \t]*effect[ \t]+(\w+)[ \t]*\(/gm;
  let m;
  while ((m = re.exec(text))) {
    const b = block(text, m.index + m[0].length);
    if (!b) continue;
    const body = stripComments(b.body);
    const before = text.slice(0, m.index);
    const machines = [...before.matchAll(/^[ \t]*(?:service[ \t]+)?machine[ \t]+(\w+)/gm)];
    const attempts = body.match(/retry[ \t]*\{[^}]*attempts[ \t]+(\d+)/);
    out.push({
      machine: machines.length ? machines[machines.length - 1][1] : '',
      name: m[1],
      kind: (body.match(/\bkind[ \t]+"([^"]+)"/) ?? [])[1] ?? m[1],
      cls: (body.match(/\bclass[ \t]+(\w+)/) ?? [])[1] ?? null,
      labels: (body.match(/\blabels[ \t]*\{([^}]*)\}/) ?? [])[1]?.trim().replace(/\s+/g, ' ') ?? '',
      attempts: attempts ? Number(attempts[1]) : null,
      // PS23.4: an `idempotent` item (a header or a nature) is a guarantee, so the effect is not unguarded whatever its bound.
      guarded: /(^|\s)idempotent\s/.test(body),
      completions: ['ok', 'failed', 'exhausted'].filter((k) => new RegExp(`(^|\\n)[ \\t]*${k}\\b[^\\n]*->`).test(body)),
      uses: /\buses[ \t]+\w+/.test(body),
      line: before.split('\n').length,
    });
  }
  return out;
}

const expectedLine = (text) => (text.split('\n')[0].match(/^\/\/ expected: (.*)$/) ?? [])[1] ?? '';
const moduleOf = (text) => (text.match(/^module[ \t]+([\w.]+)/m) ?? [])[1] ?? '';

/** The standard-library files a program pulls in (uses.ts). */
function stdUses(text) {
  const u = new Set();
  for (const m of text.matchAll(/^[ \t]*channel[ \t]+\w+[ \t]*:[ \t]*(\w+)/gm)) u.add(`std/channels/${m[1]}.poly`);
  if (/^[ \t]*credential[ \t]+\w+[ \t]*:/m.test(text)) u.add('std/credentials/grant.poly');
  if (/^[ \t]*(route|budget)[ \t]+\w+/m.test(text)) u.add('std/routing/routing.poly');
  for (const m of text.matchAll(/^[ \t]*use[ \t]+std\.([\w.]+)/gm)) u.add(`std:${m[1]}`);
  return [...u];
}

const guaranteeNow = (e) => (e.attempts === 1 ? 'G1 (attempts 1)' : 'none');
const bound = (e) => (e.attempts ?? DEFAULT_ATTEMPTS);
const isPolicyFile = (f) => f.endsWith('.policy.poly');

// ---- the poly sources -------------------------------------------------------------------------------------------
const FAMILIES = [
  ['examples', 'examples'],
  ['std', 'std'],
  ['conformance', 'conformance'],
  ['test/fixtures', 'test/fixtures'],
];
const files = [];
for (const [fam, dir] of FAMILIES) {
  let root;
  try { root = join(ROOT, dir); statSync(root); } catch { continue; }
  // The rule's own test inputs are unguarded on purpose (a rule that is tested needs a program it fires on); each says so with an
  // explicit marker comment, `// scan: rule-input`, and the impact leaves it out.
  for (const f of walk(root, ['.poly'])) { const text = readFileSync(f, 'utf8'); if (!/^\/\/ scan: rule-input\s*$/m.test(text)) files.push({ fam, f, r: rel(f), text }); }
}
for (const x of files) { x.effects = isPolicyFile(x.r) ? [] : effectsOf(x.text); x.policy = isPolicyFile(x.r); }

const irreversible = [];
const classless = [];
for (const x of files) for (const e of x.effects) {
  if (e.cls === 'irreversible') irreversible.push({ ...x, e });
  else if (e.cls === null && /egress:/.test(e.labels)) classless.push({ ...x, e });
}

const stdIrreversible = new Map();
for (const x of irreversible.filter((y) => y.fam === 'std')) stdIrreversible.set(x.r, [...(stdIrreversible.get(x.r) ?? []), x.e]);

const lines = [];
const out = (s = '') => lines.push(s);
const cell = (s) => String(s).replace(/\|/g, '\\|');

out('# poly · v1.3 Step 2, the impact of the retry-safety rule (S526, PS23, PT33)');
out();
out('*Cognitive Fab · October 2026 · produced by `scripts/scan-retry-safe.mjs` (read-only, no check run, no model) at the commit this file is committed with · replaces the counts of `proposals/demo-refund.md` section 2.5 and appendix A*');
out();
out('Status: for the owner\'s review. Nothing in the tree is changed by this scan. A source is read as text: effects are found by their `effect` declaration and its block, the class, labels, retry and completions by their clauses. The scan does not run the parser, so a construct it cannot read is listed as such at the end. Directories `node_modules`, `vendor`, `experiments`, `.git`, `.poly` and `dist` are skipped. The bound of an effect with no `retry` clause is the written-out default, 5 (`DEFAULT_RETRY`, `packages/poly-lower/src/lower.ts`).');
out();

// 1. counts
const per = (fam, pred) => irreversible.filter((x) => x.fam === fam && pred(x.e)).length;
out('## 1. Counts');
out();
out('`decisions-m7.md` recorded, over `examples/`, `conformance/` and `std/`: 30 irreversible effects, 25 on the default retry. This scan:');
out();
out('| Family | Irreversible effects | on the default retry | with `retry` and attempts 1 | with `retry` and attempts 2 or more | Effects with an egress label and no class |');
out('|---|---|---|---|---|---|');
let tot = 0, totDef = 0;
for (const [fam] of FAMILIES) {
  const n = per(fam, () => true), d = per(fam, (e) => e.attempts === null), one = per(fam, (e) => e.attempts === 1), more = per(fam, (e) => e.attempts !== null && e.attempts >= 2);
  const cl = classless.filter((x) => x.fam === fam).length;
  out(`| \`${fam}/\` | ${n} | ${d} | ${one} | ${more} | ${cl} |`);
  if (fam !== 'test/fixtures') { tot += n; totDef += d; }
}
out(`| \`examples/\`, \`conformance/\`, \`std/\` together | ${tot} | ${totDef} | | | |`);
out();
const draft = irreversible.find((x) => x.r === 'examples/inbox/inbox.poly' && x.e.name === 'createDraft');
const draftFixed = !!draft && draft.e.attempts === 1;
const withDraft = totDef + (draftFixed ? 1 : 0);
if (tot === 30 && totDef === 25) out('The recorded counts (30 irreversible, 25 on the default retry) are reproduced.');
else if (tot === 30 && withDraft === 25) out('The recorded count of 30 irreversible effects is reproduced. This scan finds **' + totDef + '** on the default retry, not 25: the recorded 25 counted the inbox\'s `createDraft` on the default, and it now declares `attempts 1`, so 24 + 1 = 25 once it is counted as it was recorded.');
else out('**The recorded counts (30 and 25) are not reproduced: this scan finds ' + tot + ' and ' + totDef + '.**');
out();

// 2. the effects
out('## 2. Every irreversible effect');
out();
out('"Today" is the guarantee the declaration gives (G1 when `attempts 1`, else none). "After" is the finding of PS23.5 on the declaration alone: `PL4003` when the bound is 2 or more and nothing guards it. The decision of the fix is the owner\'s at Step 6.');
out();
for (const [fam, dir] of FAMILIES) {
  const rows = irreversible.filter((x) => x.fam === fam);
  if (!rows.length) continue;
  out(`### \`${dir}/\` (${rows.length})`);
  out();
  out('| File:line | Machine.effect | Kind | Attempts | Completions | Today | After | Proposed change |');
  out('|---|---|---|---|---|---|---|---|');
  for (const x of rows) {
    const e = x.e;
    const after = bound(e) >= 2 ? '`PL4003`' : 'none';
    let change = '';
    if (bound(e) >= 2) {
      if (x.r === 'std/credentials/grant.poly') change = 'G4 `idempotent by nature "RFC 7009"` in the library (Q3)';
      else if (x.r === 'std/channels/webhook.poly') change = '`retry { attempts 1 }` (Q1, decided in section 8)';
      else if (x.fam === 'std') change = '`retry { attempts 1 }` (Q1)';
      else if (x.r === 'examples/concierge/concierge.poly') change = '`idempotent header "Idempotency-Key" window …` (the owner reads the window from the provider\'s documentation)';
      else if (x.r.startsWith('examples/')) change = 'owner chooses at Step 6: `idempotent …` or `retry { attempts 1 }`';
      else change = '`retry { attempts 1 }` unless the file is about retry (Q14)';
    }
    out(`| ${cell(x.r)}:${e.line} | ${cell(e.machine)}.${cell(e.name)} | \`${cell(e.kind)}\` | ${e.attempts ?? 'default (5)'} | ${e.completions.join(', ') || 'none'} | ${guaranteeNow(e)} | ${after} | ${change} |`);
  }
  out();
}

// 3. classless egress
out('## 3. Effects with an egress label and no class (PS23.6, `PL6304`)');
out();
if (!classless.length) out('None.');
else {
  out('| File:line | Machine.effect | Kind | Labels | Proposed change |');
  out('|---|---|---|---|---|');
  for (const x of classless) out(`| ${cell(x.r)}:${x.e.line} | ${cell(x.e.machine)}.${cell(x.e.name)} | \`${cell(x.e.kind)}\` | ${cell(x.e.labels)} | an explicit class |`);
}
out();

// 4. programs and what the standard library adds
out('## 4. Programs, the standard library they pull in, and what changes');
out();
out('A program is a source that is not a policy file and declares a module. The standard-library files are the ones `uses.ts` adds: a channel of kind `k` adds `std/channels/k.poly`, a credential adds `std/credentials/grant.poly`, a route or budget adds `std/routing/routing.poly`, and an explicit `use std.…` is listed as written. "Own" is the number of its own irreversible effects on a bound of 2 or more; "Pulled in" is the standard-library irreversible effects on a bound of 2 or more that it adds. A program with either is `FINDINGS` (`PL4003`) until migrated, whatever its expected line says.');
out();
out('| Program | Expected line | Own | Pulled in | Pulls in from |');
out('|---|---|---|---|---|');
let programsChanged = 0;
const changed = [];
for (const x of files) {
  if (x.policy || !moduleOf(x.text)) continue;
  const own = x.effects.filter((e) => e.cls === 'irreversible' && bound(e) >= 2 && !e.guarded).length;
  const used = stdUses(x.text);
  const pulled = [];
  for (const u of used) if ((stdIrreversible.get(u) ?? []).some((e) => bound(e) >= 2 && !e.guarded)) pulled.push(u);
  const cl = x.effects.filter((e) => e.cls === null && /egress:/.test(e.labels)).length;
  if (x.fam === 'std') continue;
  if (own || pulled.length || cl) { programsChanged++; changed.push(x.r); out(`| ${cell(x.r)} | ${cell(expectedLine(x.text) || '(none)')} | ${own}${cl ? ` (+${cl} classless)` : ''} | ${pulled.length} | ${pulled.map((p) => `\`${p}\``).join(', ') || ''} |`); }
}
out();
out(`${programsChanged} programs change their verdict or report under the rule as written, before any migration.`);
out();
out('A program with a pulled-in effect is fixed by changing the library once (Step 6 starts there), not file by file; its own effects are the per-file work. The programs that pull in only a library effect need no edit after the library is migrated.');
out();

// 5. embedded and inline
out('## 5. Embedded and inline sources');
out();
const emb = [];
for (const f of [...walk(join(ROOT, 'conformance'), ['.ts']), ...walk(join(ROOT, 'test'), ['.ts', '.mjs']), ...walk(join(ROOT, 'examples'), ['.ts'])]) {
  const t = readFileSync(f, 'utf8');
  const hits = [];
  t.split('\n').forEach((l, i) => { if (/cls\(\s*['"]irreversible['"]\s*\)|class:\s*['"]irreversible['"]|class irreversible/.test(l)) hits.push(i + 1); });
  if (hits.length) emb.push({ r: rel(f), hits });
}
out('| File | Lines naming an irreversible class | Kind |');
out('|---|---|---|');
for (const x of emb) {
  out(`| ${cell(x.r)} | ${x.hits.join(', ')} | ${x.r.endsWith('.ts') ? 'embedded TypeScript source' : /\.test\.mjs$/.test(x.r) ? 'inline source or fixture of a test' : 'test helper'} |`);
}
out();
out('An inline source that expects an exact code list changes with its reason in the commit. A line that names the class in a policy event (not a source the checker reads) needs no change; Step 3 settles each.');
out();

// 6. policy files
const pol = files.filter((x) => x.policy && /irreversible/.test(x.text));
out('## 6. Policy files that name the class (no change expected)');
out();
out(pol.length ? pol.map((x) => `- ${x.r}`).join('\n') : 'None.');
out();

// 7. webhook
const webhook = irreversible.find((x) => x.r === 'std/channels/webhook.poly');
out('## 7. The webhook channel (Q1: "decide from the adapter in Step 2")');
out();
out(webhook ? `\`std/channels/webhook.poly\` declares attempts ${webhook.e.attempts ?? 'default'} (base and timeout in the file). The decision from the adapter is in section 8 (written by hand, from \`packages/poly-io\`).` : 'Not found.');
out();

let tail = '';
try { tail = readFileSync(join(ROOT, 'docs', 'demo', 'impact-s526.tail.md'), 'utf8'); } catch { /* the generated part alone */ }
process.stdout.write(lines.join('\n') + '\n' + tail);
