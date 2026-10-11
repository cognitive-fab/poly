// plan-e3.md E3.4: the effect handlers of the harness that run the world: the tool, the store of a log, the stage check, the
// compaction, the saved work and the end of a trial. Each is a certified export (rt.handle takes only those, S142) and
// holds no rule: the machines have decided before any of these runs. They read and write only the tables their effects
// declare (read:store and write:store with the targets in harness.poly), through the store capability.
//
// In E3.4 the world is recorded: the tool's output and the stage's result are read from the tables recorded-tool and
// recorded-stage, which the host fills from the task's recording. The real tool, run in a scratch copy of the repository,
// replaces `act` and `stageCheck` in E3.7. The other handlers are the same in a recorded and a live run.
import { applyCompaction } from './compact.mjs';

/** tool.act: run the turn's calls. The recording gives the output and the exit status. */
export async function act(_payload, caps, ctx) {
  const calls = await caps.store.read('calls', ctx.instanceId);
  const rec = await caps.store.read('recorded-tool', ctx.instanceId);
  if (!rec || typeof calls !== 'string') throw Object.assign(new Error(`no recorded tool for ${ctx.instanceId}`), { permanent: true });
  await caps.store.write('output', ctx.instanceId, { text: rec.output, exitStatus: rec.exitStatus });
  return { ok: true };
}

/** tool.fetch: the one tool that needs the network. An offline run never gets here: the policy denies it. */
export async function fetch(_payload, caps, ctx) {
  const rec = await caps.store.read('recorded-tool', ctx.instanceId);
  if (!rec) throw Object.assign(new Error(`no recorded fetch for ${ctx.instanceId}`), { permanent: true });
  await caps.store.write('output', ctx.instanceId, { text: rec.output, exitStatus: rec.exitStatus });
  return { ok: true };
}

/** tool.store: a clean output goes to the archive as it is. */
export async function storeClean(_payload, caps, ctx) {
  const out = await caps.store.read('output', ctx.instanceId);
  await caps.store.write('archive', ctx.instanceId, { log: Buffer.from(out.text, 'utf8').toString('base64'), exitStatus: out.exitStatus, redacted: false });
  await caps.store.write('output', ctx.instanceId, { cleared: true, exitStatus: out.exitStatus });
  return { ok: true };
}

/** tool.store-redacted: a flagged output goes to the archive as the redaction the scan wrote, never as the original. */
export async function storeRedacted(_payload, caps, ctx) {
  const out = await caps.store.read('output', ctx.instanceId);
  const red = await caps.store.read('redacted', ctx.instanceId);
  if (!red) throw Object.assign(new Error(`the scan left no redaction for ${ctx.instanceId}`), { permanent: true });
  await caps.store.write('archive', ctx.instanceId, { log: Buffer.from(red.text, 'utf8').toString('base64'), exitStatus: out.exitStatus, redacted: true });
  // the raw staging row is cleared once the redaction is stored, so the unredacted bytes live nowhere a model or a journal reaches
  await caps.store.write('output', ctx.instanceId, { cleared: true, exitStatus: out.exitStatus });
  return { ok: true };
}

/** tool.stage-check: the next recorded result of the trial's stage checks. Failing is a permanent error: the stage failed. */
export async function stageCheck(_payload, caps, ctx) {
  const queue = (await caps.store.read('recorded-stage', ctx.instanceId)) ?? [];
  if (!queue.length) throw Object.assign(new Error(`no recorded stage result for ${ctx.instanceId}`), { permanent: true });
  const [passed, ...rest] = queue;
  await caps.store.write('recorded-stage', ctx.instanceId, rest);
  if (!passed) throw Object.assign(new Error('the stage check failed'), { permanent: true });
  return { ok: true };
}

/** tool.start-compaction: the transcript is pinned for the rewrite. */
export async function startCompaction(_payload, caps, ctx) {
  await caps.store.write('transcript', `${ctx.instanceId}/pinned`, { at: ctx.seq });
  return { ok: true };
}

/** tool.compact: apply the summary to the context's transcript. A result that does not shrink it is a permanent failure (S561). */
export async function compact(payload, caps, ctx) {
  const summary = await caps.content.read(payload.summary);
  const row = await caps.store.read('transcript', ctx.instanceId);
  const released = [];
  const r = applyCompaction({ transcript: row.messages, summary, keepLast: row.keepLast ?? 2, archive: { release: (id) => released.push(id) } });
  await caps.store.write('transcript', ctx.instanceId, { messages: r.transcript, keepLast: row.keepLast ?? 2, before: r.before, after: r.after, released });
  return { ok: true };
}

/** tool.save-work: the working tree is kept on disk before a capped trial ends (HF3.9). The recording notes that it was. */
export async function saveWork(_payload, caps, ctx) {
  await caps.store.write('work', ctx.instanceId, { saved: true });
  return { ok: true };
}

/** tool.show-receipt: the verified receipt is what the agent sees. */
export async function showReceipt(_payload, caps, ctx) {
  await caps.store.write('shown', ctx.instanceId, { what: 'receipt' });
  return { ok: true };
}

/** tool.show-original: the original log (redacted when flagged) is what the agent sees. */
export async function showOriginal(_payload, caps, ctx) {
  await caps.store.write('shown', ctx.instanceId, { what: 'original' });
  return { ok: true };
}

const ending = (reason) => async (_payload, caps, ctx) => {
  await caps.store.write('trial', ctx.instanceId, { ended: reason });
  return { ok: true };
};
export const stopCap = ending('cap');
export const stopOverflow = ending('overflow');
export const stopTrial = ending('stopped');
export const finishTrial = ending('finished');
