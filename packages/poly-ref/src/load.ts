// Loading a lowered next.cjs wherever it was written (review finding 5).
//
// The lowered module requires '@cognitive-fab/sam-pattern' by name, as the
// engines expect. A plain require from the build directory resolves that
// name only if the package is installed above the directory, so a --root
// outside a node_modules tree failed. This loader evaluates the module with
// a require that resolves sam-pattern from poly's own installation and
// everything else from the module's own directory: the same idea as
// polygraph's spec loader. Each call loads a fresh copy.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const OWN = createRequire(import.meta.url);
const SAM = '@cognitive-fab/sam-pattern';

export function loadLoweredModule<T = unknown>(path: string): T {
  const abs = resolve(path);
  const base = createRequire(abs);
  const require = Object.assign((id: string) => (id === SAM ? OWN(SAM) : base(id)), base);
  const module = { exports: {} as T };
  const code = readFileSync(abs, 'utf8');
  const run = vm.compileFunction(code, ['module', 'exports', 'require', '__filename', '__dirname'], { filename: abs });
  run(module, module.exports, require, abs, dirname(abs));
  return module.exports;
}
