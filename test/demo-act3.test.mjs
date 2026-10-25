import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const figuresFile = 'docs/demo/act3-figures.json';
const scriptFile = 'docs/demo/act3-script.md';
const checkModule = 'scripts/act3-check.mjs';
const repo = process.cwd();

const expectedFigures = [
  { id: 'R1', text: '25 episodes', file: 'docs/history/decisions-m7.md', quote: 'it has 25 episodes and 126 steps' },
  { id: 'R2', text: 'one draft instance', file: 'docs/history/decisions-m7.md', quote: 'one consequential effect instance, the draft' },
  { id: 'R3', text: 'proposes nothing', file: 'docs/history/decisions-m7.md', quote: 'with `--all` it returns no candidate' },
  { id: 'R4', text: 'twelve times', files: ['docs/history/decisions-m7.md', 'test/after/ex-inbox-loop.test.mjs'], quotes: ['copied twelve times under fresh episode tokens', 'Array.from({ length: 12 }'] },
  { id: 'R5', text: '37 episodes', file: 'docs/history/decisions-m7.md', quote: '(37 episodes, labelled `synthetic` in the candidates and the certificate)' },
  { id: 'R6', text: '13 of 13 runs', files: ['docs/history/decisions-m7.md', 'test/after/ex-inbox-loop.test.mjs'], quotes: ['(mined, 13 of 13 runs)', '{ holds: 13, of: 13 }'] },
  { id: 'R7', text: 'reaches 2', file: 'docs/history/decisions-m7.md', quote: 'reaches 2, above 1 on this path' },
  { id: 'R8', text: 'ten steps', file: 'docs/history/decisions-m7.md', quote: 'The witness, ten steps on one Todo' },
  { id: 'R9', text: 'IT4.4', file: 'docs/history/decisions-m7.md', quote: 'itself (IT4.4)' },
  { id: 'R10', text: 'attempts 1', file: 'examples/inbox/inbox.poly', quote: 'retry { attempts 1, base 200ms, timeout 45s }' },
  { id: 'R11', text: 'exhausted -> DraftUncertain()', file: 'examples/inbox/inbox.poly', quote: 'exhausted -> DraftUncertain()' },
  { id: 'R12', text: 'draft-created-once', file: 'test/after/ex-inbox-loop.test.mjs', quote: 'invariant draft-created-once: made implies' },
  { id: 'R13', text: 'too strong as written', file: 'test/after/ex-inbox-loop.test.mjs', quote: 'real, and too strong as written' },
  { id: 'R14', text: 'PL4003', command: 'node packages/poly-check/dist/src/cli.js check examples/retry/draft-unguarded.poly', quote: 'PL4003 UNGUARDED_RETRY' },
  { id: 'R15', text: 'executions of the target: 2', command: 'node packages/poly-check/dist/src/cli.js check examples/retry/draft-unguarded.poly', quote: 'executions of the target: 2, idempotency key: unchanged, deduplication declared: none' },
  { id: 'R16', text: 'attempts 5', command: 'node packages/poly-check/dist/src/cli.js check examples/retry/draft-unguarded.poly', quote: 'may be attempted 5 times' },
  { id: 'R17', text: 'Propose, GateAllow, Start (target may execute), HandlerFailed, Start (target may execute), HandlerOk, SettleOk', command: 'node packages/poly-check/dist/src/cli.js check examples/retry/draft-unguarded.poly', quote: 'Propose, GateAllow, Start (target may execute), HandlerFailed, Start (target may execute), HandlerOk, SettleOk' },
];

