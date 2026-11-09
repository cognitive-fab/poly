// S588: the refund-twice example (docs/examples/refund-twice.md), tests 1 to 10 of "What the tests must show", tagged
// with RB1 to RB3. Written by a separate writer (rule 7a) from that page and PT14's `poly guide` as built, before any code.
// Light: no model call, no network; each child process is one `node --test` of a small file or one `poly check`.
//
// Readings chosen where the page leaves a detail open:
// - Test 1: `npm test` is run as the script it names. The test asserts package.json's script is exactly
//   `node --test refunds.test.ts` and that package.json declares no dependency, then runs Node itself with that file
//   (TAP reporter) in before/: exit 0, `# fail 0`, and at least four passing tests, one per item the page lists.
// - Test 2: twice.test.ts is run as a child (exit 0, `# fail 0`), and the scenario is also driven directly by importing
//   refunds.ts and stripe-stand-in.ts: one order of 120 on charge `ch_1`, two messages `m-1` and `m-2`. The stand-in's
//   ids are `re_1` and `re_2` as the page says, and the ledger ends holding the second id, since it is set after each call.
// - Test 3: every import specifier in before/ is a Node built-in or a relative `.ts` file of the example, none of the
//   five network modules is imported (with or without `node:`), and no file calls `fetch(`.
// - Test 4: "prints its instance" is read as the verdict line `verdict: CLEAN (exit 0)  refunds.Desk  over ... N states`.
// - Test 5: the PL3002 block is the line naming PL3002 and the indented lines after it. Its witness steps are the lines
//   indented under `witness (N steps):`; every step is `Ask`, and at least two carry `emits payments.refund`. PL4002 is
//   on `Ask` when its line names `Ask`. Other codes are not ruled out: the page says "with", not "exactly".
// - Test 6 (as Amendment 1 defines it): the leading comment block is every line before the first line that is neither
//   blank nor a `//` comment; `on Ask` is its line through the brace that closes it. With both taken out the two files
//   are equal, character for character (CRLF read as LF), and the two `on Ask` handlers differ. A comment just above
//   `on Ask` is outside the handler, so it must be the same in both files.
// - Test 7 (as Amendment 1 lists it): both checks are run from after/ as written. A fenced block of the README whose
//   first line names PL3002 begins with the printed PL3002 block, line for line (CRLF read as LF). The `verdict:` line
//   of `poly check refunds.poly` is held as one exact line of text. Each file's `on Ask` handler is held verbatim, every
//   line with its indentation as in the file, the lines in order and consecutive. The link to `demo/baseline` is a
//   Markdown link whose target contains `demo/baseline`. "Written by hand", the instance and the `never` line are
//   matched anywhere in the README; "dashboard" and "stand-in" within `## What is not checked`. The headings are the
//   six of *The example's README*, with `## Glossary` last and `## Conclusion` before it; other headings are allowed.
// - Test 8: "No code yet" is gone, and (amendment 2, changed in the session for v1.7.0) a status line names a release
//   `vX.Y.Z` and links release notes in docs/ that exist. The link to the example is a
//   Markdown link to examples/refund-twice/README.md inside ## Before and after.
// - Test 10: the new text files are every file under examples/refund-twice (no node_modules, no .poly folder); the
//   page's eight files must exist.
// - Amendment 1's `reply' = Silent` on a request that pays changes no assertion here: no test reads `reply`, and the
//   guarded `on Ask` still differs from the unguarded one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const EX = join(ROOT, 'examples', 'refund-twice');
const BEFORE = join(EX, 'before');
const AFTER = join(EX, 'after');
const EM_DASH = '—';
const NEVER_LINE = 'never no-reissue: emit refund while refund != None';
const BEFORE_FILES = ['package.json', 'refunds.ts', 'stripe-stand-in.ts', 'refunds.test.ts', 'twice.test.ts'];
const AFTER_FILES = ['refunds.poly', 'refunds-unguarded.poly'];
const NETWORK = ['http', 'https', 'net', 'dgram', 'tls'];

// PT14 (S588): the four lines of `poly guide` as built, word for word.
const FOUR_LINES = [
  '- Run `poly guide` to learn poly before writing any.',
  '- Keep the rules that must always hold in poly: invariants, `never` statements and signed policies.',
  '- Run `poly check` before committing; only `CLEAN` is done.',
  '- Never edit a signed policy or accept a finding: those are the owner\'s.',
].join('\n');

const lf = (s) => s.replace(/\r\n/g, '\n');

function mustExist(path) {
  assert.ok(existsSync(path), `${relative(ROOT, path).split(sep).join('/')} exists`);
  return path;
}

const read = (path) => lf(readFileSync(mustExist(path), 'utf8'));

