// PS18.3, PT10r (M11): the price tables and calibration maps a module's routes name, read from beside the source. The
// checker and the lowering are given them as data, each with the digest of its bytes, which the route's descriptor
// records; poly-ref reads the same files on its own.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { routePathOk, type Module, type RoutingFiles } from '@poly/core';

/** The files of each route of `module`, the source at `file`; a path that is not well formed or has no file is left out, and is PL1201 or PL1001 at check. */
export function resolveRouting(module: Module, file: string): RoutingFiles {
  const out: RoutingFiles = { prices: {}, maps: {} };
  const dir = dirname(resolve(file));
  const read = (p: string): { json: unknown; file: string; digest: string } | null => {
    if (!routePathOk(p)) return null;
    const f = join(dir, ...p.split('/'));
    if (!existsSync(f) || !statSync(f).isFile()) return null;
    const bytes = readFileSync(f);
    let json: unknown = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { json = null; }
    return { json, file: f, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  };
  for (const d of module.decls) {
    if (d.kind !== 'Route') continue;
    for (const t of d.tiers) {
      const p = read(t.prices);
      if (p) out.prices[t.prices] = { table: p.json, file: p.file, digest: p.digest };
      if (t.calibration === null) continue;
      const m = read(t.calibration);
      if (m) out.maps[t.calibration] = { map: m.json, file: m.file, digest: m.digest };
    }
  }
  // PS18.4a, S454: an unrouted decision's price table is read beside the source as a tier's is.
  for (const m of module.decls) {
    if (m.kind !== 'Machine') continue;
    for (const d of m.items) {
      if (d.kind !== 'Decision') continue;
      for (const it of d.items) {
        if (it.kind !== 'DecBudget' || it.prices === null) continue;
        const p = read(it.prices);
        if (p) out.prices[it.prices] = { table: p.json, file: p.file, digest: p.digest };
      }
    }
  }
  return out;
}
