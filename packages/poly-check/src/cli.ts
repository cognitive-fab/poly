#!/usr/bin/env node
// `poly`: the command line (PT14), with the exit codes of PT12.3.
//
//   poly check <file.poly | project dir> [--json] [--root <dir>]
//   poly witness <id> --trace | --test [--root <dir>] [--out <file>]
//   poly fix <id> [--root <dir>]
//   poly admit <project dir>
//   poly journal verify | replay | export --db <store> …
//
// `poly check` writes its report to <root>/.poly/report.json, which `poly witness` and `poly fix` read (S69).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_CODES, ManifestError, loadProject, toJson } from '@poly/core';
import { lintHandlers } from './lint.js';
import { checkFile, checkProject, type CheckReport } from './pipeline.js';
import { render } from './render.js';
import { exportWitness, lookupWitness, WitnessExportError } from './witness.js';
import { applyFixById } from './fix.js';
import { admit, admitWitness, witnessKey, AdmitError } from './admit.js';
import { journalCommand, JournalUsageError } from './journal.js';

const USAGE = `usage: poly check <file.poly | project dir> [--json] [--root <dir>]
       poly witness <id> --trace | --test [--root <dir>] [--out <file>]
       poly fix <id> [--root <dir>]
       poly lint handlers [project dir]
       poly admit <project dir>
       poly admit --witness <file | project dir> --key <private key file> [--root <dir>] [--out <file>]
       poly journal verify --db <store> --trust <keyId>=<public key file> [--run <id>]
       poly journal replay --db <store> --build <dir> --certificate <file> --trust <keyId>=<file> [--run <id>]
       poly journal export --db <store> --run <id>
       poly journal eval --db <store> --decision <d> --candidate <provider module>
       poly journal fit --db <store> --decision <d> --model <id> [--version <n>] [--out <file>]

  check    Parses, types and lowers each module; runs strict validate(), translation
           validation (poly-ref), polygraph's model check and poly-ref's deadlock, liveness,
           effect, composition and configuration checks; prints the verdict with its checked
           instance, and writes the report to <root>/.poly/report.json.
  witness  Writes the witness with that id as {pre, action, data, post} windows (--trace),
           or as a host test that walks it and asserts the violated predicate (--test).
  fix      Applies the fix with that id if its target node still has the digest it was
           computed on; otherwise refuses it with PL0201 STALE_FIX.

  --json        print the report as JSON (diagnostics in poly.diagnostic/1 form)
  --root <dir>  where .poly/ lives (default: the project directory, or the working directory)
  --out <file>  where \`poly witness\` writes (default: .poly/witness/<id prefix>.<ext>)

  admit    Checks the project and, when it is CLEAN, writes .poly/certificate.json, signed
           with the admission key poly.json names by location (keys.admission, S126).

  journal  verify: the chain, signed heads, closure and journal binding of every run (PL9002).
           replay: every run folded again through poly-ref and polygraph (PL9001).
           export: one run's chain, heads and bodies, as JSON.
           eval: recorded questions replayed to a candidate provider; agreement and calibration.
           fit: a calibration map by isotonic regression. Neither writes to any chain.

  lint     Reads the effect handler modules poly.json names and refuses any reach for
           ambient authority (PL6401): fs, net, http, child_process, fetch, process.env.

exit codes: 0 CLEAN, 1 FINDINGS, 2 REFUSED / INCONCLUSIVE / stale fix, 3 nondeterminism, 4 error, 64 usage`;

// Every diagnostic in the JSON form carries its schema, poly.diagnostic/1 (PT12.1).
const asJson = (r: CheckReport) => ({ ...r, diagnostics: r.diagnostics.map(toJson), machines: r.machines.map((m) => ({ ...m, diagnostics: m.diagnostics.map(toJson) })), configurations: (r.configurations ?? []).map((c) => ({ ...c, diagnostics: c.diagnostics.map(toJson) })) });

