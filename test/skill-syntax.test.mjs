// v1.3.1 documentation: the Claude Code skill (adapters/claude-code/skills/poly) is documentation only, and what it
// teaches is checked. Every fenced block of syntax.md that names a file is written out and run through poly check:
// the program must be CLEAN with no diagnostic. A section with a policy block is checked as a project, with the policy
// signed as a person signs it (examples-expected.mjs). SKILL.md stays under 600 words, and every file of the skill ends
// with a glossary and holds no em dash or en dash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ROOT } from './helpers.mjs';
import { checkExample, isPolicy } from './examples-expected.mjs';

// The dashes are built from their code points, so this file holds none itself.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

const SKILL = join(ROOT, 'adapters', 'claude-code', 'skills', 'poly');
const OUT = join(ROOT, '.poly', 'test-skill-syntax');
const read = (name) => readFileSync(join(SKILL, name), 'utf8').replace(/\r\n/g, '\n');

/** The sections of a markdown file with their file blocks: ```poly name.poly or ```json path. */
export function sectionsOf(text) {
  const sections = [];
  let current = null;
  let block = null;
  for (const line of text.split('\n')) {
    if (block) {
      if (line.startsWith('```')) { current.files.push({ kind: block.kind, path: block.path, text: block.lines.join('\n') + '\n' }); block = null; } else block.lines.push(line);
      continue;
    }
    const h = /^## (.+)$/.exec(line);
    if (h) { current = { title: h[1], files: [] }; sections.push(current); continue; }
    const f = /^```(poly|json) (\S+)$/.exec(line);
    if (f && current) block = { kind: f[1], path: f[2], lines: [] };
  }
  assert.equal(block, null, 'a fenced block is not closed');
  return sections;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SECTIONS = sectionsOf(read('syntax.md')).filter((s) => s.files.some((f) => f.kind === 'poly'));

test('syntax.md has one checked example for each construct the skill names', () => {
  const titles = SECTIONS.map((s) => s.title);
  for (const want of ['Machine', 'Decision', 'Effect, retry and idempotency', 'Route and budget', 'Policy', 'Workflow', 'Properties', 'Compose invariant', 'Configuration invariant']) {
    assert.ok(titles.includes(want), `no checked example for ${want}`);
  }
  const props = SECTIONS.find((s) => s.title === 'Properties').files.find((f) => f.kind === 'poly').text;
  for (const kind of [/^\s*invariant /m, /^\s*step property /m, /^\s*reject property /m, /^\s*path property /m, /^\s*never /m, /^\s*liveness /m]) {
    assert.match(props, kind, `the Properties example lacks ${kind}`);
  }
});

for (const section of SECTIONS) {
  test(`syntax.md, ${section.title}: the program is CLEAN with no diagnostic`, async () => {
    const dir = join(OUT, slug(section.title));
    rmSync(dir, { recursive: true, force: true });
    for (const f of section.files) {
      const p = join(dir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.text);
    }
    const programs = section.files.filter((f) => f.kind === 'poly' && !isPolicy(f.path));
    assert.ok(programs.length >= 1, 'a program');
    for (const prog of programs) {
      const file = join(dir, prog.path);
      const r = await checkExample(file, join(dir, '.root'), `skill-syntax-${slug(section.title)}`);
      const diagnostics = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
      assert.deepEqual(diagnostics.map((d) => `${d.code} ${d.message}`), [], `${relative(ROOT, file)}`);
      assert.deepEqual(r.warnings ?? [], [], `${relative(ROOT, file)} warns`);
      assert.equal(r.verdict, 'CLEAN', `${relative(ROOT, file)}`);
    }
  });
}

test('SKILL.md is under 600 words, with the frontmatter and the glossary counted', () => {
  const words = read('SKILL.md').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 600, `${words} words`);
});

test('every file of the skill ends with a glossary and holds no em dash or en dash', () => {
  const files = readdirSync(SKILL).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), ['SKILL.md', 'findings.md', 'host.md', 'patterns.md', 'syntax.md']);
  for (const f of files) {
    const text = read(f);
    assert.ok(!DASHES.test(text), `${f} holds an em dash or an en dash`);
    assert.ok(!/\bhonest/i.test(text), `${f} uses a word the house style forbids`);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.equal(headings.at(-1), 'Glossary', `${f} does not end with a glossary`);
    const tail = text.slice(text.lastIndexOf('## Glossary'));
    assert.ok(/^- \*\*/m.test(tail), `${f}: the glossary has no entries`);
  }
});

test('SKILL.md names each reference file, and each file it names exists', () => {
  const skill = read('SKILL.md');
  for (const f of ['syntax.md', 'findings.md', 'patterns.md', 'host.md']) {
    assert.ok(skill.includes(f), `SKILL.md does not say when to read ${f}`);
    assert.ok(existsSync(join(SKILL, f)), f);
  }
});
