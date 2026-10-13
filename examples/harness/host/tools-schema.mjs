// plan-e3.md E3.9, HF2.1, HF2.2, HF2.9: the tools the live agent is offered, and the reading of its answer. The model answers with
// tool_use blocks; the harness's machines read the turn's calls as one JSON list (the form the classifier and the recordings
// use): [{ tool, ...arguments }, ...]. This file is the one place where the two meet, and it holds the two facts the host gives
// the machines from the calls: whether the turn is the agent's done (Go's done) and the list the classifier reads.
//
// The fused action (Action Fusion) is a tool of the schema, because prompt-only triggering was found unreliable (the paper;
// owner, 2026-10-12): edit_and_run is one call that edits a file and runs a command, and it is offered only when the fusion
// mechanism is on. It reaches the machines as the two calls it is, an edit then a command, so the classifier decides whether
// they may run as one (HF3.4) exactly as for a model that wrote the two itself. The base configuration is not offered it.

/**
 * The command the bash tool accepts, in words. Part of the tool's description, and so of every request. It names the runners of the classifier's
 * table (S559) and not the vitest command that host/world.mjs also allows: the pilot (2026-10-13) showed an agent that is told of that
 * command uses it, and a command outside the table is neither fused nor read by the Reducer. The table is not widened to match (owner, 2026-10-13).
 */
const BASH_NOTE = 'Runs one program from this list and nothing else: npm test (arguments for the test runner go after --, for example npm test -- tests/unit/core/urgency.test.js), npm run build, npm run lint, node --test, go test (for example go test ./internal/filter -run TestHead -count 1), go build, go vet. Words are letters, digits and . / : = @ + - _ only: no quotes, pipes, redirection, variables or globs. Use read and search to look at files, not bash.';

const TOOLS = {
  read: { name: 'read', description: 'Reads a file of the repository and returns its text.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the repository root.' } }, required: ['path'] } },
  search: { name: 'search', description: 'Searches the files of the repository for a regular expression; returns path:line:text for each match.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'A folder to search in; the whole repository if absent.' } }, required: ['pattern'] } },
  edit: { name: 'edit', description: 'Replaces one exact piece of text in a file by another. The old text must occur once.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
  write: { name: 'write', description: 'Writes a whole file, creating it or replacing it.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  bash: { name: 'bash', description: BASH_NOTE, input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  done: { name: 'done', description: 'Say that the current stage is finished. The stage is then checked, once. Call it when you believe the stage is done, and not before; a stage that runs out of turns is checked as it stands.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'One sentence on what you did.' } } } },
  edit_and_run: { name: 'edit_and_run', description: 'Edits a file and runs a command in one call, and returns both results together. Use it when you will run the tests right after an edit and do not need to look at the edited file first.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, command: { type: 'string', description: 'A command of the bash tool.' } }, required: ['path', 'old', 'new', 'command'] } },
};

/** The tools of a request: the same in every request of a trial, so that they are cached with the system prompt. */
export function toolSchema({ fusion }) {
  const names = ['read', 'search', 'edit', 'write', 'bash', ...(fusion ? ['edit_and_run'] : []), 'done'];
  return names.map((n) => TOOLS[n]);
}

/**
 * The turn's calls as the JSON list the machines read, from the answer's content blocks. Unknown tool names are kept as they
 * are (the world refuses them as a failed call). edit_and_run becomes an edit and a bash call.
 * @returns {string}
 */
export function callsFromBlocks(blocks) {
  const calls = [];
  for (const b of blocks ?? []) {
    if (b?.type !== 'tool_use') continue;
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {};
    if (b.name === 'edit_and_run') {
      calls.push({ tool: 'edit', path: input.path, old: input.old, new: input.new }, { tool: 'bash', command: input.command });
    } else {
      calls.push({ tool: b.name, ...input });
    }
  }
  return JSON.stringify(calls);
}

/**
 * The host's reading of the turn for Go's done: true if and only if the calls hold the done tool. A text that is not a JSON list
 * of calls, or a list with no done, is false. (Assumption done-signal in assumptions.json.)
 */
export function doneOf(callsText) {
  try {
    const calls = JSON.parse(callsText);
    return Array.isArray(calls) && calls.some((c) => c && c.tool === 'done');
  } catch {
    return false;
  }
}

/** The stop the host reports for the call just made (Metered): why the model stopped. */
export function stopOf(stopReason) {
  if (stopReason === 'max_tokens') return 'Length';
  if (stopReason === 'tool_use') return 'Tool';
  return 'End';
}

/** What the agent is told a tool call returned: the calls it made, then each result in the world's own text. Plain text, no ids. */
export function resultsText(output, exitStatus) {
  return `[tool results, exit status ${exitStatus}]\n${output}`;
}
