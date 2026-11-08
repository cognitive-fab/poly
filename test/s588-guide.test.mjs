// S588, PT14: `poly guide` as built. Written by a separate writer (rule 7a) from PT14's row for `poly guide` and its
// paragraph "`poly guide` as built", before any code. Light: no model call, no network, short child processes only.
//
// Readings chosen where the text leaves a detail open:
// - "Reads no project" is shown by running the command from a fresh folder that holds a poly.json no reader could parse:
//   the guide is still printed with exit 0, and the folder is unchanged after ("writes no file").
// - "Anything after guide is a usage error" is tried with a word (`extra`) and with two options (`--json`, `--help`).
// - "Takes no input" over MCP: the registry command's input schema declares no property and requires none.
// - The eight headings are checked as a subsequence of the guide's `## ` lines (outside fenced code), in order and
//   written exactly; the text does not say they are the only ones.
// - "Says only CLEAN is done" is read as a sentence of *The verdicts* of the form "only `CLEAN` is done" (or
//   "`CLEAN` is the only ... done").
// - The other sections' contents are checked by the words PT14 uses for them, within each section, ignoring case.
// - "Every `poly <command>` the guide names" is read as each `poly <word>` inside inline code or a fenced block: plain
//   prose such as "poly is a language" names no command. The word is matched against a command's name or the part of
//   its name before a `-`, or is one of `new`, `mcp`, `lsp`, and must not be in NOT_BUILT.
// - "Keeps its front matter" is today's front matter of SKILL.md, byte for byte (after CRLF is read as LF).
// - "Before anything else" is read as: the skill names both `poly guide` and `poly_guide` before its first `## ` heading.
// - The README's four lines are found as four consecutive lines inside the section `## Using poly with a coding agent`.
// - House style is checked in GUIDE.md, the README's new section and SKILL.md: no em dash and no "honest" word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, NOT_BUILT, commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const GUIDE = join(ROOT, 'packages', 'poly-check', 'GUIDE.md');
const SKILL = join(ROOT, 'adapters', 'claude-code', 'skills', 'poly', 'SKILL.md');
const README = join(ROOT, 'README.md');
const DIAGNOSTICS = join(ROOT, 'packages', 'poly-core', 'src', 'diagnostics.ts');
const EM_DASH = '—';

const HEADINGS = ['What poly is', 'The loop', 'The verdicts', 'Where the rules live', 'What never to do', 'Before committing', 'Where to read more', 'Conclusion'];

// PT14 (S588): the lines an owner puts in a project's AGENTS.md or CLAUDE.md, word for word.
const FOUR_LINES = [
  '- Run `poly guide` to learn poly before writing any.',
  '- Keep the rules that must always hold in poly: invariants, `never` statements and signed policies.',
  '- Run `poly check` before committing; only `CLEAN` is done.',
  '- Never edit a signed policy or accept a finding: those are the owner\'s.',
].join('\n');

// The skill's front matter before S588, which PT14 says it keeps.
const FRONT_MATTER = [
  '---',
  'name: poly',
  'description: Write, check and fix poly programs (.poly files and embedded TypeScript modules), and run poly workflows through polyflow. Use when the task is the stateful core of a program, a workflow, or a policy written in poly.',
  '---',
].join('\n');

const lf = (s) => s.replace(/\r\n/g, '\n');

/** The guide's text, after asserting the file exists, so that a missing guide fails on an assertion. */
function guideText() {
  assert.ok(existsSync(GUIDE), 'packages/poly-check/GUIDE.md exists (PT14, S588)');
  return lf(readFileSync(GUIDE, 'utf8'));
}

/** The text with fenced blocks taken out, and the fenced blocks' contents. */
function splitFences(text) {
  const fences = [];
  const prose = text.replace(/^```[^\n]*\n([\s\S]*?)^```[^\n]*$/gm, (_, body) => { fences.push(body); return ''; });
  return { prose, fences };
}

/** The guide's `## ` headings outside fenced code, and each one's section text (up to the next `## `). */
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    const m = !fenced && /^## (.+)$/.exec(line);
    if (m) out.push({ heading: m[1], body: [] });
    else if (out.length) out.at(-1).body.push(line);
  }
  return out.map((s) => ({ heading: s.heading, body: s.body.join('\n') }));
}

function section(text, heading) {
  const s = sections(text).find((x) => x.heading === heading);
  assert.ok(s, `the guide has the section ## ${heading}`);
  return s.body;
}

/** A section of a Markdown file by its `## ` heading, up to the next `## ` line. */
function markdownSection(text, heading) {
  const lines = text.split('\n');
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(at + 1, end).join('\n');
}

