// The providers `poly new` drafts with (S169). No provider spends per-token API money by default, and none reads, logs
// or records an API key or the environment:
//
//   - sampling: the MCP client's own model (MCP sampling), the first provider;
//   - claude-cli: Claude Code run headless under the user's own login, as the M3 runs were, the second;
//   - recorded: drafts given in advance, the only provider any test uses.
//
// An Anthropic API provider may exist behind this interface; none is built, configured or used.
import { spawn } from 'node:child_process';

/** What a provider is asked for: the description, the grammar reference, and the previous round's draft and diagnostics. */
export interface DraftRequest {
  description: string;
  grammar: string;
  previous?: { source: string; diagnostics: { code: string; message: string; line?: number }[] };
}

export interface Provider {
  name: string;
  draft(req: DraftRequest): Promise<string>;
}

/** The prompt every provider sends, from the request: the same words to every model. */
export function promptOf(req: DraftRequest): string {
  const parts = [
    'Write one poly module for this description. Answer with the module only, in a ```poly block.',
    '',
    `Description: ${req.description}`,
    '',
    'The language, in brief:',
    req.grammar,
  ];
  if (req.previous) {
    parts.push('', 'Your previous draft:', '```poly', req.previous.source.trimEnd(), '```', '', 'poly check reported:');
    for (const d of req.previous.diagnostics) parts.push(`- ${d.code}${d.line ? ` at line ${d.line}` : ''}: ${d.message}`);
    parts.push('', 'Fix every diagnostic and answer with the whole module again.');
  }
  return parts.join('\n');
}

/** Drafts given in advance, one per round; it records each request, so a test can read what was asked. */
export function recordedProvider(drafts: string[]): Provider & { requests: DraftRequest[] } {
  const queue = [...drafts];
  const requests: DraftRequest[] = [];
  return {
    name: 'recorded',
    requests,
    async draft(req) {
      requests.push(req);
      const next = queue.shift();
      if (next === undefined) throw new Error('the recorded provider has no draft left');
      return next;
    },
  };
}

/** The MCP client's own model: `sample` sends sampling/createMessage to the client and returns its text. */
export function samplingProvider(sample: (prompt: string) => Promise<string>): Provider {
  return { name: 'sampling', draft: (req) => sample(promptOf(req)) };
}

/** The variables whose presence would make Claude Code bill an API key instead of the user's subscription. */
export const API_KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Claude Code, headless, under the user's own login (S169). It refuses to start while an API key variable is present:
 * a key would move billing to per-token spend. It checks only that the variable is present, as the M3 runner does, and
 * never reads, logs or records its value or the rest of the environment, which the CLI inherits as it is.
 */
export function claudeCliProvider(opts: { bin?: string; keyVariables?: string[] } = {}): Provider {
  const bin = opts.bin ?? 'claude';
  const keyVariables = opts.keyVariables ?? API_KEY_VARIABLES;
  return {
    name: 'claude-cli',
    draft(req) {
      const present = keyVariables.filter((k) => Object.prototype.hasOwnProperty.call(process.env, k));
      if (present.length) return Promise.reject(new Error(`poly new does not start Claude Code while ${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'} set: a key would bill per token instead of your subscription (S169)`));
      return new Promise((resolve, reject) => {
        const child = spawn(bin, ['-p', promptOf(req), '--output-format', 'text'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        child.on('error', (e) => reject(new Error(`${bin} did not start: ${e.message}`)));
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-500)}`))));
      });
    },
  };
}
