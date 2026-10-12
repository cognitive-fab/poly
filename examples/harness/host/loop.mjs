// plan-e3.md E3.4 and E3.5: the host's loop for one task, over a loaded poly-runtime. It holds no rule. The machines (Turn,
// Context, Trial, Receipt, Observation, Archive) decide; this file creates their instances, wires them, composes each
// request's context from the transcript, reports the measures it has taken (the stop reason, the window in buckets, the
// gate's numbers), dispatches the actions the machines wait for, registers the effect handlers, and polls the runtime's
// worker until a state is reached. A require in a machine rejects an action out of turn, so a mistake here is a rejected
// dispatch or a stuck run, and never a broken rule (assumptions.json, dispatch-order).
//
// The four mechanisms can each be switched off (Q-E3-2: the base harness is this harness with all four off):
//   fusion      off: the classifier says separate for every call (handlers/classify.mjs reads the host's setting through the
//               secrets capability, which has no write; the host sets all four once, before the trial: transports.mjs)
//   compaction  off: the host never takes the pay-gate's measure, so no compaction is chosen (the limit still compacts, HF3.8)
//   pack        off: a large output stays in the transcript in full
//   reducer     off: a log is shown to the agent whole, and the cheaper model is never asked
//
// A recording is a task as one recorded run saw it:
//   { task, prompt, steps: [ { model: [ { calls, stop, usage? } ], tool: { output, exitStatus, net?, log? },
//                               stage: { passed }, cap? } ],
//     summaries?: [text], receipts?: [text] }
// A step's model entries are the model's answers for that step in order: a second one answers a reprompt after a cutoff.
// The reducer reads the output of a build or test command of a predefined set (the declared runners of handlers/classify.mjs);
// a file read or a search bypasses it (SoL-Pi, the Evidence-Preserving Reducer).
import { ArchiveStore, handleText } from './handlers/archive.mjs';
import { isRunnerCall } from './handlers/classify.mjs';

export const KINDS = {
  'tool.verify': ['verify', 'verify'],
  'tool.scan': ['scan', 'scan'],
  'tool.classify': ['classify', 'classify'],
  'tool.act': ['tools', 'act'],
  'tool.fetch': ['tools', 'fetch'],
  'tool.store': ['tools', 'storeClean'],
  'tool.store-redacted': ['tools', 'storeRedacted'],
  'tool.stage-check': ['tools', 'stageCheck'],
  'tool.start-compaction': ['tools', 'startCompaction'],
  'tool.compact': ['tools', 'compact'],
  'tool.save-work': ['tools', 'saveWork'],
  'tool.show-receipt': ['tools', 'showReceipt'],
  'tool.show-original': ['tools', 'showOriginal'],
  'trial.stop-cap': ['tools', 'stopCap'],
  'trial.stop-overflow': ['tools', 'stopOverflow'],
  'trial.stop': ['tools', 'stopTrial'],
  'trial.finish': ['tools', 'finishTrial'],
};

/** The handlers of the project's handler files, registered for their kinds. */
export function registerHandlers(rt, base = 'src/handlers') {
  const files = new Map();
  for (const [kind, [file, name]] of Object.entries(KINDS)) {
    if (!files.has(file)) files.set(file, rt.handlerExports(`${base}/${file}.mjs`));
    rt.handle(kind, files.get(file)[name]);
  }
}

export const ALL_ON = Object.freeze({ fusion: true, compaction: true, pack: true, reducer: true });
export const ALL_OFF = Object.freeze({ fusion: false, compaction: false, pack: false, reducer: false });
export const THRESHOLDS = Object.freeze({ logBytes: 4096, handleBytes: 10240, excerptBytes: 512 });

/** A token is estimated at four characters. The provider's own usage figure replaces this in a live run (assumption token-buckets). */
export const tokensOf = (text) => Math.ceil(String(text).length / 4);

export const PREAMBLE = `You are a coding agent working in a copy of a repository. Tools: edit(path, new), bash(command). ${'The tool schemas are part of every request. '.repeat(24)}`;
const KEEP_LAST = 2;
const SUMMARY_TOKENS = 250;

/** A provider that answers from a queue of recorded texts, in order, with the usage its question implies (input from what it was shown). */
function queueProvider(name, texts, materialOf, preamble, calls) {
  const asked = [];
  const fn = (q, m) => {
    asked.push(q);
    const text = texts.shift();
    if (text === undefined) throw new Error(`no recorded answer left for ${name}`);
    const shown = m?.bodies?.[materialOf] ?? '';
    const input = tokensOf(shown);
    // HAC6: the request's input is the preamble (the system prompt and the tool schemas, the first message) and the rest (the transcript)
    const pre = shown.startsWith(preamble) ? Math.min(input, tokensOf(preamble)) : 0;
    calls.push({ kind: name, preamble: pre, transcript: input - pre, output: tokensOf(text) });
    return { answer: text, distribution: [[text, 1]], usage: { input, output: tokensOf(text) } };
  };
  fn.asked = asked;
  return fn;
}

