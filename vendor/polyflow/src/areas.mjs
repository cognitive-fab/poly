// Areas — the two-tier addressing polyflow runs on.
//
//   agent area     one per agent CLASS ("openworker/cowork", "claude-code").
//                  Owns the workflow library: what this kind of agent knows
//                  how to do. Shared by every running copy.
//   instance area  one per running COPY ("workspace=/home/x/acme"). Owns the
//                  live instances and their journals.
//
// The mapping onto OpenWorker needs no new fields: agent area is
// ScheduledTask.agent (plus personas/, teams/), instance area is `workspace`
// — which is already coworker.memory.Scope.WORKSPACE.
//
// The instance id is derived, not random, so "start" and "attach" are the same
// call: a cron task that fires nightly re-attaches to the run it left open
// instead of starting a fresh one.

const clean = (s) => String(s ?? '')
  .trim()
  .replace(/[^A-Za-z0-9._/@-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'default';

export class Area {
  constructor({ agent = 'default', instance = 'default' } = {}) {
    this.agent = clean(agent);
    this.instance = clean(instance);
  }

  /** Stable id for one long-lived run of `workflow`, keyed by the caller's key. */
  instanceId(workflow, key) {
    return `${this.agent}|${this.instance}|${clean(workflow)}|${clean(key)}`;
  }

  static parse(instanceId) {
    const [agent, instance, workflow, key] = String(instanceId).split('|');
    return { agent, instance, workflow, key };
  }

  toString() { return `${this.agent}|${this.instance}`; }
}