test('Act 3 demo: figures file', async (t) => {
  await t.test('parses as JSON with v 1', () => {
    assert(existsSync(path.join(repo, figuresFile)), `${figuresFile} does not exist`);
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    assert.equal(data.v, 1, 'figures file version must be 1');
    assert(Array.isArray(data.figures), 'figures must be an array');
  });

  await t.test('contains exactly R1 to R17 each once', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    const ids = data.figures.map(f => f.id);
    const expected = Array.from({ length: 17 }, (_, i) => `R${i + 1}`);
    assert.deepEqual(ids, expected, 'figures must have ids R1 through R17 in order, each exactly once');
  });

  await t.test('each figure text matches DS3a table', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    for (const expected of expectedFigures) {
      const fig = data.figures.find(f => f.id === expected.id);
      assert(fig, `figure ${expected.id} not found`);
      assert.equal(fig.text, expected.text, `R${expected.id} text must be "${expected.text}"`);
    }
  });

  await t.test('R1 to R13 have live false', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    for (let i = 0; i < 13; i++) {
      const fig = data.figures[i];
      assert.equal(fig.id, `R${i + 1}`);
      assert.equal(fig.live, false, `R${i + 1} must have live: false`);
    }
  });

  await t.test('R14 to R17 have live with command and quote', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    for (let i = 13; i < 17; i++) {
      const fig = data.figures[i];
      assert.equal(fig.id, `R${i + 1}`);
      assert(fig.live && typeof fig.live === 'object', `R${i + 1} must have live as an object`);
      assert(fig.live.command, `R${i + 1} live.command must exist`);
      assert(fig.live.quote, `R${i + 1} live.quote must exist`);
    }
  });

  await t.test('sources structure for R1-R13', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    for (let i = 0; i < 13; i++) {
      const fig = data.figures[i];
      assert(Array.isArray(fig.sources), `R${i + 1} sources must be an array`);
      for (const source of fig.sources) {
        assert(source.file, `R${i + 1} source must have file`);
        assert(source.quote, `R${i + 1} source must have quote`);
      }
    }
  });

  await t.test('cited files exist and contain their quotes (R1-R13)', () => {
    const content = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(content);
    for (let i = 0; i < 13; i++) {
      const fig = data.figures[i];
      for (const source of fig.sources) {
        const filePath = path.join(repo, source.file);
        assert(existsSync(filePath), `cited file ${source.file} (for R${i + 1}) does not exist`);
        const fileContent = readFileSync(filePath, 'utf8');
        assert(fileContent.includes(source.quote), `quote "${source.quote}" not found in ${source.file} (for R${i + 1})`);
      }
    }
  });
});

test('Act 3 demo: script file', async (t) => {
  await t.test('file exists and is readable', () => {
    assert(existsSync(path.join(repo, scriptFile)), `${scriptFile} does not exist`);
  });

  await t.test('contains exactly 6 timeline rows with correct times', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const times = ['0:00', '0:10', '0:20', '0:30', '0:45', '0:55'];
    for (const time of times) {
      assert(content.includes(`| ${time}`), `script must contain timeline row with time ${time}`);
    }
    const rows = content.split('\n').filter((line) => /^\| \d+:\d\d /.test(line));
    assert.deepEqual(rows.map((line) => line.split('|')[1].trim()), times, 'the timeline has these six rows, each once, in order');
  });

  await t.test('all R1-R17 used as tags at least once', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    for (let i = 1; i <= 17; i++) {
      const tag = `[R${i}]`;
      assert(content.includes(tag), `tag ${tag} not found in script`);
    }
  });

  await t.test('each figure text appears in a line with its tag', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const lines = content.split('\n');
    for (const expected of expectedFigures) {
      const tag = `[${expected.id}]`;
      const lineWithTag = lines.find(line => line.includes(tag));
      assert(lineWithTag, `no line found with tag ${tag}`);
      assert(lineWithTag.includes(expected.text), `text "${expected.text}" not found in line with tag ${tag}`);
    }
  });

  await t.test('no em dash or en dash', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    assert(!content.includes('\u2014'), 'script must not contain em dash (U+2014)');
    assert(!content.includes('\u2013'), 'script must not contain en dash (U+2013)');
  });

  await t.test('no word of the banned family (case-insensitive)', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const lowerContent = content.toLowerCase();
    // The stem is built in two parts so that this file does not hold the banned word itself (style rule). Any form of it contains the stem.
    const stem = ['hon', 'est'].join('');
    assert(!lowerContent.includes(stem), 'script must not contain the banned stem in any form');
  });

  await t.test('last two level-2 headings are Conclusion and Glossary', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const lines = content.split('\n');
    const h2Lines = lines.filter(line => line.startsWith('## '));
    assert(h2Lines.length >= 2, 'script must have at least 2 level-2 headings');
    const lastTwo = h2Lines.slice(-2);
    assert.equal(lastTwo[0], '## Conclusion', 'second to last heading must be "## Conclusion"');
    assert.equal(lastTwo[1], '## Glossary', 'last heading must be "## Glossary"');
  });

  await t.test('file ends with glossary section', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    assert(content.includes('## Glossary'), 'script must have ## Glossary heading');
    const glossaryIndex = content.lastIndexOf('## Glossary');
    const afterGlossary = content.substring(glossaryIndex);
    const nextHeading = afterGlossary.substring(11).match(/^## /m);
    assert(!nextHeading, 'no level-2 heading should appear after ## Glossary');
  });

  await t.test('rows 0:10 and 0:20 contain word "synthetic"', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const lines = content.split('\n');
    const row010 = lines.find(line => line.includes('| 0:10'));
    const row020 = lines.find(line => line.includes('| 0:20'));
    assert(row010, 'row with 0:10 not found');
    assert(row020, 'row with 0:20 not found');
    assert(row010.includes('synthetic'), 'row 0:10 must contain "synthetic"');
    assert(row020.includes('synthetic'), 'row 0:20 must contain "synthetic"');
  });

  await t.test('script mentions proposes nothing (R3 text)', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    assert(content.includes('proposes nothing'), 'script must contain the text "proposes nothing" (R3)');
  });
});

