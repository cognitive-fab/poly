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

// polyrun's product checker, read from polyrun/src/check-product.mjs of @cognitive-fab/polygraph 8.3.2.
declare module '@cognitive-fab/polygraph/polyrun/src/check-product.mjs' {
  export interface ProductStep {
    stimulus: { target: string; action: string; data: unknown } | null;
    cascade: { target: string; action: string; stepKind: string; reason?: string }[];
    joint: unknown;
  }
  export interface ProductViolation {
    invariant: string;
    kind: 'state' | 'transition' | 'doctrine' | 'poison';
    path: ProductStep[];
    detail?: string;
  }
  export interface ProductResult {
    ok: boolean;
    statesExplored: number;
    capHit: boolean;
    violations: ProductViolation[];
    notes: string[];
    nondeterministic?: boolean;
  }
  export function checkProduct(options: {
    parent: { machineId: string; module: string; contract: string; mapper: string; manifest?: string };
    children: { machineId: string; module: string; contract: string }[];
    invariants: string;
    maxStates?: number;
  }): Promise<ProductResult>;
}

// polyrun's effect-emission checker, read from polyrun/src/check-effects.mjs of @cognitive-fab/polygraph 8.3.2.
declare module '@cognitive-fab/polygraph/polyrun/src/check-effects.mjs' {
  export interface EffectsViolation {
    invariant: string;
    counterexample: string[];
    emitted: { kind: string; payload: unknown; step: number }[];
    finalState?: unknown;
    detail?: string;
  }
  export interface EffectsResult {
    violations: EffectsViolation[];
    violationCounts: Record<string, number>;
    pathsExplored: number;
    statesSeen: number;
    cyclesPruned: number;
    bounded: boolean;
    notes: string[];
  }
  export function checkEffects(options: {
    module: string;
    mapper: string;
    manifest: string;
    invariants: string;
    contract?: unknown;
    maxDepth?: number;
    maxPaths?: number;
  }): Promise<EffectsResult>;
}

// polygraph's replayer of a SAM v2 strict module over windows, read from scripts/replay.mjs of 8.3.2.
declare module '@cognitive-fab/polygraph/scripts/replay.mjs' {
  export function replaySpecResults(specPath: string, windows: { action: string; data: unknown; pre: unknown; post: unknown }[]): { ok: boolean; error?: string; results: { status: string; rejectionReason?: string }[] };
}

// polyflow's library, vendored unchanged (vendor/polyflow, M6): the admission the workflow stage runs (PT10, S165).
declare module '@cognitive-fab/polyflow-server/library' {
  export class Library {
    constructor(dir: string);
    load(): Library;
    get(name: string): unknown;
    certify(wf: unknown, opts?: { maxDepth?: number; maxPaths?: number }): Promise<{ ok: boolean; bounded: boolean; violations: { name?: string; invariant?: string }[]; pathsExplored: number; report: string }>;
  }
}
