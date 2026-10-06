// Exploration samples synthesized from a machine's own literals (the admission
// action domain when the author declares none). Moved from the v0.1 explorer.

/**
 * Synthesize a small action domain from the string literals that appear in a
 * machine's expressions, so exploration has something to drive it with even
 * when the policy declares no samples. Every `action.kind == 'x'` literal
 * becomes an action of kind x; every other literal is offered as `target`,
 * `path`, `content`, `host` and `branch` of each kind.
 */
export function synthesizeActions(compiledMachine, extra = []) {
  const kinds = new Set();
  const literals = new Set();
  const fields = new Set(['target', 'path', 'content', 'host', 'url', 'command', 'branch', 'query', 'message']);
  const visit = (ast) => {
    if (!Array.isArray(ast)) return;
    if (ast[0] === '==' && ast[1] && ast[1][0] === 'get' && ast[1][2] === 'kind' && ast[2] && ast[2][0] === 'lit') kinds.add(ast[2][1]);
    if (ast[0] === 'in' && ast[1] && ast[1][0] === 'get' && ast[1][2] === 'kind' && ast[2] && ast[2][0] === 'list') for (const l of ast[2].slice(1)) if (l[0] === 'lit') kinds.add(l[1]);
    if (ast[0] === 'get' && ast[1] && ast[1][0] === 'path' && ast[1][1] === 'action' && ast[2] !== 'kind') fields.add(ast[2]);
    if (ast[0] === 'lit' && typeof ast[1] === 'string' && ast[1].length < 80) literals.add(ast[1]);
    for (let i = 1; i < ast.length; i++) visit(ast[i]);
  };
  for (const t of compiledMachine.transitions) { visit(t._when.ast); for (const e of Object.values(t._set)) visit(e.ast); }
  for (const g of compiledMachine.guards) visit(g._when.ast);
  const out = [...extra];
  const lits = [...literals].filter((l) => !kinds.has(l));
  const every = lits.join(' ');
  const F = [...fields];
  const fill = (v) => Object.fromEntries(F.map((f) => [f, v]));
  for (const kind of [...kinds].sort()) {
    out.push({ kind, target: null });
    // the sample carrying every literal at once comes first (rules and
    // transitions that require several substrings in one field fire on it), then
    // every referenced field set to true, then one sample per literal — so a
    // truncated sample list keeps the most informative samples of every kind
    out.push({ kind, ...fill(every), paths: lits });
    out.push({ kind, ...fill(true) });
    for (const l of lits) out.push({ kind, ...fill(l), paths: [l] });
  }
  if (!kinds.size) out.push({ kind: 'tool.call', target: null });
  out.push({ kind: 'run.end' });
  return out.slice(0, 400);
}

