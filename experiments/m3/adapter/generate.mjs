// The host adapter generator of M3 (M3-4, S90, S91).
//
// In the poly arms the agent writes host.map.json as part of its solution: which instance and action each
// method of the host interface drives, and which fields each query reads. This generator validates the map
// against the host interface and the agent's poly module, and a map that names a machine, an instance, an
// action, a parameter, an argument or a field that does not exist is a failed build: every error is listed,
// and nothing is written. A valid map gives a TypeScript module, host.gen.ts, whose default export creates
// a fresh host over polyrun's kernel (M3-4): a method dispatches one action to one instance, a query reads
// the instance's flat state, and the network methods drive polyrun's message worker one message at a time
// (S89, S91). The machines are lowered beside it, in build/.
//
// Usage: node generate.mjs --map host.map.json --host host.ts --module <file.poly|file.ts> --out <dir>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';

const NETWORK = ['inFlight', 'deliver', 'deliverAll'];
const RETURNS = ['verdict', 'state', 'nothing'];
const ARG = /^\$arg:([A-Za-z_$][\w$]*)$/;

/** The members of `interface Host` in a host interface, with their parameter names, and whether it has the network API. */
export function readHost(text, file = 'host.ts') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const members = new Map();
  let network = false;
  let found = false;
  for (const st of sf.statements) {
    if (!ts.isInterfaceDeclaration(st) || st.name.text !== 'Host') continue;
    found = true;
    network = (st.heritageClauses ?? []).some((h) => h.types.some((x) => x.expression.getText(sf) === 'Network'));
    for (const m of st.members) {
      if (!m.name || !ts.isIdentifier(m.name)) continue;
      const params = ts.isMethodSignature(m) ? m.parameters.map((p) => p.name.getText(sf)) : null;
      if (params) members.set(m.name.text, params);
    }
  }
  return { found, members, network };
}

function loadModule(file) {
  const text = readFileSync(file, 'utf8');
  const parsed = file.endsWith('.ts') ? readEmbedded(text, file) : parse(text);
  if (!parsed.module) return { errors: parsed.diagnostics.map((d) => `the module does not parse: ${d.code} ${d.message}`) };
  const checked = checkModule(parsed.module);
  const errors = checked.diagnostics.filter((d) => d.severity === 'error').map((d) => `the module does not check: ${d.code} ${d.message}`);
  return { module: parsed.module, checked, errors };
}

