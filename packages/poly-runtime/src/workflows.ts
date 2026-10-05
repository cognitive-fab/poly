// Workflows on poly-runtime (PT10, S164, M8a step 2): what polyflow's daemon did for a run, done over this runtime so
// that every work order crosses the gate (S173). A run is an instance of the workflow's machine, named by its key; the
// key is derived from the input when the workflow declares a key template, as polyflow derives it, so an agent cannot
// start the same work twice under a key it invents. The views carry polyflow's fields, so the six MCP tools keep
// polyflow's schemas (S174).
import type { VerifiedWorkflow } from './load.js';

export class WorkflowError extends Error {
  /** An error the agent can act on (a bad input, an unknown name), as polyflow marks its own. */
  readonly expected = true;
  constructor(message: string) { super(message); this.name = 'WorkflowError'; }
}

/** polyflow's deriveKey: each template field from the input, checked against its pattern; a problem is the caller's. */
export function deriveKey(w: VerifiedWorkflow, input: Record<string, unknown>): string {
  const problems: string[] = [];
  let key = w.key.template;
  for (const name of keyFields(w)) {
    const f = w.key.fields?.[name] ?? {};
    const raw = input?.[name];
    if (raw === undefined || raw === null || raw === '') { problems.push(`input.${name} is required`); continue; }
    const value = String(raw);
    if (f.pattern !== undefined && !new RegExp(f.pattern).test(value)) { problems.push(`input.${name} = ${JSON.stringify(value)} does not match ${f.pattern}`); continue; }
    key = key.split(`{${name}}`).join(value);
  }
  if (problems.length) {
    throw new WorkflowError(`this workflow derives its run key from ${keyFields(w).map((n) => `input.${n}`).join(', ')}, not from a key you choose. ${problems.join('; ')}. Fix the input rather than inventing a different key: a second key would run the job again.`);
  }
  return key;
}

/** The fields a key template names, in order (PT10: each is a parameter of the input action). */
export const keyFields = (w: VerifiedWorkflow): string[] => [...new Set([...w.key.template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];

/** A run's instance id: the workflow and its key, as polyflow's last two segments. */
export const runIdOf = (workflow: string, key: string): string => `${workflow}|${key}`;
export const keyOfRun = (instanceId: string): string => instanceId.slice(instanceId.indexOf('|') + 1);
