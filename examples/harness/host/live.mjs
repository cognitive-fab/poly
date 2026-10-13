// plan-e3.md E3.9, HF2.1, HF2.9 (amendment A1): the host's loop for one task with a live model, over a loaded poly-runtime. Like
// loop.mjs it holds no rule: the machines decide. It differs in what it supplies: the agent's answer comes from the Anthropic
// client (host/anthropic.mjs) through the provider of the decision, the tools run in the world the host's exec transport serves (the
// no-network container, host/container-exec.mjs, or in the tests a scratch copy on the host), and a stage is up to N turns: the
// loop makes a Turn for each model call, and the Trial (not this file) decides when the stage ends and checks it once.
//
// What this file does for the machines: it reads the agent's calls for the done fact (tools-schema.mjs), reports the stop reason and
// the window, keeps the transcript (the text the Context machine's compaction rewrites), packs large outputs behind handles, has the
// cheaper model read long logs and summarise, and ends the trial at a wall-clock cap with the work saved (HF3.9). The transcript is
// sent to the API as plain text turns (an assistant turn holds the calls the model made; the next user turn holds their results).
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ArchiveStore, handleText } from './handlers/archive.mjs';
import { isRunnerCall } from './handlers/classify.mjs';
import { ALL_ON, LIVE_WINDOW_TOKENS, THRESHOLDS, fusionOpportunity, receiptView, registerHandlers, tokensOf } from './loop.mjs';
import { callsFromBlocks, doneOf, resultsText, stopOf, toolSchema } from './tools-schema.mjs';

export const MAX_TURNS = 8; // N of the module (Trial: turns 0..8); the machine ends a stage at its eighth turn whatever the host does
const KEEP_LAST = 2;
const SUMMARY_TOKENS = 250;

const SUMMARY_SYSTEM = 'You compress the working history of a coding agent so that it can continue from the summary alone. Keep what the next action needs: the task, what has been changed in which files, what the tests said, and what is left. Write plain text of at most 200 words. Do not call tools.';
const READ_SYSTEM = 'You read the output of a build or test command and write a receipt as one JSON object and nothing else: {"sourceHash": <the hash you are given, copied exactly>, "status": <"pass" or "fail", the status you are given>, "quotes": [<up to 8 lines copied exactly, character for character, from the output, the ones that show what failed or passed>]}. A quote must occur in the output byte for byte. The receipt must be much shorter than the output.';

/** The system prompt: the editable prompt and skills (host/../editable), then the note on stages. The tools are a separate part of the request. */
export function systemPrompt(editableDir) {
  const prompt = readFileSync(join(editableDir, 'prompts', 'system.md'), 'utf8').trim();
  const skills = readdirSync(join(editableDir, 'skills')).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(editableDir, 'skills', f), 'utf8').trim());
  return [prompt, ...skills, `Work in turns. In each turn make the tool calls you need; their results come back in the next turn. A stage is checked once, when you call the done tool, or when it has run ${MAX_TURNS} turns. Call done when the stage is finished.`].join('\n\n');
}

