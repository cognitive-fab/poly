// PT34.2, PT34.3, S586: what a project that opts in to risk reporting adds to its check and its certificate. A project
// opts in when poly.json declares `exposure` or any policy item carries a tag; one that has not gets nothing from here,
// so its check output and its certificate are v1.5.1's (RT15).
import { exposureProblem, hasTags, loadCatalogs, ManifestError, type Catalogs, type Manifest, type Module, type PolicyItem } from '@poly/core';

/** A warning of PT12.3a: beside the verdict, never in it, and certified nowhere. */
export interface RiskWarning { kind: 'risk'; warning: 'untagged' | 'no-control' | 'uncovered'; item?: string; risk?: string; text: string }

/** `poly.risk` in the certificate (PT34.3): the catalogs, the exposure and every policy item of every scope. */
export interface RiskRecord {
  catalogs: { catalog: string; version: string; digest: string }[];
  exposure: string[];
  items: Record<string, { scope: string; kind: 'rule' | 'machine' | 'invariant' | 'recalled' | 'never'; risks: string[]; controls: string[] }>;
}

const KIND: Record<PolicyItem['kind'], RiskRecord['items'][string]['kind']> = {
  RuleObligation: 'rule', MachineObligation: 'machine', InvariantObligation: 'invariant', Recalled: 'recalled', Never: 'never',
};
const sorted = (ts: { tag: string }[] | undefined) => [...new Set((ts ?? []).map((t) => t.tag))].sort();

/** Whether a project opts in (PT34.2). */
export const optsIn = (manifest: Manifest, program: readonly Module[]): boolean => manifest.exposure !== undefined || hasTags(program);

/** Every policy item of the program, in source order, with its scope and its tags as the formatter orders them. */
function itemsOf(program: readonly Module[]) {
  const out: { id: string; scope: string; item: PolicyItem; risks: string[]; controls: string[] }[] = [];
  for (const m of program) for (const d of m.decls) {
    if (d.kind !== 'Policy') continue;
    for (const it of d.items) out.push({ id: `${d.name}.${it.name}`, scope: d.scope, item: it, risks: sorted(it.mitigates), controls: sorted(it.implements) });
  }
  return out;
}

/**
 * PT34.2: each exposure id is a MIT subdomain, or PL6507, an error of the manifest (it refuses the check, as an unknown
 * field does). `where` is the manifest's path.
 */
export function checkExposure(manifest: Manifest, catalogs: () => Catalogs, where: string): void {
  for (const r of manifest.exposure?.risks ?? []) {
    const why = exposureProblem(r, catalogs());
    if (why) throw new ManifestError(`${where}: PL6507 EXPOSURE_TAG_UNKNOWN: exposure ${why}`);
  }
}

/** PT34.2: the warnings of a project that opts in, items in source order, then the exposed risks no item mitigates. */
export function riskWarnings(manifest: Manifest, program: readonly Module[]): RiskWarning[] {
  const out: RiskWarning[] = [];
  const items = itemsOf(program);
  for (const x of items) {
    if (!x.risks.length) out.push({ kind: 'risk', warning: 'untagged', item: x.id, text: `untagged: ${x.id} names no risk it mitigates (PT8.6)` });
    else if (!x.controls.length) out.push({ kind: 'risk', warning: 'no-control', item: x.id, text: `no control: ${x.id} names no control it implements (PT8.6)` });
  }
  const named = new Set(items.flatMap((x) => x.risks));
  for (const r of [...new Set(manifest.exposure?.risks ?? [])].sort()) {
    if (!named.has(r)) out.push({ kind: 'risk', warning: 'uncovered', risk: r, text: `uncovered: ${r} is listed as an exposure and no rule mitigates it (PT34.2)` });
  }
  return out;
}

/** PT34.3: the certificate's `poly.risk`, for a project that opts in. */
export function riskRecord(exposure: readonly string[] | undefined, program: readonly Module[], std?: string): RiskRecord {
  const catalogs = loadCatalogs(std);
  const items: RiskRecord['items'] = {};
  for (const x of itemsOf(program)) items[x.id] = { scope: x.scope, kind: KIND[x.item.kind], risks: x.risks, controls: x.controls };
  return {
    catalogs: Object.values(catalogs).map((c) => ({ catalog: c.catalog, version: c.version, digest: c.digest })).sort((a, b) => (a.catalog < b.catalog ? -1 : 1)),
    exposure: [...new Set(exposure ?? [])].sort(),
    items,
  };
}
