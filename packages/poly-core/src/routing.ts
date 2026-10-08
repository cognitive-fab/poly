// Routes and budgets (PS18, PT10r, M11): the compiler's expansion of `route r { … }` into the module `m.r`, std.routing
// with Route instantiated for r (PS18.1), and of `budget b { … }` into `m.b`, std.routing with Route left out. The
// calibration maps a route's tiers name are read by poly-check and passed in as data, as price tables are (money.ts);
// poly-ref writes the same modules from PS18 on its own, and is never given these.
import type * as A from './ast.js';
import { diag, type Diagnostic } from './diagnostics.js';
import { digest } from './digest.js';

/** A calibration map as `poly journal fit` writes it (PD1.6b): fitted for one model of one decision. */
export interface CalibrationFile {
  decision: string;
  version: number;
  fittedFor: string;
  /** `[raw, calibrated]` in thousandths, raw strictly ascending, calibrated non-decreasing. */
  points: [number, number][];
  digest: string;
}

/** A map as poly-check found it: the parsed JSON (unchecked), the file, and the digest of its bytes. */
export interface MapEntry {
  map: unknown;
  file: string;
  digest: string;
}

/** The files a module's routes name, keyed by the path as written, each found beside the source by poly-check. */
export interface RoutingFiles {
  prices: Record<string, import('./money.js').PriceEntry>;
  maps: Record<string, MapEntry>;
}

/**
 * PS18.3: a file a route names is a relative path under the source's directory, written with `/`, ending in `.json`,
 * with no `.` or `..` segment, so a route reads nothing outside its project.
 */
export function routePathOk(p: string): boolean {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*\.json$/.test(p)) return false;
  return p.split('/').every((s) => s !== '.' && s !== '..');
}

/** What is wrong with a calibration map, or null when it is the shape `poly journal fit` writes, with its digest right. */
export function mapProblem(m: unknown): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'is not a JSON object';
  const o = m as Record<string, unknown>;
  if (typeof o.decision !== 'string' || !o.decision) return 'names no decision';
  if (!Number.isSafeInteger(o.version) || (o.version as number) < 1) return 'has no version, a whole number from 1';
  if (typeof o.fittedFor !== 'string' || !o.fittedFor) return 'names no model it was fitted for (fittedFor)';
  const pts = o.points;
  if (!Array.isArray(pts) || !pts.length) return 'has no points';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const ok = Array.isArray(p) && p.length === 2 && p.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 1000);
    if (!ok) return `point ${i} is not [raw, calibrated] in thousandths`;
    if (i > 0 && !(p[0] > pts[i - 1][0])) return `its raw values are not strictly ascending at point ${i}`;
    if (i > 0 && p[1] < pts[i - 1][1]) return `it is not non-decreasing at point ${i}`;
  }
  // PD1.6b: the map is named by the digest of its decision, version, model and points, as poly journal fit writes it.
  if (o.digest !== digest({ decision: o.decision, version: o.version, fittedFor: o.fittedFor, points: pts })) return 'states a digest that is not the digest of its decision, version, model and points';
  return null;
}

/** The decisions of a module that name each route, by route name (PT24.1c). */
export function routedDecisions(module: A.Module): Map<string, { machine: A.Machine; decision: A.Decision }[]> {
  const out = new Map<string, { machine: A.Machine; decision: A.Decision }[]>();
  for (const m of module.decls) {
    if (m.kind !== 'Machine') continue;
    for (const d of m.items) {
      if (d.kind !== 'Decision') continue;
      for (const it of d.items) if (it.kind === 'DecRoute') out.set(it.route, [...(out.get(it.route) ?? []), { machine: m, decision: d }]);
    }
  }
  return out;
}

/** PS18.1: the rules of Route whose trigger is an answer below the thresholds. */
const BELOW_RULES = new Set(['below-thresholds-escalates', 'exhausted-after-the-last']);

const STD_CONDITION = (e: unknown): boolean => {
  // `conf < 0.8 || margin < 0.1`, as std.routing writes it, compared with no ids or spans.
  const n = e as A.Expr;
  if (n?.kind !== 'Binary' || n.op !== '||') return false;
  const cmp = (x: A.Expr, name: string, v: number) => x.kind === 'Binary' && x.op === '<' && x.left.kind === 'Name' && x.left.name === name && x.right.kind === 'Decimal' && x.right.value === v;
  return cmp(n.left, 'conf', 800) && cmp(n.right, 'margin', 100);
};
const LEFT_GT_ZERO = (e: unknown): boolean => {
  const n = e as A.Expr;
  return n?.kind === 'Binary' && n.op === '>' && n.left.kind === 'Name' && n.left.name === 'left' && n.right.kind === 'Int' && n.right.value === 0;
};

/** PS18.1: the route's condition as an expression: its conf and margin terms joined by `||`, or `false` with none. */
function conditionOf(r: A.Route, id: string): A.Expr {
  const terms = r.escalate.filter((t): t is { on: 'conf' | 'margin'; below: number } => t.on !== 'failed').map((t, i): A.Expr => ({
    kind: 'Binary', id: `${id}:t${i}`, op: '<', left: { kind: 'Name', id: `${id}:t${i}:l`, name: t.on }, right: { kind: 'Decimal', id: `${id}:t${i}:r`, value: t.below },
  } as A.Expr));
  if (!terms.length) return { kind: 'Bool', id: `${id}:false`, value: false } as A.Expr;
  return terms.reduce((a, b, i) => ({ kind: 'Binary', id: `${id}:or${i}`, op: '||', left: a, right: b } as A.Expr));
}

