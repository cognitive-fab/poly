// Node ids (PT12.1): "stable across formatting because they derive from the
// node's path in the AST".
//
// A path names what the grammar names (`machine:Gate/on:Coin/body.1/cond`)
// and indexes the rest. Formatting cannot change a path, so it cannot change
// an id. Editing can: inserting a statement shifts the indices after it,
// which is exactly why fixes also carry a node digest precondition.
import { sha256Hex } from './digest.js';

type Obj = Record<string, unknown>;

const NAMED: Record<string, string> = {
  Machine: 'machine',
  TypeDecl: 'type',
  EnumDecl: 'type',
  RecordDecl: 'type',
  Ctor: 'ctor',
  PayloadField: 'pf',
  Field: 'field',
  Action: 'action',
  Param: 'param',
  Handler: 'on',
  Property: 'prop',
  Liveness: 'liveness',
  EffectDecl: 'effect',
  Configuration: 'configuration',
  ConfigInstance: 'instance',
};

function segmentOf(node: Obj, key: string, index: number): string {
  const prefix = NAMED[node.kind as string];
  if (prefix) {
    const name = (node.kind === 'Handler' ? node.action : node.name) as string;
    return `${prefix}:${name}`;
  }
  if (node.kind === 'Terminal') return 'terminal';
  return `${key}.${index}`;
}

export function idOfPath(path: string): string {
  return 'n:' + sha256Hex(path).slice(0, 16);
}

/** Assigns `id` on every node in place and returns the path of every id. */
export function assignIds(root: Obj, rootPath = ''): Map<string, string> {
  const paths = new Map<string, string>();
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) return; // arrays are visited through their parent key
    if (value === null || typeof value !== 'object') return;
    const node = value as Obj;
    if (typeof node.kind === 'string') {
      const id = idOfPath(path);
      node.id = id;
      paths.set(id, path);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'id' || key === 'span') continue;
      if (Array.isArray(child)) {
        const used = new Set<string>();
        child.forEach((el, i) => {
          if (el === null || typeof el !== 'object') return;
          let seg = segmentOf(el as Obj, key, i);
          // Duplicate names are PL1002; ids must still be unique meanwhile.
          if (used.has(seg)) seg = `${seg}#${i}`;
          used.add(seg);
          visit(el, `${path}/${seg}`);
        });
      } else if (child !== null && typeof child === 'object') {
        visit(child, `${path}/${key}`);
      }
    }
  };
  visit(root, rootPath || (typeof root.name === 'string' ? `module:${root.name}` : 'root'));
  return paths;
}
