// One turn of an agent in a workspace (plan-m3 section 6): the `claude` CLI in headless mode, or a stub that
// replays a recorded script. Either way the turn is written to the journal as stream-json events, its tokens
// are counted, and it is stopped when the run's token budget or wall time runs out.
//
// Tokens are input + cache creation + cache read + output (S99). The recorded measure of a turn is the usage of the
// CLI's final result event, and its cost is computed from those counts at list price (d28afc3, 4210fa6). During a
// turn the cut-off uses a running count that takes each message's usage once, by message id: the CLI streams one
// event per content block, each repeating its message's usage, and the pilots' first count, which added every
// event, was 2.4 to 2.6 times the CLI's. A streamed message carries its output count before it is final, so the
// running output is low; the record says where the running count and the result differ. Nothing here calls a
// model on a check or decision path: the agent is the arm under test.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armEnv } from './isolation.mjs';

const LAUNCH = fileURLToPath(new URL('launch.mjs', import.meta.url));

/** The allowed tools of each arm: the file tools and a shell for the arm's commands, nothing else (plan-m3 §6). */
export const ALLOWED_TOOLS = {
  1: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)'],
  2: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)'],
  3: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npm test*)', 'Bash(npm run poly *)', 'Bash(npm run adapter*)'],
  4: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(npm test*)', 'Bash(npm run poly *)', 'Bash(npm run adapter*)'],
};

/**
 * The CLI's arguments for one turn. The arms run on the owner's subscription, so without `--bare` (which takes only
 * an API key); the owner's setup is kept out by the configuration folder and the environment of isolation.mjs.
 */
export function claudeArgs({ arm, model, prompt, sessionId, maxBudgetUsd }) {
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--allowedTools', ALLOWED_TOOLS[arm].join(','),
    // dontAsk: a tool outside the allowed list is denied without a prompt, so the arm cannot leave its tools.
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    // No MCP server: none is given with --mcp-config, so neither a plugin's nor the account's connectors load.
    '--strict-mcp-config',
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

/** The four parts of a turn's tokens (S99), as the API names them. */
export const PARTS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
export const tokensOf = (u) => PARTS.reduce((n, k) => n + (u?.[k] ?? 0), 0);
const partsOf = (u) => Object.fromEntries(PARTS.map((k) => [k, u?.[k] ?? 0]));

/**
 * List prices in dollars per million tokens. Claude Opus 5.5: $4 input, $20 output, $0.20 cache read, cache writes at
 * 1.25 times input for five minutes and twice input for an hour. The pilots' CLI figures (costBasis "list") agree
 * with these to the micro-dollar on every turn (test/m3-count.test.mjs).
 */
export const PRICES = { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } };

/** A turn's cost at list price, from its token counts; a cache write not split by duration is priced as five-minute. */
export function costOfUsage(u, model) {
  const p = PRICES[model];
  if (!p) throw new Error(`no list price for ${model}`);
  const write = u?.cache_creation_input_tokens ?? 0;
  const hour = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return ((u?.input_tokens ?? 0) * p.input + (u?.output_tokens ?? 0) * p.output + (u?.cache_read_input_tokens ?? 0) * p.cacheRead + (write - hour) * p.cacheWrite5m + hour * p.cacheWrite1h) / 1e6;
}

const LIMITED = /usage limit reached|hit your (usage )?limit/i;
const AUTH = /not logged in|please run \/login|authentication_failed|invalid api key|oauth token (has )?expired/i;

/**
 * The accounting of one turn, fed every stream event: the running count (each message once, by id), the result
 * event's usage, and whether the turn hit the plan's usage limit or failed to authenticate.
 */
export function turnAccount() {
  const messages = new Map();
  let anon = 0;
  let result = null;
  let status = null;
  const running = () => {
    const out = partsOf();
    for (const u of messages.values()) for (const k of PARTS) out[k] += u[k] ?? 0;
    return out;
  };
  return {
    add(e) {
      if (e.type === 'assistant' && e.message?.usage) messages.set(e.message.id ?? `anon-${++anon}`, e.message.usage);
      const text = e.type === 'assistant' ? (e.message?.content ?? []).map((c) => c.text ?? '').join(' ') : e.type === 'result' ? String(e.result ?? '') : '';
      if (e.error === 'rate_limit' || ((e.error || e.is_error) && LIMITED.test(text))) status = 'limited';
      else if (!status && (e.error === 'authentication_failed' || ((e.error || e.is_error) && AUTH.test(text)))) status = 'auth';
      if (e.type === 'result') result = e;
    },
    running,
    status: () => status,
    /** The CLI's own dollar cap stopped the turn (--max-budget-usd, enforced on the subscription: measured). */
    capStop: () => (result?.subtype === 'error_max_budget_usd' ? 'usd' : null),
    final() {
      const r = running();
      // A turn the dollar cap stops reports no usage in its result event (measured: every part 0 after a $0.20 call),
      // so its running count is recorded instead, and the record says which.
      if (!result?.usage || (tokensOf(result.usage) === 0 && tokensOf(r) > 0)) return { source: 'running', usage: r, running: r, differs: [], cliCostUsd: result?.total_cost_usd ?? null, cacheCreation: null };
      const usage = partsOf(result.usage);
      return { source: 'result', usage, running: r, differs: PARTS.filter((k) => r[k] !== usage[k]), cliCostUsd: result.total_cost_usd ?? null, cacheCreation: result.usage.cache_creation ?? null };
    },
  };
}

