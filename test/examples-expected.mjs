// V10 item 4 (ruled 2026-10-10): every file in examples/ carries its expected verdict on its first line,
//   // expected: CLEAN | FINDING <code> [<code> …] | INCONCLUSIVE <reason>
// and the gate compares each verdict to it, so nobody has to know which files are teaching variants. A reason that
// begins with a code names a code the check must report. Shared by the parallel test and the serial group's.
import { readFileSync } from 'node:fs';

/** The expected verdict a source's first line states, or null when it states none. */
export function expectedOf(file) {
  const first = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
  const m = /^\/\/ expected: (CLEAN|FINDING((?: PL\d{4})+)|INCONCLUSIVE (.+))$/.exec(first);
  if (!m) return null;
  if (m[1] === 'CLEAN') return { verdict: 'CLEAN', codes: [] };
  if (m[2]) return { verdict: 'FINDINGS', codes: m[2].trim().split(' ').sort() };
  const code = /^(PL\d{4})\b/.exec(m[3]);
  return { verdict: 'INCONCLUSIVE', codes: code ? [code[1]] : [], reason: m[3] };
}

/** Why a check report does not match the expected line, or null when it does. */
export function mismatch(expected, report) {
  const codes = [...new Set([...report.diagnostics, ...report.machines.flatMap((m) => m.diagnostics), ...(report.configurations ?? []).flatMap((c) => c.diagnostics)].map((d) => d.code))].sort();
  if (report.verdict !== expected.verdict) return `the verdict is ${report.verdict}, and the file expects ${expected.verdict} (${codes.join(' ') || 'no code'})`;
  if (expected.verdict === 'FINDINGS' && codes.join(' ') !== expected.codes.join(' ')) return `the findings are ${codes.join(' ')}, and the file expects ${expected.codes.join(' ')}`;
  if (expected.verdict === 'INCONCLUSIVE' && expected.codes.some((c) => !codes.includes(c))) return `the codes are ${codes.join(' ')}, and the file expects ${expected.codes.join(' ')}`;
  return null;
}