/** The pinned first message: the task and its plan. */
export function taskMessage(task) {
  return `${task.prompt}\n\nThe work has ${task.plan.length} stages, one after another:\n${task.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}

/**
 * The three providers of the decisions. They read the host's session (the transcript to send, the last answer) and call the client.
 * Before each call they ask session.guard(kind), which refuses a call that would take the trial past its cap (see runLive).
 */
export function makeProviders({ anthropic, models, session }) {
  const reply = (answer, r, model) => ({ answer, distribution: [[answer, 1]], usage: r.usage, reported: model, latencyMs: r.latencyMs });
  const agent = async (q) => {
    session.guard('agent');
    const r = await anthropic.call({ kind: 'agent', model: models.main, system: session.system, tools: session.tools, messages: session.messages(), maxTokens: q.limits?.maxTokens ?? 4000 });
    const calls = callsFromBlocks(r.blocks);
    session.last = { calls, stop: stopOf(r.stopReason), text: r.text, usage: r.usage, fusedTool: (r.blocks ?? []).some((b) => b?.type === 'tool_use' && b.name === 'edit_and_run') };
    session.lastUsage = r.usage;
    return reply(calls, r, models.main);
  };
  const summarise = async (q, m) => {
    session.guard('summarise');
    const r = await anthropic.call({ kind: 'summarise', model: models.cheap, system: SUMMARY_SYSTEM, messages: [{ role: 'user', text: m?.bodies?.context ?? '' }], maxTokens: q.limits?.maxTokens ?? 1000 });
    return reply(r.text.trim() || '(nothing to summarise)', r, models.cheap);
  };
  const read = async (q, m) => {
    session.guard('read');
    const log = m?.bodies?.log ?? '';
    const hash = `sha256:${createHash('sha256').update(Buffer.from(log, 'utf8')).digest('hex')}`;
    const status = session.logExitStatus === 0 ? 'pass' : 'fail';
    const r = await anthropic.call({ kind: 'read', model: models.cheap, system: READ_SYSTEM, messages: [{ role: 'user', text: `sourceHash: ${hash}\nstatus: ${status}\n\nOutput:\n${log}` }], maxTokens: q.limits?.maxTokens ?? 1000 });
    // a code fence around the JSON is removed; anything else the model wrote is left for the verifier to refuse
    const text = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    session.lastReceipt = text;
    return reply(text, r, models.cheap);
  };
  return { agent, summarise, read };
}

/**
 * @param {{ rt: object, host: ReturnType<typeof import('./transports.mjs').makeHost>, task: object, models: { main: string, cheap: string },
 *   anthropic: ReturnType<typeof import('./anthropic.mjs').createAnthropic>, editableDir: string, mechanisms?: object, thresholds?: object,
 *   windowTokens?: number, cacheRatio?: number, wallClockMs?: number, now?: () => number, onCap?: () => Promise<void> | void,
 *   trialCapMicro: number, reservations: { agent: number, summarise: number, read: number }, runId?: string }} input
 *   runId names the run's instances (default: the task's id), so that several trials of one task share one runtime and one store
 *
 * The trial's cap (finding of 2026-10-13, decisions-e3.md). The module's "cap usd 0.60 per run" is per decision instance, so per Turn (PS18.4:
 * budget:b:run:<instance>), and one Turn's calls cannot reach it; only the month's cap of the scope spans trials. The cap of a trial is
 * therefore the host's: before each model call the host adds the call's reservation (the module's, from its limits and table) to what
 * the trial has spent and refuses the call if the sum passes trialCapMicro. A refused call is the decision's failed outcome, which
 * the machines take as the end of the budget (Turn.StepFailed sends BudgetStop to the Trial: the open stage is checked once and the
 * trial ends with the reason Budget). The sum is the driver's figure, which e3-live.test.mjs shows equals poly's charge. Infinity turns the guard off.
 */
export async function runLive({ rt, host, task, models, anthropic, editableDir, mechanisms = ALL_ON, thresholds = THRESHOLDS, windowTokens = LIVE_WINDOW_TOKENS, cacheRatio = 25, wallClockMs = 20 * 60_000, now = Date.now, onCap = async () => {}, trialCapMicro, reservations, runId = task.id }) {
  if (typeof trialCapMicro !== 'number') throw new Error('runLive needs the trial cap in micro-units (Infinity for none)');
  if (!reservations || !(reservations.agent > 0 && reservations.summarise > 0 && reservations.read > 0)) throw new Error('runLive needs the reservation of each kind of call');
  const store = host.store;
  const n = task.stages.length;
  const bucketTokens = windowTokens / 6;
  const bucketOf = (tokens) => Math.max(0, Math.min(6, Math.floor(tokens / bucketTokens)));
  const ids = { trial: `trial:${runId}`, context: `context:${runId}`, ledger: `ledger:${runId}` };
  const state = async (id) => (await rt.getState(id)).state;
  const pump = async (until, what, limit = 80) => {
    for (let i = 0; i < limit; i++) {
      if (await until()) return;
      await rt.advance(8);
    }
    if (!(await until())) throw new Error(`the run did not reach: ${what}`);
  };

  const spentAtStart = anthropic.totals.microUsd;
  const guard = (kind) => {
    const spent = anthropic.totals.microUsd - spentAtStart;
    if (spent + reservations[kind] > trialCapMicro) throw new Error(`the trial budget: ${spent} spent and ${reservations[kind]} reserved for a ${kind} call would pass the cap of ${trialCapMicro}`);
  };

  const preamble = systemPrompt(editableDir);
  const tools = toolSchema({ fusion: mechanisms.fusion === true });
  const toolTokens = tokensOf(JSON.stringify(tools));
  const messages = [{ role: 'system', text: preamble, pinned: true }, { role: 'user', text: taskMessage(task), pinned: true }];
  const shownText = (m) => (m.obs ? m.shown : m.text);
  const session = { guard, system: preamble, tools, last: null, lastUsage: null, lastReceipt: null, logExitStatus: 0, messages: () => messages.map((m) => ({ role: m.role, text: shownText(m) })) };
  const prov = makeProviders({ anthropic, models, session });
  rt.provide('agent', { provider: prov.agent, model: models.main });
  rt.provide('summarise', { provider: prov.summarise, model: models.cheap });
  rt.provide('read', { provider: prov.read, model: models.cheap });
  registerHandlers(rt);
  host.setMechanisms(mechanisms);

  const archive = new ArchiveStore();
  const live = []; // observations the transcript still refers to
  const turnsLog = [];
  const receipts = [];
  const compactions = [];
  const requests = [];
  const gateLog = [];
  const metrics = {
    fusion: { opportunities: 0, fired: 0 },
    compaction: { opportunities: 0, chosen: 0, forced: 0 },
    pack: { opportunities: 0, observations: 0, handled: 0, fullSends: [] },
    reducer: { opportunities: 0, receipts: 0, verified: 0, rejected: 0, flagged: 0 },
  };
  let sinceCall = 0; // characters added to the transcript since the last request: the part of the window not yet measured
  const t0 = now();

  /** The window before a request: what the API reported for the last request (all three input classes), plus what was added since, estimated. */
  const windowNow = () => {
    const u = session.lastUsage;
    const base = u ? u.input + u.cache_read + u.cache_write : tokensOf(messages.map(shownText).join('\n')) + toolTokens;
    return base + (u ? Math.ceil(sinceCall / 4) : 0);
  };
  const push = (m) => {
    messages.push(m);
    sinceCall += String(shownText(m)).length;
    return m;
  };
  const compose = async () => {
    for (const o of live) {
      await rt.dispatch(o.id, 'Sent', {});
      const st = (await state(o.id)).st;
      o.message.shown = st === 'Full' ? o.message.full : o.message.handle;
      if (st === 'Full') o.fullSends += 1;
    }
    const text = messages.map(shownText).join('\n');
    const tokens = windowNow();
    requests.push({ n: requests.length + 1, tokens, bucket: bucketOf(tokens) });
    sinceCall = 0;
    return { text, tokens };
  };
  const level = async (tokens) => {
    if ((await state(ids.context)).mode === 'Working') await rt.dispatch(ids.context, 'Level', { to: bucketOf(tokens) });
  };
  const plainText = () => messages.map((m) => (m.obs ? (m.shown ?? m.full) : m.text)).join('\n');
  const measuredNumbers = (stepsDone) => {
    const stepsLeft = n - stepsDone;
    const tokensNow = tokensOf(plainText());
    const rps = Math.max(1, requests.length / stepsDone);
    const growth = requests.length > 1 ? (tokensNow - requests[0].tokens) / (requests.length - 1) : 0;
    const fill = growth > 0 ? Math.floor((windowTokens - tokensNow) / growth) : Number.POSITIVE_INFINITY;
    const remaining = Math.max(0, Math.min(Math.round(rps * stepsLeft), fill));
    const cut = messages.length - KEEP_LAST;
    const dropped = messages.filter((m, k) => !m.pinned && k < cut);
    const tail = messages.filter((m, k) => !m.pinned && k >= cut);
    const savingTokens = Math.max(0, tokensOf(dropped.map(shownText).join('\n')) - SUMMARY_TOKENS) * remaining;
    const rewriteTokens = dropped.length ? (SUMMARY_TOKENS + tokensOf(tail.map(shownText).join('\n'))) * (cacheRatio - 1) : 0;
    const gain = rewriteTokens > 0 ? Math.max(0, Math.min(8, Math.floor((2 * savingTokens) / rewriteTokens))) : savingTokens > 0 ? 8 : 0;
    gateLog.push({ step: stepsDone, remaining, savingTokens, rewriteTokens, gain });
    return { gain };
  };
  // the host numbers the compactions it has adopted and publishes that number with the transcript; the handler adds one when it writes
  // a compaction, so a compaction is new exactly when its number is above the last adopted, however alike two of them look
  let adopted = 0;
  const publish = () => store.put('transcript', ids.context, { messages: messages.map((m) => ({ role: m.role, text: shownText(m), pinned: m.pinned })), keepLast: KEEP_LAST, n: adopted });
  const adopt = () => {
    const row = store.read('transcript', ids.context);
    if (row && row.after !== undefined && row.n > adopted) {
      adopted = row.n;
      compactions.push({ n: adopted, before: row.before, after: row.after, released: row.released });
      messages.splice(0, messages.length, ...row.messages);
      for (let k = live.length - 1; k >= 0; k--) if (!row.messages.some((x) => x.text.includes(live[k].message.handleId))) live.splice(k, 1);
      // the summary replaced messages the cache held: the next request is measured afresh
      session.lastUsage = null;
      sinceCall = 0;
    }
  };

  await rt.create('harness.Trial', { id: ids.trial });
  await rt.create('harness.Context', { id: ids.context });
  await rt.create('harness.Ledger', { id: ids.ledger });
  await rt.dispatch(ids.context, 'Wire', { tr: ids.trial });
  await rt.dispatch(ids.trial, 'Begin', { cx: ids.context, n });

  /**
   * The window at its limit (HF3.8). The machine decides: the first Overflowed starts a compaction; a compaction that worked clears
   * the attempt, so a window still over the limit may start another; one that did not work leaves the next Overflowed to end the
   * trial. This loops on what the machine says (the Context's mode after the dispatch) and not on a guess. Returns true if the trial ended.
   */
  const overflow = async () => {
    for (let round = 0; round < 4; round++) {
      if ((await state(ids.context)).ctx < 5) return false;
      publish();
      await rt.dispatch(ids.context, 'Overflowed', { context: await rt.putContent(plainText()) });
      if ((await state(ids.context)).mode === 'Closed') {
        await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial ended on overflow');
        return true;
      }
      await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} overflow settled`, 200);
      const before = compactions.length;
      adopt();
      if (compactions.length > before) metrics.compaction.forced += 1;
      await level(windowNow());
    }
    return false;
  };
  /** One turn: a model call, its tools, its log. Returns 'failed' if the model call could not be made (the machines have taken it as the budget). */
  const turnOf = async (k, i) => {
    const turn = `turn:${runId}:${k}:${i}`;
    await rt.create('harness.Turn', { id: turn });
    const first = await compose();
    await level(first.tokens);
    await rt.dispatch(turn, 'Start', { task: await rt.putContent(first.text), tr: ids.trial, led: ids.ledger });
    let reprompted = false;
    for (;;) {
      await pump(async () => { const s = await state(turn); return s.stepped || s.mode === 'Failed'; }, `${turn} answered`, 400);
      if ((await state(turn)).mode === 'Failed') return 'failed';
      const last = session.last;
      await rt.dispatch(turn, 'Metered', { s: last.stop });
      await pump(async () => !((await state(turn)).plan === 'Unplanned'), `${turn} planned`);
      push({ role: 'assistant', text: last.calls });
      if (last.stop === 'Length' && !reprompted) {
        reprompted = true;
        await rt.dispatch(turn, 'Go', { net: false, done: false });
        const again = await compose();
        await rt.dispatch(turn, 'Reprompt', { note: await rt.putContent(again.text) });
        continue;
      }
      break;
    }
    const calls = session.last.calls;
    if (fusionOpportunity(calls)) metrics.fusion.opportunities += 1;
    await rt.dispatch(turn, 'Go', { net: false, done: doneOf(calls) });
    if ((await state(turn)).plan === 'Fusable') metrics.fusion.fired += 1;
    await pump(async () => (await state(turn)).mode === 'Observing' && (await state(turn)).scanned, `${turn} scanned`, 400);
    await rt.dispatch(turn, 'StoreLog', {});
    await pump(async () => ['Done', 'Failed'].includes((await state(turn)).mode), `${turn} stored`, 80);
    const archived = store.read('archive', turn);
    const logText = Buffer.from(archived.log, 'base64').toString('utf8');
    const logBytes = Buffer.byteLength(logText, 'utf8');
    if (archived.redacted) metrics.reducer.flagged += 1;
    let shown = logText;
    let shownIsReceipt = false;

    // the Evidence-Preserving Reducer: a long log of a declared runner is read by the cheaper model, and only a verified receipt is shown
    if (isRunnerCall(calls) && logBytes >= thresholds.logBytes) {
      metrics.reducer.opportunities += 1;
      if (mechanisms.reducer) {
        const receipt = `receipt:${runId}:${k}:${i}`;
        receipts.push(receipt);
        metrics.reducer.receipts += 1;
        const flagged = archived.redacted === true;
        session.logExitStatus = archived.exitStatus;
        session.lastReceipt = null;
        await rt.create('harness.Receipt', { id: receipt });
        store.put('archive', receipt, archived);
        await rt.dispatch(receipt, 'Open', { log: await rt.putContent(logText), flagged });
        await pump(async () => ['Verified', 'Rejected'].includes((await state(receipt)).st), `${receipt} decided`, 200);
        if ((await state(receipt)).st === 'Verified') metrics.reducer.verified += 1;
        else metrics.reducer.rejected += 1;
        await rt.dispatch(receipt, 'Show', {});
        await pump(async () => (await state(receipt)).presented, `${receipt} shown`);
        if (store.read('shown', receipt).what === 'receipt') {
          shown = receiptView(session.lastReceipt, logBytes);
          shownIsReceipt = true;
        }
      }
    }
    const body = JSON.parse(calls).length === 0 ? 'You made no tool call. Make the tool calls the stage needs, or call done if it is finished.' : shown;
    const message = { role: 'tool', text: resultsText(body, archived.exitStatus) };
    if (!shownIsReceipt && Buffer.byteLength(shown, 'utf8') > thresholds.handleBytes) {
      metrics.pack.opportunities += 1;
      if (mechanisms.pack) {
        const obs = `obs:${runId}:${k}:${i}`;
        const arch = `archive:${runId}:${k}:${i}`;
        const handleId = archive.put(Buffer.from(shown, 'utf8'));
        await rt.create('harness.Archive', { id: arch });
        await rt.create('harness.Observation', { id: obs });
        await rt.dispatch(obs, 'Wire', { a: arch });
        await rt.dispatch(obs, 'Put', {});
        await pump(async () => (await state(obs)).st === 'Full', `${obs} stored`);
        metrics.pack.observations += 1;
        const full = resultsText(shown, archived.exitStatus);
        Object.assign(message, { obs: true, full, handle: resultsText(handleText(handleId, shown, thresholds.excerptBytes), archived.exitStatus), handleId, shown: full });
        live.push({ id: obs, message, fullSends: 0 });
      }
    }
    push(message);
    // the commands of every bash call (a fused call's command is its bash call), and what the classifier and the Reducer's condition said of the turn,
    // so that the trigger rates of the mechanisms rest on what the agent ran and not on a guess
    const parsed = JSON.parse(calls);
    turnsLog.push({
      stage: k, turn: i + 1, runId, calls: parsed.map((c) => c.tool), commands: parsed.filter((c) => c.tool === 'bash').map((c) => c.command),
      plan: (await state(turn)).plan, fusable: (await state(turn)).plan === 'Fusable', runnerCall: isRunnerCall(calls), fusedTool: session.last.fusedTool === true,
      done: doneOf(calls), stop: session.last.stop, usage: session.last.usage, exitStatus: archived.exitStatus, logBytes, receipt: shownIsReceipt,
    });
    return 'ok';
  };

  /** The budget (or a failed call) took a Turn: the Trial has been told. Let a stage the budget ended be checked, then end the trial. */
  const afterBudget = async () => {
    await pump(async () => ['Checking', 'Failing', 'Stopped'].includes((await state(ids.trial)).mode), 'the trial took the budget stop');
    if ((await state(ids.trial)).mode === 'Checking') {
      await pump(async () => (await state(ids.context)).finished, 'the stage the budget ended was checked');
      await rt.dispatch(ids.trial, 'NextStep', {});
      await pump(async () => (await state(ids.trial)).mode === 'Failing', 'the trial ended on the budget');
    }
    if ((await state(ids.trial)).mode === 'Failing') {
      await rt.dispatch(ids.trial, 'Close', {});
      await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial stopped');
    }
  };

  stages: for (let k = 0; k < n; k++) {
    push({ role: 'user', text: `Stage ${k + 1} of ${n}: ${task.plan[k]}` });
    for (let i = 0; (await state(ids.trial)).mode === 'Running' && i <= MAX_TURNS; i++) {
      if (now() - t0 > wallClockMs) {
        await rt.dispatch(ids.trial, 'CapReached', {});
        await pump(async () => (await state(ids.trial)).mode === 'Failing', 'the cap saved the work');
        await onCap();
        await rt.dispatch(ids.trial, 'Close', {});
        await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial stopped');
        break stages;
      }
      if ((await turnOf(k, i)) === 'failed') {
        await afterBudget();
        break stages;
      }
      if ((await state(ids.trial)).mode === 'Running' && (await overflow())) break stages;
    }
    // the stage ended (done, the bound): the Trial is checking it
    await pump(async () => (await state(ids.context)).finished || ['Failing', 'Stopped'].includes((await state(ids.trial)).mode), `${ids.context} finished`, 400);
    if (['Failing', 'Stopped'].includes((await state(ids.trial)).mode)) break;
    await level(windowNow());
    if (mechanisms.compaction) {
      const ctxNow = await state(ids.context);
      if (ctxNow.finished && ctxNow.ctx > 2) metrics.compaction.opportunities += 1;
      publish();
      const nums = measuredNumbers(k + 1);
      await rt.dispatch(ids.context, 'Measured', { gain: nums.gain, context: await rt.putContent(plainText()) });
      await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} compaction settled`, 200);
      const before = compactions.length;
      adopt();
      if (compactions.length > before) metrics.compaction.chosen += 1;
    }
    if (await overflow()) break;
    await pump(async () => (await state(ids.trial)).mode === 'Checking', 'the trial is checking');
    await rt.dispatch(ids.trial, 'NextStep', {});
    if ((await state(ids.trial)).mode === 'Done') break;
  }
  await rt.advance(8);
  for (const o of live) metrics.pack.fullSends.push(o.fullSends);
  for (const o of live) if ((await state(o.id)).st === 'Handled') metrics.pack.handled += 1;
  return {
    ids, runId, trial: await state(ids.trial), context: await state(ids.context), turns: turnsLog, receipts,
    compactions: compactions.map(({ before, after, released }) => ({ before, after, released })),
    metrics, requests, gateLog, live: live.map((o) => ({ id: o.id, handle: o.message.handleId, fullSends: o.fullSends })), archive, transcript: messages,
    llm: { ...anthropic.totals, spentThisTrial: anthropic.totals.microUsd - spentAtStart }, wallClockMs: now() - t0,
  };
}