/**
 * Runs one turn. `agent` is { kind: 'claude', bin?: 'claude' } or { kind: 'stub', turns: [...] } (see stubTurn).
 * `limits` is { tokens, wallMs }, what is left of the run's budget. Resolves to { sessionId, usage, tokens, costUsd,
 * cliCostUsd, usageSource, running, differs, wallMs, stopped: null | 'budget' | 'wall' | 'usd' | 'limited' | 'auth', exitCode }.
 * `configDir` is the arms' configuration folder (isolation.mjs).
 */
export async function runTurn({ agent, ws, journal, arm, model, prompt, sessionId, limits, turn, maxBudgetUsd, onToolResult, configDir, job }) {
  mkdirSync(dirname(journal), { recursive: true });
  const t0 = Date.now();
  const log = (event) => appendFileSync(journal, JSON.stringify({ at: Date.now() - t0, turn, ...event }) + '\n');
  log({ type: 'runner.prompt', prompt });
  const state = { sessionId: sessionId ?? null, stopped: null };
  const account = turnAccount();
  // A usage limit or a failed login ends the turn at once: the run is recorded, not scored, and rerun (4210fa6, aad9a23).
  const over = () => account.status() ?? (tokensOf(account.running()) > limits.tokens ? 'budget' : Date.now() - t0 > limits.wallMs ? 'wall' : null);
  const onEvent = (e) => {
    log({ type: 'stream', event: e });
    if (e.type === 'system' && e.session_id) state.sessionId = e.session_id;
    if (e.type === 'result' && e.session_id) state.sessionId = e.session_id;
    account.add(e);
    // After a tool ran, the runner may snapshot the delivery, for the regressions caught before delivery (PT13).
    if (e.type === 'user' && (e.message?.content ?? []).some((c) => c.type === 'tool_result')) onToolResult?.();
  };
  let exitCode;
  if (agent.kind === 'stub') {
    exitCode = await stubTurn(agent.turns[turn] ?? { events: [] }, ws, onEvent, () => (state.stopped = over()));
  } else {
    exitCode = await new Promise(async (resolve) => {
      const args = [...(agent.prefix ?? []), ...claudeArgs({ arm, model, prompt, sessionId, maxBudgetUsd })];
      // 37beede: in a run's job, the CLI starts only once the launcher is held by the job, so all it starts is too.
      const held = job?.windows === true;
      const child = held
        ? spawn(process.execPath, [LAUNCH, agent.bin ?? 'claude', ...args], { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'], env: armEnv(process.env, configDir) })
        : spawn(agent.bin ?? 'claude', args, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], env: armEnv(process.env, configDir) });
      if (held) {
        // A CLI outside the job could leave processes no one ends, so it is never started: the run stops as `job`,
        // is recorded unscored and is rerun.
        const ok = await job.assign(child.pid).catch(() => false);
        if (!ok) {
          log({ type: 'runner.job', text: `the job could not hold the launcher ${child.pid}; the CLI was not started` });
          state.stopped = 'job';
          child.kill();
        } else child.stdin.end('go\n');
      }
      // A cap ends the run, so it ends the run's processes with it: the whole job, or the CLI alone without one.
      const stop = () => { if (held) job.end(); else child.kill(); };
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { log({ type: 'runner.unparsed', line }); }
          if (!state.stopped && (state.stopped = over())) stop();
        }
      });
      child.stderr.on('data', (d) => log({ type: 'runner.stderr', text: String(d) }));
      const timer = setInterval(() => { if (!state.stopped && (state.stopped = over())) stop(); }, 1000);
      child.on('close', (code) => { clearInterval(timer); resolve(code); });
    });
  }
  const wallMs = Date.now() - t0;
  const f = account.final();
  const stopped = state.stopped ?? account.status() ?? account.capStop();
  const out = { usage: f.usage, tokens: tokensOf(f.usage), costUsd: PRICES[model] ? costOfUsage({ ...f.usage, cache_creation: f.cacheCreation }, model) : null, cliCostUsd: f.cliCostUsd, usageSource: f.source, running: f.running, differs: f.differs, wallMs, stopped, exitCode };
  log({ type: 'runner.turn-end', ...out });
  return { sessionId: state.sessionId, ...out };
}

/**
 * The stub agent: replays one turn of a script. Events: { type: 'write', path, content } writes a file in the
 * workspace, { type: 'usage', usage } reports an assistant message's tokens, { type: 'text', text } says
 * something. Each is emitted as the CLI's stream-json would emit it. The turn stops early when `stop()` says the
 * budget or wall time is spent, as the CLI's process would be killed.
 */
async function stubTurn(script, ws, onEvent, stop) {
  // A test's stand-in for what happens around the CLI during a turn (test/m3-after.test.mjs).
  script.before?.();
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