/** S69: the last report: .poly/report.json under the root. */
function writeReport(root: string, report: unknown): void {
  mkdirSync(join(root, '.poly'), { recursive: true });
  writeFileSync(join(root, '.poly', 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

function readReport(root: string): unknown {
  const path = join(root, '.poly', 'report.json');
  if (!existsSync(path)) throw new UsageError(`no report at ${path}: run poly check first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

class UsageError extends Error {}

function option(args: string[], name: string): string | undefined | null {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const v = args[at + 1];
  return v !== undefined && !v.startsWith('--') ? v : null;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes('--json');
  const root = option(args, '--root');
  const out = option(args, '--out');
  const valued = new Set([args.indexOf('--root') + 1, args.indexOf('--out') + 1, args.indexOf('--key') + 1].filter((i) => i > 0));
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(i));
  const usage = () => { process.stderr.write(USAGE + '\n'); return EXIT_CODES.USAGE; };
  if (root === null || out === null) return usage();
  try {
    if (positional[0] === 'check' && positional.length === 2) {
      const target = positional[1];
      if (!existsSync(target)) { process.stderr.write(`poly: no such file or directory ${target}\n`); return EXIT_CODES.USAGE; }
      if (statSync(target).isDirectory()) {
        const p = await checkProject(target, { root });
        writeReport(root ?? target, { ...p, files: p.files.map(asJson) });
        if (json) process.stdout.write(JSON.stringify({ ...p, files: p.files.map(asJson) }, null, 2) + '\n');
        else {
          for (const r of p.files) process.stdout.write(`── ${r.file}\n${render(r)}`);
          if (p.handlers?.status === 'ran') {
            for (const d of p.handlers.diagnostics) process.stdout.write(`${d.code} ${d.name}  ${d.message}\n`);
            process.stdout.write(`handlers: lint ${p.handlers.diagnostics.length ? 'REFUSED' : 'CLEAN'} over ${p.handlers.files} file${p.handlers.files === 1 ? '' : 's'} (PT6.5)\n`);
          } else if (p.handlers) process.stdout.write(`handlers: lint not run (${p.handlers.reason})\n`);
          process.stdout.write(`project ${p.name}: ${p.verdict} (exit ${p.exit}) over ${p.files.length} module${p.files.length === 1 ? '' : 's'}\n`);
        }
        return p.exit;
      }
      const report = await checkFile(target, { root });
      writeReport(root ?? process.cwd(), asJson(report));
      process.stdout.write(json ? JSON.stringify(asJson(report), null, 2) + '\n' : render(report));
      return report.exit;
    }
    if (positional[0] === 'witness' && positional.length === 2) {
      const trace = args.includes('--trace');
      if (trace === args.includes('--test')) return usage();
      const base = root ?? process.cwd();
      const looked = lookupWitness(readReport(base), positional[1]);
      if (!('found' in looked)) { process.stderr.write(`poly: ${looked.reason}\n`); return EXIT_CODES.USAGE; }
      const written = exportWitness(looked.found, { root: base, kind: trace ? 'trace' : 'test', out: out ?? undefined });
      process.stdout.write(`${written}\n`);
      return 0;
    }
    if (positional[0] === 'lint' && positional[1] === 'handlers' && positional.length <= 3) {
      // S72: the lint alone, over the handlers poly.json names.
      const { handlers } = loadProject(positional[2] ?? process.cwd());
      if (!handlers) { process.stderr.write('poly: poly.json names no handlers (S72)\n'); return EXIT_CODES.USAGE; }
      const ds = lintHandlers(handlers);
      for (const d of ds) process.stdout.write(`${d.code} ${d.name}  ${d.message}\n`);
      process.stdout.write(`handlers: lint ${ds.length ? 'REFUSED' : 'CLEAN'} over ${handlers.length} file${handlers.length === 1 ? '' : 's'} (PT6.5)\n`);
      return ds.length ? EXIT_CODES.REFUSED : EXIT_CODES.CLEAN;
    }
    if (positional[0] === 'journal' && positional.length >= 2) {
      return await journalCommand(positional[1], argv, (s) => process.stdout.write(s));
    }
    if (positional[0] === 'admit' && positional.length === 2 && args.includes('--witness')) {
      // S139: a witness certificate, signed with the test key given by file (never one under version control).
      const keyFile = option(args, '--key');
      if (!keyFile) { process.stderr.write('poly: admit --witness needs --key <private key file>\n'); return EXIT_CODES.USAGE; }
      const target = positional[1];
      const base = root ?? (statSync(target).isDirectory() ? target : dirname(target));
      const r = await admitWitness(target, { root: root ?? undefined, key: witnessKey(keyFile), out: out ?? join(base, '.poly', 'witness.certificate.json') });
      process.stdout.write(`witness certificate for ${r.certificate.subject.project}: ${r.certificate.findings?.length ?? 0} finding(s), ${r.certificate.digest}\n  ${r.certificatePath}\n  the runtime loads it only with allowWitness, never in production (S139)\n`);
      return EXIT_CODES.CLEAN;
    }
    if (positional[0] === 'admit' && positional.length === 2) {
      const r = await admit(positional[1]);
      process.stdout.write(`admitted ${r.certificate.subject.project}: ${r.certificate.buildId}, ${r.certificate.digest}\n  ${r.certificatePath}\n`);
      for (const l of r.certificate.poly.limits) process.stdout.write(`  limit: ${l}\n`);
      return EXIT_CODES.CLEAN;
    }
    if (positional[0] === 'fix' && positional.length === 2) {
      const base = root ?? process.cwd();
      const r = applyFixById(readReport(base), positional[1]);
      if (r.status === 'applied') { process.stdout.write(`applied ${positional[1]} to ${r.file}; run poly check again (PT12.1)\n`); return 0; }
      process.stderr.write(`${r.code ?? 'poly'}: ${r.message}\n`);
      return r.code === 'PL0201' ? EXIT_CODES.REFUSED : EXIT_CODES.USAGE;
    }
    return usage();
  } catch (e) {
    const err = e as Error & { nondeterministic?: boolean };
    process.stderr.write(`poly: ${err.message}\n`);
    if (err instanceof ManifestError || err instanceof UsageError || err instanceof WitnessExportError) return EXIT_CODES.USAGE;
    if (err instanceof AdmitError) return EXIT_CODES.REFUSED;
    if (err instanceof JournalUsageError) return EXIT_CODES.USAGE;
    return err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