test('Act 3 demo: no uncited figures', async (t) => {
  await t.test('DS3a item 4: all table rows with digits have tags', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const lines = content.split('\n');
    const tableRows = lines.filter(line => line.startsWith('|'));

    for (const row of tableRows) {
      if (row === tableRows[0] || row === tableRows[1]) {
        continue;
      }

      const firstCell = row.split('|')[1];

      const isTime = /^\s*\d:\d{2}\s*$/.test(firstCell);
      const hasDigitOutsideTime = /\d/.test(row.substring(row.indexOf('|', 1)));

      if (hasDigitOutsideTime) {
        const rowContent = row;
        const hasTag = /\[R\d+\]/.test(rowContent);
        const hasCode = /[A-Z]{2}\d{4,5}|[A-Z]{2}\d\.\d/.test(rowContent);

        assert(hasTag || hasCode, `table row with digit must have either a tag [Rn] or a code: ${row}`);
      }
    }
  });

  await t.test('all figure ids are used in the script', () => {
    const content = readFileSync(path.join(repo, scriptFile), 'utf8');
    const figContent = readFileSync(path.join(repo, figuresFile), 'utf8');
    const data = JSON.parse(figContent);

    for (const fig of data.figures) {
      const tag = `[${fig.id}]`;
      assert(content.includes(tag), `figure ${fig.id} is not used in the script`);
    }
  });
});

test('Act 3 demo: checkFigures function', async (t) => {
  let checkFigures;

  await t.test('setup: import checkFigures', async () => {
    try {
      const checkModulePath = path.resolve(path.join(repo, checkModule));
      const mod = await import(`file://${checkModulePath}`);
      checkFigures = mod.checkFigures || mod.default;
      assert(typeof checkFigures === 'function', 'checkFigures must be a function');
    } catch (e) {
      assert.fail(`cannot import checkFigures from ${checkModule}: ${e.message}`);
    }
  });

  await t.test('with live false: R1-R13 ok true, R14-R17 ok null', async () => {
    if (!checkFigures) assert.fail('checkFigures not available');
    try {
      const result = checkFigures({
        root: repo,
        figuresFile: path.join(repo, figuresFile),
        scriptFile: path.join(repo, scriptFile),
        live: false
      });

      assert(Array.isArray(result), 'result must be an array');
      assert.equal(result.length, 17, 'result must have 17 entries');

      for (let i = 0; i < 13; i++) {
        const entry = result[i];
        assert.equal(entry.id, `R${i + 1}`, `entry ${i} id must be R${i + 1}`);
        assert.equal(entry.ok, true, `R${i + 1} must have ok: true`);
      }

      for (let i = 13; i < 17; i++) {
        const entry = result[i];
        assert.equal(entry.id, `R${i + 1}`, `entry ${i} id must be R${i + 1}`);
        assert.equal(entry.ok, null, `R${i + 1} must have ok: null`);
        assert.equal(entry.why, 'live check not run', `R${i + 1} why must be exactly "live check not run"`);
      }
    } catch (e) {
      assert.fail(`checkFigures with live false failed: ${e.message}`);
    }
  });

  await t.test('with live true: all 17 ok true', async () => {
    if (!checkFigures) assert.fail('checkFigures not available');
    try {
      const result = checkFigures({
        root: repo,
        figuresFile: path.join(repo, figuresFile),
        scriptFile: path.join(repo, scriptFile),
        live: true
      });

      assert(Array.isArray(result), 'result must be an array');
      assert.equal(result.length, 17, 'result must have 17 entries');

      for (let i = 0; i < 17; i++) {
        const entry = result[i];
        assert.equal(entry.id, `R${i + 1}`, `entry ${i} id must be R${i + 1}`);
        assert.equal(entry.ok, true, `R${i + 1} with live true must have ok: true`);
      }
    } catch (e) {
      assert.fail(`checkFigures with live true failed: ${e.message}`);
    }
  });
});

