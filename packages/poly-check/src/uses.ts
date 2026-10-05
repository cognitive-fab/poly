// S176: the modules a module uses, found for `poly check` (PS1.0, PT1.3). In a project they are the project's modules;
// a file checked outside a project searches its own directory, and `std.*` is searched under the repository's `std/`.
// A directory is a search path only: a file is read only when its header names a module that `use` asks for, so an
// unrelated file, broken or not, changes nothing. Two files that declare one used module refuse the check (PL1002);
// one is never picked. The used modules' own `use` declarations are followed, so a cycle is read once.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diag, type Diagnostic, type Module } from '@poly/core';
import type * as A from '@poly/core';
import { parse } from '@poly/lang';

/** The repository's standard library (PT20.4), beside the packages. */
const STD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'std');

/** A module's name from the head of its source, with no parse: the first `module` line after comments. */
export function headerModule(text: string): string | null {
  const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*module\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/.exec(text);
  return m ? m[1] : null;
}

function polyFiles(dir: string, deep: boolean): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((n) => {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { return []; }
    if (st.isDirectory()) return deep && n !== 'node_modules' && n !== '.poly' ? polyFiles(p, true) : [];
    return n.endsWith('.poly') ? [p] : [];
  });
}

export interface Uses {
  /** Every module the program holds for this check: the checked module and the modules it uses, transitively. */
  program: Module[];
  diagnostics: Diagnostic[];
}

/**
 * The program a module is checked in. `project` gives a project's modules with their files; with none, the file's
 * directory and `std/` are searched, reading only the files whose header names a module `use` asks for.
 */
export function resolveUses(module: Module, file: string, project?: { file: string; module: Module }[]): Uses {
  const diagnostics: Diagnostic[] = [];
  const found = new Map<string, Module>([[module.name, module]]);
  // Candidate files by module name, read lazily, never parsed unless named.
  const candidates = (name: string): { file: string; module: Module | null; text?: string }[] => {
    if (project && !name.startsWith('std.')) return project.filter((p) => p.module.name === name && resolve(p.file) !== resolve(file));
    const files = name.startsWith('std.') ? (existsSync(STD) ? polyFiles(STD, true) : []) : polyFiles(dirname(resolve(file)), false).filter((f) => resolve(f) !== resolve(file));
    return files.flatMap((f) => { const text = readFileSync(f, 'utf8'); return headerModule(text) === name ? [{ file: f, module: null, text }] : []; });
  };
  const queue: { from: Module; decl: A.UseDecl }[] = module.decls.filter((d): d is A.UseDecl => d.kind === 'Use').map((decl) => ({ from: module, decl }));
  const asked = new Set<string>();
  while (queue.length) {
    const { from, decl } = queue.shift()!;
    // The whole path may be a module (use m) or a module and a machine (use m.M); a found module decides.
    const tries = [decl.path.join('.'), decl.path.slice(0, -1).join('.')].filter((x) => x !== '');
    for (const t of tries) {
      if (found.has(t)) {
        // Review B-F3: a use of the checked module is resolved to its file only when no other file declares it too.
        if (t === module.name && !asked.has(t)) {
          asked.add(t);
          const c = candidates(t);
          if (c.length) diagnostics.push(diag('PL1002', { module: from.name, node: decl.id, line: decl.span?.line, col: decl.span?.col }, `module ${t}, used by module ${from.name}, is declared in ${[file, ...c.map((x) => x.file)].join(' and ')}; a module is named once, and the check never picks one (S176)`));
        }
        break;
      }
      if (asked.has(t)) continue;
      asked.add(t);
      const c = candidates(t);
      if (!c.length) continue;
      const at = { module: from.name, node: decl.id, line: decl.span?.line, col: decl.span?.col };
      if (c.length > 1) {
        // Polywatch: a module reached through another module's use refuses the check as one used directly does.
        diagnostics.push(diag('PL1002', at, `module ${t}${from === module ? '' : `, used by module ${from.name},`} is declared in ${c.map((x) => x.file).join(' and ')}; a module is named once, and the check never picks one (S176)`));
        break;
      }
      let m = c[0].module;
      if (!m) {
        const r = parse(c[0].text!);
        if (!r.module) { diagnostics.push(diag('PL1001', at, `module ${t}${from === module ? '' : `, used by module ${from.name},`} in ${c[0].file} does not parse, so its machines cannot be named (S176)`)); break; }
        m = r.module;
      }
      found.set(t, m);
      for (const d of m.decls) if (d.kind === 'Use') queue.push({ from: m, decl: d });
      break;
    }
  }
  return { program: [...found.values()], diagnostics };
}

