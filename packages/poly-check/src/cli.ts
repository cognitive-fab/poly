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
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
       poly memory-verify --item <id> --by <keyId> --key <private key file> [--out <file>] [--project <dir>]
       poly forget --subject <principal> | --source <source> --by <keyId> --key <private key file> [--out <file>] [--project <dir>]
       poly grant-request --credential <c> [--for <holder>] --by <keyId> --key <private key file> --out <file>   (a request for the runtime's approvals folder)
       poly grant-revoke --grant <instance id> | --credential <c> --db <store> --by <keyId> --key <private key file> [--out <file>]
       poly journal verify --db <store> --trust <keyId>=<public key file> [--run <id>]
       poly journal replay --db <store> --build <dir> --certificate <file> --trust <keyId>=<file> [--run <id>]
       poly journal export --db <store> --run <id>
       poly bench gate [--sizes 1,8,64] [--out <file>]
       poly journal eval --db <store> --decision <d> --candidate <provider module>
       poly journal fit --db <store> --decision <d> --model <id> [--version <n>] [--out <file>]
       poly try <file> --machine <M> --ops <file.json> [--out <trace.json>]   (a playground: nothing is admitted, run or written)
       poly cost --db <store> [--run <id>] [--scope <module>] [--period YYYY-MM-DD | YYYY-MM] [--prices <file>]

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

  export   traces: a certified build's journals as a trace corpus file (PF10.1, PT29): values for declared
           domains, salted tokens for the rest, erased steps left out and counted. Never over MCP.

  mine     over a trace corpus: runs polyx (a separate tool, by path) and writes candidate rules (PT30). Never over MCP.
  adjudicate  signs a person's verdict (real, spurious, defer) on one candidate rule. Never over MCP.
  promote  adds the rules adjudicated real to the sources, checks them, refuses PL6501. Never over MCP.

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
  // PT28.2: poly try <file> --machine M --ops <ops.json> [--out <trace.json>].
  if (cmd === 'try' && positional.length === 2) {
    const machine = option(args, '--machine');
    const opsFile = option(args, '--ops');
    if (!machine || !opsFile) throw new UsageError('try needs --machine <M> and --ops <file of operations>');
    return { name: 'try', input: { file: a, machine, ops: JSON.parse(readFileSync(opsFile, 'utf8')), out } };
  }
  // PT24.4: poly cost --db <store> [--run r] [--scope s] [--period p] [--prices file].
  if (cmd === 'cost' && positional.length === 1) {
    const db = option(args, '--db');
    if (!db) throw new UsageError('cost needs --db <store>');
    return { name: 'cost', input: { db, ...Object.fromEntries(['run', 'scope', 'period', 'prices'].flatMap((k) => { const v = option(args, `--${k}`); return v ? [[k, v]] : []; })) } };
  }
  // PT29.1: poly export traces --db --build --certificate --trust k=f … --out <file> [--run id …].
  if (cmd === 'export' && a === 'traces' && positional.length === 2) {
    const all = (name: string) => args.flatMap((x, i) => (x === name && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));
    const need = (name: string) => option(args, name) ?? (() => { throw new UsageError(`export traces needs ${name} <value>`); })();
    return { name: 'export', input: { sub: 'traces', db: need('--db'), build: need('--build'), certificate: need('--certificate'), out: need('--out'), trust: all('--trust'), runs: all('--run') } };
  }
  // PT30: mine, adjudicate and promote.
  {
    const all = (name: string) => args.flatMap((x, i) => (x === name && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));
    const need = (name: string, what: string) => option(args, name) ?? (() => { throw new UsageError(`${cmd} needs ${name} <${what}>`); })();
    if (cmd === 'mine' && positional.length === 1 && (args.includes('--pin-polyx') || args.includes('--repin-polyx'))) return { name: 'mine', input: { pin: true, repin: args.includes('--repin-polyx'), project: need('--project', 'dir'), polyx: need('--polyx', 'dir'), polyxPin: option(args, '--polyx-pin') ?? undefined } };
    if (cmd === 'mine' && positional.length === 1) return { name: 'mine', input: { traces: need('--traces', 'corpus'), project: need('--project', 'dir'), polyx: need('--polyx', 'dir'), out: need('--out', 'file'), synthetic: args.includes('--synthetic'), all: args.includes('--all'), polyxPin: option(args, '--polyx-pin') ?? undefined, ...(option(args, '--timeout') ? { timeoutSeconds: Number(option(args, '--timeout')) } : {}), ...(option(args, '--max-output') ? { maxOutput: Number(option(args, '--max-output')) } : {}) } };
    if (cmd === 'adjudicate' && positional.length === 2) return { name: 'adjudicate', input: { candidates: a, candidate: need('--candidate', 'id'), verdict: need('--verdict', 'real|spurious|defer'), by: need('--by', 'keyId'), key: need('--key', 'private key file'), out: need('--out', 'file'), project: option(args, '--project') ?? undefined } };
    if (cmd === 'promote' && positional.length === 2) return { name: 'promote', input: { project: a, candidates: need('--candidates', 'file'), adjudications: all('--adjudication'), scope: option(args, '--scope') ?? undefined } };
  }
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
  // PT10l: a person's verification of a memory item, and a forget of a subject or a source, each a signed record.
  if (cmd === 'memory-verify' && positional.length === 1) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    const item = option(args, '--item');
    if (!by || !key || !item) throw new UsageError('memory-verify needs --item <id>, --by <keyId> and --key <private key file>');
    return { name: 'memory-verify', input: { item, by, key, out, project: option(args, '--project') ?? undefined } };
  }
  // PS16.4, PT10g (ruled 2026-10-11): a grant request and a revocation, each a signed record for the runtime's approvals folder.
  if (cmd === 'grant-request' && positional.length === 1) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    const credential = option(args, '--credential');
    if (!by || !key || !credential || !out) throw new UsageError('grant-request needs --credential <c>, --by <keyId>, --key <private key file> and --out <file>');
    return { name: 'grant-request', input: { credential, for: option(args, '--for') ?? undefined, by, key, out } };
  }
  if (cmd === 'grant-revoke' && positional.length === 1) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    const grant = option(args, '--grant') ?? undefined;
    const credential = option(args, '--credential') ?? undefined;
    const db = option(args, '--db') ?? undefined;
    if (!by || !key || (grant === undefined) === (credential === undefined) || (credential !== undefined && db === undefined)) throw new UsageError('grant-revoke needs --by <keyId>, --key <private key file>, and --grant <instance id> or --credential <c> with --db <store>');
    return { name: 'grant-revoke', input: { grant, credential, db, by, key, out } };
  }
  if (cmd === 'forget' && positional.length === 1) {
    const by = option(args, '--by');
    const key = option(args, '--key');
    const subject = option(args, '--subject') ?? undefined;
    const source = option(args, '--source') ?? undefined;
    if (!by || !key || (subject === undefined) === (source === undefined)) throw new UsageError('forget needs --subject <principal> or --source <source>, --by <keyId> and --key <private key file>');
    return { name: 'forget', input: { subject, source, by, key, out, project: option(args, '--project') ?? undefined } };
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
  const valued = new Set([args.indexOf('--into') + 1, args.indexOf('--host') + 1, args.indexOf('--project') + 1, args.indexOf('--root') + 1, args.indexOf('--out') + 1, args.indexOf('--key') + 1, args.indexOf('--by') + 1, args.indexOf('--db') + 1, args.indexOf('--sizes') + 1, args.indexOf('--old') + 1, args.indexOf('--new') + 1, args.indexOf('--text') + 1, args.indexOf('--item') + 1, args.indexOf('--subject') + 1, args.indexOf('--source') + 1, args.indexOf('--run') + 1, args.indexOf('--scope') + 1, args.indexOf('--period') + 1, args.indexOf('--prices') + 1, args.indexOf('--machine') + 1, args.indexOf('--ops') + 1, args.indexOf('--credential') + 1, args.indexOf('--for') + 1, args.indexOf('--grant') + 1].filter((i) => i > 0));
  // PT29.1: options that repeat or are new with export traces, whose values are no positional argument.
  args.forEach((x, i) => { if (['--build', '--certificate', '--trust', '--run', '--traces', '--polyx', '--candidates', '--candidate', '--verdict', '--adjudication', '--polyx-pin', '--timeout', '--max-output'].includes(x)) valued.add(i + 1); });
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

// PT14 (ruled 2026-10-11): the command runs only when this file is the process's entry point, so importing it, as a host or
// a test does, starts nothing and sets no exit code. Both paths are real paths, so a link to the file is the file.
const isEntry = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isEntry()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
