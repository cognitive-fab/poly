## Language

Write the system's stateful core in poly, a language for state machines that talk by messages. Its manual is in `tools/poly/`: `README.md`, `docs/03-technical-spec.md` (the grammar, the checks and their diagnostics) and `docs/04-semantics.md` (what a program means), with examples in `tools/poly/examples/`. Write the module in the standalone syntax, in a `.poly` file.

poly runs your module on a runtime; a generated adapter turns the host interface into commands to your machines. You say how, in `host.map.json`: which machine instance and which action each method of the host interface drives, with which parameters, and which fields each query returns. Its schema, with a description of every key, is `host.map.schema.json`.

## Tools

The file tools, and a shell for `node` and `npm`:

- `npm run poly -- check src/system.poly` checks the module and prints its verdict, with a witness and typed fixes for each finding; `npm run poly -- fix <id>` applies a fix, and `npm run poly -- explain <code>` explains a diagnostic;
- `npm run adapter` builds the adapter from `host.map.json` and your module into `build/host.gen.ts`, or lists what in the map does not exist; `build/host.gen.ts` is then a module whose default export is the factory of `host.ts`, which you can test with `node --test`.

## Delivery

`src/system.poly`, your module, and `host.map.json`. The module must pass `npm run poly -- check src/system.poly`, and the adapter must build.
