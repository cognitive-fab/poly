// Admission reads proposals back (PS21.4, PS21.6, PT31.6): each `proposals/<name>.json` is checked against the sources, in file
// order, and the certificate lists them. A rule that its own history does not support is refused with PL6520, naming the
// rule, its numbers and the thresholds (S517); an evidence file that does not describe the sources, or sources with a path
// property the evidence does not name, is refused with PL6521. The check of the machine itself is the ordinary one: a path
// property the machine breaks is PL4001 with a witness, as for any program.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, sha256OfBytes } from '@poly/core';
import { parse } from '@poly/lang';

export interface Proposal { name: string; evidence: string; tool: { name: string; version: string; pin: string } }
export interface ProposalProblem { code: 'PL6520' | 'PL6521'; entry: string; message: string }

/** The floors of PT31.5: polyness proposes only from five instances, and only a rule the history keeps for 0.6 of them. */
export const PROPOSAL_FLOORS = { minInstances: 5, ownSupport: 0.6 } as const;

const under = (slug: string) => slug.replace(/-/g, '_');

export function readProposals(project: string): { list: Proposal[]; files: Record<string, string>; problems: ProposalProblem[] } {
  const dir = join(project, 'proposals');
  const list: Proposal[] = [];
  const files: Record<string, string> = {};
  const problems: ProposalProblem[] = [];
  if (!existsSync(dir)) return { list, files, problems };

  // The modules of the project, by name, with the names of their path properties.
  const modules = new Map<string, string[]>();
  for (const f of loadProject(project).files) {
    const text = readFileSync(f, 'utf8');
    const m = parse(text).module;
    if (m) modules.set(m.name, [...text.matchAll(/^\s*path property ([A-Za-z0-9_-]+)\s*:/gm)].map((x) => x[1]));
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const rel = `proposals/${file}`;
    const slug = file.slice(0, -'.json'.length);
    const bytes = readFileSync(join(dir, file));
    files[rel] = sha256OfBytes(bytes);
    const bad = (code: ProposalProblem['code'], message: string) => problems.push({ code, entry: rel, message });
    let e: { v?: unknown; kind?: unknown; name?: unknown; rules?: unknown; tool?: { name?: unknown; version?: unknown; pin?: unknown } };
    try { e = JSON.parse(bytes.toString('utf8')); } catch { bad('PL6521', `${rel} is not JSON`); continue; }
    if (!e || typeof e !== 'object' || e.kind !== 'poly.proposal' || e.v !== 1) { bad('PL6521', `${rel} is not a poly.proposal of version 1 (PT31.5)`); continue; }
    if (e.name !== slug) { bad('PL6521', `${rel} names the proposal ${JSON.stringify(e.name)}, and the file is named for ${slug}`); continue; }
    const paths = modules.get(under(slug));
    if (!paths) { bad('PL6521', `${rel} has no source: the project has no module ${under(slug)}`); continue; }
    const tool = e.tool;
    if (!tool || tool.name !== 'polyness' || typeof tool.version !== 'string' || typeof tool.pin !== 'string') { bad('PL6521', `${rel} does not record the tool that proposed it: { name: "polyness", version, pin } (PT31.5)`); continue; }

    // PL6520: every rule is supported by the person's own history (S517).
    const rules = Array.isArray(e.rules) ? (e.rules as Record<string, unknown>[]) : [];
    const named: string[] = [];
    for (const r of rules) {
      const name = String(r?.name);
      named.push(name);
      const s = r?.support as { holds?: unknown; of?: unknown } | undefined;
      const nums = !!s && typeof s.holds === 'number' && typeof s.of === 'number' && Number.isFinite(s.holds) && Number.isFinite(s.of);
      const thresholds = `the history needs at least ${PROPOSAL_FLOORS.minInstances} instances, and the rule must hold for ${PROPOSAL_FLOORS.ownSupport} of them`;
      if (r?.provenance !== 'own') bad('PL6520', `${rel}: the rule ${name} has the provenance ${JSON.stringify(r?.provenance)}, and only the person's own history supports a rule (S517)`);
      else if (!nums) bad('PL6520', `${rel}: the rule ${name} has no numeric support { holds, of } (S517)`);
      else {
        const { holds, of } = s as { holds: number; of: number };
        if (holds > of || holds < 0) bad('PL6520', `${rel}: the rule ${name} holds for ${holds} of ${of}, which is not a support (S517)`);
        else if (of < PROPOSAL_FLOORS.minInstances) bad('PL6520', `${rel}: the rule ${name} holds for ${holds} of ${of}: ${thresholds} (S517)`);
        else if (holds / of < PROPOSAL_FLOORS.ownSupport) bad('PL6520', `${rel}: the rule ${name} holds for ${holds} of ${of}, below ${PROPOSAL_FLOORS.ownSupport}: ${thresholds} (S517)`);
      }
      if (r?.window !== 'run' && r?.window !== 'session') bad('PL6520', `${rel}: the rule ${name} has the window ${JSON.stringify(r?.window)}; it is run or session (S517)`);
    }

    // PL6521: the evidence and the sources name the same path properties; the derivation writes none of its own.
    for (const n of named) if (!paths.includes(n)) bad('PL6521', `${rel} names the rule ${n}, and the module ${under(slug)} has no path property of that name`);
    for (const p of paths) if (!named.includes(p)) bad('PL6521', `the path property ${p} of the module ${under(slug)} is not named by ${rel}: a proposal carries evidence for every rule it holds`);

    list.push({ name: slug, evidence: sha256OfBytes(bytes), tool: { name: 'polyness', version: tool.version, pin: tool.pin } });
  }
  return { list, files, problems };
}
