## Language

Write the implementation in TypeScript. Node 24 runs `.ts` files directly by stripping their types, so use only syntax that erases to JavaScript: no `enum`, no `namespace`, no parameter properties. `npx tsc --noEmit` type-checks your code (`typescript` is installed).

When your implementation works, check it with polygraph: derive a state-machine specification of its stateful core, state the rules the brief requires as invariants, and let polygraph's model checker search for a state that breaks one. Fix what it finds, in your implementation and in the specification.

## Tools

The file tools, and a shell for `node`, `npx tsc` and `npm test`. polygraph is in `tools/polygraph`: its method is in `tools/polygraph/skills/polygraph/SKILL.md` and `tools/polygraph/README.md`, and its model checker runs as `node tools/polygraph/scripts/check.mjs --spec <module> --contract <contract.json> --invariants <invariants.mjs>`.

## Delivery

`src/host.impl.ts`, whose default export is the factory of `host.ts` (`CreateHost`): an async function that returns a fresh system. It may import other files under `src/` and Node's built-in modules, and nothing else. Keep your polygraph specification, contract and invariants under `spec/`.