function poly(args, cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, timeout: 60_000 });
}

test('S588, PT14: poly guide prints packages/poly-check/GUIDE.md byte for byte to standard output and exits 0', () => {
  assert.ok(existsSync(GUIDE), 'packages/poly-check/GUIDE.md exists');
  const r = poly(['guide'], ROOT);
  assert.equal(r.status, 0, `exit 0; stderr: ${r.stderr}`);
  assert.ok(Buffer.isBuffer(r.stdout));
  assert.ok(r.stdout.equals(readFileSync(GUIDE)), 'standard output is the file, byte for byte');
});

test('S588, PT14: poly guide takes no argument and no option; anything after guide is a usage error, exit 64', () => {
  // The bare command is served, so the 64 below is the guide's refusal, not an unknown command's.
  const bare = poly(['guide'], ROOT);
  assert.equal(bare.status, 0, `poly guide exits 0; stderr: ${bare.stderr}`);
  for (const extra of [['extra'], ['--json'], ['--help']]) {
    const r = poly(['guide', ...extra], ROOT);
    assert.equal(r.status, 64, `poly guide ${extra.join(' ')} exits 64`);
  }
});

test('S588, PT14: poly guide reads no project and writes no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 's588-guide-'));
  try {
    // A project file no reader could parse: a command that read the project would fail on it.
    const broken = '{ this is not a project';
    writeFileSync(join(dir, 'poly.json'), broken);
    const r = poly(['guide'], dir);
    assert.equal(r.status, 0, `exit 0 beside a broken poly.json; stderr: ${r.stderr}`);
    assert.ok(existsSync(GUIDE), 'packages/poly-check/GUIDE.md exists');
    assert.ok(r.stdout.equals(readFileSync(GUIDE)), 'the guide is printed whatever the working directory holds');
    assert.deepEqual(readdirSync(dir), ['poly.json'], 'nothing is written in the working directory');
    assert.equal(readFileSync(join(dir, 'poly.json'), 'utf8'), broken, 'the project file is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S588, PT14: the registry serves guide as the MCP tool poly_guide, which takes no input and returns { text } equal to GUIDE.md', async () => {
  const cmd = COMMANDS.find((c) => c.mcp === 'poly_guide');
  assert.ok(cmd, 'a registry command has the MCP tool name poly_guide');
  assert.equal(cmd.name, 'guide');
  assert.equal(commandNamed('guide'), cmd);
  assert.ok(!NOT_BUILT.some((n) => n.name === 'guide' || n.mcp === 'poly_guide'), 'guide is not listed as not built');
  assert.deepEqual(Object.keys(cmd.input?.properties ?? {}), [], 'the input declares no property');
  assert.deepEqual(cmd.input?.required ?? [], [], 'the input requires nothing');
  const o = await cmd.run({});
  assert.deepEqual(o.result, { text: readFileSync(GUIDE, 'utf8') });
});

test('S588, PT14: the guide holds the eight second-level headings, in order, each written exactly', () => {
  const found = sections(guideText()).map((s) => s.heading);
  let from = 0;
  for (const h of HEADINGS) {
    const at = found.indexOf(h, from);
    assert.ok(at >= 0, `## ${h} after ## ${HEADINGS[HEADINGS.indexOf(h) - 1] ?? '(start)'}; headings: ${found.join(' | ')}`);
    from = at + 1;
  }
});

test('S588, PT14: The loop is the skill\'s: write, poly check, read each diagnostic and its witness, poly fix or an edit, until CLEAN', () => {
  const body = section(guideText(), 'The loop');
  assert.ok(body.includes('poly check'), 'names poly check');
  assert.ok(body.includes('poly fix'), 'names poly fix');
  assert.match(body, /diagnostic/i);
  assert.match(body, /witness/i);
  assert.match(body, /edit/i);
  assert.ok(body.includes('CLEAN'), 'loops until CLEAN');
});

test('S588, PT14, PT12.3: The verdicts names the five verdicts and says only CLEAN is done', () => {
  const body = section(guideText(), 'The verdicts');
  for (const v of ['CLEAN', 'FINDINGS', 'REFUSED', 'UNDERPOWERED', 'INCONCLUSIVE']) assert.match(body, new RegExp(`\\b${v}\\b`), `names ${v}`);
  assert.match(body, /\bonly `?CLEAN`? (?:is|counts as) done\b|`?CLEAN`? is the only [^.\n]*\bdone\b/i, 'says only CLEAN is done');
});

test('S588, PT14: Where the rules live names invariants, never statements, path properties, configurations and *.policy.poly policies, and says a signed policy is never edited by an agent', () => {
  const body = section(guideText(), 'Where the rules live');
  assert.match(body, /invariant/i);
  assert.match(body, /`?never`? statement/i);
  assert.match(body, /path propert/i);
  assert.match(body, /configuration/i);
  assert.ok(body.includes('*.policy.poly'), 'names *.policy.poly');
  assert.match(body, /sign/i, 'says a policy a person signed is the person\'s');
  assert.match(body, /never edit/i, 'says an agent never edits it');
});

test('S588, PT14: What never to do names accepting a finding, approving an escalation, admitting a program, and weakening a property or a check domain', () => {
  const body = section(guideText(), 'What never to do');
  assert.match(body, /accept/i);
  assert.match(body, /finding/i);
  assert.match(body, /approv/i);
  assert.match(body, /escalation/i);
  assert.match(body, /admit/i);
  assert.match(body, /weaken/i);
  assert.match(body, /propert/i);
  assert.match(body, /domain/i);
});

test('S588, PT14: Before committing says to run poly check on the project and to commit nothing but CLEAN as done', () => {
  const body = section(guideText(), 'Before committing');
  assert.ok(body.includes('poly check'), 'names poly check');
  assert.ok(body.includes('CLEAN'), 'names CLEAN');
  assert.match(body, /commit/i);
});

test('S588, PT14: Where to read more names docs/04-semantics.md, docs/03-technical-spec.md and examples/', () => {
  const body = section(guideText(), 'Where to read more');
  for (const p of ['docs/04-semantics.md', 'docs/03-technical-spec.md', 'examples/']) assert.ok(body.includes(p), `names ${p}`);
});

test('S588, PT14: every poly <command> the guide names is a registry command or new, mcp or lsp, and none is in NOT_BUILT', () => {
  const { prose, fences } = splitFences(guideText());
  const code = [...fences, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])];
  const words = new Set();
  for (const snippet of code) for (const m of snippet.matchAll(/(?<![\w./-])poly ([a-z][a-z-]*)/g)) words.add(m[1]);
  assert.ok(words.has('check'), 'the guide names poly check');
  assert.ok(words.has('fix'), 'the guide names poly fix');
  const served = (w) => ['new', 'mcp', 'lsp'].includes(w) || COMMANDS.some((c) => c.name === w || c.name.split('-')[0] === w);
  for (const w of words) {
    assert.ok(served(w), `poly ${w} is a command the command line serves`);
    assert.ok(!NOT_BUILT.some((n) => n.name === w), `poly ${w} is not in NOT_BUILT`);
  }
});

