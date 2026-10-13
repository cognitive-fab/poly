// plan-e3.md E3.5 follow-up (owner, 2026-10-11): the host's transports for a run, and the mechanisms setting.
//
// The four switches (Q-E3-2) are the host's alone. A handler reads them through the secrets capability, which has no write,
// and no effect of the module declares a store table named mechanisms, so no model-driven effect or tool can change them
// (test/e3/e3-loop.test.mjs holds both). The host sets them once, before the trial begins: a second set is refused. If a trial
// could flip its own mechanisms the comparison table of the base and the full harness would mean nothing.
import { MemoryStore } from './store.mjs';
import { runCheck } from './tasks.mjs';
import { runCalls } from './world.mjs';

/**
 * @param {{ known?: string[] }} options the secrets the vault knows, which the scan looks for
 */
export function makeHost({ known = [], exec: execOverride = null } = {}) {
  const store = new MemoryStore();
  let mechanisms = null;
  let world = null;
  // The exec transport (E3.7, PT "exec.run"): the runtime lets a handler run only the commands its effect declares, here
  // harness-tool (act) and harness-check (stageCheck). Both are names, not programs. What runs is decided here: the calls
  // go to world.mjs and the check to tasks.mjs, in the one scratch copy the host set, which no payload or handler names.
  // execOverride is the live run's: the same two commands, served by the no-network container (host/container-exec.mjs)
  const exec = execOverride ?? (async (command, args) => {
    if (!world) throw Object.assign(new Error('no task copy was set by the host, so nothing can run'), { permanent: true });
    if (command === 'harness-tool') return runCalls(world.copy, String(args[0]), { timeoutMs: world.timeoutMs });
    if (command === 'harness-check') {
      const stage = world.task.stages[Number(args[0])];
      if (!stage) throw Object.assign(new Error(`the task has no stage ${args[0]}`), { permanent: true });
      const r = await runCheck(world.copy, stage);
      return { passed: r.passed, text: `${r.stdout}${r.stderr}`, exitStatus: r.status ?? 1 };
    }
    throw Object.assign(new Error(`${command} is not a command of the host`), { permanent: true });
  });
  return {
    store,
    transports: {
      store,
      exec,
      secrets: (name) => {
        if (name === 'known-secrets') return JSON.stringify(known);
        if (name === 'mechanisms') return mechanisms === null ? undefined : JSON.stringify(mechanisms);
        return undefined;
      },
    },
    /** Sets the four switches, once. */
    setMechanisms(cfg) {
      if (mechanisms !== null) throw new Error('the mechanisms are set once, by the host, before the trial begins');
      mechanisms = Object.freeze({ fusion: cfg.fusion === true, compaction: cfg.compaction === true, pack: cfg.pack === true, reducer: cfg.reducer === true });
    },
    /** Sets the task's scratch copy (from tasks.mjs prepare), once. */
    setWorld({ copy, task, timeoutMs = 120_000 }) {
      if (world !== null) throw new Error('the task copy is set once, by the host');
      world = Object.freeze({ copy, task, timeoutMs });
    },
    get mechanisms() {
      return mechanisms;
    },
  };
}