/** Whether a step's calls are an edit then any command: the opportunity of Action Fusion, read without the classifier. */
function fusionOpportunity(calls) {
  try {
    const c = JSON.parse(calls);
    return Array.isArray(c) && c.length === 2 && (c[0]?.tool === 'edit' || c[0]?.tool === 'write') && c[1]?.tool === 'bash';
  } catch {
    return false;
  }
}

/** What the agent is shown in place of a verified log: the receipt's status and exact quotes, and the log's size. */
function receiptView(receiptJson, logBytes) {
  const r = JSON.parse(receiptJson);
  return `[verified receipt of a log of ${logBytes} bytes, status ${r.status}]\n${r.quotes.join('\n')}`;
}

/**
 * @param {{ rt: object, host: ReturnType<typeof import('./transports.mjs').makeHost>, recording: object, models: { main: string, cheap: string },
 *   mechanisms?: object, thresholds?: object, windowTokens?: number, preamble?: string, cacheRatio?: number }} input
 */
export async function runTask({ rt, host, recording, models, mechanisms = ALL_ON, thresholds = THRESHOLDS, windowTokens = 6000, preamble = PREAMBLE, cacheRatio = 12.5 }) {
  const calls = []; // every model call, in order, with the terms of its cost (HAC6)
  const store = host.store;
  const task = recording.task;
  const bucketTokens = windowTokens / 6;
  const bucketOf = (tokens) => Math.max(0, Math.min(6, Math.floor(tokens / bucketTokens)));
  const ids = { trial: `trial:${task}`, context: `context:${task}`, ledger: `ledger:${task}` };
  const state = async (id) => (await rt.getState(id)).state;
  const pump = async (until, what, limit = 60) => {
    for (let i = 0; i < limit; i++) {
      if (await until()) return;
      await rt.advance(8);
    }
    if (!(await until())) throw new Error(`the run did not reach: ${what}`);
  };
  const agentTexts = recording.steps.flatMap((s) => s.model.map((m) => m.calls));
  rt.provide('agent', { provider: queueProvider('agent', agentTexts, 'task', preamble, calls), model: models.main });
  rt.provide('summarise', { provider: queueProvider('summarise', [...(recording.summaries ?? [])], 'context', preamble, calls), model: models.cheap });
  rt.provide('read', { provider: queueProvider('read', [...(recording.receipts ?? [])], 'log', preamble, calls), model: models.cheap });
  registerHandlers(rt);
  host.setMechanisms(mechanisms);

  await rt.create('harness.Trial', { id: ids.trial });
  await rt.create('harness.Context', { id: ids.context });
  await rt.create('harness.Ledger', { id: ids.ledger });
  await rt.dispatch(ids.context, 'Wire', { tr: ids.trial });
  await rt.dispatch(ids.trial, 'Begin', { cx: ids.context, n: recording.steps.length });
  store.put('recorded-stage', ids.trial, recording.steps.map((s) => s.stage?.passed !== false));

  const archive = new ArchiveStore();
  const messages = [{ role: 'system', text: preamble, pinned: true }, { role: 'user', text: recording.prompt, pinned: true }];
  const live = []; // observations the transcript still refers to: { id, message, fullSends }
  const turns = [];
  const receipts = [];
  const compactions = [];
  const requests = [];
  let reads = 0; // the cheaper model's readings used so far, which index the recording's receipts
  const metrics = {
    fusion: { opportunities: 0, fired: 0 },
    compaction: { opportunities: 0, chosen: 0, forced: 0 },
    pack: { opportunities: 0, observations: 0, handled: 0, fullSends: [] },
    reducer: { opportunities: 0, receipts: 0, verified: 0, rejected: 0, flagged: 0 },
  };
  const shownText = (m) => (m.obs ? m.shown : m.text);

  /** The request's context: each live observation is told one more request has gone out and shown full or as its handle. */
  const compose = async () => {
    for (const o of live) {
      await rt.dispatch(o.id, 'Sent', {});
      const st = (await state(o.id)).st;
      o.message.shown = st === 'Full' ? o.message.full : o.message.handle;
      if (st === 'Full') o.fullSends += 1;
    }
    const text = messages.map(shownText).join('\n');
    const tokens = tokensOf(text);
    requests.push({ n: requests.length + 1, tokens, bucket: bucketOf(tokens) });
    return { text, tokens };
  };
  /** The window in buckets, reported before a request (assumption token-buckets). */
  const level = async (tokens) => {
    if ((await state(ids.context)).mode === 'Working') await rt.dispatch(ids.context, 'Level', { to: bucketOf(tokens) });
  };
  const plainText = () => messages.map((m) => (m.obs ? (m.shown ?? m.full) : m.text)).join('\n');
  /**
   * The pay-gate's measure, as the SoL-Pi paper structures it (section 2.4). The requests still to come are estimated from the
   * observed rate (the requests per completed step, times the steps left) and capped by the requests that would fill the
   * window at the observed growth. The saving is what a compaction would not send again, over those requests. The rewrite is
   * the extra cost of the prompt cache: the summary and the messages after the first dropped one are written again, at the
   * write price for what would have been read, so the context rewritten times the cache write/read price ratio less one. The
   * pinned head stays cached. The summary call is not priced (as in the paper). The host reports the ratio of the two in
   * halves, rounded down, so a borderline case is never compacted.
   */
  const gateLog = [];
  const measuredNumbers = (stepsDone) => {
    const stepsLeft = recording.steps.length - stepsDone;
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
    // the ratio of the two, in halves, rounded down: the check domain is one number of 0..8 (Context.Measured)
    const gain = rewriteTokens > 0 ? Math.max(0, Math.min(8, Math.floor((2 * savingTokens) / rewriteTokens))) : savingTokens > 0 ? 8 : 0;
    gateLog.push({ step: stepsDone, remaining, savingTokens, rewriteTokens, gain });
    return { gain };
  };
  const publish = () => store.put('transcript', ids.context, { messages: messages.map((m) => ({ role: m.role, text: m.obs ? m.shown : m.text, pinned: m.pinned })), keepLast: KEEP_LAST });
  const adopt = () => {
    const row = store.read('transcript', ids.context);
    const key = row ? `${row.messages.length}:${row.after}:${row.before}` : null;
    if (row && row.after !== undefined && !compactions.some((c) => c.key === key)) {
      compactions.push({ key, before: row.before, after: row.after, released: row.released });
      messages.splice(0, messages.length, ...row.messages);
      // an observation whose handle the new transcript no longer mentions is no longer referred to
      for (let k = live.length - 1; k >= 0; k--) if (!row.messages.some((x) => x.text.includes(live[k].message.handleId))) live.splice(k, 1);
    }
  };

  for (let i = 0; i < recording.steps.length; i++) {
    const step = recording.steps[i];
    const turn = `turn:${task}:${i}`;
    turns.push(turn);
    await rt.create('harness.Turn', { id: turn });
    store.put('recorded-tool', turn, step.tool);
    const first = await compose();
    await level(first.tokens);
    await rt.dispatch(turn, 'Start', { task: await rt.putContent(first.text), tr: ids.trial, led: ids.ledger });
    for (let m = 0; m < step.model.length; m++) {
      const e = step.model[m];
      await rt.dispatch(turn, 'Metered', { s: e.stop });
      await pump(async () => { const s = await state(turn); return s.stepped && !(s.plan === 'Unplanned'); }, `${turn} planned`);
      messages.push({ role: 'assistant', text: e.calls });
      if (e.stop === 'Length' && m + 1 < step.model.length) {
        await rt.dispatch(turn, 'Go', { net: false });
        const again = await compose();
        await rt.dispatch(turn, 'Reprompt', { note: await rt.putContent(again.text) });
      }
    }
    if (fusionOpportunity(step.model[step.model.length - 1].calls)) metrics.fusion.opportunities += 1;
    await rt.dispatch(turn, 'Go', { net: step.tool.net === true });
    if ((await state(turn)).plan === 'Fusable') metrics.fusion.fired += 1;
    await pump(async () => (await state(turn)).mode === 'Observing' && (await state(turn)).scanned, `${turn} scanned`);
    await rt.dispatch(turn, 'StoreLog', {});
    await pump(async () => ['Done', 'Failed'].includes((await state(turn)).mode), `${turn} stored`);
    const archived = store.read('archive', turn);
    const logText = Buffer.from(archived.log, 'base64').toString('utf8');
    const logBytes = Buffer.byteLength(logText, 'utf8');
    if (archived.redacted) metrics.reducer.flagged += 1;
    let shown = logText;
    let shownIsReceipt = false;

    // the Evidence-Preserving Reducer: a log over the threshold is read by the cheaper model, and only a verified receipt is shown
    const reducible = isRunnerCall(step.model[step.model.length - 1].calls);
    if (reducible && logBytes >= thresholds.logBytes) {
      metrics.reducer.opportunities += 1;
      if (mechanisms.reducer) {
        const receipt = `receipt:${task}:${i}`;
        receipts.push(receipt);
        metrics.reducer.receipts += 1;
        const flagged = archived.redacted === true;
        const mine = flagged ? null : recording.receipts[reads++];
        await rt.create('harness.Receipt', { id: receipt });
        store.put('archive', receipt, archived);
        await rt.dispatch(receipt, 'Open', { log: await rt.putContent(logText), flagged });
        await pump(async () => ['Verified', 'Rejected'].includes((await state(receipt)).st), `${receipt} decided`);
        const verdict = (await state(receipt)).st;
        if (verdict === 'Verified') metrics.reducer.verified += 1;
        else metrics.reducer.rejected += 1;
        await rt.dispatch(receipt, 'Show', {});
        await pump(async () => (await state(receipt)).presented, `${receipt} shown`);
        if (store.read('shown', receipt).what === 'receipt') {
          shown = receiptView(mine, logBytes);
          shownIsReceipt = true;
        }
      }
    }
    // ObservationPack: an output over the threshold is archived, sent in full for two requests and then shown as its handle
    const message = { role: 'tool', text: shown };
    // a verified receipt is never packed: the evidence it holds is what the agent must keep (SoL-Pi: the pack skips the reducer's marker)
    if (!shownIsReceipt && Buffer.byteLength(shown, 'utf8') > thresholds.handleBytes) {
      metrics.pack.opportunities += 1;
      if (mechanisms.pack) {
        const obs = `obs:${task}:${i}`;
        const arch = `archive:${task}:${i}`;
        const handleId = archive.put(Buffer.from(shown, 'utf8'));
        await rt.create('harness.Archive', { id: arch });
        await rt.create('harness.Observation', { id: obs });
        await rt.dispatch(obs, 'Wire', { a: arch });
        await rt.dispatch(obs, 'Put', {});
        await pump(async () => (await state(obs)).st === 'Full', `${obs} stored`);
        metrics.pack.observations += 1;
        Object.assign(message, { obs: true, full: shown, handle: handleText(handleId, shown, thresholds.excerptBytes), handleId, shown });
        live.push({ id: obs, message, fullSends: 0 });
      }
    }
    messages.push(message);

    await pump(async () => (await state(ids.context)).finished || ['Failing', 'Stopped'].includes((await state(ids.trial)).mode), `${ids.context} finished`);
    if (step.cap) {
      await rt.dispatch(ids.trial, 'CapReached', {});
      await pump(async () => (await state(ids.trial)).mode === 'Failing', 'the cap saved the work');
      await rt.dispatch(ids.trial, 'Close', {});
      await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial stopped');
      break;
    }
    await level(tokensOf(plainText()));
    if (mechanisms.compaction) {
      const ctxNow = await state(ids.context);
      if (ctxNow.finished && ctxNow.ctx > 2) metrics.compaction.opportunities += 1;
      publish();
      const nums = measuredNumbers(i + 1);
      await rt.dispatch(ids.context, 'Measured', { gain: nums.gain, context: await rt.putContent(plainText()) });
      await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} compaction settled`);
      const before = compactions.length;
      adopt();
      if (compactions.length > before) metrics.compaction.chosen += 1;
    }
    if ((await state(ids.context)).ctx >= 5) {
      publish();
      await rt.dispatch(ids.context, 'Overflowed', { context: await rt.putContent(plainText()) });
      await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} overflow settled`);
      adopt();
      metrics.compaction.forced += 1;
      await level(tokensOf(plainText()));
      if ((await state(ids.context)).ctx >= 5) {
        await rt.dispatch(ids.context, 'Overflowed', { context: await rt.putContent('over the limit') });
        await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial ended on overflow');
        break;
      }
    }
    await pump(async () => (await state(ids.trial)).mode === 'Checking', 'the trial is checking');
    await rt.dispatch(ids.trial, 'NextStep', {});
    if ((await state(ids.trial)).mode === 'Done') break;
  }
  await rt.advance(8);
  for (const o of live) metrics.pack.fullSends.push(o.fullSends);
  for (const o of live) if ((await state(o.id)).st === 'Handled') metrics.pack.handled += 1;
  return {
    ids, trial: await state(ids.trial), context: await state(ids.context), turns, receipts,
    compactions: compactions.map(({ before, after, released }) => ({ before, after, released })),
    metrics, requests, calls, gateLog, live: live.map((o) => ({ id: o.id, handle: o.message.handleId, fullSends: o.fullSends })), archive, transcript: messages,
  };
}
