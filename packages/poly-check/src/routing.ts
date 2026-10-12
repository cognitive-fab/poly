// PS18.3, PT10r (M11): the price tables and calibration maps a module's routes name, read from beside the source. The
// checker and the lowering are given them as data, each with the digest of its bytes, which the route's descriptor
// records; poly-ref reads the same files on its own.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { routePathOk, type Module, type RoutingFiles } from '@poly/core';

/**
 * PT24 (ruled 2026-10-11): why a calibration map deserves a warning, or null. A map is a step function: a raw probability,
 * in thousandths, is calibrated to the y of the last point whose x is at most the raw value, and to 0 below the first
 * point (provider.ts's calibrate, which the tests hold to the same). It deserves a warning when it sends to 0 a band of
 * more than 100 consecutive raw values above raw 0 (ruled 2026-10-11: raw 0 itself, or a narrow band near it, is harmless;
 * the values below its first point and above its last count when they are 0), and when its points all lie on the diagonal, so that it seems to declare the identity, but it is more than 100 thousandths from the identity at some
 * raw value, having too few points to approximate it. A map that does not have well formed points is PL1201 elsewhere.
 */
export function calibrationWarning(map: unknown): string | null {
  const pts = (map as { points?: unknown } | null)?.points;
  if (!Array.isArray(pts) || pts.length === 0 || !pts.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  const points = pts as [number, number][];
  const at = (raw: number): number => { let out = 0; for (const [x, y] of points) { if (x <= raw) out = y; else break; } return out; };
  const why: string[] = [];
  let run = 0;
  let best = 0;
  let bestFrom = 0;
  for (let raw = 1; raw <= 1000; raw++) {
    if (at(raw) === 0) { run++; if (run > best) { best = run; bestFrom = raw - run + 1; } } else run = 0;
  }
  if (best > 100) why.push(`it sends the ${best} raw values ${bestFrom} to ${bestFrom + best - 1} (thousandths) to 0, a band wider than 100`);
  if (points.every(([x, y]) => x === y)) {
    let worst = 0;
    let worstAt = 0;
    for (let raw = 0; raw <= 1000; raw++) { const d = Math.abs(at(raw) - raw); if (d > worst) { worst = d; worstAt = raw; } }
    if (worst > 100) why.push(`its ${points.length} points all lie on the diagonal, so it seems to declare the identity, but a step function through them is ${worst} thousandths from it at the raw value ${worstAt}`);
  }
  return why.length ? why.join('; and ') : null;
}

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
  // PS18.7 (M7.5): the participant's price table of a workflow's budget, beside the source.
  for (const w of module.decls) {
    if (w.kind !== 'Workflow' || !w.budget) continue;
    const p = read(w.budget.prices);
    if (p) out.prices[w.budget.prices] = { table: p.json, file: p.file, digest: p.digest };
  }
  return out;
}