function childEnv() {
  // Node's runner marks its children with NODE_TEST_CONTEXT; a nested `node --test` must not think it is one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** `node --test` of one file of before/, with the TAP reporter. */
function nodeTest(file) {
  mustExist(join(BEFORE, file));
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: BEFORE, env: childEnv(), encoding: 'utf8', timeout: 120_000 });
}

/** `poly check <file>` run from after/, once per file. */
const checks = new Map();
function polyCheck(file) {
  mustExist(join(AFTER, file));
  if (!checks.has(file)) checks.set(file, spawnSync(process.execPath, [CLI, 'check', file], { cwd: AFTER, env: childEnv(), encoding: 'utf8', timeout: 300_000 }));
  return checks.get(file);
}

/** The lines of a printed diagnostic: the column-0 line naming the code and the indented lines after it. */
function blockOf(output, code) {
  const lines = lf(output).split('\n');
  const at = lines.findIndex((l) => /^\S/.test(l) && new RegExp(`\\b${code}\\b`).test(l));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end++;
  return lines.slice(at, end);
}

/** The witness steps of a diagnostic block: the lines indented under its `witness (N steps):` line. */
function witnessSteps(block) {
  const at = block.findIndex((l) => /^\s+witness \(\d+ steps?\):\s*$/.test(l));
  if (at < 0) return [];
  const indent = block[at].match(/^\s*/)[0].length;
  const steps = [];
  for (const l of block.slice(at + 1)) {
    if (l.match(/^\s*/)[0].length <= indent) break;
    steps.push(l);
  }
  return steps;
}

/** Every file under a folder, build output and installed packages left out. */
function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.poly') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out.sort();
}

/** The text with its leading comment and its `on Ask` handler taken out, and the handler. */
function withoutAskAndLeadingComment(text) {
  const lines = lf(text).split('\n');
  let start = 0;
  while (start < lines.length && /^\s*(\/\/.*)?$/.test(lines[start])) start++;
  const body = lines.slice(start);
  const at = body.findIndex((l) => /^\s*on Ask\b/.test(l));
  assert.ok(at >= 0, 'the file has on Ask');
  let depth = 0;
  let opened = false;
  let end = at;
  for (; end < body.length; end++) {
    for (const ch of body[end].replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '')) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
    }
    if (opened && depth === 0) break;
  }
  assert.ok(opened && depth === 0, 'on Ask closes its brace');
  return { rest: [...body.slice(0, at), ...body.slice(end + 1)].join('\n'), ask: body.slice(at, end + 1).join('\n') };
}

test('RB1, test 1: npm test in before/ exits 0, and the tests of refunds.test.ts all pass', () => {
  const pkg = JSON.parse(read(join(BEFORE, 'package.json')));
  assert.equal(pkg.scripts?.test, 'node --test refunds.test.ts', 'npm test runs Node on refunds.test.ts');
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.deepEqual(Object.keys(pkg[k] ?? {}), [], `package.json has no ${k}`);
  const r = nodeTest('refunds.test.ts');
  assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# fail 0$/m, 'no test fails');
  const pass = Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
  assert.ok(pass >= 4, `at least the four tests the page lists pass (${pass})`);
});

