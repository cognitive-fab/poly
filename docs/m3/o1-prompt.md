# Writing end-to-end test suites from briefs

You are writing test suites for ten small systems. Each system is described by a brief and a TypeScript host interface. Other people will implement the systems, some correctly and some not, and your suites will be run against their implementations. You will never see an implementation, and you must not guess at one: test only what the brief promises, through the host interface.

## What you have

The workspace holds one directory per task, `T1` to `T10`. Each has:

- `v0/brief.md` and `v0/host.ts`: the system as first specified;
- `v1/`, `v2/` and `v3/`: the same system after one, two and three changes. Each holds `brief.md`, the brief as changed so far (the original brief followed by each change in order), and `host.ts`, the interface at that point.

Read the whole brief of a version before writing its suite. A later version may add commands, add fields to a query result, or change a rule; its suite tests the system as that version describes it.

## What to deliver

One suite per task and version, `o1/<task>/v<n>.test.mjs` (for example `o1/T4/v2.test.mjs`), forty files in all.

Each suite:

- is plain JavaScript run with `node --test`, using only Node's built-in modules (`node:test`, `node:assert/strict`, `node:url`);
- loads the implementation from the path in the environment variable `M3_IMPL`, which it does not choose:

  ```js
  import { pathToFileURL } from 'node:url';
  const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);
  ```

- creates a fresh system with `await createHost()` in every test, so that tests do not depend on each other;
- awaits every call, since every method and query of the interface returns a promise;
- checks a command's outcome by its `ok` field only: the wording of a refusal's `reason` is the implementer's choice;
- runs in under a minute, with no timers, sleeps, network or file access.

Write many small tests rather than a few large ones, each named for the one behaviour it checks. A failing test is counted as one defect of the implementation, so a test should fail only when the brief is broken, and each broken rule should fail its own tests.

## What to test

Test every rule the brief states: each command in each situation where it takes effect and where it is refused, what the queries return after it, and what must hold after any sequence of commands. The conclusion of each brief says what matters most; test it from several directions. A refused command changes nothing, so check the queries after a refusal too.

Some systems have parts that talk by messages. For those, the interface has `inFlight()`, `deliver(id)` and `deliverAll()`, and the brief names each message, its sender, its receiver and its data. Nothing is delivered until the test delivers it, and messages may arrive in any order. Test the orders that matter: deliver one message before another, deliver a reply before or after a later command, and check what the brief promises in each case. Find a message by its `from`, `to`, `action` and `data` in the result of `inFlight()`, never by its position or its `id`, which the implementation chooses.

Some systems ask the outside world to do things, such as charging a card. For those, the interface has an effect port: `pendingEffects()` lists what was asked and not yet answered, and `completeEffect(id, outcome)` gives the answer, `'ok'` or `'failed'`. The brief names each effect's `kind` and data. Test what the brief promises for each answer, and for answers that come late or in a different order from the requests. Find an effect by its `from`, `kind` and `data`, never by its `id`.

## Flag what a brief should not say

A brief should describe behaviour only. Also write `o1/LEAKS.md`: for each task and version, list every sentence of the brief that names a particular programming language, framework, verification tool or modelling notation, or that describes how the system should be built inside (its internal states, components or data structures) rather than what it does through the interface. Quote the sentence and say why. Write `none` for a brief with nothing to flag. Then write the suites as the briefs say; a flag changes nothing in them.

## What not to do

- Do not test anything the brief does not say. If the brief is silent, the implementer may choose.
- Do not read or depend on anything outside a test's own calls to the interface: no internal fields, no files, no timing.
- Do not write an implementation, even a partial one, and do not ask for one.

## Conclusion

Forty suites, one per task and version, and `o1/LEAKS.md`, each a set of small named tests of the brief's promises through the host interface, run by `node --test` against the implementation at `M3_IMPL`. A correct implementation passes every test; an implementation that breaks a rule of the brief fails the tests of that rule.
