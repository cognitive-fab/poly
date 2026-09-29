#!/usr/bin/env node
// `poly`: the M0 command line. One command, `poly check <file.poly>` (PT14),
// with the exit codes of PT12.3.
import { existsSync } from 'node:fs';
import { EXIT_CODES, toJson } from '@poly/core';
import { checkFile } from './pipeline.js';
import { render } from './render.js';

const USAGE = `usage: poly check <file.poly> [--json] [--root <dir>]

  Parses, types and lowers the module; runs strict validate(), translation
  validation (poly-ref), polygraph's model check and poly-ref's deadlock check;
  prints the verdict with its checked instance.

  --json        print the report as JSON (diagnostics in poly.diagnostic/1 form)
  --root <dir>  write .poly/build under <dir> (default: the working directory)

exit codes: 0 CLEAN, 1 FINDINGS, 2 REFUSED / INCONCLUSIVE, 3 nondeterminism, 4 error, 64 usage`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes('--json');
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? args[rootAt + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (rootAt < 0 || i !== rootAt + 1));
  if (positional[0] !== 'check' || positional.length !== 2 || (rootAt >= 0 && !root)) {
    process.stderr.write(USAGE + '\n');
    return EXIT_CODES.USAGE;
  }
  const file = positional[1];
  if (!existsSync(file)) {
    process.stderr.write(`poly: no such file ${file}\n`);
    return EXIT_CODES.USAGE;
  }
  try {
    const report = await checkFile(file, { root });
    // Every diagnostic in the JSON form carries its schema, poly.diagnostic/1 (PT12.1).
    const asJson = { ...report, diagnostics: report.diagnostics.map(toJson), machines: report.machines.map((m) => ({ ...m, diagnostics: m.diagnostics.map(toJson) })) };
    process.stdout.write(json ? JSON.stringify(asJson, null, 2) + '\n' : render(report));
    return report.exit;
  } catch (e) {
    const err = e as Error & { nondeterministic?: boolean };
    process.stderr.write(`poly: ${err.message}\n`);
    return err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