const keysOnly = (obj, allowed, where, errors) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { errors.push(`${where} is not an object`); return false; }
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where} has an unknown key '${k}'`);
  return true;
};

/**
 * Validates a map against the host interface and the module (S90). Returns the errors, empty when it is valid.
 * `host` is readHost's result; `module` the checked poly module.
 */
export function validate(map, host, module) {
  const errors = [];
  if (!keysOnly(map, ['$schema', 'module', 'instances', 'methods', 'queries'], 'host.map.json', errors)) return errors;
  for (const k of ['module', 'instances', 'methods', 'queries']) if (!(k in map)) errors.push(`host.map.json has no '${k}'`);
  if (errors.length) return errors;
  if (map.module !== module.name) errors.push(`module: the map names '${map.module}', and the module is '${module.name}'`);
  if (!host.found) errors.push('host.ts declares no interface Host');
  const machines = new Map(module.decls.filter((d) => d.kind === 'Machine').map((d) => [d.name, d]));
  const typeDecl = (name) => module.decls.find((d) => (d.kind === 'EnumDecl' || d.kind === 'TypeDecl') && d.name === name);
  const instances = map.instances ?? {};
  const methods = map.methods ?? {};
  const queries = map.queries ?? {};

  // An instance name, or a family of instances a method creates, keyed by one of its arguments.
  for (const [name, inst] of Object.entries(instances)) {
    const where = `instances.${name}`;
    if (!keysOnly(inst, ['machine', 'createdBy', 'keyArgument', 'init'], where, errors)) continue;
    const m = machines.get(inst.machine);
    if (!m) { errors.push(`${where}: no machine '${inst.machine}' in module ${module.name}`); continue; }
    if ((inst.createdBy === undefined) !== (inst.keyArgument === undefined)) errors.push(`${where}: createdBy and keyArgument go together`);
    if (inst.createdBy !== undefined) {
      if (!(inst.createdBy in methods)) errors.push(`${where}: createdBy names no method '${inst.createdBy}'`);
      else if (methods[inst.createdBy].instance !== name) errors.push(`${where}: its createdBy method '${inst.createdBy}' targets '${methods[inst.createdBy].instance}', not this family`);
      const params = host.members.get(inst.createdBy);
      if (params && !params.includes(inst.keyArgument)) errors.push(`${where}: keyArgument '${inst.keyArgument}' is not an argument of ${inst.createdBy}(${params.join(', ')})`);
    }
    for (const [field, value] of Object.entries(inst.init ?? {})) {
      const f = m.fields.find((x) => x.name === field);
      if (!f) { errors.push(`${where}.init: ${m.name} has no field '${field}'`); continue; }
      const bad = initError(f.type, value, instances, typeDecl);
      if (bad) errors.push(`${where}.init.${field}: ${bad}`);
    }
  }

  // The instance a method or query targets: a named instance, or a family with the argument that keys it.
  const target = (spec, where, params) => {
    const inst = instances[spec.instance];
    if (!inst) { errors.push(`${where}: no instance or family '${spec.instance}' in instances`); return null; }
    const keyed = inst.createdBy !== undefined;
    if (keyed && spec.key === undefined) errors.push(`${where}: '${spec.instance}' is a family, so the method names its key: "key": "$arg:<argument>"`);
    if (!keyed && spec.key !== undefined) errors.push(`${where}: '${spec.instance}' is one instance, so it takes no key`);
    if (spec.key !== undefined) {
      const a = ARG.exec(spec.key);
      if (!a) errors.push(`${where}.key: '${spec.key}' is not $arg:<argument>`);
      else if (params && !params.includes(a[1])) errors.push(`${where}.key: '${a[1]}' is not an argument of ${where.split('.')[1]}(${params.join(', ')})`);
    }
    return machines.get(inst.machine) ?? null;
  };

  for (const [name, spec] of Object.entries(methods)) {
    const where = `methods.${name}`;
    if (!keysOnly(spec, ['instance', 'key', 'action', 'params', 'returns'], where, errors)) continue;
    const params = host.members.get(name);
    if (!params) errors.push(`${where}: the Host interface has no method '${name}'`);
    if (NETWORK.includes(name)) errors.push(`${where}: '${name}' is the network API, which the adapter implements itself (S91)`);
    if (spec.returns !== undefined && !RETURNS.includes(spec.returns)) errors.push(`${where}.returns: '${spec.returns}' is not one of ${RETURNS.join(', ')}`);
    const m = target(spec, where, params);
    if (!m) continue;
    const action = m.items.find((i) => i.kind === 'Action' && i.name === spec.action);
    if (!action) { errors.push(`${where}: ${m.name} has no action '${spec.action}'`); continue; }
    const given = spec.params ?? {};
    for (const p of action.params) if (!(p.name in given)) errors.push(`${where}.params: ${m.name}.${action.name} takes '${p.name}', which the map does not give`);
    for (const [p, v] of Object.entries(given)) {
      if (!action.params.some((x) => x.name === p)) errors.push(`${where}.params: ${m.name}.${action.name} has no parameter '${p}'`);
      const a = typeof v === 'string' ? ARG.exec(v) : null;
      if (a && params && !params.includes(a[1])) errors.push(`${where}.params.${p}: '${a[1]}' is not an argument of ${name}(${params.join(', ')})`);
    }
  }

  for (const [name, spec] of Object.entries(queries)) {
    const where = `queries.${name}`;
    if (!keysOnly(spec, ['instance', 'key', 'fields'], where, errors)) continue;
    const params = host.members.get(name);
    if (!params) errors.push(`${where}: the Host interface has no method '${name}'`);
    if (name in methods) errors.push(`${where}: '${name}' is mapped as a method too`);
    const m = target(spec, where, params);
    if (!m) continue;
    for (const [out, field] of Object.entries(spec.fields ?? {})) if (!m.fields.some((f) => f.name === field)) errors.push(`${where}.fields.${out}: ${m.name} has no field '${field}'`);
  }

  // Every member of Host is driven by the map, except the network API, which the adapter implements.
  for (const name of host.members.keys()) {
    if (NETWORK.includes(name)) continue;
    if (!(name in methods) && !(name in queries)) errors.push(`the Host interface's '${name}' is neither a method nor a query of the map`);
  }
  return errors;
}

