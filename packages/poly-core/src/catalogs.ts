// PT34.1, S586: the risk and control catalogs a policy item's tags name (PT8.6), read from std/catalogs/. A catalog is read
// only when its digest is the one std/PINS.json pins for it, as a library module is (PS23.4): a catalog that differs from
// its pin is the toolchain fault `catalog-unpinned`, never a set of ids an author can meet. A catalog is read only when a
// tag or an exposure needs it, so a project that has not opted in reads none (RT15).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as A from './ast.js';
import { diag, type Diagnostic } from './diagnostics.js';

/** The repository's std/, beside the packages (as poly-check's STD). */
export const STD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'std');

export const CATALOG_FILES = { mit: 'mit-ai-risk.json', nist: 'nist-ai-rmf.json', iso: 'iso-42001.json' } as const;
export type CatalogName = keyof typeof CATALOG_FILES;

export interface Catalog {
  catalog: CatalogName;
  version: string;
  /** The digest std/PINS.json pins for the file, which is the file's. */
  digest: string;
  /** Every entry's label, by id. */
  labels: Map<string, string>;
  /** The ids a tag may name: the entries no other entry has as parent (a MIT subdomain, a NIST subcategory, an ISO control). */
  leaves: Set<string>;
}
export type Catalogs = Record<CatalogName, Catalog>;

/** The pinned digest of a text, as std-pins pins it: line endings normalised. */
const pinDigest = (text: string) => 'sha256:' + createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export class CatalogError extends Error {}

/** The three catalogs of `std`, each checked against its pin; a catalog that is not pinned throws `catalog-unpinned`. */
export function loadCatalogs(std: string = STD_DIR): Catalogs {
  const pinsFile = join(std, 'PINS.json');
  const pins = existsSync(pinsFile) ? ((JSON.parse(readFileSync(pinsFile, 'utf8')) as { files?: Record<string, string> }).files ?? {}) : {};
  const out = {} as Catalogs;
  for (const [name, file] of Object.entries(CATALOG_FILES) as [CatalogName, string][]) {
    const path = join(std, 'catalogs', file);
    const rel = `catalogs/${file}`;
    if (!existsSync(path)) throw new CatalogError(`catalog-unpinned: std/${rel} is missing (PT34.1)`);
    const text = readFileSync(path, 'utf8');
    const digest = pinDigest(text);
    if (pins[rel] !== digest) throw new CatalogError(`catalog-unpinned: std/${rel} has digest ${digest}, and std/PINS.json pins ${pins[rel] ?? 'nothing'} for it; a catalog is read only as pinned (PT34.1)`);
    const doc = JSON.parse(text) as { catalog: string; version: string; entries: { id: string; label: string; parent?: string }[] };
    if (doc.catalog !== name) throw new CatalogError(`catalog-unpinned: std/${rel} names the catalog ${doc.catalog}, not ${name} (PT34.1)`);
    const parents = new Set(doc.entries.flatMap((e) => (e.parent ? [e.parent] : [])));
    out[name] = { catalog: name, version: doc.version, digest, labels: new Map(doc.entries.map((e) => [e.id, e.label])), leaves: new Set(doc.entries.filter((e) => !parents.has(e.id)).map((e) => e.id)) };
  }
  return out;
}

/** Whether a module holds a policy item that carries a tag (PT34.2: such a project opts in). */
export const hasTags = (modules: readonly A.Module[]): boolean =>
  modules.some((m) => m.decls.some((d) => d.kind === 'Policy' && d.items.some((i) => (i.mitigates?.length ?? 0) + (i.implements?.length ?? 0) > 0)));

/**
 * PT34.2: why a tag is unknown in its clause, or null when it is known. `mitigates` takes a MIT subdomain; `implements`
 * a NIST subcategory or an ISO Annex A control.
 */
export function tagProblem(tag: string, clause: 'mitigates' | 'implements', catalogs: Catalogs): string | null {
  const i = tag.indexOf(':');
  const prefix = i < 0 ? '' : tag.slice(0, i);
  const id = tag.slice(i + 1);
  if (prefix !== 'mit' && prefix !== 'nist' && prefix !== 'iso') return `"${tag}" names no catalog: a tag is "mit:<d>.<s>", "nist:<FUNCTION>-<c>.<s>" or "iso:A.<o>.<c>" (PT8.6)`;
  const c = catalogs[prefix];
  if (clause === 'mitigates' && prefix !== 'mit') return `"${tag}" is a control, and mitigates takes a risk, a subdomain of the MIT catalog (PT8.6)`;
  if (clause === 'implements' && prefix === 'mit') return `"${tag}" is a risk, and implements takes a control of the NIST or ISO catalog (PT8.6)`;
  if (!c.labels.has(id)) return `"${tag}" is not in the ${prefix.toUpperCase()} catalog (${c.version}) (PT34.1)`;
  if (!c.leaves.has(id)) return prefix === 'mit' ? `"${tag}" is a MIT domain; a risk tag names one of its subdomains (PT8.6)` : `"${tag}" groups controls; a control tag names a ${prefix === 'nist' ? 'subcategory' : 'control'} under it (PT8.6)`;
  return null;
}

/** PT34.2: why an exposure id is not a MIT subdomain, or null. */
export function exposureProblem(risk: string, catalogs: Catalogs): string | null {
  if (typeof risk !== 'string' || !risk.startsWith('mit:')) return `"${String(risk)}" is not a MIT subdomain, "mit:<d>.<s>" (PT34.2)`;
  return tagProblem(risk, 'mitigates', catalogs);
}

/**
 * PT34.2, S586: each tag of each policy item against the bundled catalogs, PL6506 at the tag's opening quote. The catalogs
 * are read only when a tag is present, and `catalogs` gives them (poly-check reads them from its std).
 */
export function checkPolicyTags(module: A.Module, catalogs: () => Catalogs = () => loadCatalogs()): Diagnostic[] {
  const out: Diagnostic[] = [];
  let read: Catalogs | null = null;
  for (const p of module.decls) {
    if (p.kind !== 'Policy') continue;
    for (const it of p.items) {
      for (const clause of ['mitigates', 'implements'] as const) {
        for (const t of it[clause] ?? []) {
          read ??= catalogs();
          const why = tagProblem(t.tag, clause, read);
          if (why) out.push(diag('PL6506', { module: module.name, node: it.id, line: t.line, col: t.col }, `${p.name}.${it.name}: ${why}`));
        }
      }
    }
  }
  return out;
}
