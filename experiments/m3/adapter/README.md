# The host adapter generator (M3-4, S90, S91)

In the poly arms of M3 the agent writes a poly module and a `host.map.json`. This generator turns the two into an implementation of the task's host interface, so the hidden tests (O1, O2, O3) drive a poly solution exactly as they drive a TypeScript one.

```
node experiments/m3/adapter/generate.mjs --map host.map.json --host host.ts --module <file.poly|file.ts> --out <dir>
```

## What it checks

The map is validated against the host interface and the module before anything is written (S90). A map is a failed build, with every error listed and exit code 1, when it:

- names another module, or a machine, instance, family, action, action parameter, host argument or field that does not exist;
- leaves an action parameter without a value, or a member of `Host` unmapped;
- uses a family of instances without the argument that keys it, or keys a single instance, or names an instance by an argument without its machine;
- sets an initial value outside its field's type, or an address that is not an instance created with the host;
- maps the network API or the effect port, which the adapter implements itself, or the host interface has a member the adapter reserves (`__dispose`, `__state`).

The module must parse and pass stage 0 of `poly check`, and every machine must lower. Whether the module is correct is not the generator's question: the hidden tests answer it.

## What it writes

`<out>/host.gen.ts` default-exports a factory of a fresh host over polyrun's kernel, with an in-memory store (M3-4). The lowered machines are written beside it in `<out>/build/`.

- An instance with no `createdBy` is created with the host. A family's member is created by its `createdBy` method, the first time that method names it; its id is the value of the key argument.
- A method or query can also name its instance by an argument, as `"instance": "$arg:<argument>"` with `"machine"`: the argument must name an instance created with the host, of that machine, or the call is refused (a query returns `null`).
- An instance starts in its machine's initial state with the map's `init` values in place, as a configuration's instance does (PS13.1).
- A method dispatches one action with the parameters the map gives. It returns `{ ok: true }` for an accepted step, and `{ ok: false, reason }` with the machine's reject reason otherwise (`returns: "verdict"`, the default); or the instance's flat state (`"state"`); or nothing.
- A query returns the fields the map names, renamed as the interface names them, or `null` for an instance that does not exist.
- `inFlight()` lists polyrun's messages in transit, `deliver(id)` delivers one of them, and `deliverAll()` delivers until none is left, within 10,000 rounds (S89, S91).
- `pendingEffects()` lists the effects in polyrun's outbox that are pending, and `completeEffect(id, outcome)` runs that one effect through polyrun's own effect worker, with a handler that returns for `ok` and throws a permanent failure for `failed`, so the completion action, its journal entry and its deduplication are the engine's (S95). An effect must declare both its `ok` and its `failed` completion.

The host also has `__dispose()`, which the tests call to release the store, and `__state()`, every instance's state, which the O3 generator uses to tell apart states the interface shows alike. A `Host` with a member of either name is a failed build.

## Tests

`test/m3-adapter.test.mjs` runs the generator on `fixtures/checkout/` (the checkout of `examples/checkout` behind a three-member interface), from the standalone and the embedded surface, drives the adapter through both arrival orders, and breaks the map in eighteen ways, each a failed build that names what it broke. Each task's reference is run through the generator by the controls (plan-m3 section 5).

## Glossary

- **Adapter:** the generated `host.gen.ts`, the poly arms' implementation of the host interface.
- **Family:** the instances one host method creates, one per value of its key argument.
- **Host interface:** `host.ts` of a task, the API every arm implements (PT13).
- **Map:** `host.map.json`, the agent's statement of which instance, action and field each member of the host interface drives (S90).
- **Effect port:** `pendingEffects` and `completeEffect`, through which a test answers the effects a system asks for (S95).
- **Network API:** `inFlight`, `deliver` and `deliverAll`, through which a test chooses the order messages arrive in (S91).
