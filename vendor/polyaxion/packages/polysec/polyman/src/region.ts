// Forbidden-region predicate compiler — ported verbatim in semantics from
// scripts/polysec-lib.mjs#compileRegion. The predicate string comes from the
// author's trusted security.json manifest (same trust boundary as a contract's
// dataDomain), consumed only by this checker/monitor — not runtime-untrusted
// data. Kept identical to the design-time compiler so the runtime region and
// the proven region can never disagree.
import type { SamState } from './types.ts';

export function compileRegion(predicate: string, stateKeys: string[]): (s: SamState) => boolean {
  const keys = [...stateKeys];
  let fn: (s: SamState) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('__s', `const { ${keys.join(', ')} } = __s; return (${predicate});`) as (s: SamState) => unknown;
  } catch (e) {
    throw new Error(`forbidden-region predicate '${predicate}' failed to compile: ${(e as Error).message}`);
  }
  return (state: SamState) => {
    try {
      return !!fn(state);
    } catch (e) {
      throw new Error(`forbidden-region predicate '${predicate}' threw on a state: ${(e as Error).message}`);
    }
  };
}
