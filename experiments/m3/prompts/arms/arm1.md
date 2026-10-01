## Language

Write the implementation in TypeScript. Node 24 runs `.ts` files directly by stripping their types, so use only syntax that erases to JavaScript: no `enum`, no `namespace`, no parameter properties. `npx tsc --noEmit` type-checks your code (`typescript` is installed).

## Tools

The file tools, and a shell for `node`, `npx tsc` and `npm test`.

## Delivery

`src/host.impl.ts`, whose default export is the factory of `host.ts` (`CreateHost`): an async function that returns a fresh system. It may import other files under `src/` and Node's built-in modules, and nothing else.
