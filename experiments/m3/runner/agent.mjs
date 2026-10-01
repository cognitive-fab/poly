// One turn of an agent in a workspace (plan-m3 section 6): the `claude` CLI in headless mode, or a stub that
// replays a recorded script. Either way the turn is written to the journal as stream-json events, its tokens
// are counted, and it is stopped when the run's token budget or wall time runs out.
//
// Tokens are counted as input + cache creation + cache read + output, from the usage of each assistant message,
// which is what the budget and PT13's "tokens per delivered task" measure. Nothing here calls a model on a
// check or decision path: the agent is the arm under test.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The allowed tools of each arm: the file tools and a shell for the arm's commands, nothing else (plan-m3 §6). */
export const ALLOWED_TOOLS = {
  1: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)'],
  2: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)'],
  3: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npm test*)', 'Bash(npm run poly *)', 'Bash(npm run adapter*)'],
  4: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)', 'Bash(npm run poly *)', 'Bash(npm run adapter*)'],
};

/** The CLI's arguments for one turn. `--bare` keeps the owner's settings, memory, hooks and plugins out of the arm. */
export function claudeArgs({ arm, model, prompt, sessionId, maxBudgetUsd }) {
  return [
    '-p', prompt,
    '--bare',
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--allowedTools', ALLOWED_TOOLS[arm].join(','),
    // dontAsk: a tool outside the allowed list is denied without a prompt, so the arm cannot leave its tools.
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

export const tokensOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.output_tokens ?? 0);

/**
 * Runs one turn. `agent` is { kind: 'claude', bin?: 'claude' } or { kind: 'stub', turns: [...] } (see stubTurn).
 * `limits` is { tokens, wallMs }, what is left of the run's budget. Resolves to { sessionId, usage, tokens,
 * wallMs, stopped: null | 'budget' | 'wall', exitCode }.
 */
export async function runTurn({ agent, ws, journal, arm, model, prompt, sessionId, limits, turn, maxBudgetUsd, onToolResult }) {
  mkdirSync(dirname(journal), { recursive: true });
  const t0 = Date.now();
  const log = (event) => appendFileSync(journal, JSON.stringify({ at: Date.now() - t0, turn, ...event }) + '\n');
  log({ type: 'runner.prompt', prompt });
  const state = { sessionId: sessionId ?? null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, stopped: null };
  const count = (u) => { for (const k of Object.keys(state.usage)) state.usage[k] += u?.[k] ?? 0; };
  const over = () => (tokensOf(state.usage) > limits.tokens ? 'budget' : Date.now() - t0 > limits.wallMs ? 'wall' : null);
  const onEvent = (e) => {
    log({ type: 'stream', event: e });
    if (e.type === 'system' && e.session_id) state.sessionId = e.session_id;
    if (e.type === 'result' && e.session_id) state.sessionId = e.session_id;
    if (e.type === 'assistant' && e.message?.usage) count(e.message.usage);
    // After a tool ran, the runner may snapshot the delivery, for the regressions caught before delivery (PT13).
    if (e.type === 'user' && (e.message?.content ?? []).some((c) => c.type === 'tool_result')) onToolResult?.();
  };
  let exitCode;
  if (agent.kind === 'stub') {
    exitCode = await stubTurn(agent.turns[turn] ?? { events: [] }, ws, onEvent, () => (state.stopped = over()));
  } else {
    exitCode = await new Promise((resolve) => {
      const child = spawn(agent.bin ?? 'claude', claudeArgs({ arm, model, prompt, sessionId, maxBudgetUsd }), { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { log({ type: 'runner.unparsed', line }); }
          if (!state.stopped && (state.stopped = over())) child.kill();
        }
      });
      child.stderr.on('data', (d) => log({ type: 'runner.stderr', text: String(d) }));
      const timer = setInterval(() => { if (!state.stopped && (state.stopped = over())) child.kill(); }, 1000);
      child.on('close', (code) => { clearInterval(timer); resolve(code); });
    });
  }
  const wallMs = Date.now() - t0;
  log({ type: 'runner.turn-end', usage: state.usage, tokens: tokensOf(state.usage), wallMs, stopped: state.stopped, exitCode });
  return { sessionId: state.sessionId, usage: state.usage, tokens: tokensOf(state.usage), wallMs, stopped: state.stopped, exitCode };
}

/**
 * The stub agent: replays one turn of a script. Events: { type: 'write', path, content } writes a file in the
 * workspace, { type: 'usage', usage } reports an assistant message's tokens, { type: 'text', text } says
 * something. Each is emitted as the CLI's stream-json would emit it. The turn stops early when `stop()` says the
 * budget or wall time is spent, as the CLI's process would be killed.
 */
async function stubTurn(script, ws, onEvent, stop) {
  onEvent({ type: 'system', subtype: 'init', session_id: 'stub-session' });
  for (const e of script.events) {
    if (e.type === 'write') {
      mkdirSync(dirname(join(ws, e.path)), { recursive: true });
      writeFileSync(join(ws, e.path), e.content);
      onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: e.path } }] } });
      onEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: `wrote ${e.path}` }] } });
    } else if (e.type === 'usage') {
      onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }], usage: e.usage } });
    } else if (e.type === 'text') {
      onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: e.text }] } });
    }
    if (stop()) return 143;
  }
  onEvent({ type: 'result', subtype: 'success', session_id: 'stub-session' });
  return 0;
}
