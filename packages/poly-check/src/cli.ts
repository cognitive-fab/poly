#!/usr/bin/env node
// `poly`: the command line (PT14), with the exit codes of PT12.3.
//
//   poly check <file.poly | project dir> [--json] [--root <dir>]
//   poly witness <id> --trace | --test [--root <dir>] [--out <file>]
//   poly fix <id> [--root <dir>]
//   poly admit <project dir>
//   poly journal verify | replay | export --db <store> …
//   poly bench gate [--sizes 1,8,64] [--out <file>]
//
// `poly check` writes its report to <root>/.poly/report.json, which `poly witness` and `poly fix` read (S69).
import { EXIT_CODES, ManifestError } from '@poly/core';
import { WitnessExportError } from './witness.js';
import { AdmitError } from './admit.js';
import { RecordUsageError } from './records.js';
import { journalCommand, JournalUsageError } from './journal.js';
import { commandNamed, CommandUsageError } from './commands.js';

const USAGE = `usage: poly check <file.poly | project dir> [--json] [--root <dir>] [--host <tsconfig>]
       poly edit-check <module> --old <text> --new <text> | --text <file text> [--project <dir>] [--apply] [--json]
       poly fmt <file.poly> [--write] [--json]
       poly mcp      (an MCP server over stdio: the registry's commands as tools)
       poly lsp      (the language server over stdio, on both surfaces)
       poly new "<description>" --into <file.poly>   (drafts with the headless provider under your login; never admitted)
       poly install --host <adapter> [--project <dir>]   (prints a host's entries from adapters/<adapter>/install.json)
       poly run --mcp [--project <dir>]   (the workflow tools over stdio, on poly-runtime, from poly.json's run field)
       poly witness <id> --trace | --test [--root <dir>] [--out <file>]
       poly fix <id> [--root <dir>]
       poly lint handlers [project dir]
       poly admit <project dir>
       poly admit --witness <file | project dir> --key <private key file> [--root <dir>] [--out <file>]
       poly approve <intent> --by <keyId> --key <private key file> --db <store> [--out <file>]
       poly accept <witness id> --by <keyId> --key <private key file> [--root <dir>]
       poly anchor keyrings --out <file outside the project> [--production] [--project <dir>]
       poly anchor production on|off [--project <dir>]
       poly sign keyrings --by <keyId> --key <private key file> [--project <dir>]
       poly sign policy <scope> --by <keyId> --key <private key file> [--project <dir>]
       poly journal verify --db <store> --trust <keyId>=<public key file> [--run <id>]
       poly journal replay --db <store> --build <dir> --certificate <file> --trust <keyId>=<file> [--run <id>]
       poly journal export --db <store> --run <id>
       poly bench gate [--sizes 1,8,64] [--out <file>]
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

class UsageError extends Error {}

function option(args: string[], name: string): string | undefined | null {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const v = args[at + 1];
  return v !== undefined && !v.startsWith('--') ? v : null;
}

/**
 * The command line is a projection of the registry (commands.ts, S167): it turns argv into a command's input, runs
 * it, and prints its text, or its JSON with --json. `poly check --json` prints the report itself, as before.
 */
function inputOf(positional: string[], args: string[]): { name: string; input: Record<string, unknown> } | null {
  const root = option(args, '--root') ?? undefined;
  const out = option(args, '--out') ?? undefined;
  const [cmd, a, b] = positional;
  if (cmd === 'check' && positional.length === 2) return { name: 'check', input: { target: a, root, host: option(args, '--host') ?? undefined } };
  // PT28.4, PT10h: an edit is --old and --new, or --text; it is written only with --apply, after the check.
  if (cmd === 'edit-check' && positional.length === 2) return { name: 'edit-check', input: { module: a, old: option(args, '--old') ?? undefined, new: option(args, '--new') ?? undefined, text: option(args, '--text') ?? undefined, project: option(args, '--project') ?? undefined, apply: args.includes('--apply') } };
  if (cmd === 'fmt' && positional.length === 2) return { name: 'fmt', input: { file: a, write: args.includes('--write') } };
  if (cmd === 'witness' && positional.length === 2) {
    const trace = args.includes('--trace');
    if (trace === args.includes('--test')) return null;
    return { name: 'witness', input: { id: a, kind: trace ? 'trace' : 'test', root, out } };
  }
  if (cmd === 'lint' && a === 'handlers' && positional.length <= 3) return { name: 'lint', input: { project: b } };
  if (cmd === 'journal' && positional.length >= 2) return { name: 'journal', input: { sub: a, args: args.slice(args.indexOf(a) + 1) } };
  if ((cmd === 'approve' || cmd === 'accept') && positional.length === 2) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    if (!by || !key) throw new UsageError(`${cmd} needs --by <keyId> and --key <private key file>`);
    if (cmd === 'approve') {
      const db = option(args, '--db');
      if (!db) throw new UsageError('approve needs --db <store>');
      return { name: 'approve', input: { intent: a, by, key, db, out } };
    }
    return { name: 'accept', input: { id: a, by, key, root } };
  }
  // S194: the owner's keyring commands, never served over MCP.
  if (cmd === 'anchor' && a === 'keyrings' && positional.length === 2) {
    const o = option(args, '--out');
    if (!o) throw new UsageError('anchor keyrings needs --out <file outside the project>');
    return { name: 'anchor-keyrings', input: { out: o, production: args.includes('--production'), project: option(args, '--project') ?? undefined } };
  }
  // S210, D9: production is the anchor's, set by the owner.
  if (cmd === 'anchor' && a === 'production' && positional.length === 3 && (b === 'on' || b === 'off')) return { name: 'anchor-production', input: { on: b === 'on', project: option(args, '--project') ?? undefined } };
  if (cmd === 'sign' && a === 'policy' && positional.length === 3) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    if (!by || !key) throw new UsageError('sign policy needs --by <keyId> and --key <private key file>');
    return { name: 'sign-policy', input: { scope: b, by, key, project: option(args, '--project') ?? undefined } };
  }
  if (cmd === 'sign' && a === 'keyrings' && positional.length === 2) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    if (!by || !key) throw new UsageError('sign keyrings needs --by <keyId> and --key <private key file>');
    return { name: 'sign-keyrings', input: { by, key, project: option(args, '--project') ?? undefined } };
  }
  if (cmd === 'admit' && positional.length === 2 && args.includes('--witness')) {
    const key = option(args, '--key');
    if (!key) throw new UsageError('admit --witness needs --key <private key file>');
    return { name: 'admit-witness', input: { target: a, key, root, out } };
  }
  if (cmd === 'admit' && positional.length === 2) return { name: 'admit', input: { project: a } };
  if (cmd === 'bench' && a === 'gate' && positional.length === 2) {
    const sizes = (option(args, '--sizes') ?? '1,8,64').split(',').map(Number);
    // Review B-F6: bad sizes print the usage text, as before the registry.
    if (sizes.some((n) => !Number.isInteger(n) || n < 1)) return null;
    return { name: 'bench', input: { sizes, out } };
  }
  if (cmd === 'fix' && positional.length === 2) return { name: 'fix', input: { id: a, root } };
  if (cmd === 'run' && positional.length === 1) {
    if (!args.includes('--mcp')) throw new UsageError('run needs --mcp: it serves the workflow tools over stdio (S174)');
    return { name: 'run', input: { mcp: true, project: option(args, '--project') ?? undefined } };
  }
  if (cmd === 'install' && positional.length === 1) {
    const host = option(args, '--host');
    if (!host) throw new UsageError('install needs --host <adapter>');
    return { name: 'install', input: { host, project: option(args, '--project') ?? undefined } };
  }
  return null;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes('--json');
  const valued = new Set([args.indexOf('--into') + 1, args.indexOf('--host') + 1, args.indexOf('--project') + 1, args.indexOf('--root') + 1, args.indexOf('--out') + 1, args.indexOf('--key') + 1, args.indexOf('--by') + 1, args.indexOf('--db') + 1, args.indexOf('--sizes') + 1, args.indexOf('--old') + 1, args.indexOf('--new') + 1, args.indexOf('--text') + 1].filter((i) => i > 0));
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(i));
  const usage = () => { process.stderr.write(USAGE + '\n'); return EXIT_CODES.USAGE; };
  if (option(args, '--root') === null || option(args, '--out') === null) return usage();
  try {
    // S167: the MCP server is poly-agent's; it is loaded by name, so poly-check does not depend on it.
    if (positional[0] === 'mcp' && positional.length === 1) {
      const agent = '@poly/agent';
      const { serveMcp } = (await import(agent)) as { serveMcp: () => Promise<void> };
      await serveMcp();
      return EXIT_CODES.CLEAN;
    }
    if (positional[0] === 'lsp' && positional.length === 1) {
      const agent = '@poly/agent';
      const { serveLsp } = (await import(agent)) as { serveLsp: () => Promise<void> };
      await serveLsp();
      return EXIT_CODES.CLEAN;
    }
    // S169: poly new is poly-new's, loaded by name only here: nothing on a check path imports it.
    if (positional[0] === 'new' && positional.length === 2) {
      const into = option(args, '--into');
      if (!into) throw new UsageError('new needs --into <file.poly>');
      const pkg = '@poly/new';
      const { newCommand, claudeCliProvider } = (await import(pkg)) as { newCommand: (p: () => unknown) => { run(i: Record<string, unknown>): Promise<{ exit: number; result: unknown; text: string }> }; claudeCliProvider: () => unknown };
      const o = await newCommand(() => claudeCliProvider()).run({ description: positional[1], into });
      process.stdout.write(json ? JSON.stringify(o.result, null, 2) + '\n' : o.text);
      return o.exit;
    }
    const call = inputOf(positional, args);
    if (!call) return usage();
    // The journal reads its own options from argv, as before.
    if (call.name === 'journal') return await journalCommand(positional[1], argv, (s) => process.stdout.write(s));
    const o = await commandNamed(call.name)!.run(call.input);
    if (json) process.stdout.write(JSON.stringify(call.name === 'check' ? o.result.report : o.result, null, 2) + '\n');
    else if (o.exit !== EXIT_CODES.CLEAN && o.exit !== EXIT_CODES.FINDINGS && call.name === 'fix') process.stderr.write(o.text);
    else process.stdout.write(o.text);
    return o.exit;
  } catch (e) {
    const err = e as Error & { nondeterministic?: boolean };
    process.stderr.write(`poly: ${err.message}\n`);
    if (err instanceof ManifestError || err instanceof UsageError || err instanceof CommandUsageError || err instanceof WitnessExportError || err instanceof RecordUsageError) return EXIT_CODES.USAGE;
    if (err instanceof AdmitError) return EXIT_CODES.REFUSED;
    if (err instanceof JournalUsageError) return EXIT_CODES.USAGE;
    return err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
