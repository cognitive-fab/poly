// The workflow library — polyflow's procedural memory.
//
// A workflow is a directory holding the five artifacts polyrun needs plus a
// manifest that maps each effect kind to the AGENT tool that fulfils it:
//
//   polyflow.workflow.json   name, description, area, tools{kind -> {tool,target,why}},
//                            key{template,fields} — the run's identity, DERIVED
//   contract.json            states, actions, finite data domain
//   machine.cjs              SAM v2 strict-profile module
//   effects.cjs              pure mapper: transition -> effect intents
//   effects.manifest.json    per-kind completion actions + retry policy
//   effect-invariants.mjs    what the machine o mapper may EMIT, on every path
//
// Nothing enters the library on the strength of "it worked once". `publish`
// runs the exhaustive emission check first and refuses on any violation.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkEffects, renderReport } from './polyrun.mjs';

const DESCRIPTOR = 'polyflow.workflow.json';

/**
 * A workflow may DERIVE its run key from typed input fields instead of letting
 * the caller name it. That is the difference between "this is the 2026-08-25
 * run" and "this is whatever the agent decided to call it" — see
 * FINDINGS-phase3.md §6: an agent that finds a completed run will otherwise
 * invent a fresh key and legitimately do the job twice.
 */
function parseKeyPolicy(raw) {
  if (!raw || !raw.template) return null;
  const template = String(raw.template);
  const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`key.template '${template}' names no fields`);
  const declared = raw.fields ?? {};
  const fields = names.map((name) => {
    const f = declared[name] ?? {};
    return {
      name,
      pattern: f.pattern ? new RegExp(f.pattern) : null,
      patternSource: f.pattern ?? null,
      description: f.description ?? '',
    };
  });
  return { template, fields };
}

/** Resolve a run key from the caller's input, or explain precisely why not. */
export function deriveKey(policy, input = {}) {
  const problems = [];
  let key = policy.template;
  for (const field of policy.fields) {
    const raw = input?.[field.name];
    if (raw === undefined || raw === null || raw === '') {
      problems.push(`input.${field.name} is required${field.description ? ` (${field.description})` : ''}`);
      continue;
    }
    const value = String(raw);
    if (field.pattern && !field.pattern.test(value)) {
      problems.push(
        `input.${field.name} = ${JSON.stringify(value)} does not match ${field.patternSource}` +
        (field.description ? ` (${field.description})` : '')
      );
      continue;
    }
    key = key.replaceAll(`{${field.name}}`, value);
  }
  if (problems.length) {
    const err = new Error(
      `this workflow derives its run key from ${policy.fields.map((f) => `input.${f.name}`).join(', ')}, ` +
      `not from a key you choose. ${problems.join('; ')}. ` +
      `Fix the input rather than inventing a different key — a second key would run the job again.`
    );
    err.expected = true;
    throw err;
  }
  return key;
}

export class Library {
  constructor(dir) {
    this.dir = resolve(dir);
    this.workflows = new Map();
  }

  load() {
    this.workflows.clear();
    if (!existsSync(this.dir)) return this;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      if (!statSync(path).isDirectory()) continue;
      if (!existsSync(join(path, DESCRIPTOR))) continue;
      const wf = this._read(name, path);
      // `list()` advertises wf.name and `get()` looks up by directory. Let
      // those disagree and the workflow is listed under a name that cannot be
      // started — "unknown workflow" for something the agent was just offered.
      if (wf.name !== name) {
        throw new Error(
          `workflow in '${name}/' calls itself '${wf.name}'. `
          + 'A workflow is named by its directory — rename one to match the other.'
        );
      }
      this.workflows.set(name, wf);
    }
    return this;
  }

  _read(name, path) {
    const d = JSON.parse(readFileSync(join(path, DESCRIPTOR), 'utf-8'));
    const file = (k, dflt) => resolve(path, d[k] ?? dflt);
    const contract = JSON.parse(readFileSync(file('contract', 'contract.json'), 'utf-8'));
    const terminalKey = contract.terminalKey
      ?? (contract.stateKeys && contract.stateKeys[0] && contract.stateKeys[0].name);
    return {
      terminal: { key: terminalKey, values: new Set(contract.terminalStates ?? []) },
      name: d.name ?? name,
      dir: path,
      description: d.description ?? '',
      area: d.area ?? 'default',
      tools: d.tools ?? {},
      key: parseKeyPolicy(d.key),
      inputAction: d.inputAction ?? 'START',
      contract: file('contract', 'contract.json'),
      module: file('machine', 'machine.cjs'),
      mapper: file('effects', 'effects.cjs'),
      manifest: file('manifest', 'effects.manifest.json'),
      effectInvariants: file('effectInvariants', 'effect-invariants.mjs'),
      invariants: existsSync(file('invariants', 'invariants.mjs'))
        ? file('invariants', 'invariants.mjs') : undefined,
      certified: d.certified ?? null,
    };
  }

  get(name) { return this.workflows.get(name); }

  get keyPolicies() {
    return Object.fromEntries([...this.workflows].map(([n, w]) => [n, w.key]));
  }
  list() {
    return [...this.workflows.values()].map((w) => ({
      name: w.name, description: w.description, area: w.area,
      key: w.key ? { derived_from: w.key.fields.map((f) => f.name), template: w.key.template } : null,
      tools: Object.entries(w.tools).map(([kind, t]) => `${kind} -> ${t.tool}`),
      certified: w.certified,
    }));
  }

  /**
   * The admission gate. Exhaustively enumerates every reachable emission path
   * over the contract's declared domain and checks the effect invariants.
   * Returns {ok, report, summary}; a caller must not register on ok:false.
   */
  async certify(wf, { maxDepth = 12, maxPaths = 50_000 } = {}) {
    const invMod = await import(pathToFileURL(wf.effectInvariants).href);
    const invariantNames = (invMod.effectInvariants ?? []).map((i) => i.name);
    const result = await checkEffects({
      module: wf.module, mapper: wf.mapper, manifest: wf.manifest,
      invariants: wf.effectInvariants, contract: wf.contract, maxDepth, maxPaths,
    });
    const violations = result.violations ?? [];
    // A bounded run is not a pass — polyrun's doctrine, kept here: a workflow
    // whose exploration hit the depth/path ceiling is not admitted.
    const bounded = Boolean(result.bounded);
    return {
      ok: violations.length === 0 && !bounded,
      bounded,
      violations,
      invariantNames,
      pathsExplored: result.pathsExplored,
      statesSeen: result.statesSeen,
      notes: result.notes ?? [],
      report: renderReport(result),
    };
  }

  /** polyrun `machines` entry for a certified workflow. */
  machineSpec(wf) {
    return {
      machineId: wf.name,
      module: wf.module,
      contract: wf.contract,
      effects: { mapper: wf.mapper, manifest: wf.manifest },
      ...(wf.invariants ? { invariants: wf.invariants } : {}),
      effectInvariants: wf.effectInvariants,
    };
  }
}