/** Why an initial value does not fit its field's type, or null. Only the types a configuration sets are taken. */
function initError(t, v, instances, typeDecl) {
  switch (t.kind) {
    case 'TBool': return typeof v === 'boolean' ? null : `${JSON.stringify(v)} is not a bool`;
    case 'TInt': return Number.isInteger(v) ? null : `${JSON.stringify(v)} is not an int`;
    case 'TString': return typeof v === 'string' ? null : `${JSON.stringify(v)} is not a string`;
    case 'TRange': return Number.isInteger(v) && v >= t.lo && v <= t.hi ? null : `${JSON.stringify(v)} is not in ${t.lo}..${t.hi}`;
    case 'TRef': {
      if (v === null) return null;
      const inst = instances[v];
      if (!inst || inst.createdBy !== undefined) return `${JSON.stringify(v)} is not an instance created with the host`;
      const want = t.machine[t.machine.length - 1];
      return inst.machine === want ? null : `${v} is a ${inst.machine}, not a ${want}`;
    }
    case 'TName': {
      const d = typeDecl(t.name);
      const members = d?.kind === 'EnumDecl' ? d.members : d?.kind === 'TypeDecl' && d.ctors.every((c) => !c.fields.length) ? d.ctors.map((c) => c.name) : null;
      if (!members) return `a field of type ${t.name} cannot be set by the map`;
      return members.includes(v) ? null : `${JSON.stringify(v)} is not a member of ${t.name}`;
    }
    default: return `a field of this type cannot be set by the map`;
  }
}

/** The adapter's source: the map as data, and one method per member of Host with its parameters in order. */
function emit(map, host, machines, polyrun) {
  const members = [...host.members].filter(([n]) => !NETWORK.includes(n));
  const methods = members.map(([n, params]) => `    ${n}: (${params.join(', ')}) => ${n in map.methods ? 'call' : 'query'}(${JSON.stringify(n)}, { ${params.join(', ')} }),`);
  return `// Generated by experiments/m3/adapter/generate.mjs from host.map.json (M3-4, S90). Do not edit.
// A fresh host over polyrun's kernel: a method dispatches one action to one instance, a query reads the
// instance's flat state, and the network methods deliver messages one at a time (S89, S91).
import { fileURLToPath } from 'node:url';
import { createRuntime } from ${JSON.stringify(polyrun)};

const MAP = ${JSON.stringify(map, null, 2)};
const MACHINES = ${JSON.stringify(machines, null, 2)};
const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const ARG = /^\\$arg:(.+)$/;

export default async function createHost() {
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: MACHINES.map((m) => ({ machineId: m.machineId, module: at(m.module), contract: at(m.contract), ...(m.effects ? { effects: { mapper: at(m.effects.mapper), manifest: at(m.effects.manifest) } } : {}) })),
  });
  let n = 0;
  const actionId = () => \`host-\${++n}\`;
  // An instance starts in its machine's initial state, with the map's values in place (as a configuration's, PS13.1).
  const make = async (id, spec) => {
    await rt.create(spec.machine, id);
    if (spec.init && Object.keys(spec.init).length) {
      const inst = await rt.store.getInstance(id);
      rt.store.db.prepare('UPDATE pr_instance SET state = ? WHERE instance_id = ?').run(JSON.stringify({ ...inst.state, ...spec.init }), id);
    }
  };
  for (const [name, spec] of Object.entries(MAP.instances)) if (spec.createdBy === undefined) await make(name, spec);
  const idOf = (spec, args) => (spec.key === undefined ? spec.instance : String(args[ARG.exec(spec.key)[1]]));
  const valueOf = (v, args) => (typeof v === 'string' && ARG.test(v) ? args[ARG.exec(v)[1]] : v);
  const call = async (name, args) => {
    const spec = MAP.methods[name];
    const id = idOf(spec, args);
    const family = MAP.instances[spec.instance];
    if (family.createdBy === name && !(await rt.store.getInstance(id))) await make(id, family);
    if (!(await rt.store.getInstance(id))) return spec.returns === 'nothing' ? undefined : { ok: false, reason: 'unknown' };
    const data = Object.fromEntries(Object.entries(spec.params ?? {}).map(([p, v]) => [p, valueOf(v, args)]));
    const r = await rt.dispatch(id, spec.action, data, actionId());
    if (spec.returns === 'nothing') return undefined;
    if (spec.returns === 'state') return (await rt.getState(id)).state;
    return r.stepKind === 'accepted' ? { ok: true } : { ok: false, reason: r.rejectReason ?? r.stepKind };
  };
  const query = async (name, args) => {
    const spec = MAP.queries[name];
    const inst = await rt.getState(idOf(spec, args)).catch(() => null);
    if (!inst) return null;
    return Object.fromEntries(Object.entries(spec.fields).map(([out, f]) => [out, inst.state[f]]));
  };
  const inFlight = async () => (await rt.workers.pendingMessages()).map(({ id, from, to, action, data }) => ({ id, from, to, action, data }));
  return {
    inFlight,
    async deliver(id) {
      if (!(await rt.workers.deliverMessage(id))) throw new Error(\`no message \${id} in transit\`);
    },
    async deliverAll() {
      // A bound, so a system that sends forever fails here instead of hanging the test.
      for (let i = 0; i < 10000; i++) if (!(await rt.workers.tickMessages())) return;
      throw new Error('deliverAll: messages still in transit after 10000 rounds');
    },
${methods.join('\n')}
    close: () => rt.close(),
  };
}
`;
}

