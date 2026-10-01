// The fixed tests of PT13's analysis: the exact Wilcoxon signed-rank test (two-sided) and Holm's step-down
// correction. Written out here so the analysis has no dependency to trust, and tested on known values.

/** Ranks of values, ties sharing the mean of their positions (1-based). */
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const mean = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) r[order[k][1]] = mean;
    i = j + 1;
  }
  return r;
}

/**
 * The exact Wilcoxon signed-rank test of paired samples x and y, two-sided. Zero differences are dropped
 * (Wilcoxon's rule); ties among the rest share mean ranks, and the null distribution is enumerated over every
 * sign assignment of those ranks, so it is exact with ties. Returns { n, wPlus, p }; p is 1 with no nonzero
 * difference.
 */
export function wilcoxonSignedRank(x, y) {
  if (x.length !== y.length) throw new Error('wilcoxon: samples of different lengths');
  const d = x.map((v, i) => v - y[i]).filter((v) => v !== 0);
  const n = d.length;
  if (n === 0) return { n: 0, wPlus: 0, p: 1 };
  if (n > 20) throw new Error('wilcoxon: the exact test enumerates 2^n signs; n is at most 20 here');
  const r = ranks(d.map(Math.abs));
  const wPlus = d.reduce((s, v, i) => s + (v > 0 ? r[i] : 0), 0);
  // Ranks are halves at worst, so doubling them makes every sum an integer key.
  const counts = new Map([[0, 1]]);
  for (const rank of r) {
    const step = Math.round(rank * 2);
    const next = new Map(counts);
    for (const [s, c] of counts) next.set(s + step, (next.get(s + step) ?? 0) + c);
    counts.clear();
    for (const [k, v] of next) counts.set(k, v);
  }
  const total = 2 ** n;
  const w2 = Math.round(wPlus * 2);
  let le = 0, ge = 0;
  for (const [s, c] of counts) { if (s <= w2) le += c; if (s >= w2) ge += c; }
  return { n, wPlus, p: Math.min(1, (2 * Math.min(le, ge)) / total) };
}

/**
 * Holm's step-down correction of p-values at level alpha. Returns, in the input's order, { p, adjusted,
 * rejected }: adjusted p-values are monotone, and a hypothesis is rejected when its adjusted p is at most alpha.
 */
export function holm(ps, alpha = 0.05) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adjusted = new Array(m);
  let running = 0;
  order.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    adjusted[i] = running;
  });
  return ps.map((p, i) => ({ p, adjusted: adjusted[i], rejected: adjusted[i] <= alpha }));
}