/**
 * PS18.0, PS18.1: each route `r` of a module `m` means the module `m.r`, std.routing with Budget left out and Route
 * instantiated for r: every type `0..1` of Route is `0..T-1` and `left` starts at `T-1`; every `conf < 0.8 || margin
 * < 0.1` is r's condition; without `failed`, every `left > 0` in Fail's handler is `false`; and the effect `call` has the
 * kind `route.r.call`, the labels of the decision that names r and one attempt within its timeout. Each budget `b`
 * means `m.b`, std.routing with Route left out.
 */
export function expandRoutes(module: A.Module, program: A.Module[]): { extra: A.Module[]; diagnostics: Diagnostic[] } {
  const routes = module.decls.filter((d): d is A.Route => d.kind === 'Route');
  const budgets = module.decls.filter((d): d is A.Budget => d.kind === 'Budget');
  const diagnostics: Diagnostic[] = [];
  if (!routes.length && !budgets.length) return { extra: [], diagnostics };
  const at = (n: A.NodeBase) => ({ module: module.name, node: n.id, line: n.span?.line, col: n.span?.col });
  const lib = program.find((m) => m.name === 'std.routing');
  const has = (name: string) => lib?.decls.some((d) => d.kind === 'Machine' && d.name === name);
  if (!lib || !has('Route') || !has('Budget')) {
    diagnostics.push(diag('PL1001', at(routes[0] ?? budgets[0]), 'no module std.routing with the machines Route and Budget, which a route and a budget mean (PS18.0)'));
    return { extra: [], diagnostics };
  }
  const taken = new Set(module.decls.flatMap((d) => (d.kind === 'Channel' || d.kind === 'Credential' ? [d.name] : [])));
  const decisions = routedDecisions(module);
  const extra: A.Module[] = [];
  const without = (name: string): A.Module => ({ ...structuredClone(lib), decls: structuredClone(lib.decls).filter((d) => !(d.kind === 'Machine' && d.name === name)) });
  // Review A1 (M11): a route's and a budget's names name a module and files of the build, so each is an identifier.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const r of routes) {
    if (!IDENT.test(r.name)) { diagnostics.push(diag('PL1201', at(r), `a route's name is an identifier, and ${JSON.stringify(r.name)} is not one (PT10r)`)); continue; }
    if (taken.has(r.name)) { diagnostics.push(diag('PL1002', at(r), `route ${r.name} has the name of another declaration that means a module ${module.name}.${r.name} (PS15, PS16, PS18)`)); continue; }
    taken.add(r.name);
    const T = Math.max(1, r.tiers.length);
    const named = decisions.get(r.name)?.[0]?.decision;
    const labels = named?.items.find((i): i is NodeBase & { kind: 'EffLabels'; labels: string[] } => i.kind === 'EffLabels')?.labels;
    const timeout = (named?.items.find((i) => i.kind === 'DecTimeout') as { value: string } | undefined)?.value;
    const failed = r.escalate.some((t) => t.on === 'failed');
    const mod = without('Budget');
    const route = mod.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === 'Route')!;
    const rewrite = (x: unknown, inFail: boolean): unknown => {
      if (Array.isArray(x)) return x.map((y) => rewrite(y, inFail));
      if (!x || typeof x !== 'object') return x;
      const n = x as Record<string, unknown>;
      if (n.kind === 'TRange' && n.lo === 0 && n.hi === 1) return { ...n, hi: T - 1 };
      if (STD_CONDITION(n)) return conditionOf(r, `${n.id as string}:${r.name}`);
      if (inFail && !failed && LEFT_GT_ZERO(n)) return { kind: 'Bool', id: `${n.id as string}:${r.name}`, value: false };
      if (n.kind === 'Field' && n.name === 'left') return { ...n, type: rewrite(n.type, false), init: { kind: 'Int', id: `${(n.init as A.NodeBase).id}:${r.name}`, value: T - 1 } };
      if (n.kind === 'EffKind') return { ...n, value: `route.${r.name}.call`, generated: 'route' };
      if (n.kind === 'EffLabels' && labels) return { ...n, labels: [...labels] };
      if (n.kind === 'EffRetry' && timeout) return { ...n, attempts: 1, timeout };
      const fail = inFail || (n.kind === 'Handler' && n.action === 'Fail');
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, rewrite(v, fail)]));
    };
    const instantiated = rewrite(route, false) as A.Machine;
    // PS18.1, ruled on the review of M11: with no conf or margin term, the rules whose trigger is an answer below the
    // thresholds are not instantiated for the route.
    if (!r.escalate.some((t) => t.on !== 'failed')) instantiated.items = instantiated.items.filter((i) => !(i.kind === 'Property' && BELOW_RULES.has(i.name)));
    mod.decls[mod.decls.indexOf(route)] = instantiated;
    extra.push({ ...mod, name: `${module.name}.${r.name}`, id: `${r.id}:module` });
  }
  for (const b of budgets) {
    if (!IDENT.test(b.name)) { diagnostics.push(diag('PL1201', at(b), `a budget's name is an identifier, and ${JSON.stringify(b.name)} is not one (PT10r)`)); continue; }
    if (taken.has(b.name)) { diagnostics.push(diag('PL1002', at(b), `budget ${b.name} has the name of another declaration that means a module ${module.name}.${b.name} (PS15, PS16, PS18)`)); continue; }
    taken.add(b.name);
    extra.push({ ...without('Route'), name: `${module.name}.${b.name}`, id: `${b.id}:module` });
  }
  return { extra, diagnostics };
}

type NodeBase = A.NodeBase;
