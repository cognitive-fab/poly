// plan-e3.md E3.4: the host's loop for one task, over a loaded poly-runtime. It holds no rule. The machines (Turn, Context,
// Trial, Receipt) decide; this file creates their instances, wires them, dispatches the facts it has measured or read from a
// recording (the stop reason, the growth of the window, the next tool call), registers the effect handlers, and polls the
// runtime's worker until a state is reached. A require in a machine rejects an action out of turn, so a mistake here is a
// rejected dispatch or a stuck run, and never a broken rule (assumptions.json, dispatch-order).
//
// A recording is a task as one recorded run saw it:
//   { task, prompt, steps: [ { model: [ { calls, stop, grew, usage } ], tool: { output, exitStatus, net? },
//                               stage: { passed }, gate?: { saving, rewrite }, cap?: true } ],
//     summaries?: [text], receipts?: [text] }
// A step's model entries are the model's answers for that step in order: a second one answers a reprompt after a cutoff.

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

/** A provider that answers from a queue of recorded texts, in order, and says so when it runs out. */
function queueProvider(name, texts, usage) {
  const asked = [];
  const fn = (q) => {
    asked.push(q);
    const text = texts.shift();
    if (text === undefined) throw new Error(`no recorded answer left for ${name}`);
    return { answer: text, distribution: [[text, 1]], usage: usage ?? { input: 1000, output: 100 } };
  };
  fn.asked = asked;
  return fn;
}

const THRESHOLDS = { logBytes: 4096 };

/**
 * @param {{ rt: object, store: import('./store.mjs').MemoryStore, recording: object, models: { main: string, cheap: string }, thresholds?: object }} input
 * @returns {Promise<{ ids: object, trial: object, context: object, turns: object[], receipts: object[] }>}
 */
