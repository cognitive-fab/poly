// The standing rule's one exception, written out (decisions-m0.md, after the review): the only
// programs allowed to reach PL2501 or PL2001 are the deliberately broken lowerings, and they are
// named here one by one. No path pattern, directory or file name exempts anything. A fault added
// to poly-lower without being listed here fails the standing test, and so does a listed fault
// that poly-lower no longer has.
export const DELIBERATELY_BROKEN_LOWERINGS = [
  'drop-frame',
  'swap-reason',
  'off-by-one',
  'invert-require',
  'skip-guard',
  'skip-terminal',
  'drop-property',
  'drop-auto-invariant',
];

/** The toolchain-fault diagnostics among a list (S20: addressed to the toolchain, never to the author). */
export function toolchainFaults(diagnostics) {
  return diagnostics.filter((d) => d.code === 'PL2501' || d.code === 'PL2001');
}