test('Act 3 demo: synthetic test cases', async (t) => {
  let checkFigures;
  let tmpDir;

  await t.test('setup: import and prepare temp dir', async () => {
    try {
      const checkModulePath = path.resolve(path.join(repo, checkModule));
      const mod = await import(`file://${checkModulePath}`);
      checkFigures = mod.checkFigures || mod.default;
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    } catch (e) {
      assert.fail(`setup failed: ${e.message}`);
    }
  });

  const cleanup = () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  await t.test('E1: figure text in tagged line with quote in file returns ok true', () => {
    try {
      const figFile = path.join(tmpDir, 'e1-figures.json');
      const scriptFile = path.join(tmpDir, 'e1-script.md');
      const dataFile = path.join(tmpDir, 'e1-data.txt');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E1',
          text: 'test figure',
          sources: [{ file: 'e1-data.txt', quote: 'found it' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | test figure [E1] | test |\n');
      writeFileSync(dataFile, 'This text has: found it inside.');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].id, 'E1');
      assert.equal(result[0].ok, true);
    } finally {
      cleanup();
    }
  });

  await t.test('E2: missing quote in file returns ok false', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e2-figures.json');
      const scriptFile = path.join(tmpDir, 'e2-script.md');
      const dataFile = path.join(tmpDir, 'e2-data.txt');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E2',
          text: 'test figure',
          sources: [{ file: 'e2-data.txt', quote: 'not found' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | test figure [E2] | test |\n');
      writeFileSync(dataFile, 'This text has no matching quote.');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].id, 'E2');
      assert.equal(result[0].ok, false);
      assert(result[0].why, 'why field must be set when ok is false');
    } finally {
      cleanup();
    }
  });

  await t.test('E3: missing cited file returns ok false', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e3-figures.json');
      const scriptFile = path.join(tmpDir, 'e3-script.md');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E3',
          text: 'test figure',
          sources: [{ file: 'missing-file.txt', quote: 'quote' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | test figure [E3] | test |\n');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].id, 'E3');
      assert.equal(result[0].ok, false);
      assert(result[0].why.includes('missing') || result[0].why.includes('not found'), 'why should mention file issue');
    } finally {
      cleanup();
    }
  });

  await t.test('E4: figure text not in tagged line returns ok false', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e4-figures.json');
      const scriptFile = path.join(tmpDir, 'e4-script.md');
      const dataFile = path.join(tmpDir, 'e4-data.txt');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E4',
          text: 'correct text',
          sources: [{ file: 'e4-data.txt', quote: 'present' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | wrong text [E4] | test |\n');
      writeFileSync(dataFile, 'This has the present quote.');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].ok, false);
    } finally {
      cleanup();
    }
  });

  await t.test('E5: table row with digit and no tag is uncited', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e5-figures.json');
      const scriptFile = path.join(tmpDir, 'e5-script.md');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E5',
          text: 'test',
          sources: [],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | some text with 42 and no tag | test |\n');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      const uncited = result.find(e => e.id === 'uncited');
      assert(uncited, 'uncited entry must be reported');
      assert.equal(uncited.ok, false);
    } finally {
      cleanup();
    }
  });

  await t.test('E6: figure id never used in script returns ok false', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e6-figures.json');
      const scriptFile = path.join(tmpDir, 'e6-script.md');
      const dataFile = path.join(tmpDir, 'e6-data.txt');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E6',
          text: 'unused',
          sources: [{ file: 'e6-data.txt', quote: 'present' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | nothing here | test |\n');
      writeFileSync(dataFile, 'The present quote is here.');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].ok, false);
      assert(result[0].why.includes('unused') || result[0].why.includes('not used'), 'why should mention unused');
    } finally {
      cleanup();
    }
  });

  await t.test('E7: results are in order of figure ids', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e7-figures.json');
      const scriptFile = path.join(tmpDir, 'e7-script.md');
      const dataFile = path.join(tmpDir, 'e7-data.txt');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [
          { id: 'E7A', text: 'alpha', sources: [{ file: 'e7-data.txt', quote: 'a' }], live: false },
          { id: 'E7B', text: 'beta', sources: [{ file: 'e7-data.txt', quote: 'b' }], live: false },
          { id: 'E7C', text: 'gamma', sources: [{ file: 'e7-data.txt', quote: 'c' }], live: false }
        ]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | alpha [E7A] | test |\n| 0:10 | beta [E7B] | test |\n| 0:20 | gamma [E7C] | test |\n');
      writeFileSync(dataFile, 'a b c');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].id, 'E7A');
      assert.equal(result[1].id, 'E7B');
      assert.equal(result[2].id, 'E7C');
    } finally {
      cleanup();
    }
  });

  await t.test('E8: failed figure is a failure, not a warning', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e8-figures.json');
      const scriptFile = path.join(tmpDir, 'e8-script.md');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E8',
          text: 'fail',
          sources: [{ file: 'missing.txt', quote: 'x' }],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | fail [E8] | test |\n');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].ok, false, 'failed figure must have ok: false');
    } finally {
      cleanup();
    }
  });

  await t.test('E9: figure with empty sources array and no live has no citation', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e9-figures.json');
      const scriptFile = path.join(tmpDir, 'e9-script.md');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E9',
          text: 'no citation',
          sources: [],
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | no citation [E9] | test |\n');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].ok, false, 'figure with empty sources must have ok: false');
      assert(result[0].why.includes('no citation'), 'why must contain "no citation"');
    } finally {
      cleanup();
    }
  });

  await t.test('E10: figure with no sources key and no live has no citation', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'act3-test-'));
    try {
      const figFile = path.join(tmpDir, 'e10-figures.json');
      const scriptFile = path.join(tmpDir, 'e10-script.md');

      writeFileSync(figFile, JSON.stringify({
        v: 1,
        figures: [{
          id: 'E10',
          text: 'no sources key',
          live: false
        }]
      }));

      writeFileSync(scriptFile, '# Test\n\n| 0:00 | no sources key [E10] | test |\n');

      const result = checkFigures({
        root: tmpDir,
        figuresFile: figFile,
        scriptFile: scriptFile,
        live: false
      });

      assert.equal(result[0].ok, false, 'figure with no sources key must have ok: false');
      assert(result[0].why.includes('no citation'), 'why must contain "no citation"');
    } finally {
      cleanup();
    }
  });
});

