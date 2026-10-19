#!/usr/bin/env node
// The check of the figures of Act 3 (DS3a, DAC12). Every number the script of Act 3 prints is a figure with a tag, and each figure is cited in a committed
// record or produced by the one live command. A figure that cannot be reproduced is a failure, never a warning: the rule is that it is removed from the script.
//
//   node scripts/act3-check.mjs [--no-live]
//
// --no-live does not run the live command; the live figures are then reported as not run (ok: null), counted apart, and never as holding. Exit 0 if no
// figure has ok: false, 1 otherwise.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIGURES = 'docs/demo/act3-figures.json';
const SCRIPT = 'docs/demo/act3-script.md';

/** The output of a live command, run once in the repository (exit status 1 is a verdict, not an error here). */
function runLive(command, root) {
  const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const isSeparator = (line) => /^\|[\s:|-]+\|\s*$/.test(line);

/**
 * DS3a item 4: the rows of the timeline table (lines that start with `|`, other than the header and the separator) that hold a digit outside a time in the
 * first cell, a tag and a code (PL4001, IT4.4) and carry no tag. Returns the offending rows.
 */
function uncitedRows(script) {
  const lines = script.split('\n');
  const out = [];
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('|') || isSeparator(line) || isSeparator(lines[i + 1] ?? '')) continue;
    const cells = line.split('|').slice(1, -1);
    const rest = cells.slice(1).join('|').replace(/\[R\d+\]/g, '').replace(/\b[A-Z]{2,}\d+(?:\.\d+)*\b/g, '');
    if (/\d/.test(rest) && !/\[R\d+\]/.test(line)) out.push(line);
  }
  return out;
}

/**
 * Checks the figures against the script and the records. Returns [{ id, ok, why }] in the order of the figures, then one { id: 'uncited', ok: false, why }
 * for each row of the timeline table that holds a number and no tag. `live` false does not run the live command: those figures are { ok: null }.
 */
export function checkFigures({ root = ROOT, figuresFile = join(root, FIGURES), scriptFile = join(root, SCRIPT), live = true } = {}) {
  const { figures } = JSON.parse(readFileSync(figuresFile, 'utf8'));
  const script = readFileSync(scriptFile, 'utf8');
  const lines = script.split('\n');
  const liveOutput = new Map();
  const results = figures.map((figure) => {
    const tag = `[${figure.id}]`;
    const tagged = lines.filter((l) => l.includes(tag));
    if (tagged.length === 0) return { id: figure.id, ok: false, why: `unused: the tag ${tag} is not in the script` };
    if (!tagged.some((l) => l.includes(figure.text))) return { id: figure.id, ok: false, why: `the text "${figure.text}" is not in a line that carries ${tag}` };
    if (figure.live) {
      if (!live) return { id: figure.id, ok: null, why: 'live check not run' };
      if (!liveOutput.has(figure.live.command)) liveOutput.set(figure.live.command, runLive(figure.live.command, root));
      const out = liveOutput.get(figure.live.command);
      return out.includes(figure.live.quote)
        ? { id: figure.id, ok: true, why: 'the live command prints it' }
        : { id: figure.id, ok: false, why: `the live command does not print "${figure.live.quote}"` };
    }
    if (!figure.sources?.length) return { id: figure.id, ok: false, why: 'no citation' };
    for (const source of figure.sources) {
      const file = join(root, source.file);
      if (!existsSync(file)) return { id: figure.id, ok: false, why: `the cited file is missing: ${source.file}` };
      if (!readFileSync(file, 'utf8').includes(source.quote)) return { id: figure.id, ok: false, why: `the quote is not in ${source.file}: "${source.quote}"` };
    }
    return { id: figure.id, ok: true, why: 'cited and found' };
  });
  for (const row of uncitedRows(script)) results.push({ id: 'uncited', ok: false, why: `a row holds a number and no tag: ${row.trim().slice(0, 80)}` });
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const live = !process.argv.includes('--no-live');
  const results = checkFigures({ live });
  for (const r of results) console.log(`${r.id.padEnd(8)} ${r.ok === true ? 'holds ' : r.ok === null ? 'not run' : 'FAILS '} ${r.why}`);
  const hold = results.filter((r) => r.ok === true).length;
  const notRun = results.filter((r) => r.ok === null).length;
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`${results.length - results.filter((r) => r.id === 'uncited').length} figures: ${hold} hold${notRun ? `, ${notRun} not run` : ''}${failed ? `, ${failed} fail` : ''}`);
  process.exit(failed ? 1 : 0);
}
