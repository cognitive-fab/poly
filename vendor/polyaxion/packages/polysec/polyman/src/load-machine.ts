// Self-contained SAM-machine loader — a minimal, faithful port of the polygraph
// repo's scripts/load-spec.mjs#loadSpec. It compiles a CommonJS machine file and
// require-patches '@cognitive-fab/sam-pattern' (and aliases) to polyman's OWN
// vendored bundle, so:
//   • polyman installs standalone with no sibling polygraph checkout, and
//   • the runtime steps the machine with the SAME SAM build the checker proved
//     against (the vendored copy is byte-identical) — the golden-parity claim.
//
// This is the ONE reason polyman needs vm/createRequire; kept tiny and audited.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Console } from 'node:console';
import vm from 'node:vm';

const VENDORED_SAM = fileURLToPath(new URL('../vendor/sam-pattern.cjs', import.meta.url));

// A machine may console.log (generated modules often append demo logging). Bind
// a STDERR-backed console when compiling it (as load-spec.mjs does) so that
// stray output never reaches the host's stdout — which a stdio protocol host
// (an MCP server, the Phase-B sidecar) uses as a data channel.
const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });

// Specifiers a machine may use to import the SAM library — all pinned to the
// vendored bundle (matches load-spec.mjs's SAM_LIB_SPECIFIERS).
const SAM_SPECIFIERS = new Set(['@cognitive-fab/sam-pattern', 'sam-pattern', 'sam-lib']);

/** Load a CJS SAM v2 machine ({ instance, init, actions, getState, setState }). */
export function loadMachine(machinePath: string): Record<string, unknown> {
  const abs = resolve(machinePath);
  const code = readFileSync(abs, 'utf-8');
  const mod = { exports: {} as Record<string, unknown> };
  const baseRequire = createRequire(abs);
  const patched = Object.assign(
    (id: string) => (SAM_SPECIFIERS.has(id) ? baseRequire(VENDORED_SAM) : baseRequire(id)),
    baseRequire,
  );
  const compiled = vm.compileFunction(
    code,
    ['module', 'exports', 'require', '__filename', '__dirname', 'console'],
    { filename: abs },
  );
  compiled(mod, mod.exports, patched, abs, dirname(abs), stderrConsole);
  return mod.exports;
}
