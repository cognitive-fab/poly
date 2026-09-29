// Deliberately broken lowerings, for one test only: translation validation
// must catch each of them with PL2501 (PT18 M0 gate, AC8). `poly check`
// never sets a fault. Each fault changes the lowered artefact, never the
// source or the checker's facts, so poly-ref still checks the true program.
import type * as A from '@poly/core';
import type { Fault } from './lower.js';

export const FAULTS: Fault[] = ['drop-frame', 'swap-reason', 'off-by-one', 'invert-require', 'skip-guard', 'skip-terminal'];

/** The machine as the broken lowering sees it. drop-frame and skip-terminal act in the emitter instead. */
export function applyFault(m: A.Machine, fault: Fault | undefined): A.Machine {
  if (!fault || fault === 'drop-frame' || fault === 'skip-terminal') return m;
  const copy = structuredClone(m);
  let done = false;
  const visitStmts = (body: A.Stmt[]): void => {
    for (const s of body) {
      if (done) return;
      if (fault === 'swap-reason' && (s.kind === 'Require' || s.kind === 'Reject')) { s.reason = s.reason + '-swapped'; done = true; }
      if (fault === 'invert-require' && s.kind === 'Require') { s.cond = { kind: 'Unary', op: '!', arg: s.cond, id: s.cond.id }; done = true; }
      if (fault === 'off-by-one' && s.kind === 'Assign' && bumpInt(s.expr)) done = true;
      if (s.kind === 'If') { visitStmts(s.then); visitStmts(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) visitStmts(a.body);
    }
  };
  if (fault === 'skip-guard') {
    const i = copy.items.findIndex((x) => x.kind === 'Guard');
    if (i >= 0) copy.items.splice(i, 1);
    return copy;
  }
  for (const it of copy.items) if (it.kind === 'Handler' && !done) visitStmts(it.body);
  return copy;
}

/** Adds 1 to the first integer literal of an expression; false when there is none. */
function bumpInt(e: A.Expr): boolean {
  if (e.kind === 'Int') { e.value += 1; return true; }
  for (const v of Object.values(e)) {
    if (v && typeof v === 'object' && 'kind' in (v as object) && bumpInt(v as A.Expr)) return true;
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && 'value' in x && typeof (x as { value: unknown }).value === 'object' && bumpInt((x as { value: A.Expr }).value)) return true;
  }
  return false;
}