test('S588, PT14, PT12.2: every PL code the guide names is defined in packages/poly-core/src/diagnostics.ts', () => {
  const text = guideText();
  const defined = readFileSync(DIAGNOSTICS, 'utf8');
  for (const code of new Set(text.match(/\bPL\d{4}\b/g) ?? [])) assert.match(defined, new RegExp(`\\b${code}:\\s*\\{`), `${code} is defined`);
});

test('S588, PT14: the Claude Code skill keeps its front matter and tells the agent to run poly guide, or call poly_guide, before anything else', () => {
  const text = lf(readFileSync(SKILL, 'utf8'));
  assert.ok(text.startsWith(FRONT_MATTER + '\n'), 'the front matter is kept, byte for byte');
  const body = text.slice(FRONT_MATTER.length);
  const firstSection = body.search(/^## /m);
  const intro = firstSection < 0 ? body : body.slice(0, firstSection);
  assert.ok(intro.includes('poly guide'), 'names poly guide before the first ## heading');
  assert.ok(intro.includes('poly_guide'), 'names poly_guide before the first ## heading');
});

test('S588, PT14: poly\'s README gives the four lines word for word under ## Using poly with a coding agent', () => {
  const body = markdownSection(lf(readFileSync(README, 'utf8')), 'Using poly with a coding agent');
  assert.ok(body !== null, 'README.md has ## Using poly with a coding agent');
  assert.ok(body.includes(FOUR_LINES), 'the four lines, word for word and in order');
});

test('S588: house style in the guide, the README\'s new section and the skill: no em dash, no banned word', () => {
  const texts = { 'GUIDE.md': guideText(), 'SKILL.md': readFileSync(SKILL, 'utf8') };
  const readmeSection = markdownSection(lf(readFileSync(README, 'utf8')), 'Using poly with a coding agent');
  assert.ok(readmeSection !== null, 'README.md has ## Using poly with a coding agent');
  texts['README.md (Using poly with a coding agent)'] = readmeSection;
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(!text.includes(EM_DASH), `${name}: no em dash`);
    assert.ok(!/\bhonest/i.test(text), `${name}: none of the banned words`);
  }
});