export async function runTask({ rt, store, recording, models, thresholds = THRESHOLDS }) {
  const task = recording.task;
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
  rt.provide('agent', { provider: queueProvider('agent', agentTexts), model: models.main });
  rt.provide('summarise', { provider: queueProvider('summarise', [...(recording.summaries ?? [])]), model: models.cheap });
  rt.provide('read', { provider: queueProvider('read', [...(recording.receipts ?? [])]), model: models.cheap });
  registerHandlers(rt);

  await rt.create('harness.Trial', { id: ids.trial });
  await rt.create('harness.Context', { id: ids.context });
  await rt.create('harness.Ledger', { id: ids.ledger });
  await rt.dispatch(ids.context, 'Wire', { tr: ids.trial });
  await rt.dispatch(ids.trial, 'Begin', { cx: ids.context, n: recording.steps.length });
  store.put('recorded-stage', ids.trial, recording.steps.map((s) => s.stage?.passed !== false));
  const messages = [{ role: 'system', text: 'system prompt', pinned: true }, { role: 'user', text: recording.prompt, pinned: true }];
  const turns = [];
  const receipts = [];
  const compactions = [];
  // after a compaction the transcript is the one the handler wrote, so the host reads it back and keeps it
  const adopt = () => {
    const row = store.read('transcript', ids.context);
    if (row && row.after !== undefined && !compactions.some((c) => c.row === row.messages.length + ':' + row.after)) {
      compactions.push({ before: row.before, after: row.after, released: row.released, row: row.messages.length + ':' + row.after });
      messages.splice(0, messages.length, ...row.messages);
    }
  };

  for (let i = 0; i < recording.steps.length; i++) {
    const step = recording.steps[i];
    const turn = `turn:${task}:${i}`;
    turns.push(turn);
    await rt.create('harness.Turn', { id: turn });
    store.put('recorded-tool', turn, step.tool);
    await rt.dispatch(turn, 'Start', { task: await rt.putContent(i === 0 ? recording.prompt : `continue with step ${i + 1}`), tr: ids.trial, led: ids.ledger });
    for (let m = 0; m < step.model.length; m++) {
      const e = step.model[m];
      await rt.dispatch(turn, 'Metered', { s: e.stop });
      // the check domain of Grew is 0..2 buckets, so a larger growth is reported as several facts
      for (let left = e.grew ?? 0; left > 0; left -= 2) await rt.dispatch(ids.context, 'Grew', { by: Math.min(2, left) });
      messages.push({ role: 'assistant', text: e.calls });
      await pump(async () => { const s = await state(turn); return s.stepped && !(s.plan === 'Unplanned'); }, `${turn} planned`);
      if (e.stop === 'Length' && m + 1 < step.model.length) {
        await rt.dispatch(turn, 'Go', { net: false });
        await rt.dispatch(turn, 'Reprompt', { note: await rt.putContent('continue') });
      }
    }
    await rt.dispatch(turn, 'Go', { net: step.tool.net === true });
    await pump(async () => (await state(turn)).mode === 'Observing' && (await state(turn)).scanned, `${turn} scanned`);
    await rt.dispatch(turn, 'StoreLog', {});
    await pump(async () => ['Done', 'Failed'].includes((await state(turn)).mode), `${turn} stored`);
    const archived = store.read('archive', turn);
    messages.push({ role: 'tool', text: Buffer.from(archived.log, 'base64').toString('utf8') });

    // a log over the threshold is read by the cheaper model, and the receipt is shown only if the verifier passed it
    if (Buffer.from(archived.log, 'base64').length >= thresholds.logBytes) {
      const receipt = `receipt:${task}:${i}`;
      receipts.push(receipt);
      await rt.create('harness.Receipt', { id: receipt });
      store.put('archive', receipt, archived);
      await rt.dispatch(receipt, 'Open', { log: await rt.putContent(Buffer.from(archived.log, 'base64').toString('utf8')), flagged: archived.redacted === true });
      await pump(async () => ['Verified', 'Rejected'].includes((await state(receipt)).st), `${receipt} decided`);
      await rt.dispatch(receipt, 'Show', {});
      await pump(async () => (await state(receipt)).presented, `${receipt} shown`);
    }

    await pump(async () => (await state(ids.context)).finished || ['Failing', 'Stopped'].includes((await state(ids.trial)).mode), `${ids.context} finished`);
    if (step.cap) {
      await rt.dispatch(ids.trial, 'CapReached', {});
      await pump(async () => (await state(ids.trial)).mode === 'Failing', 'the cap saved the work');
      await rt.dispatch(ids.trial, 'Close', {});
      await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial stopped');
      break;
    }
    store.put('transcript', ids.context, { messages, keepLast: 2 });
    const gate = step.gate ?? { saving: 0, rewrite: 1 };
    await rt.dispatch(ids.context, 'Measured', { saving: gate.saving, rewrite: gate.rewrite, context: await rt.putContent(messages.map((x) => x.text).join('\n')) });
    await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} compaction settled`);
    adopt();
    if ((await state(ids.context)).ctx >= 5) {
      await rt.dispatch(ids.context, 'Overflowed', { context: await rt.putContent(messages.map((x) => x.text).join('\n')) });
      await pump(async () => (await state(ids.context)).mode !== 'Compacting', `${ids.context} overflow settled`);
      adopt();
      if ((await state(ids.context)).ctx >= 5) {
        await rt.dispatch(ids.context, 'Overflowed', { context: await rt.putContent('over the limit') });
        await pump(async () => (await state(ids.trial)).mode === 'Stopped', 'the trial ended on overflow');
        break;
      }
    }
    await pump(async () => (await state(ids.trial)).mode === 'Checking', 'the trial is checking');
    await rt.dispatch(ids.trial, 'NextStep', {});
    const t = await state(ids.trial);
    if (t.mode === 'Done') {
      await pump(async () => false || true, 'done');
      break;
    }
  }
  await rt.advance(8);
  return { ids, trial: await state(ids.trial), context: await state(ids.context), turns, receipts, compactions: compactions.map(({ before, after, released }) => ({ before, after, released })) };
}
