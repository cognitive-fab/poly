// The command registry (PT14, PF9.1, PF9.2, S167, M6 step 5): each command poly has is defined once, with its input
// schema, its output schema and a function from input to a JSON result. The command line, the MCP server and the
// language server are projections of this table: the CLI renders a result as text (or prints its JSON with --json),
// the MCP server returns it as structured content, and the language server returns it from workspace/executeCommand.
// The registry knows no host. Its schemas are published under schemas/ (test/agent-registry.test.mjs keeps them in
// step and validates every command's output against its own).
//
// It lives beside the CLI, in poly-check, and poly-agent re-exports it: the `poly` binary, its tests and the frozen
// M3 runner name the CLI here.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, fold, verdictOf, type Verdict, digest, grantRequestSubject, memoryVerifySubject, forgetSubject, loadProject, readAnchor, revocationSubject, signRecord, toJson, type Certificate } from '@poly/core';
import { format, parse } from '@poly/lang';
import { handlerClosure } from './handlers.js';
import { checkFile, checkProject, type CheckReport } from './pipeline.js';
import { render } from './render.js';
import { exportWitness, lookupWitness } from './witness.js';
import { applyFixById } from './fix.js';
import { admit, admitWitness, personKey, witnessKey } from './admit.js';
import { setProduction, signKeyrings, writeAnchor } from './keyrings.js';
import { signPolicy } from './policy-sign.js';
import { approvalRecord, acceptanceRecord, writeAcceptance } from './records.js';
import { journalCommand } from './journal.js';
import { exportTraces, TraceUsageError } from './traces.js';
import { MineUsageError, mineTraces, pinPolyx } from './mine.js';
import { pinPolyness, proposeWorkflow } from './propose.js';
import { adjudicate } from './adjudicate.js';
import { promote, PromoteUsageError } from './promote.js';
import { benchGate } from './bench.js';
import { checkHost, type HostCheck } from './host.js';
import { editCheck } from './edit-check.js';
import { costCalls, costReport, periodProblem, readPriceTable } from './cost.js';
import { trySession, type TryOp } from './try.js';

/** A JSON Schema, in the subset the published schemas use: type, properties, required, items, enum, description. */
export type Schema = { type?: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; additionalProperties?: boolean | Schema };

/** What a command gives: its exit code (PT12.3), its JSON result, and the text the command line prints. */
export interface Outcome { exit: number; result: Record<string, unknown>; text: string }

export interface Command {
  /** The command as typed, `check` or `journal`. */
  name: string;
  summary: string;
  /** The MCP tool's name, or null when the command is the command line's only (a person's key, PT14). */
  mcp: string | null;
  /** Whether the language server serves it through workspace/executeCommand (S171). */
  lsp: boolean;
  input: Schema;
  output: Schema;
  run(input: Record<string, unknown>): Promise<Outcome>;
}

/** A usage error: the input does not name what the command needs. */
export class CommandUsageError extends Error {}

const str = (description: string): Schema => ({ type: 'string', description });
const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({ type: 'object', properties, required, ...(description ? { description } : {}) });
const DIAGNOSTIC: Schema = obj({ schema: str('poly.diagnostic/1'), code: str('PLxxxx'), name: str('the code\'s name'), severity: str('error, finding, warning or note'), message: str('the diagnostic in words'), at: { type: 'object', description: 'where: module, machine, node, line, col' } }, ['code', 'severity', 'message']);
const FILE_REPORT: Schema = obj({
  file: str('the source file'),
  module: { type: ['string', 'null'], description: 'the module name, or null when it did not parse' },
  moduleDigest: str('the module digest the witnesses and fixes were computed on (PT1.4, S69)'),
  verdict: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'REFUSED', 'UNDERPOWERED', 'INCONCLUSIVE', 'NONDETERMINISM', 'ERROR'] },
  exit: { type: 'integer' },
  diagnostics: { type: 'array', items: DIAGNOSTIC },
  machines: { type: 'array', items: obj({ machine: str('the machine'), stages: { type: 'array', items: obj({ stage: str('the stage'), status: { type: 'string', enum: ['ran', 'not-run'] } }, ['stage', 'status']) }, diagnostics: { type: 'array', items: DIAGNOSTIC } }, ['machine', 'stages', 'diagnostics']) },
}, ['file', 'module', 'verdict', 'exit', 'diagnostics', 'machines'], 'one module\'s check report (PT12.3)');

// Every diagnostic in the JSON form carries its schema, poly.diagnostic/1 (PT12.1).
const asJson = (r: CheckReport) => ({ ...r, diagnostics: r.diagnostics.map(toJson), machines: r.machines.map((m) => ({ ...m, diagnostics: m.diagnostics.map(toJson) })), configurations: (r.configurations ?? []).map((c) => ({ ...c, diagnostics: c.diagnostics.map(toJson) })) });

/** PT28.1d: the host check as JSON, each diagnostic with its schema, and as the text the command line prints. */
const hostJson = (h: HostCheck) => (h.status === 'ran' ? { ...h, diagnostics: h.diagnostics.map(toJson) } : h);
const hostText = (h: HostCheck) => (h.status === 'ran' ? `${h.diagnostics.map((d) => `${d.code} ${d.name}  ${d.message}\n`).join('')}host: ${h.diagnostics.length ? 'FINDINGS' : 'CLEAN'} over ${h.files} file${h.files === 1 ? '' : 's'} (PT28.1d)\n` : `host: not run (${h.reason})\n`);

