// The short grammar reference `poly new` gives a provider with every request (S169): enough to draft a module, with
// one complete example. The checker, not this text, decides what is valid.
export const GRAMMAR = `A module: \`module name\`, then declarations.
- \`enum E { A, B }\`; \`type T = A | B { f: 0..3 }\`.
- \`machine M { state { f : T = init  … }  terminal <expr on the first field>  action A(p: 0..3)  on A(p) { require <expr> else reject "reason"  f' = <expr>  emit e(1) }  effect e(n: 0..1) { kind "k"  labels { egress:external }  class irreversible  ok -> B() } }\`.
- State fields and parameters have finite domains: enums, ranges \`0..n\`, \`bool\`, \`string check { "a", "b" }\`.
- Handlers read the pre-state; primed fields (\`f'\`) are written, never read. Every require comes before any write.
- \`invariant name: <expr>\` and \`path property name: count("k") <= 1\` state what must hold.
- \`workflow w runs M { input A  key "{f}" where f matches "re"  tool "k" -> tool_name why "…" }\`: every effect kind maps to one tool, and the machine has a path property.

Example:
\`\`\`poly
module turnstile

enum Phase { Locked, Unlocked }

machine Turnstile {
  state {
    phase : Phase = Locked
  }

  action Coin()
  action Push()

  on Coin {
    require phase == Locked else reject "unlocked"
    phase' = Unlocked
  }

  on Push {
    require phase == Unlocked else reject "locked"
    phase' = Locked
  }

  invariant known: phase == Locked || phase == Unlocked
}
\`\`\``;
