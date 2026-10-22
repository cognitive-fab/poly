# poly host code: handlers, types and capabilities

A poly program decides. A handler, written in TypeScript or JavaScript outside the program, does. The program emits an effect; the gate allows it; the runtime calls the handler registered for the effect's `kind`; the handler's end becomes a completion action of the machine. A handler holds no rule. Rules belong in the program, where they are checked.

## The handler

A handler is an exported function of a file that `poly.json` names under `handlers`. It takes the effect's payload, the capabilities its labels grant, and a context:

```js
// handlers/payments.mjs, registered for the effect kind "payments.refund"
export async function refund(payload, caps, ctx) {
  const res = await caps.api.post('https://api.stripe.com/v1/refunds', form(payload));
  if (res.status !== 200) throw new Error(`refunds.create answered ${res.status}`);
  return { ok: true };
}
```

The host registers it by identity of the certified export, and a function that is not an export of a certified file is refused (`PL6404`):

```js
rt.handle('payments.refund', rt.handlerExports('handlers/payments.mjs').refund);
```

- `payload`: the effect's parameters, as the program emitted them. A `Content` is a digest: read its body with `caps.content.read(digest)`, which serves only the bodies of this intent's own payload.
- `ctx.idempotencyKey`: the intent id, the same on every attempt. `ctx.instanceId`: the machine instance.
- Real handlers to read: `examples/concierge/host/refund.mjs` (a refund through a grant, with refusals), `examples/inbox/host/drafts.mjs`.

## Types: types.d.ts

`poly check` writes `.poly/build/<module>.<Machine>/types.d.ts` for each machine. Do not edit it: change the program and check again. It declares:

| Type | What it is |
|---|---|
| `Content`, `Principal` | branded strings; host code passes one it was given and cannot build one from a string |
| `State` | the state as `rt.getState` returns it |
| `Action` | the union of `{ action: "A"; data: { ... } }` over the machine's actions |
| `Effects` | each effect kind with its payload type |
| `Completions` | each effect kind with each outcome (`ok`, `failed`, `exhausted`) and the data of the action it dispatches |

Use them so that the compiler holds the host to the program:

```ts
import type { Action, Effects } from './.poly/build/refund.Desk/types.js';

type Caps = Record<string, any>;

export async function refund(payload: Effects['payments.refund'], caps: Caps, ctx: { idempotencyKey: string }) {
  const res = await caps.egress.post('https://api.stripe.com/v1/refunds', `amount=${payload.amount}`);
  if (res.status !== 200) throw new Error(`refunds.create answered ${res.status}`);
  return { ok: true };
}

// rt comes from load(). The action name and its data are checked against Action.
await rt.dispatch<Action>(id, 'Ask', { amount: 40 });
```

Type the parameters: under `strict`, an untyped `caps` or `ctx` is a compiler error, and so a `PL6836`.

`poly check <project> --host <tsconfig>` compiles the host project against these declarations. Each compiler error is `PL6836 HOST_TYPE_ERROR` at the host file's line. A wrong action name, wrong data, or a payload field the program does not emit is a finding. A `// @ts-nocheck` first line is a finding too. If the compiler cannot run, the host check is listed as not run and the verdict cannot be `CLEAN`.

## Capabilities

A handler receives only the capabilities its effect's labels and targets grant. A call outside the declared targets throws `CapabilityRefused` before the transport runs, and is audited (`PL6406`).

| Label or clause | Capability | Bound to |
|---|---|---|
| `egress:external`, `egress:public` | `caps.egress` (`get`, `post`, `put`, `patch`, `delete`, `head`) | the URL prefixes in `targets { egress: ... }`; `exact "<url>"` admits one URL only; a redirect outside them is refused |
| `read:store`, `write:store` | `caps.store.read(table, key)`, `caps.store.write(table, key, value)` | the declared tables or keys |
| `read:private` | `caps.secrets.get(name)` | the declared secret names |
| `exec` | `caps.exec.run(command, args)` | the declared commands |
| `uses <credential> { scopes }` | `caps.api`, with the same methods, in place of `caps.egress` | the credential's grant and the same egress targets; the vault attaches the token, so no token reaches the handler |
| `one <param>` on an `Items` parameter | `caps.items.read(payload.<param>)` | the one item set the program passed |
| a `Content` in the payload | `caps.content.read(digest)` | this intent's own payload bodies |
| none of the above | nothing | none |

Never read a header that carries a credential (`PL6824`). Never reach ambient authority with `import()`, `globalThis`, `process.env` or `fetch`: the handler lint (`poly lint handlers`) refuses the forms it can see (`PL6401`), and only the opt-in sandbox enforces the rest. An import the certificate cannot name (a missing file, a file outside the project, a URL) is `PL6402`.

## What a handler returns

The runtime reads the handler's end, not its prose:

| The handler | The attempt ends | The program receives |
|---|---|---|
| returns a value | `ok` | the effect's `ok` action; with `ok(r) -> A(p: r.x)`, `r` is the returned object |
| throws an `Error` | `failed`, retried up to `retry { attempts n }` | `exhausted` when every attempt ended; `failed` instead if the effect declares no `exhausted`; else the outcome of a later attempt |
| throws an `Error` with `permanent: true` | final, no retry | the effect's `failed` action at once |
| crashes or times out | `lost`, retried | as a thrown error |

```js
const refuse = (message) => Object.assign(new Error(message), { permanent: true });
```

- Return plain data of the types the completion expects. A result that lacks `r.x`, or has `r.x` outside the parameter's domain, is rejected at dispatch and journaled, and the attempt counts as failed. Return nothing the program does not read.
- Use `permanent: true` for a refusal that the same inputs would repeat: the target did not execute. Use a plain error for anything that might succeed later, or that might already have executed. A 409 on a keyed write and a 429 are plain errors.
- Do not send the idempotency header yourself on an effect that declares `idempotent header "..."`. The runtime sends the intent id on every attempt.
- Do not put a rule in a handler that the program should state. A bound only a handler checks is not a checked property. Say it in the program, and let the handler refuse as a second line.
- A decision is not a handler. A model call is served by a provider (`rt.provide`, or a route's tiers); it answers `{ answer, ... }` and the runtime checks the answer's type and citations.

## Glossary

- **Capability:** a function the runtime passes a handler, bound to the targets its effect declares. It is the handler's only authority.
- **Certified handler:** a handler file whose bytes the certificate names; a changed file is refused at load (`PL6403`).
- **Completion:** the action the runtime dispatches when an effect ends: `ok`, `failed` or `exhausted`.
- **Effect kind:** the string in the effect's `kind` clause; the key a handler is registered under.
- **Grant:** a credential's authorisation held by a person or a merchant; `caps.api` sends under it.
- **Permanent error:** an error with `permanent: true`; the effect ends at once with its `failed` completion.
- **Transport:** the host function a capability calls to do the real network, secret, command or store access.
