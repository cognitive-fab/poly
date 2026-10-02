// Checks what the O1 session returned (M3-1), before control 4 runs it: one suite per task and version under
// experiments/m3/o1/<task>/v<n>.test.mjs, each loading the implementation only from M3_IMPL, importing only
// Node's built-in modules, and holding at least one test. A suite that fails a check is listed; none is
// repaired, since O1 is the owner's session's output, not ours.
//
// Usage: node experiments/m3/controls/o1-check.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { M3, taskIds, versions } from '../lib/task.mjs';

/** The problems of one suite's text; empty when it passes every check. */
export function suiteProblems(text, file = 'suite.test.mjs') {
  const problems = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) imports.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) imports.push(n.arguments[0].text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') problems.push('uses require');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const m of imports) if (!m.startsWith('node:')) problems.push(`imports ${m}, which is not a Node built-in`);
  if (!/process\.env\.M3_IMPL/.test(text)) problems.push('does not load the implementation from M3_IMPL');
  if (!/\btest\s*\(|\bit\s*\(/.test(text)) problems.push('holds no test');
  return problems;
}

/**
 * The flags of o1/LEAKS.md (M3-1, M3-9), as { task, version, flag }: what is written under a `## T<n>` and
 * `### v<n>` heading. The preamble before the first task is not a flag, and a `none` is no flag. A list item starts a
 * flag, and the lines after it, up to the next item, continue it. A first line without a list marker is a flag too:
 * a flag the session wrote as prose is still a flag, and dropping it would hide it from the owner.
 */
export function leakFlags(text) {
  const out = [];
  let task = null;
  let version = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    const t = /^##\s+(T\d+)\s*$/.exec(l);
    const v = /^###\s+v(\d+)\s*$/.exec(l);
    if (t) { task = t[1]; version = null; continue; }
    if (v) { version = Number(v[1]); continue; }
    if (l.startsWith('#')) { task = null; version = null; continue; }
    if (task === null || version === null || !l || /^[-*]?\s*none\.?$/i.test(l)) continue;
    const last = out[out.length - 1];
    if (/^[-*]\s/.test(l) || !last || last.task !== task || last.version !== version) out.push({ task, version, flag: l });
    else last.flag += ` ${l}`;
  }
  return out;
}

export function checkO1() {
  const report = [];
  for (const id of taskIds()) {
    for (const v of versions(id)) {
      const file = join(M3, 'o1', id, `v${v.n}.test.mjs`);
      if (!existsSync(file)) { report.push({ task: id, version: v.n, problems: ['missing'] }); continue; }
      report.push({ task: id, version: v.n, problems: suiteProblems(readFileSync(file, 'utf8'), file) });
    }
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = checkO1();
  for (const r of report) console.log(`${r.task} v${r.version}: ${r.problems.length ? r.problems.join('; ') : 'ok'}`);
  // The session's flags of briefs that leak a design or a tool's concept: each is for the owner to rule on.
  const leaks = join(M3, 'o1', 'LEAKS.md');
  const flags = existsSync(leaks) ? leakFlags(readFileSync(leaks, 'utf8')) : null;
  if (flags === null) console.log('o1/LEAKS.md: missing');
  else for (const f of flags) console.log(`flagged: ${f.task} v${f.version}: ${f.flag}`);
  process.exitCode = report.every((r) => r.problems.length === 0) && flags !== null ? 0 : 1;
}