test('RB1, test 2: twice.test.ts passes, and the stand-in records two calls for one order with different keys and the full amount each', async () => {
  const r = nodeTest('twice.test.ts');
  assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# fail 0$/m, 'no test fails');
  assert.match(r.stdout, /^# pass [1-9]\d*$/m, 'its test ran and passed');

  const { standInStripe } = await import(pathToFileURL(mustExist(join(BEFORE, 'stripe-stand-in.ts'))).href);
  const { handleRefund } = await import(pathToFileURL(mustExist(join(BEFORE, 'refunds.ts'))).href);
  const stripe = standInStripe();
  const orders = [{ id: 'o-1', customer: 'c-1', charge: 'ch_1', amount: 120 }];
  const ledger = new Map();
  const deps = { orders, stripe, ledger };
  const first = await handleRefund({ customer: 'c-1', order: 'o-1', messageId: 'm-1' }, deps);
  const second = await handleRefund({ customer: 'c-1', order: 'o-1', messageId: 'm-2' }, deps);
  assert.deepEqual(first, { status: 'refunded', refundId: 're_1' });
  assert.deepEqual(second, { status: 'refunded', refundId: 're_2' }, 'the second message pays again');
  assert.equal(stripe.calls.length, 2, 'two calls for one order');
  for (const c of stripe.calls) {
    assert.equal(c.charge, 'ch_1', 'the same charge');
    assert.equal(c.amount, 120, 'the full amount');
  }
  assert.deepEqual(stripe.calls.map((c) => c.idempotencyKey), ['m-1', 'm-2'], 'two different keys, the messages\' ids');
  assert.deepEqual(stripe.calls.map((c) => c.id), ['re_1', 're_2']);
  assert.equal(ledger.get('o-1'), 're_2', 'the ledger is written after each call and never read before it');
});

test('RB1, test 3: no file of before/ imports a module that reaches the network or calls fetch', () => {
  for (const f of BEFORE_FILES) mustExist(join(BEFORE, f));
  const builtins = new Set(builtinModules);
  for (const file of filesUnder(BEFORE)) {
    const name = relative(BEFORE, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(file)) continue;
    assert.ok(!/\bfetch\s*\(/.test(text), `${name} calls no fetch`);
    for (const m of text.matchAll(/\b(?:from|import|require)\s*\(?\s*(['"])([^'"]+)\1/g)) {
      const spec = m[2];
      const bare = spec.replace(/^node:/, '');
      assert.ok(!NETWORK.includes(bare), `${name} imports no network module (${spec})`);
      const builtin = spec.startsWith('node:') || builtins.has(spec);
      const own = /^\.\.?\//.test(spec) && spec.endsWith('.ts');
      assert.ok(builtin || own, `${name} imports only Node's built-ins and the example's own .ts files (${spec})`);
    }
  }
});

test('RB2, test 4: poly check after/refunds.poly reports CLEAN with exit 0 and prints its instance', () => {
  const r = polyCheck('refunds.poly');
  assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^verdict: CLEAN \(exit 0\)\s+refunds\.Desk\s+over \S.*\b\d+ states\b/m, 'the verdict line with its checked instance (PT12.3a)');
});

test('RB2, test 5: poly check after/refunds-unguarded.poly reports FINDINGS, exit 1, PL3002 on no-reissue with Ask steps of which two emit payments.refund, and PL4002 on Ask', () => {
  const r = polyCheck('refunds-unguarded.poly');
  assert.equal(r.status, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^verdict: FINDINGS \(exit 1\)/m);

  const pl3002 = blockOf(r.stdout, 'PL3002');
  assert.ok(pl3002, `a PL3002 diagnostic is printed\n${r.stdout}`);
  assert.match(pl3002[0], /\bno-reissue\b/, 'PL3002 names no-reissue');
  const steps = witnessSteps(pl3002);
  assert.ok(steps.length >= 2, `a witness of at least two steps\n${pl3002.join('\n')}`);
  for (const s of steps) assert.equal(/^\s*([A-Za-z_]\w*)/.exec(s)?.[1], 'Ask', `every step is Ask: ${s.trim()}`);
  const paying = steps.filter((s) => /\bemits payments\.refund\b/.test(s));
  assert.ok(paying.length >= 2, `at least two steps emit payments.refund\n${steps.join('\n')}`);

  const pl4002 = blockOf(r.stdout, 'PL4002');
  assert.ok(pl4002, `a PL4002 diagnostic is printed\n${r.stdout}`);
  assert.match(pl4002[0], /\bAsk\b/, 'PL4002 is on Ask');
});

test('RB2, test 6: the two .poly files are the same text except for their leading comment blocks and their on Ask handlers', () => {
  const guarded = withoutAskAndLeadingComment(read(join(AFTER, 'refunds.poly')));
  const unguarded = withoutAskAndLeadingComment(read(join(AFTER, 'refunds-unguarded.poly')));
  assert.equal(unguarded.rest, guarded.rest, 'everything but on Ask and the leading comment is the same');
  assert.notEqual(unguarded.ask, guarded.ask, 'on Ask differs');
  assert.ok(guarded.rest.includes(NEVER_LINE), 'the rule is written once, outside on Ask');
});

test('RB3, test 7: the example\'s README holds the PL3002 block and the verdict line as poly check prints them, the never line, both on Ask handlers, the claims, and the headings of every example README', () => {
  const readme = read(join(EX, 'README.md'));
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```[^\n]*$/gm;

  // The PL3002 diagnostic and its witness, as printed today from after/ (compared, so a change to the output fails here).
  const printed = blockOf(polyCheck('refunds-unguarded.poly').stdout, 'PL3002');
  assert.ok(printed, 'poly check refunds-unguarded.poly prints a PL3002 diagnostic');
  const fences = [...readme.matchAll(fenceRe)].map((m) => m[1].replace(/\n$/, '').split('\n'));
  const block = fences.find((f) => /\bPL3002\b/.test(f[0]));
  assert.ok(block, 'a fenced block of the README starts with the line naming PL3002');
  assert.deepEqual(block.slice(0, printed.length), printed, 'the README\'s block is the PL3002 block as printed today, from after/');

  // The verdict line of the guarded desk, as printed today from after/.
  const verdict = lf(polyCheck('refunds.poly').stdout).split('\n').find((l) => l.startsWith('verdict: '));
  assert.ok(verdict, 'poly check refunds.poly prints a verdict line');
  assert.ok(readme.split('\n').includes(verdict), `the README holds the verdict line exactly as printed: ${verdict}`);

  // The never line, and each file's on Ask handler as it is in the file.
  assert.ok(readme.includes(NEVER_LINE), 'the README holds the never line');
  for (const f of AFTER_FILES) {
    const { ask } = withoutAskAndLeadingComment(read(join(AFTER, f)));
    assert.ok(readme.includes(ask), `the README holds on Ask of ${f} as it is in the file`);
  }

  // What is and is not claimed (S458 for the amount's cut).
  assert.match(readme, /written by hand/i, 'the README says the before was written by hand');
  assert.match(readme, /\]\([^)\s]*demo\/baseline[^)\s]*\)/, 'the README links to demo/baseline');
  assert.ok(readme.includes('Ask.amount ∈ 0..500 at {0}'), 'the README names the instance with the amount\'s cut');
  const lines = readme.split('\n');
  const notChecked = lines.indexOf('## What is not checked');
  assert.ok(notChecked >= 0, 'the README has ## What is not checked');
  let end = notChecked + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  const body = lines.slice(notChecked + 1, end).join('\n');
  assert.match(body, /dashboard/, 'What is not checked names the dashboard');
  assert.match(body, /stand-in/, 'What is not checked names the stand-in');

  // The headings every example README has (test/ex-readmes.test.mjs), outside fenced code.
  const headings = [...readme.replace(fenceRe, '').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const h of ['What it shows', 'Run it', 'What is checked', 'What is not checked', 'Conclusion', 'Glossary']) assert.ok(headings.includes(h), `## ${h} in ${headings.join(', ')}`);
  assert.equal(headings.at(-1), 'Glossary', '## Glossary is last');
  assert.ok(headings.indexOf('Conclusion') < headings.indexOf('Glossary'), '## Conclusion comes before ## Glossary');
});

test('RB3, test 8: poly\'s README holds the four lines under ## Using poly with a coding agent, ## Before and after before ## Hello, world linking to the example, and no "No code yet"', () => {
  const readme = read(join(ROOT, 'README.md'));
  const lines = readme.split('\n');
  const sectionOf = (h) => {
    const at = lines.indexOf(`## ${h}`);
    if (at < 0) return null;
    let end = at + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    return { at, body: lines.slice(at + 1, end).join('\n') };
  };
  const agent = sectionOf('Using poly with a coding agent');
  assert.ok(agent, 'README.md has ## Using poly with a coding agent');
  assert.ok(agent.body.includes(FOUR_LINES), 'the four lines of poly guide as built, word for word');
  const before = sectionOf('Before and after');
  const hello = sectionOf('Hello, world');
  assert.ok(before, 'README.md has ## Before and after');
  assert.ok(hello, 'README.md has ## Hello, world');
  assert.ok(before.at < hello.at, '## Before and after comes before ## Hello, world');
  assert.match(before.body, /\]\((?:\.\/)?examples\/refund-twice\/README\.md\)/, 'it links to the example\'s README');
  assert.ok(!readme.includes('No code yet'), 'the README no longer says "No code yet"');
  // Amendment 2 (v1.7.0): the status line names the current release and links its notes, a file that exists in docs/.
  const status = lines.find((l) => /\bv\d+\.\d+\.\d+\b/.test(l) && /\]\((?:\.\/)?docs\/release-notes-v[\d.]+\.md\)/.test(l));
  assert.ok(status, 'a status line names a release and links its release notes');
  const notes = /\]\((?:\.\/)?(docs\/release-notes-v[\d.]+\.md)\)/.exec(status)[1];
  assert.ok(existsSync(join(ROOT, notes)), `${notes} exists`);
});

test('RB3, test 9: examples/README.md lists refund-twice/', () => {
  assert.ok(read(join(ROOT, 'examples', 'README.md')).includes('refund-twice/'));
});

test('RB3, test 10: house style in every new text file of the example: no em dash, none of the banned words', () => {
  mustExist(join(EX, 'README.md'));
  for (const f of BEFORE_FILES) mustExist(join(BEFORE, f));
  for (const f of AFTER_FILES) mustExist(join(AFTER, f));
  for (const file of filesUnder(EX)) {
    const name = relative(ROOT, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(EM_DASH), `${name}: no em dash`);
    assert.ok(!/\bhonest/i.test(text), `${name}: none of the banned words`);
  }
});