test('Act 3 demo: command line interface', async (t) => {
  await t.test('--no-live exits 0 on real files with correct output', () => {
    try {
      const cmd = `node ${path.join(repo, checkModule)} --no-live`;
      const result = execSync(cmd, { cwd: repo, encoding: 'utf8' });

      assert(result.includes('hold'), 'output must mention figures that hold');
      assert(result.includes('not run'), 'output must mention figures not run');
      assert(result.includes('13'), 'output must mention 13 figures holding');
      assert(result.includes('4'), 'output must mention 4 figures not run');
    } catch (e) {
      assert.fail(`command failed: ${e.message}`);
    }
  });

  await t.test('--no-live outputs one line per figure', () => {
    try {
      const cmd = `node ${path.join(repo, checkModule)} --no-live`;
      const result = execSync(cmd, { cwd: repo, encoding: 'utf8' });
      const lines = result.trim().split('\n').filter(l => l.trim());

      assert(lines.length >= 17, `output must have at least 17 lines (one per figure), got ${lines.length}`);
    } catch (e) {
      assert.fail(`command failed: ${e.message}`);
    }
  });

  await t.test('full command without --no-live on real files exits 0', () => {
    try {
      const cmd = `node ${path.join(repo, checkModule)}`;
      const result = execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
      assert(result, 'command should produce output');
    } catch (e) {
      assert.fail(`command failed: ${e.message}`);
    }
  });
});
