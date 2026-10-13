// plan-e3.md E3.9, option A: the exec transport of the live run. The module declares two commands (harness-tool for act,
// harness-check for stageCheck); in the live run they are served by the no-network container, through the runner that runs inside
// it (container/runner.mjs). This file holds the one copy of the task that the run works in, which the container's runner made and
// named, and which no payload, handler or model output can change.
//
// `send` is container/ctl.mjs send (a request to the runner, a JSON reply). It is a parameter so that the tests give it a function of
// their own and need no Docker.

/**
 * @param {{ send: (req: object) => object | Promise<object>, task: object, run: string }} options
 * @returns {{ exec: (command: string, args: string[]) => Promise<object>, prepare: () => Promise<string>, copy: () => string | null }}
 */
export function containerExec({ send, task, run }) {
  let copy = null;
  return {
    /** Makes the task's scratch copy inside the container, once; its path is the container's, and stays in this closure. */
    async prepare() {
      if (copy !== null) throw new Error('the task copy is made once');
      const r = await send({ op: 'prepare', task: task.id, run });
      if (r.error) throw new Error(`the container could not prepare ${task.id}: ${r.error}`);
      copy = r.copy;
      return copy;
    },
    copy: () => copy,
    /** Deletes the copy inside the container when the trial is over. */
    async remove() {
      if (copy === null) return;
      const r = await send({ op: 'remove', copy });
      if (r.error) throw new Error(`the container could not remove the copy: ${r.error}`);
      copy = null;
    },
    async exec(command, args) {
      if (copy === null) throw Object.assign(new Error('no task copy was made in the container, so nothing can run'), { permanent: true });
      if (command === 'harness-tool') {
        const r = await send({ op: 'calls', copy, calls: String(args[0]) });
        if (r.error) throw Object.assign(new Error(`the container refused the calls: ${r.error}`), { permanent: true });
        return r;
      }
      if (command === 'harness-check') {
        const stage = Number(args[0]);
        if (!task.stages[stage]) throw Object.assign(new Error(`the task has no stage ${args[0]}`), { permanent: true });
        const r = await send({ op: 'check', copy, task: task.id, stage });
        if (r.error) throw Object.assign(new Error(`the container could not check stage ${stage}: ${r.error}`), { permanent: true });
        return r;
      }
      throw Object.assign(new Error(`${command} is not a command of the host`), { permanent: true });
    },
  };
}
