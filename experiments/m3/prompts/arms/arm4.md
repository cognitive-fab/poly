## Language

Write the system's stateful core in poly, a language for state machines that talk by messages, in its embedded TypeScript surface: a `.ts` module that builds the program from combinators imported from `@cognitive-fab/poly/embed`. Its manual is in `tools/poly/`: `README.md`, `docs/03-technical-spec.md` (the grammar, the embedded surface in PT2.5, the checks and their diagnostics) and `docs/04-semantics.md` (what a program means), with examples in `tools/poly/examples/` (standalone syntax) and `tools/poly/examples/embedded/` (embedded surface). The combinators' declarations are in `tools/poly/embed/index.d.ts`, and `npx tsc --noEmit -p tsconfig.json` type-checks your module against them.

poly runs your module on a runtime; a generated adapter turns the host interface into commands to your machines. You say how, in `host.map.json`: which machine instance and which action each method of the host interface drives, with which parameters, and which fields each query returns. Its schema, with a description of every key, is `host.map.schema.json`.

## Tools

The file tools, and a shell for `node`, `npx tsc` and `npm`:

- `npm run poly -- check src/system.ts` checks the module and prints its verdict, with a witness and typed fixes for each finding; `npm run poly -- fix <id>` applies a fix, and `npm run poly -- explain <code>` explains a diagnostic;
- `npm run adapter` builds the adapter from `host.map.json` and your module into `build/host.gen.ts`, or lists what in the map does not exist; `build/host.gen.ts` is then a module whose default export is the factory of `host.ts`, which you can test with `node --test`.

## Delivery

`src/system.ts`, your module, and `host.map.json`. The module must pass `npm run poly -- check src/system.ts`, and the adapter must build.