/**
 * Validates and generates. Returns { errors } on a failed build, with nothing written; else { files }, the
 * paths written under `out`.
 */
export function generate({ mapFile, hostFile, moduleFile, out, polyrun = '@cognitive-fab/polygraph/polyrun/src/index.mjs' }) {
  let map;
  try { map = JSON.parse(readFileSync(mapFile, 'utf8')); } catch (e) { return { errors: [`host.map.json does not parse: ${e.message}`] }; }
  const host = readHost(readFileSync(hostFile, 'utf8'), hostFile);
  const loaded = loadModule(moduleFile);
  if (loaded.errors.length) return { errors: loaded.errors };
  const errors = validate(map, host, loaded.module);
  if (errors.length) return { errors };
  const machines = [];
  const lowered = [];
  for (const machine of loaded.checked.machines.keys()) {
    const r = lowerMachine(loaded.module, loaded.checked, machine);
    if (!r.lowered) return { errors: r.diagnostics.map((d) => `${machine} does not lower: ${d.code} ${d.message}`) };
    lowered.push([machine, r.lowered.files]);
  }
  rmSync(join(out, 'build'), { recursive: true, force: true });
  const files = [];
  for (const [machine, fs] of lowered) {
    const rel = `build/${loaded.module.name}.${machine}`;
    mkdirSync(join(out, rel), { recursive: true });
    for (const [f, text] of Object.entries(fs)) { writeFileSync(join(out, rel, f), text); files.push(`${rel}/${f}`); }
    machines.push({ machineId: machine, module: `./${rel}/next.cjs`, contract: `./${rel}/contract.json`, ...(fs['effects.cjs'] ? { effects: { mapper: `./${rel}/effects.cjs`, manifest: `./${rel}/effects.manifest.json` } } : {}) });
  }
  writeFileSync(join(out, 'host.gen.ts'), emit(map, host, machines, polyrun));
  files.push('host.gen.ts');
  return { files };
}

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mapFile, hostFile, moduleFile, out] = ['map', 'host', 'module', 'out'].map(flag);
  if (!mapFile || !hostFile || !moduleFile || !out) {
    console.error(`usage: node ${basename(process.argv[1])} --map host.map.json --host host.ts --module <file.poly|file.ts> --out <dir>`);
    process.exit(64);
  }
  mkdirSync(out, { recursive: true });
  const r = generate({ mapFile, hostFile, moduleFile, out });
  if (r.errors) {
    console.error(`host.map.json: failed build (S90)\n${r.errors.map((e) => `  ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`wrote ${r.files.length} files to ${out}`);
}
