// polygraph ships no type declarations and no `exports` map; its model
// checker is imported by path. These are the parts poly-check uses, read from
// scripts/check.mjs of @cognitive-fab/polygraph 8.3.0.
declare module '@cognitive-fab/polygraph/scripts/check.mjs' {
  export interface PolygraphViolation {
    invariant: string;
    kind: 'state' | 'transition' | 'rejection' | 'throw' | 'nondeterminism';
    path: { action: string | null; data: unknown; state: unknown; origin?: string; rejected?: boolean; reason?: string }[];
    detail?: string;
  }
  export interface PolygraphResult {
    ok: boolean;
    error?: string;
    statesExplored: number;
    capHit: boolean;
    violations: PolygraphViolation[];
    nondeterministic?: boolean;
    domainNotes: string[];
  }
  export function check(options: {
    specModule: unknown;
    contract: unknown;
    invariants?: unknown;
    maxStates?: number;
  }): PolygraphResult;
}