/** S69: the last report: .poly/report.json under the root. */
function writeReport(root: string, report: unknown): void {
  mkdirSync(join(root, '.poly'), { recursive: true });
  writeFileSync(join(root, '.poly', 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
function readReport(root: string): unknown {
  const path = join(root, '.poly', 'report.json');
  if (!existsSync(path)) throw new CommandUsageError(`no report at ${path}: run poly check first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
const need = (input: Record<string, unknown>, k: string): string => {
  const v = input[k];
  if (typeof v !== 'string' || !v) throw new CommandUsageError(`${k} is required`);
  return v;
};
const opt = (input: Record<string, unknown>, k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);

export const COMMANDS: Command[] = [
  {
    name: 'check', mcp: 'poly_check', lsp: true,
    summary: 'Runs the check pipeline over a module or a project and writes the report to <root>/.poly/report.json.',
    input: obj({ target: str('a .poly, .policy.poly or .ts module, or a project directory'), root: str('where .poly/ lives (default: the project directory, or the working directory)'), host: str('a tsconfig naming host code to compile against the generated declarations (PT28.1d)') }, ['target']),
    output: obj({ report: { type: 'object', description: 'a module\'s report, or a project\'s with its files' }, files: { type: 'array', items: FILE_REPORT, description: 'each module\'s report' }, host: { type: 'object', description: 'the host check of PT28.1d, when host was given: ran with its diagnostics, or not run with its reason' }, verdict: { type: 'string' }, exit: { type: 'integer' } }, ['report', 'files', 'verdict', 'exit']),
    async run(input) {
      const target = need(input, 'target');
      const root = opt(input, 'root');
      const host = opt(input, 'host');
      if (!existsSync(target)) throw new CommandUsageError(`no such file or directory ${target}`);
      if (statSync(target).isDirectory()) {
        const p = await checkProject(target, { root, ...(host ? { host } : {}) });
        const report = { ...p, files: p.files.map(asJson) };
        writeReport(root ?? target, report);
        const lines: string[] = [];
        for (const r of p.files) lines.push(`── ${r.file}\n${render(r)}`);
        if (p.handlers?.status === 'ran') {
          for (const d of p.handlers.diagnostics) lines.push(`${d.code} ${d.name}  ${d.message}\n`);
          lines.push(`handlers: lint ${p.handlers.diagnostics.length ? 'REFUSED' : 'CLEAN'} over ${p.handlers.files} file${p.handlers.files === 1 ? '' : 's'} (PT6.5)\n`);
        } else if (p.handlers) lines.push(`handlers: lint not run (${p.handlers.reason})\n`);
        if (p.host) lines.push(hostText(p.host));
        lines.push(`project ${p.name}: ${p.verdict} (exit ${p.exit}) over ${p.files.length} module${p.files.length === 1 ? '' : 's'}\n`);
        return { exit: p.exit, result: { report, files: report.files, ...(p.host ? { host: hostJson(p.host) } : {}), verdict: p.verdict, exit: p.exit }, text: lines.join('') };
      }
      const r = await checkFile(target, { root });
      const report = asJson(r);
      writeReport(root ?? process.cwd(), report);
      if (!host) return { exit: r.exit, result: { report, files: [report], verdict: r.verdict, exit: r.exit }, text: render(r) };
      // PT28.1d, S312: after the check, which wrote the declarations; an ERROR or a NONDETERMINISM stands.
      const h = await checkHost(host);
      const special = r.verdict === 'ERROR' || r.verdict === 'NONDETERMINISM';
      const verdict = special ? r.verdict : fold([r.verdict as Verdict, h.status === 'ran' ? verdictOf(h.diagnostics) : 'INCONCLUSIVE']);
      const exit = special ? r.exit : EXIT_CODES[verdict as Verdict];
      return { exit, result: { report, files: [report], host: hostJson(h), verdict, exit }, text: `${render(r)}${hostText(h)}verdict with the host check: ${verdict} (exit ${exit})\n` };
    },
  },
  {
    name: 'fmt', mcp: 'poly_fmt', lsp: true,
    summary: 'Formats a standalone module canonically and prints its module digest (PF9.5); with write, rewrites the file.',
    input: obj({ file: str('a .poly or .policy.poly module'), write: { type: 'boolean', description: 'rewrite the file in place' } }, ['file']),
    output: obj({ file: str('the module'), formatted: str('the canonical text'), changed: { type: 'boolean' }, moduleDigest: str('the AST digest, which comments do not change (PT1.4)') }, ['file', 'formatted', 'changed', 'moduleDigest']),
    async run(input) {
      const file = need(input, 'file');
      if (file.endsWith('.ts')) throw new CommandUsageError(`${file} is an embedded module: its text is TypeScript's to format, and poly fmt formats the standalone surface (S168)`);
      if (!existsSync(file)) throw new CommandUsageError(`no such file ${file}`);
      const src = readFileSync(file, 'utf8');
      const parsed = parse(src);
      if (!parsed.module) {
        const d = parsed.diagnostics.map(toJson);
        return { exit: EXIT_CODES.REFUSED, result: { file, formatted: src, changed: false, moduleDigest: '', diagnostics: d }, text: parsed.diagnostics.map((x) => `${x.code} ${x.message}\n`).join('') };
      }
      // Review C-F3: the parser skips a construct of a later milestone (PL0901), which the printed module would lose.
      const skipped = parsed.diagnostics.filter((x) => x.code === 'PL0901');
      if (skipped.length) return { exit: EXIT_CODES.REFUSED, result: { file, formatted: src, changed: false, moduleDigest: '', diagnostics: skipped.map(toJson) }, text: `${skipped.map((x) => `PL0901 ${x.message}\n`).join('')}poly fmt: formatting would delete the text the parser skips; nothing is written\n` };
      const formatted = format(parsed.module, parsed.trivia);
      const changed = formatted !== src;
      if (changed && input.write === true) writeFileSync(file, formatted);
      const moduleDigest = digest(parsed.module);
      return { exit: EXIT_CODES.CLEAN, result: { file, formatted, changed, moduleDigest }, text: input.write === true ? `${changed ? 'formatted' : 'unchanged'} ${file}\n${moduleDigest}\n` : formatted };
    },
  },
  {
    name: 'witness', mcp: 'poly_witness', lsp: true,
    summary: 'Writes the witness with that id as {pre, action, data, post} windows (trace) or as a host test (test) (PT12.4).',
    input: obj({ id: str('the witness id, or at least its first 12 hex digits'), kind: { type: 'string', enum: ['trace', 'test'] }, root: str('where .poly/report.json lives'), out: str('where to write') }, ['id', 'kind']),
    output: obj({ path: str('the file written') }, ['path']),
    async run(input) {
      const id = need(input, 'id');
      const kind = need(input, 'kind');
      if (kind !== 'trace' && kind !== 'test') throw new CommandUsageError('kind is trace or test');
      const base = opt(input, 'root') ?? process.cwd();
      const looked = lookupWitness(readReport(base), id);
      if (!('found' in looked)) throw new CommandUsageError(looked.reason);
      const path = exportWitness(looked.found, { root: base, kind, out: opt(input, 'out') });
      return { exit: EXIT_CODES.CLEAN, result: { path }, text: `${path}\n` };
    },
  },
  {
    name: 'fix', mcp: 'poly_fix', lsp: true,
    summary: 'Applies the fix with that id if its target node still has the digest it was computed on; otherwise refuses it with PL0201 (PT12.1).',
    input: obj({ id: str('the fix id'), root: str('where .poly/report.json lives') }, ['id']),
    output: obj({ status: { type: 'string', enum: ['applied', 'refused'] }, file: str('the module changed'), code: str('PL0201 for a stale fix; PL0901 for a module holding text the parser skips'), message: str('why it was refused') }, ['status']),
    async run(input) {
      const id = need(input, 'id');
      const base = opt(input, 'root') ?? process.cwd();
      const r = applyFixById(readReport(base), id);
      if (r.status === 'applied') return { exit: 0, result: { status: 'applied', file: r.file }, text: `applied ${id} to ${r.file}; run poly check again (PT12.1)\n` };
      return { exit: r.code ? EXIT_CODES.REFUSED : EXIT_CODES.USAGE, result: { status: 'refused', ...(r.code ? { code: r.code } : {}), message: r.message }, text: `${r.code ?? 'poly'}: ${r.message}\n` };
    },
  },
  {
    name: 'edit-check', mcp: 'poly_edit_check', lsp: true,
    summary: 'Checks a module with an edit applied in memory and returns the verdict, each finding with its line and witness, and the path of the full report; with apply, writes the edit after the check unless it is REFUSED (PT28.4, PT10h). Never admits, signs or runs anything.',
    input: obj({ module: str('the module file'), old: str('the exact text to replace, which occurs once'), new: str('the text that replaces it'), text: str('the whole file, in place of old and new'), project: str('the project directory whose poly.json names the program'), apply: { type: 'boolean', description: 'write the edit to the module after the check, unless it is REFUSED, ERROR or NONDETERMINISM' } }, ['module']),
    output: obj({ status: { type: 'string', enum: ['checked', 'refused'] }, module: str('the module'), reason: str('why the edit was refused before any check'), verdict: str('the verdict of the edited module'), exit: { type: 'integer' }, findings: { type: 'array', items: obj({ code: str('PLxxxx'), severity: str('error, finding, inconclusive or warning'), line: { type: ['integer', 'null'] }, col: { type: ['integer', 'null'] }, machine: { type: ['string', 'null'] }, witness: obj({ id: str('the witness id'), length: { type: 'integer' }, actions: { type: 'array', items: { type: 'string' } } }, ['id', 'length', 'actions']) }, ['code', 'severity', 'line', 'col', 'machine']) }, report: str('the full report, read only through this path'), written: { type: 'boolean', description: 'whether the edit was written to the module' } }, ['status', 'module', 'written']),
    async run(input) {
      const r = await editCheck({ module: need(input, 'module'), ...(typeof input.old === 'string' ? { old: input.old } : {}), ...(typeof input.new === 'string' ? { new: input.new } : {}), ...(typeof input.text === 'string' ? { text: input.text } : {}), ...(opt(input, 'project') ? { project: opt(input, 'project') } : {}), apply: input.apply === true });
      if (r.status === 'refused') return { exit: EXIT_CODES.USAGE, result: r as unknown as Record<string, unknown>, text: `edit refused: ${r.reason}; nothing was checked or written\n` };
      const lines = r.findings!.map((f) => `${f.code} ${f.machine ?? ''}${f.line ? ` line ${f.line}` : ''}${f.witness ? ` witness ${f.witness.id.slice(0, 12)} (${f.witness.actions.join(' ')})` : ''}\n`);
      return { exit: r.exit!, result: r as unknown as Record<string, unknown>, text: `${lines.join('')}verdict: ${r.verdict} (exit ${r.exit}); ${r.written ? 'written to' : 'not written to'} ${r.module}\n  full report: ${r.report}\n` };
    },
  },
  {
    name: 'lint', mcp: 'poly_lint', lsp: true,
    summary: 'Reads the handler modules poly.json names and the files they import, and refuses any reach for ambient authority (PL6401, S142).',
    input: obj({ project: str('the project directory (default: the working directory)') }),
    output: obj({ verdict: { type: 'string', enum: ['CLEAN', 'REFUSED'] }, files: { type: 'integer' }, diagnostics: { type: 'array', items: DIAGNOSTIC } }, ['verdict', 'files', 'diagnostics']),
    async run(input) {
      const projectDir = opt(input, 'project') ?? process.cwd();
      const { handlers } = loadProject(projectDir);
      if (!handlers) throw new CommandUsageError('poly.json names no handlers (S72)');
      const closure = handlerClosure(projectDir, handlers);
      const ds = closure.diagnostics;
      const verdict = ds.length ? 'REFUSED' : 'CLEAN';
      return { exit: ds.length ? EXIT_CODES.REFUSED : EXIT_CODES.CLEAN, result: { verdict, files: closure.bytes.size, diagnostics: ds.map(toJson) }, text: `${ds.map((d) => `${d.code} ${d.name}  ${d.message}\n`).join('')}handlers: lint ${verdict} over ${closure.bytes.size} file${closure.bytes.size === 1 ? '' : 's'} (PT6.5, S142)\n` };
    },
  },
  {
    name: 'admit', mcp: 'poly_admit', lsp: false,
    summary: 'Checks the project and, when it is CLEAN (or every finding is accepted), writes and signs .poly/certificate.json with the admission key poly.json names (PT15, S126).',
    input: obj({ project: str('the project directory') }, ['project']),
    output: obj({ certificatePath: str('the certificate'), digest: str('its digest'), buildId: str('its build id'), limits: { type: 'array', items: { type: 'string' } } }, ['certificatePath', 'digest', 'buildId', 'limits']),
    async run(input) {
      const r = await admit(need(input, 'project'));
      const limits = r.certificate.poly.limits;
      return { exit: EXIT_CODES.CLEAN, result: { certificatePath: r.certificatePath, digest: r.certificate.digest, buildId: r.certificate.buildId, limits }, text: `admitted ${r.certificate.subject.project}: ${r.certificate.buildId}, ${r.certificate.digest}\n  ${r.certificatePath}\n${limits.map((l) => `  limit: ${l}\n`).join('')}` };
    },
  },
  {
    name: 'admit-witness', mcp: null, lsp: false,
    summary: 'Writes a witness certificate, signed with a test key given by file, which the runtime loads only with allowWitness (S139).',
    input: obj({ target: str('a module file or a project directory'), key: str('the private key file'), root: str('where .poly/ lives'), out: str('where to write the certificate') }, ['target', 'key']),
    output: obj({ certificatePath: str('the certificate'), digest: str('its digest'), findings: { type: 'integer' } }, ['certificatePath', 'digest', 'findings']),
    async run(input) {
      const target = need(input, 'target');
      const root = opt(input, 'root');
      const base = root ?? (statSync(target).isDirectory() ? target : dirname(target));
      const r = await admitWitness(target, { root, key: witnessKey(need(input, 'key')), out: opt(input, 'out') ?? join(base, '.poly', 'witness.certificate.json') });
      const findings = r.certificate.findings?.length ?? 0;
      return { exit: EXIT_CODES.CLEAN, result: { certificatePath: r.certificatePath, digest: r.certificate.digest, findings }, text: `witness certificate for ${r.certificate.subject.project}: ${findings} finding(s), ${r.certificate.digest}\n  ${r.certificatePath}\n  the runtime loads it only with allowWitness, never in production (S139)\n` };
    },
  },
  {
    name: 'approve', mcp: null, lsp: false,
    summary: 'Signs the record of an intent\'s escalation with a person key given by file, for rt.approve (PT12.5, S150). Never over MCP.',
    input: obj({ intent: str('the escalated intent'), by: str('the key id'), key: str('the private key file'), db: str('the store'), out: str('where to write the record') }, ['intent', 'by', 'key', 'db']),
    output: obj({ record: { type: 'object', description: 'the signed approval record' }, path: str('where it was written, when out was given') }, ['record']),
    async run(input) {
      const record = await approvalRecord(need(input, 'db'), need(input, 'intent'), need(input, 'by'), need(input, 'key'));
      const text = JSON.stringify(record, null, 2) + '\n';
      const out = opt(input, 'out');
      if (out) writeFileSync(out, text);
      return { exit: EXIT_CODES.CLEAN, result: { record, ...(out ? { path: out } : {}) }, text: out ? '' : text };
    },
  },
  {
    name: 'accept', mcp: null, lsp: false,
    summary: 'Records an accepted finding, signed with a person key given by file, in accepted/ (PT12.5, S150). Never over MCP.',
    input: obj({ id: str('the witness id'), by: str('the key id'), key: str('the private key file'), root: str('where .poly/report.json lives') }, ['id', 'by', 'key']),
    output: obj({ path: str('the acceptance written') }, ['path']),
    async run(input) {
      const base = opt(input, 'root') ?? process.cwd();
      const path = writeAcceptance(base, acceptanceRecord(readReport(base), need(input, 'id'), need(input, 'by'), need(input, 'key')));
      return { exit: EXIT_CODES.CLEAN, result: { path }, text: `${path}\n  admission reads it from accepted/ (PT12.5)\n` };
    },
  },
  {
    name: 'anchor-keyrings', mcp: null, lsp: false,
    summary: 'Writes the keyring anchor of the people and agents rings in poly.json, a file outside the project with its id, first rings, head, policy sequences and production flag, and names it in the owner\'s per-user configuration (PT12.5, S194, S210). The owner\'s command; never over MCP.',
    input: obj({ out: str('the anchor file, outside the project'), production: { type: 'boolean', description: 'whether the project is a production project (S210)' }, project: str('the project directory (default: the working directory)') }, ['out']),
    output: obj({ path: str('the anchor written'), digest: str('the digest of the rings'), id: str('the anchor\'s id'), config: str('the per-user configuration that names it') }, ['path', 'digest', 'id', 'config']),
    async run(input) {
      const dir = resolve(opt(input, 'project') ?? process.cwd());
      const r = writeAnchor(dir, loadProject(dir).manifest, need(input, 'out'), input.production === true);
      return { exit: EXIT_CODES.CLEAN, result: r, text: `${r.digest}\n  anchor ${r.id} written to ${r.path}, and named for this project in ${r.config} (S194, S210)\n` };
    },
  },
  {
    name: 'anchor-production', mcp: null, lsp: false,
    summary: 'Sets or clears production on the project\'s keyring anchor, which poly.json can neither set nor clear (PT12.5, S210). The owner\'s command; never over MCP.',
    input: obj({ on: { type: 'boolean', description: 'true for a production project, false otherwise' }, project: str('the project directory (default: the working directory)') }, ['on']),
    output: obj({ path: str('the anchor written'), production: { type: 'boolean', description: 'the flag as written' } }, ['path', 'production']),
    async run(input) {
      const dir = resolve(opt(input, 'project') ?? process.cwd());
      const r = setProduction(dir, loadProject(dir).manifest, input.on === true);
      return { exit: EXIT_CODES.CLEAN, result: r, text: `production ${r.production ? 'on' : 'off'}\n  written to ${r.path} (S210)\n` };
    },
  },
  {
    name: 'sign-keyrings', mcp: null, lsp: false,
    summary: 'Appends the rings in poly.json to keyrings/history.json with a keyring record signed by a person of the last rings (PT12.5, S194). The owner\'s command; never over MCP.',
    input: obj({ by: str('the key id'), key: str('the private key file'), project: str('the project directory (default: the working directory)') }, ['by', 'key']),
    output: obj({ path: str('the history written'), head: str('the digest of the rings signed') }, ['path', 'head']),
    async run(input) {
      const dir = resolve(opt(input, 'project') ?? process.cwd());
      const cert = join(dir, '.poly', 'certificate.json');
      const certified = existsSync(cert) ? (JSON.parse(readFileSync(cert, 'utf8')) as Certificate).poly.keyrings : undefined;
      const r = signKeyrings(dir, loadProject(dir).manifest, need(input, 'by'), personKey(need(input, 'key')), new Date().toISOString(), certified);
      return { exit: EXIT_CODES.CLEAN, result: r, text: `${r.head}\n  appended to ${r.path}; admission checks it against the anchor (S194)\n` };
    },
  },
  {
    name: 'sign-policy', mcp: null, lsp: false,
    summary: 'Signs a policy scope with a person key given by file: checks the module that declares it, and signs its lowered document, its source and the engine pin, in policies/<scope>.sig.json (PT12.5, S194, Q8). The owner\'s command; never over MCP.',
    input: obj({ scope: str('the policy scope'), by: str('the key id'), key: str('the private key file'), project: str('the project directory (default: the working directory)') }, ['scope', 'by', 'key']),
    output: obj({ path: str('the signature written'), subject: str('what was signed') }, ['path', 'subject']),
    async run(input) {
      const dir = resolve(opt(input, 'project') ?? process.cwd());
      const r = await signPolicy(dir, need(input, 'scope'), need(input, 'by'), personKey(need(input, 'key')), new Date().toISOString());
      return { exit: EXIT_CODES.CLEAN, result: r, text: `${r.subject}\n  written to ${r.path}; admission and load verify it (S194)\n` };
    },
  },
  {
    name: 'grant-request', mcp: null, lsp: false,
    summary: 'Asks a holder for a grant of a credential: signs the request with a person key given by file, a record of the kind grant-request, and writes it to the runtime\'s approvals folder, which rt.takeApprovals takes once; the runtime hands the authorization URL to the host to deliver (PT22.3, PT10g, S210). An agent cannot start a grant for a person; never over MCP.',
    input: obj({ credential: str('the credential'), for: str('the holder, a principal; omitted for the service\'s own credential'), by: str('the key id'), key: str('the private key file'), out: str('the request file to write, in the approvals folder') }, ['credential', 'by', 'key', 'out']),
    output: obj({ path: str('where the request was written') }, ['path']),
    async run(input) {
      const out = need(input, 'out');
      const holder = opt(input, 'for') ?? null;
      const credential = need(input, 'credential');
      const record = signRecord({ kind: 'grant-request', subject: grantRequestSubject(credential, holder), by: need(input, 'by'), at: new Date().toISOString() }, personKey(need(input, 'key')));
      writeFileSync(out, JSON.stringify({ kind: 'grant-request', credential, holder, record }, null, 2) + '\n');
      return { exit: EXIT_CODES.CLEAN, result: { path: out }, text: `${out}\n  the runtime takes it from its approvals folder (PT10g)\n` };
    },
  },
  {
    name: 'memory-verify', mcp: null, lsp: false,
    summary: 'Signs the promotion of a memory item to verified with a person key given by file, a record of the kind verify over the item, for rt.verifyMemory (PS17.5, PT10l). Never over MCP.',
    input: obj({ item: str('the memory item'), by: str('the key id'), key: str('the private key file'), out: str('where to write the record'), project: str('the project whose anchor the record is bound to (default: the working directory)') }, ['item', 'by', 'key']),
    output: obj({ record: { type: 'object', description: 'the signed verification' }, path: str('where it was written, when out was given') }, ['record']),
    async run(input) {
      const record = signRecord({ kind: 'verify', subject: memoryVerifySubject(anchorIdOf(opt(input, 'project')), need(input, 'item')), by: need(input, 'by'), at: new Date().toISOString() }, personKey(need(input, 'key')));
      const text = JSON.stringify(record, null, 2) + '\n';
      const out = opt(input, 'out');
      if (out) writeFileSync(out, text);
      return { exit: EXIT_CODES.CLEAN, result: { record, ...(out ? { path: out } : {}) }, text: out ? '' : text };
    },
  },
  {
    name: 'forget', mcp: null, lsp: false,
    summary: 'Signs the forgetting of a subject (a principal) or a whole source with a person key given by file, a record of the kind forget, for rt.forget (PS17.7, PT10l). Never over MCP.',
    input: obj({ subject: str('the principal to forget'), source: str('or the source to forget'), by: str('the key id'), key: str('the private key file'), out: str('where to write the record'), project: str('the project whose anchor the record is bound to (default: the working directory)') }, ['by', 'key']),
    output: obj({ record: { type: 'object', description: 'the signed forget' }, path: str('where it was written, when out was given') }, ['record']),
    async run(input) {
      const subject = opt(input, 'subject');
      const source = opt(input, 'source');
      if ((subject === undefined) === (source === undefined)) throw new CommandUsageError('forget names a subject or a source, one of them');
      const record = signRecord({ kind: 'forget', subject: forgetSubject(anchorIdOf(opt(input, 'project')), subject !== undefined ? { subject } : { source: source! }), by: need(input, 'by'), at: new Date().toISOString() }, personKey(need(input, 'key')));
      const text = JSON.stringify(record, null, 2) + '\n';
      const out = opt(input, 'out');
      if (out) writeFileSync(out, text);
      return { exit: EXIT_CODES.CLEAN, result: { record, ...(out ? { path: out } : {}) }, text: out ? '' : text };
    },
  },
  {
    name: 'grant-revoke', mcp: null, lsp: false,
    summary: 'Signs the revocation of a grant with a person key given by file, a record of the kind revocation over the grant\'s instance id, for rt.takeApprovals or rt.revokeGrant (PS16.4, PT10g). Never over MCP.',
    input: obj({ grant: str('the grant\'s instance id'), credential: str('or the credential, whose one live grant in the store is revoked'), db: str('the store, read without being written, with credential'), by: str('the key id'), key: str('the private key file'), out: str('where to write the record') }, ['by', 'key']),
    output: obj({ record: { type: 'object', description: 'the signed revocation' }, path: str('where it was written, when out was given') }, ['record']),
    async run(input) {
      // PS16.4, PT10g (ruled 2026-10-11): the grant is named by its instance id, or by its credential in a store, which must
      // hold exactly one live grant of it; with a grant for each owner (S461) the ids are printed and nothing is signed.
      const named = opt(input, 'grant');
      const credential = opt(input, 'credential');
      if ((named === undefined) === (credential === undefined)) throw new CommandUsageError('grant-revoke names the grant by --grant <instance id>, or by --credential <c> with --db <store>, one of them');
      let grant = named;
      if (credential !== undefined) {
        const { liveGrants } = await import('@poly/runtime');
        const db = need(input, 'db');
        const live = liveGrants(db, credential);
        if (live.length === 0) throw new CommandUsageError(`credential ${credential} has no live grant in ${db}`);
        if (live.length > 1) throw new CommandUsageError(`credential ${credential} has ${live.length} live grants, one for each holder; name one with --grant:\n${live.map((g) => `  ${g}`).join('\n')}`);
        grant = live[0];
      }
      const record = signRecord({ kind: 'revocation', subject: revocationSubject(grant!), by: need(input, 'by'), at: new Date().toISOString() }, personKey(need(input, 'key')));
      const text = JSON.stringify(record, null, 2) + '\n';
      const out = opt(input, 'out');
      if (out) writeFileSync(out, text);
      return { exit: EXIT_CODES.CLEAN, result: { record, ...(out ? { path: out } : {}) }, text: out ? '' : text };
    },
  },
  {
    name: 'run', mcp: null, lsp: false,
    summary: 'Serves a project\'s workflows over stdio as the six workflow MCP tools, on poly-runtime, each work order through the gate; configured by poly.json\'s run field (S174, S188, S189).',
    input: obj({ mcp: { type: 'boolean', description: 'serve the workflow tools over MCP on stdio (the only mode)' }, project: str('the project directory (default: the working directory)') }, ['mcp']),
    output: obj({ served: { type: 'boolean', description: 'true once the client closed the session' } }, ['served']),
    async run(input) {
      if (input.mcp !== true) throw new CommandUsageError('poly run serves the workflow tools over MCP: pass --mcp (S174)');
      // S167: the server is poly-agent's, loaded by name, so poly-check does not depend on it.
      const agent = '@poly/agent';
      const { serveRun } = (await import(agent)) as { serveRun: (project: string) => Promise<void> };
      await serveRun(opt(input, 'project') ?? process.cwd());
      return { exit: EXIT_CODES.CLEAN, result: { served: true }, text: '' };
    },
  },
  {
    name: 'install', mcp: null, lsp: false,
    summary: 'Prints a host\'s entries for a project from its adapter\'s template (adapters/<host>/install.json): the commands the host launches. It names no host itself (S167).',
    input: obj({ host: str('the adapter\'s directory under adapters/'), project: str('the project directory (default: the working directory)') }, ['host']),
    output: obj({ host: str('the host'), description: str('what the entries are'), files: { type: 'array', items: obj({ path: str('where the host reads the file'), content: str('the file') }, ['path', 'content']) }, notes: { type: 'array', items: { type: 'string' } } }, ['host', 'files', 'notes']),
    async run(input) {
      const host = need(input, 'host');
      if (!/^[a-z0-9-]+$/.test(host)) throw new CommandUsageError(`${host} is not an adapter name`);
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
      const template = join(root, 'adapters', host, 'install.json');
      if (!existsSync(template)) throw new CommandUsageError(`no adapter for ${host} under adapters/`);
      const project = resolve(opt(input, 'project') ?? process.cwd());
      const slash = (p: string) => p.split('\\').join('/');
      const fill = (s: string) => s.split('${PROJECT}').join(slash(project)).split('${POLY_ROOT}').join(slash(root));
      const t = JSON.parse(readFileSync(template, 'utf8')) as { description?: string; waiting?: string; files?: { path: string; json: unknown }[]; notes?: string[] };
      if (t.waiting) throw new CommandUsageError(`${host} is waiting: ${t.waiting}`);
      const files = (t.files ?? []).map((f) => ({ path: fill(f.path), content: fill(JSON.stringify(f.json, null, 2)) + '\n' }));
      const notes = (t.notes ?? []).map(fill);
      return { exit: EXIT_CODES.CLEAN, result: { host, description: t.description ?? '', files, notes }, text: `${files.map((f) => `── ${f.path}\n${f.content}`).join('')}${notes.map((n) => `  ${n}\n`).join('')}` };
    },
  },
  {
    name: 'try', mcp: 'poly_try', lsp: true,
    summary: 'A playground over one machine (PT28.2): its operations (dispatch, state, intents, gate, witness, reset) replayed from the start, each step by the runtime kernel over the lowered module; no handler runs, no model is called, and nothing is admitted, signed or written to a store or a ledger.',
    input: obj({ file: str('the source file'), machine: str('the machine'), ops: { type: 'array', items: { type: 'object', description: '{ op: "dispatch", action, data? } | { op: "state" } | { op: "intents" } | { op: "gate", policy } | { op: "witness", predicate } | { op: "reset" }' }, description: 'the session, in order' }, out: str('where to write the session as a trace of {pre, action, data, post} windows') }, ['file', 'machine', 'ops']),
    output: obj({ machine: str('the machine'), results: { type: 'array', items: { type: 'object' } }, trace: { type: 'array', items: { type: 'object' } }, diagnostics: { type: 'array', items: DIAGNOSTIC } }, ['machine', 'results', 'trace', 'diagnostics']),
    async run(input) {
      const ops = input.ops;
      if (!Array.isArray(ops)) throw new CommandUsageError('ops is a list of operations');
      const r = await trySession({ file: need(input, 'file'), machine: need(input, 'machine'), ops: ops as TryOp[] });
      const out = opt(input, 'out');
      // PT28.2d: a session saved as a trace, the one file poly try writes, where it is asked to.
      if (out) writeFileSync(out, JSON.stringify(r.trace, null, 2) + '\n');
      const lines = r.results.map((x, i) => `${i} ${String(x.op)}${x.op === 'dispatch' ? ` ${String(x.action)}: ${String(x.stepKind)}${x.rejectReason ? ` (${String(x.rejectReason)})` : ''}` : ''} ${JSON.stringify(x.state ?? x.intents ?? x.decisions ?? x.path ?? '')}`);
      for (const d of r.diagnostics) lines.push(`${d.code} ${d.message}`);
      return { exit: r.diagnostics.some((d) => d.severity === 'error') ? EXIT_CODES.REFUSED : EXIT_CODES.CLEAN, result: { ...r, diagnostics: r.diagnostics.map(toJson) } as unknown as Record<string, unknown>, text: lines.join('\n') + '\n' };
    },
  },
  {
    name: 'cost', mcp: 'poly_cost', lsp: false,
    summary: 'Cost per run, per scope and per day, summed from the ledger alone with no provider call; with prices, the calls of that table\'s model priced again under it, by its digest (PT24.4, PS18.6).',
    input: obj({ db: str('the store'), run: str('only this run'), scope: str('only this trust scope'), period: str('only this UTC day, YYYY-MM-DD, or month, YYYY-MM'), prices: str('a price table to price the calls of its model again under') }, ['db']),
    output: obj({ calls: { type: 'integer' }, total: { type: 'object', description: 'micro-units per currency' }, byRun: { type: 'object' }, byScope: { type: 'object' }, byDay: { type: 'object' }, repriced: { type: 'object', description: 'the prices\' digest, the model, the calls priced again and their total' } }, ['calls', 'total', 'byRun', 'byScope', 'byDay']),
    async run(input) {
      // The runtime is loaded only here, as for the journal, so poly check runs without it.
      const { openJournal, verifyRunChain } = await import('@poly/runtime');
      // Review C4, C5 (M11): poly cost writes nothing, so a store that does not exist is refused, never created; and a
      // period that names no month or day is refused.
      const db = need(input, 'db');
      if (!existsSync(db) || !statSync(db).isFile()) throw new CommandUsageError(`no store at ${db}`);
      const period = opt(input, 'period');
      const bad = period === undefined ? null : periodProblem(period);
      if (bad) throw new CommandUsageError(bad);
      const store = openJournal(db);
      try {
        const refused: { run: string; reason: string }[] = [];
        const calls = await costCalls(store, { run: opt(input, 'run'), scope: opt(input, 'scope'), period }, (events) => verifyRunChain(events as never), refused);
        const prices = opt(input, 'prices');
        const report = costReport(calls, prices ? readPriceTable(prices) : undefined, refused);
        const lines = [`${report.calls} call${report.calls === 1 ? '' : 's'}`, ...report.refused.map((x) => `not summed: run ${x.run}, whose chain does not verify (${x.reason})`), ...Object.entries(report.total).map(([c, v]) => `total ${(v / 1_000_000).toFixed(6)} ${c}`), ...(report.repriced ? Object.entries(report.repriced.total).map(([c, v]) => `priced again under ${report.repriced!.prices}: ${(v / 1_000_000).toFixed(6)} ${c} over ${report.repriced!.calls} call(s) of ${report.repriced!.model}`) : [])];
        return { exit: report.refused.length ? EXIT_CODES.REFUSED : EXIT_CODES.CLEAN, result: report as unknown as Record<string, unknown>, text: lines.join('\n') + '\n' };
      } finally { await store.close(); }
    },
  },
  {
    name: 'export', mcp: null, lsp: false,
    summary: 'Writes the trace corpus of the journals of a certified build to a file: values for declared domains, salted tokens for the rest, erased steps left out and counted, no chain written (PF10.1, PS19, PT29). The corpus is private, so never over MCP.',
    input: obj({ sub: { type: 'string', enum: ['traces'] }, db: str('the store'), build: str('the certified build directory'), certificate: str('the certificate'), trust: { type: 'array', items: { type: 'string' }, description: 'keyId=public key file, as journal replay takes them' }, out: str('the corpus file; an existing file is refused'), runs: { type: 'array', items: { type: 'string' }, description: 'only these runs' } }, ['sub', 'db', 'build', 'certificate', 'out']),
    output: obj({ path: str('the corpus written'), header: { type: 'object', description: 'the corpus header: counts of episodes and of what was left out' } }, ['path', 'header']),
    async run(input) {
      if (need(input, 'sub') !== 'traces') throw new CommandUsageError('poly export takes traces');
      const trust = Object.fromEntries((Array.isArray(input.trust) ? (input.trust as unknown[]).map(String) : []).map((t) => {
        const eq = t.indexOf('=');
        if (eq <= 0) throw new CommandUsageError(`--trust takes <keyId>=<public key file>, not ${t}`);
        return [t.slice(0, eq), readFileSync(t.slice(eq + 1), 'utf8')];
      }));
      try {
        const r = await exportTraces({ db: need(input, 'db'), build: need(input, 'build'), certificate: need(input, 'certificate'), trust, out: need(input, 'out'), runs: Array.isArray(input.runs) ? (input.runs as unknown[]).map(String) : undefined });
        const h = r.header;
        return { exit: EXIT_CODES.CLEAN, result: { path: r.path, header: h as unknown as Record<string, unknown> }, text: `${r.path}: ${h.episodes} episode(s); left out: ${h.omitted.erasedSteps} erased step(s), ${h.omitted.erasedRuns} erased run(s); ${h.omitted.gappedRuns} gapped run(s); consequence unknown for ${h.unknown.consequence} effect(s)
` };
      } catch (e) { if (e instanceof TraceUsageError) throw new CommandUsageError(e.message); throw e; }
    },
  },
  {
    name: 'mine', mcp: null, lsp: false,
    summary: 'Runs polyx, a separately installed tool, over a trace corpus and writes the candidate rules it proposes, with their support, counter-evidence and the source that would carry them (PF10.2, PS20, PT30). The corpus is private, so never over MCP.',
    input: obj({ pin: { type: 'boolean', description: 'record the polyx at --polyx as the one this project trusts (S507), and mine nothing' }, repin: { type: 'boolean', description: 'with pin, replace a different pin' }, polyxPin: str('the pin file (default: polyx.pin.json in the project)'), timeoutSeconds: { type: 'integer', description: 'stop polyx after this many seconds (default 600)' }, maxOutput: { type: 'integer', description: 'stop polyx when it has written this many bytes (default 64 MiB)' }, traces: str('the trace corpus (poly export traces)'), project: str('the poly project the corpus came from'), polyx: str('the directory of a polyx checkout'), out: str('the candidates file; an existing file is refused'), synthetic: { type: 'boolean', description: 'the corpus was made for the purpose, and the candidates say so (PS20.5)' }, all: { type: 'boolean', description: 'also the rules polyx suppresses as subsumed' } }, ['project', 'polyx']),
    output: obj({ path: str('the candidates written'), candidates: { type: 'integer' }, promotable: { type: 'integer' }, gappedLeftOut: { type: 'integer' } }, []),
    async run(input) {
      try {
        if (input.pin === true) {
          const p = await pinPolyx({ project: need(input, 'project'), polyx: need(input, 'polyx'), polyxPin: opt(input, 'polyxPin'), repin: input.repin === true });
          return { exit: EXIT_CODES.CLEAN, result: { path: p.path }, text: `${p.path}: polyx ${(p.pin as { version: string }).version} pinned${p.changed ? '' : ' (already)'}\n` };
        }
        const r = await mineTraces({ traces: need(input, 'traces'), project: need(input, 'project'), polyx: need(input, 'polyx'), out: need(input, 'out'), synthetic: input.synthetic === true, all: input.all === true, polyxPin: opt(input, 'polyxPin'), timeoutMs: typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds * 1000 : undefined, maxOutput: typeof input.maxOutput === 'number' ? input.maxOutput : undefined });
        return { exit: EXIT_CODES.CLEAN, result: { ...r }, text: `${r.path}: ${r.candidates} candidate(s), ${r.promotable} promotable; ${r.gappedLeftOut} gapped run(s) left out\n` };
      } catch (e) { if (e instanceof MineUsageError) throw new CommandUsageError(e.message); throw e; }
    },
  },
  {
    name: 'adjudicate', mcp: null, lsp: false,
    summary: 'Signs a person\'s verdict (real, spurious or defer) on one candidate rule with a person key given by file, a record of the kind adjudication (PF9.6, PS20.3, PT30.4). Never over MCP.',
    input: obj({ candidates: str('the candidates file'), candidate: str('the candidate\'s id'), verdict: str('real, spurious or defer'), by: str('the key id'), key: str('the private key file'), project: str('the project whose anchor the record is bound to'), out: str('where to write the adjudication') }, ['candidates', 'candidate', 'verdict', 'by', 'key', 'out']),
    output: obj({ path: str('the adjudication written'), adjudication: { type: 'object', description: 'the poly.adjudication file' } }, ['path', 'adjudication']),
    async run(input) {
      const r = adjudicate({ candidates: need(input, 'candidates'), candidate: need(input, 'candidate'), verdict: need(input, 'verdict'), by: need(input, 'by'), key: need(input, 'key'), project: opt(input, 'project'), out: need(input, 'out') });
      return { exit: EXIT_CODES.CLEAN, result: { path: r.path, adjudication: r.file as unknown as Record<string, unknown> }, text: `${r.path}: ${r.file.verdict} on ${r.file.id}, signed by ${r.file.record.by}\n` };
    },
  },
  {
    name: 'promote', mcp: null, lsp: false,
    summary: 'Adds the rules a person adjudicated real to the project\'s sources, checks the project, and refuses a promotion that makes a mandate undischargeable (PF4.4, PF4.5, PS20.4, PT30.5). Never over MCP.',
    input: obj({ project: str('the project directory'), candidates: str('the candidates file'), adjudications: { type: 'array', items: { type: 'string' }, description: 'the adjudication files, in the order to promote' }, scope: str('the policy scope that receives a policy rule'), refine: str('a file with the person\'s own text, promoted in place of the candidate\'s (PS20.4)'), reason: str('why the refined text differs from the candidate; required with refine') }, ['project', 'candidates', 'adjudications']),
    output: obj({ promoted: { type: 'array', items: { type: 'object' } } }, ['promoted']),
    async run(input) {
      const adjudications = Array.isArray(input.adjudications) ? (input.adjudications as unknown[]).map(String) : [];
      if (!adjudications.length) throw new CommandUsageError('promote needs at least one --adjudication <file>');
      let r;
      try { r = await promote({ project: need(input, 'project'), candidates: need(input, 'candidates'), adjudications, scope: opt(input, 'scope'), refine: opt(input, 'refine'), reason: opt(input, 'reason') }); } catch (e) { if (e instanceof PromoteUsageError) throw new CommandUsageError(e.message); throw e; }
      return { exit: r.exit, result: { promoted: r.promoted as unknown as Record<string, unknown>[] }, text: r.lines.join('\n') + '\n' };
    },
  },
  {
    name: 'propose', mcp: null, lsp: false,
    summary: 'Runs polyness, a separately installed tool, over the transcripts of repeated work and writes a proposed workflow for one step: poly source with its mined rules as path properties, and the evidence for each (PF10.3, PS21, PT31). The transcripts are private, so never over MCP.',
    input: obj({ pin: { type: 'boolean', description: 'record the polyness at --polyness as the one this person trusts (PT31.3), and propose nothing' }, repin: { type: 'boolean', description: 'with pin, replace a different pin' }, polyness: str('the directory of a polyness checkout'), polynessPin: str('the pin file (default: polyness.pin.json beside --out)'), step: str('the step to propose a workflow for: one to four words'), transcripts: str('a folder of .jsonl transcripts of repeated work'), runs: str('a store, in place of transcripts: its work orders are exported (PS19) and converted (PT31.10)'), build: str('with runs, the certified build directory'), certificate: str('with runs, the certificate'), trust: { type: 'array', items: { type: 'string' }, description: 'with runs, keyId=public key file, as export traces takes them' }, out: str('the proposal folder; an existing one is refused'), synthetic: { type: 'boolean', description: 'the transcripts were made for the purpose, and the evidence says so (PS20.5)' }, timeoutSeconds: { type: 'integer', description: 'stop polyness after this many seconds (default 600)' }, maxOutput: { type: 'integer', description: 'stop polyness when it has written this many bytes (default 64 MiB)' } }, ['polyness']),
    output: obj({ out: str('the proposal folder'), name: str('the step as a name'), steps: { type: 'array', items: { type: 'string' } }, rules: { type: 'integer' }, notTranslatable: { type: 'integer' } }, []),
    async run(input) {
      try {
        if (input.pin === true) {
          const p = await pinPolyness({ polyness: need(input, 'polyness'), polynessPin: opt(input, 'polynessPin'), repin: input.repin === true });
          return { exit: EXIT_CODES.CLEAN, result: { path: p.path }, text: `${p.path}: polyness ${p.pin.version} pinned${p.changed ? '' : ' (already)'}
` };
        }
        const trust = Object.fromEntries((Array.isArray(input.trust) ? (input.trust as unknown[]).map(String) : []).map((t) => {
          const eq = t.indexOf('=');
          if (eq <= 0) throw new CommandUsageError(`--trust takes <keyId>=<public key file>, not ${t}`);
          return [t.slice(0, eq), readFileSync(t.slice(eq + 1), 'utf8')];
        }));
        const runs = opt(input, 'runs') ? { db: opt(input, 'runs')!, build: opt(input, 'build') ?? '', certificate: opt(input, 'certificate') ?? '', trust } : undefined;
        const r = await proposeWorkflow({ polyness: need(input, 'polyness'), step: need(input, 'step'), transcripts: opt(input, 'transcripts'), runs, out: need(input, 'out'), polynessPin: opt(input, 'polynessPin'), synthetic: input.synthetic === true, timeoutMs: typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds * 1000 : undefined, maxOutput: typeof input.maxOutput === 'number' ? input.maxOutput : undefined });
        return { exit: EXIT_CODES.CLEAN, result: { ...r }, text: `${r.out}: ${r.name}, ${r.steps.length} step(s), ${r.rules} rule(s) proposed, ${r.notTranslatable} not translatable
` };
      } catch (e) { if (e instanceof MineUsageError) throw new CommandUsageError(e.message); throw e; }
    },
  },
  {
    name: 'journal', mcp: 'poly_journal', lsp: false,
    summary: 'Ledger verification, replay, export, evaluation and fitting (PF8.6, PD3.3): its arguments are those of the command line.',
    input: obj({ sub: { type: 'string', enum: ['verify', 'replay', 'export', 'eval', 'fit'] }, args: { type: 'array', items: { type: 'string' }, description: 'the options, as on the command line (--db, --run, --trust …)' } }, ['sub']),
    output: obj({ exit: { type: 'integer' }, output: str('what the subcommand printed') }, ['exit', 'output']),
    async run(input) {
      const sub = need(input, 'sub');
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
      let output = '';
      const exit = await journalCommand(sub, ['journal', sub, ...args], (s) => { output += s; });
      return { exit, result: { exit, output }, text: output };
    },
  },
  {
    name: 'bench', mcp: null, lsp: false,
    summary: 'Measures the gate (AC4, PT9.6) over AC4\'s program in this checkout: latency and throughput, with no pass threshold.',
    input: obj({ sizes: { type: 'array', items: { type: 'integer' } }, out: str('where to write the measurement') }),
    output: obj({ bench: { type: 'object', description: 'the measurement, as docs/m5/gate-bench.json holds it' } }, ['bench']),
    async run(input) {
      const sizes = Array.isArray(input.sizes) ? (input.sizes as unknown[]).map(Number) : [1, 8, 64];
      if (sizes.some((n) => !Number.isInteger(n) || n < 1)) throw new CommandUsageError('sizes are positive integers');
      const { REPO_ROOT } = await import('@poly/runtime');
      const r = await benchGate({ repo: REPO_ROOT, sizes, out: opt(input, 'out') });
      const line = (t: { instances: number; perSecond: number; allowed: number; effects: number }) => `${t.instances}: ${t.perSecond}/s (${t.allowed}/${t.effects} allowed)`;
      const lines = [`gate bench on ${r.machine.cpu}, Node ${r.node}\n`];
      if ('notRun' in r.latencyMs) lines.push(`  latency: not run (${r.latencyMs.notRun})\n`);
      else for (const [k, p] of Object.entries(r.latencyMs)) lines.push(`  latency ${k}: p50 ${p.p50} ms, p99 ${p.p99} ms over ${p.n}\n`);
      lines.push(`  throughput runtime (no policy): ${r.throughput.runtime.map(line).join(', ')}\n`);
      const s = r.throughput.session;
      lines.push(`  throughput session ${r.program.session}: ${'notRun' in s ? `not run (${s.notRun})` : s.map(line).join(', ')}\n`);
      if (opt(input, 'out')) lines.push(`  ${opt(input, 'out')}\n`);
      return { exit: EXIT_CODES.CLEAN, result: { bench: r as unknown as Record<string, unknown> }, text: lines.join('') };
    },
  },
];

/**
 * PT14's commands that poly does not have yet, each with the milestone or step that builds it (`new` is poly-new's, the
 * only package that may call a model, and poly-agent adds it to the agent's commands): the registry lists
 * them so that a command is either served or said to be missing, never silently absent.
 */
export const NOT_BUILT: { name: string; mcp: string; when: string }[] = [
  { name: 'explain', mcp: 'poly_explain', when: 'not scheduled: PT14 names it, and no milestone builds it yet' },
  { name: 'grade', mcp: 'poly_grade', when: 'not scheduled: polynv adequacy (PF7.7)' },
  { name: 'deploy', mcp: 'poly_deploy', when: 'not scheduled: the version gate at load (PF8.7)' },
  { name: 'dispatch', mcp: 'poly_dispatch', when: 'not scheduled: the development runtime' },
];

export const commandNamed = (name: string): Command | undefined => COMMANDS.find((c) => c.name === name);

/** S321: the id of the anchor a project's records are bound to; a project with none cannot sign one. */
function anchorIdOf(project: string | undefined): string {
  const dir = project ?? process.cwd();
  const a = readAnchor(dir, loadProject(dir).manifest.name);
  if (!a) throw new CommandUsageError(`${dir} has no keyring anchor, so a record cannot be bound to it (S321): anchor it with poly anchor keyrings`);
  return a.anchor.id;
}
