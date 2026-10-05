// `poly new "<description>"` (PF9.3, S169, M6 step 9): drafts a module with a provider, following polygen's method with
// poly as the target. Each draft is checked by poly check, its diagnostics go back to the provider, and the loop stops at
// CLEAN or after five rounds. The last draft is written with a header saying it is not admitted; admission stays a
// person's step (poly admit), and the check is never relaxed to let a draft through.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { checkFile, CommandUsageError, type Command } from '@poly/check';
import { EXIT_CODES } from '@poly/core';
import { GRAMMAR } from './grammar.js';
import type { Provider } from './providers.js';

export const ROUNDS = 5;
export const HEADER = '// Drafted by poly new: not admitted. Run poly check, read every finding, then a person admits it with poly admit.\n';

export interface DraftResult { file: string; rounds: number; verdict: string; admitted: false; provider: string; diagnostics: { code: string; message: string; line?: number }[] }

/**
 * A model's answer as a module: its first ```poly block, else its first fenced block, else the whole answer. Fences are
 * read line by line, so a closing fence is never taken for an opening one (review B-F5).
 */
export function sourceOf(answer: string): string {
  const lines = answer.replace(/\r\n/g, '\n').split('\n');
  const blocks: { lang: string; body: string[] }[] = [];
  let open: { lang: string; body: string[] } | null = null;
  for (const line of lines) {
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence && !open) { open = { lang: fence[1], body: [] }; continue; }
    if (fence && open) { blocks.push(open); open = null; continue; }
    if (open) open.body.push(line);
  }
  const block = blocks.find((b) => b.lang === 'poly') ?? blocks[0];
  const text = block ? block.body.join('\n') : answer.replace(/\r\n/g, '\n');
  return text.endsWith('\n') ? text : text + '\n';
}

export async function draftModule(opts: { description: string; into: string; provider: Provider; root?: string; rounds?: number }): Promise<DraftResult> {
  const rounds = opts.rounds ?? ROUNDS;
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'poly-new-'));
  let source = '';
  let verdict = 'REFUSED';
  let diagnostics: DraftResult['diagnostics'] = [];
  let n = 0;
  try {
    for (n = 1; n <= rounds; n++) {
      const answer = await opts.provider.draft({ description: opts.description, grammar: GRAMMAR, ...(n > 1 ? { previous: { source, diagnostics } } : {}) });
      source = sourceOf(answer);
      const r = await checkFile(opts.into, { root, text: source });
      verdict = r.verdict;
      diagnostics = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)].map((d) => ({ code: d.code, message: d.message, ...(d.at.line ? { line: d.at.line } : {}) }));
      if (r.error) diagnostics.push({ code: 'ERROR', message: r.error });
      if (verdict === 'CLEAN') break;
    }
  } finally {
    if (!opts.root) rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(dirname(opts.into), { recursive: true });
  writeFileSync(opts.into, HEADER + source);
  return { file: opts.into, rounds: Math.min(n, rounds), verdict, admitted: false, provider: opts.provider.name, diagnostics };
}

/** The `new` command of the agent registry, with the provider its host gives: sampling over MCP, Claude Code on the command line. */
export function newCommand(providerOf: () => Provider): Command {
  return {
    name: 'new', mcp: 'poly_new', lsp: false,
    summary: 'Drafts a module from a description with a model, checks each draft with poly check and feeds the diagnostics back, for at most five rounds. The draft is written, never admitted (PF9.3).',
    input: { type: 'object', properties: { description: { type: 'string', description: 'what the module is for' }, into: { type: 'string', description: 'the .poly file to write the draft to' } }, required: ['description', 'into'] },
    output: { type: 'object', properties: { file: { type: 'string' }, rounds: { type: 'integer' }, verdict: { type: 'string' }, admitted: { type: 'boolean' }, provider: { type: 'string' }, diagnostics: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, line: { type: 'integer' } }, required: ['code', 'message'] } } }, required: ['file', 'rounds', 'verdict', 'admitted', 'provider', 'diagnostics'] },
    async run(input) {
      const description = input.description;
      const into = input.into;
      if (typeof description !== 'string' || !description) throw new CommandUsageError('description is required');
      if (typeof into !== 'string' || !into.endsWith('.poly')) throw new CommandUsageError('into is required: the .poly file to write the draft to');
      // Review B-F2: a module that is not an earlier draft of poly new's is a person's work, and is never overwritten.
      if (existsSync(into) && !readFileSync(into, 'utf8').startsWith(HEADER)) throw new CommandUsageError(`${into} already holds a module that is not a draft of poly new's; give another file`);
      const r = await draftModule({ description, into, provider: providerOf() });
      const exit = r.verdict === 'CLEAN' ? EXIT_CODES.CLEAN : EXIT_CODES.REFUSED;
      return { exit, result: r as unknown as Record<string, unknown>, text: `drafted ${r.file} in ${r.rounds} round${r.rounds === 1 ? '' : 's'} with ${r.provider}: ${r.verdict}, not admitted\n${r.diagnostics.map((d) => `  ${d.code}${d.line ? ` line ${d.line}` : ''}: ${d.message}\n`).join('')}` };
    },
  };
}


