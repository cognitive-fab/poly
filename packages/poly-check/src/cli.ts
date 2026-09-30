#!/usr/bin/env node
// `poly`: the command line. One command, `poly check <file.poly | project dir>`
// (PT14), with the exit codes of PT12.3.
import { existsSync, statSync } from 'node:fs';
import { EXIT_CODES, ManifestError, toJson } from '@poly/core';
import { checkFile, checkProject, type CheckReport } from './pipeline.js';
import { render } from './render.js';

const USAGE = `usage: poly check <file.poly | project dir> [--json] [--root <dir>]

  Parses, types and lowers each module; runs strict validate(), translation
  validation (poly-ref), polygraph's model check and poly-ref's deadlock check;
  prints the verdict with its checked instance. A project directory is read
  through its poly.json (PT1.2): every module it names is checked.

  --json        print the report as JSON (diagnostics in poly.diagnostic/1 form)
  --root <dir>  write .poly/build under <dir> (default: the project directory,
                or the working directory for a single file)

exit codes: 0 CLEAN, 1 FINDINGS, 2 REFUSED / INCONCLUSIVE, 3 nondeterminism, 4 error, 64 usage`;

// Every diagnostic in the JSON form carries its schema, poly.diagnostic/1 (PT12.1).
const asJson = (r: CheckReport) => ({ ...r, diagnostics: r.diagnostics.map(toJson), machines: r.machines.map((m) => ({ ...m, diagnostics: m.diagnostics.map(toJson) })), configurations: (r.configurations ?? []).map((c) => ({ ...c, diagnostics: c.diagnostics.map(toJson) })) });

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes('--json');
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 && args[rootAt + 1] !== undefined && !args[rootAt + 1].startsWith('--') ? args[rootAt + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (rootAt < 0 || i !== rootAt + 1));
  if (positional[0] !== 'check' || positional.length !== 2 || (rootAt >= 0 && !root)) {
    process.stderr.write(USAGE + '\n');
    return EXIT_CODES.USAGE;
  }
  const target = positional[1];
  if (!existsSync(target)) {
    process.stderr.write(`poly: no such file or directory ${target}\n`);
    return EXIT_CODES.USAGE;
  }
  try {
    if (statSync(target).isDirectory()) {
      const p = await checkProject(target, { root });
      if (json) process.stdout.write(JSON.stringify({ ...p, files: p.files.map(asJson) }, null, 2) + '\n');
      else {
        for (const r of p.files) process.stdout.write(`── ${r.file}\n${render(r)}`);
        process.stdout.write(`project ${p.name}: ${p.verdict} (exit ${p.exit}) over ${p.files.length} module${p.files.length === 1 ? '' : 's'}\n`);
      }
      return p.exit;
    }
    const report = await checkFile(target, { root });
    process.stdout.write(json ? JSON.stringify(asJson(report), null, 2) + '\n' : render(report));
    return report.exit;
  } catch (e) {
    const err = e as Error & { nondeterministic?: boolean };
    process.stderr.write(`poly: ${err.message}\n`);
    if (err instanceof ManifestError) return EXIT_CODES.USAGE;
    return err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
