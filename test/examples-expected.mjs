// V10 item 4 (ruled 2026-10-10): every file in examples/ carries its expected verdict on its first line,
//   // expected: CLEAN | FINDING <code> [<code> …] | REFUSED <code> [<code> …] | INCONCLUSIVE <reason>
// and the gate compares each verdict to it, so nobody has to know which files are teaching variants. A reason that
// begins with a code names a code the check must report. Shared by the parallel test and the serial group's.
import { readFileSync } from 'node:fs';

/** The expected verdict a source's first line states, or null when it states none. */
export function expectedOf(file) {
  const first = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
  const m = /^\/\/ expected: (CLEAN|FINDING((?: PL\d{4})+)|REFUSED((?: PL\d{4})+)|INCONCLUSIVE (.+))$/.exec(first);
  if (!m) return null;
  if (m[1] === 'CLEAN') return { verdict: 'CLEAN', codes: [] };
  if (m[2]) return { verdict: 'FINDINGS', codes: m[2].trim().split(' ').sort() };
  // A program the type stage refuses (an error such as PL1205, not a finding) has the verdict REFUSED and no witness.
  if (m[3]) return { verdict: 'REFUSED', codes: m[3].trim().split(' ').sort() };
  const code = /^(PL\d{4})\b/.exec(m[4]);
  return { verdict: 'INCONCLUSIVE', codes: code ? [code[1]] : [], reason: m[4] };
}

/** Why a check report does not match the expected line, or null when it does. */
export function mismatch(expected, report) {
  const codes = [...new Set([...report.diagnostics, ...report.machines.flatMap((m) => m.diagnostics), ...(report.configurations ?? []).flatMap((c) => c.diagnostics)].map((d) => d.code))].sort();
  if (report.verdict !== expected.verdict) return `the verdict is ${report.verdict}, and the file expects ${expected.verdict} (${codes.join(' ') || 'no code'})`;
  if ((expected.verdict === 'FINDINGS' || expected.verdict === 'REFUSED') && codes.join(' ') !== expected.codes.join(' ')) return `the findings are ${codes.join(' ')}, and the file expects ${expected.codes.join(' ')}`;
  if (expected.verdict === 'INCONCLUSIVE' && expected.codes.some((c) => !codes.includes(c))) return `the codes are ${codes.join(' ')}, and the file expects ${expected.codes.join(' ')}`;
  return null;
}

// V10 item 4, as clarified on 2026-10-10: a policy file in examples/ is never checked alone. The program and its policy
// are one project, `<name>.poly` with `<name>.policy.poly` beside it, and the expected line lives in the program.
import { cpSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { checkFile, checkProject } from '@poly/check';
import { ROOT, polyFiles } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';

/** Whether a file is a policy, which belongs to its program's project and is never checked alone. */
export const isPolicy = (file) => file.endsWith('.policy.poly');

/** The files of a directory that are checked on their own: every program, and no policy. */
export const exampleFiles = (dir) => polyFiles(dir, { refused: true }).filter((f) => !isPolicy(f));

/** The policy file beside a program, or null. */
export function policyOf(file) {
  const p = join(dirname(file), `${basename(file, '.poly')}.policy.poly`);
  return existsSync(p) ? p : null;
}

/**
 * The check of an example as the gate takes it: the program alone, or, when a policy sits beside it, the project of the
 * two with the policy signed as a person signs it, the program's maps and prices copied beside them. The report has the
 * shape `mismatch` reads, with the policies' diagnostics in `diagnostics`.
 */
export async function checkExample(file, root, name = relative(ROOT, file).replace(/[^a-z0-9]+/gi, '-')) {
  const policy = policyOf(file);
  if (!policy) return checkFile(file, { root });
  const key = makeKey(name);
  const slashed = (f) => relative(ROOT, f).split(sep).join('/');
  const dir = project(name, [slashed(file), slashed(policy)], key, 'test-examples-project');
  for (const d of ['maps', 'prices']) if (existsSync(join(dirname(file), d))) cpSync(join(dirname(file), d), join(dir, 'src', d), { recursive: true });
  await signPolicies(dir);
  const r = await checkProject(dir, { root: dir });
  const files = r.files ?? [];
  return {
    verdict: r.verdict,
    diagnostics: [...(r.diagnostics ?? []), ...files.flatMap((f) => [...f.diagnostics, ...(f.policies ?? []).flatMap((p) => p.diagnostics ?? [])])],
    machines: files.flatMap((f) => f.machines),
    configurations: files.flatMap((f) => f.configurations ?? []),
    policies: files.flatMap((f) => f.policies ?? []),
    warnings: files.flatMap((f) => f.warnings ?? []),
  };
}
