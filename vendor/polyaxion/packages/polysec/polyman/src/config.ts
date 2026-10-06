// security.json loader + validation for the runtime (docs/polyman-spec.md §5).
// Extends the design-time manifest with a `tools` label map. Loud on malformed
// input; `unknownToolPolicy` is pinned to 'reject' (silence = denial).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ToolLabel {
  pre?: Array<string | { action: string; data?: Record<string, unknown> }>;
  post?: Array<string | { action: string; data?: Record<string, unknown> }>;
}

export interface SecurityManifest {
  forbiddenRegions: Array<{ name: string; predicate: string }>;
  gates: string[];
  projection?: string[];
  protected?: string[];
  adversarial?: string[];
  tools: Record<string, ToolLabel>;
  unknownToolPolicy: 'reject';
  [k: string]: unknown;
}

export function loadSecurity(pathArg: string): SecurityManifest {
  const abs = resolve(pathArg);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (e) {
    throw new Error(`security.json '${pathArg}': ${(e as Error).message}`);
  }
  const regions = raw.forbiddenRegions;
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error(`security.json '${pathArg}': forbiddenRegions must be a non-empty array`);
  }
  for (const r of regions) {
    if (!r || typeof (r as { name?: unknown }).name !== 'string' || typeof (r as { predicate?: unknown }).predicate !== 'string') {
      throw new Error(`security.json '${pathArg}': each forbiddenRegion needs { name, predicate }`);
    }
  }
  if (!raw.tools || typeof raw.tools !== 'object') {
    throw new Error(`security.json '${pathArg}': missing the runtime 'tools' label map (polyman needs it to mediate tool calls)`);
  }
  const unknownToolPolicy = raw.unknownToolPolicy ?? 'reject';
  if (unknownToolPolicy !== 'reject') {
    throw new Error(`security.json '${pathArg}': unknownToolPolicy must be 'reject' — an unlabeled tool must fail closed (default-deny doctrine)`);
  }
  if (!Array.isArray(raw.gates)) {
    throw new Error(`security.json '${pathArg}': missing 'gates'`);
  }
  return { ...(raw as object), unknownToolPolicy: 'reject' } as SecurityManifest;
}
