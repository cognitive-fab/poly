# The baseline: two arms, one prompt (prepared, not run)

This folder holds what Step 10 needs and nothing that has been run. The owner approves the prompt and the two arm texts, makes the pre-registration commit, and runs each arm in the owner's own terminal. Nothing here starts an agent by itself, and the drafts cost nothing.

## Everything an arm receives (DB2, DB3)

An arm gets four things and no more: the prompt, one appended text, a tool list and a workspace. The prompt and the appended text are below, word for word. The pre-registration holds the SHA-256 of each file, so a changed word is a changed hash and the runner refuses.

### The prompt (`PROMPT.md`, both arms)

```
build a support agent that issues refunds

Customers write to it on WhatsApp (Cloud API webhooks arrive at a local port; replies go out through the Cloud API). Refunds are issued through the Stripe API. The customers' orders are in `orders.json` in the workspace. Include tests, and finish when they pass. Describe in `README.md` how to start it.
```

It names the interface and nothing about failure: no timeout, retry, duplicate or idempotency, no language, and no word of poly.

### The appended text of the TypeScript arm (`arm-ts.md`)

```
Write the program in TypeScript, for Node 24.

Run the tests with `npm test`, which runs `node --test`. You may install packages with `npm install`.
```

### The appended text of the poly arm (`arm-poly.md`)

```
Write the program in poly, for Node 24. poly is a language for the stateful core of software. Its reference is in `tools/poly/` (start with `tools/poly/README.md`) and examples are in `tools/poly/examples/`. Write in JavaScript, beside the poly modules, what poly does not express, as `tools/poly/README.md` describes.

Check poly modules with `npm run poly check <file>`. Run the tests with `npm test`, which runs `node --test`. You may install packages with `npm install`.
```

Each is given to the agent as `--append-system-prompt`. The workspaces hold no `CLAUDE.md`, and the arms run with `CLAUDE.md` files off, so this is the only other instruction. The two texts have the same shape (two paragraphs: the language, then how to run the tests and install packages) and differ in the language, in the reference the poly text points to, and in the one tool that language adds (`npm run poly check`). A test checks that the TypeScript text never says poly, that neither says anything about failure, and that every command a text names is on its arm's tool list.

### The tool lists (`arms.mjs`), as passed to `--allowedTools`

TypeScript arm:

```
Read, Write, Edit, Glob, Grep, Bash(node *), Bash(npm test*), Bash(npm install*), Bash(npx tsc*)
```

poly arm:

```
Read, Write, Edit, Glob, Grep, Bash(node *), Bash(npm test*), Bash(npm install*), Bash(npm run poly check*), Bash(npm run poly witness*), Bash(npm run poly fix*), Bash(npm run poly fmt*), Bash(npm run poly edit-check*)
```

Both run with `--permission-mode dontAsk` (anything off the list is denied without a prompt), `--disable-slash-commands`, `--strict-mcp-config` (no MCP server), no web tool, no subagent. The poly arm has no `poly new` and no `poly explain`, which can call a model. Both arms can run `node` on any file, run their tests and install packages (ruled 2026-10-15: neither has a model key, so `poly new` could not reach a model, and the audit below flags any attempt). The remaining differences are the language's own: the TypeScript arm has the compiler (`npx tsc`), and the poly arm has the five `npm run poly` commands.

### The poly arm's language reference (`tools/poly/`, `poly-reference.mjs`)

Thirteen files, and no others:

```
tools/poly/README.md
tools/poly/docs/03-technical-spec.md
tools/poly/docs/04-semantics.md
tools/poly/examples/delivery/delivery-cleared.poly
tools/poly/examples/delivery/delivery-parallel-fifo.poly
tools/poly/examples/delivery/delivery-parallel.poly
tools/poly/examples/delivery/delivery.poly
tools/poly/examples/evidence/outbox-union-escape.poly
tools/poly/examples/evidence/outbox-union.poly
tools/poly/examples/evidence/outbox-v02.poly
tools/poly/examples/evidence/outbox-v03.poly
tools/poly/examples/hello/hello-empty.poly
tools/poly/examples/hello/hello.poly
```

They are the project's README, its two specifications and three small examples (a turnstile, a message-delivery machine, the outbox model), with the passages removed that work through a refund, a Stripe call or the double-charge case. The README loses its "double charge" walkthrough and gains a paragraph, "What poly does not express", that says the code around a poly program is ordinary JavaScript beside it. The specifications lose their two findings that name the double charge and every refund example, and keep the language's features (retry, class, idempotent). Their running example is renamed from an order that is paid to an order that is shipped, through exact edits: `Pay` becomes `Ship`, `charge` becomes `dispatch`, `charge-at-most-once` becomes `dispatch-at-most-once`, `payments.Payment` becomes `shipping.Shipment`, `payment.charge` becomes `shipping.dispatch`, `PaymentOk` becomes `ShipmentOk`, `api.psp.example` becomes `api.carrier.example`. The old `Ship` and `Shipped` become `Deliver` and `Delivered`, and `Paid` becomes `Dispatched`, to make room. The host handler example posts to a carrier path and still passes `ctx.idempotencyKey`, so that feature stays documented. Two lines of the price section keep "charged its full reservation" (model prices). Three lines that name Stripe as a provider profile stay (the attach style, the deauthorization notice, the secret-key shapes of the config scan). The edits are exact strings in `poly-reference.mjs`, each of which must match once. The record holds the list of the files, its SHA-256, and a digest of what they hold. A test fails if the words refund, Stripe, charge, payment or double appear in the README or an example, or if refund, charge or payment appears in the specifications outside those two price lines, or Stripe outside those three lines.

### The workspaces

Built fresh outside the repository, in `~/.poly-demo/work/<arm>-<run>` (the run's own files are in `~/.poly-demo/runs/<arm>-<run>`, a sibling). TypeScript: `package.json`, `tsconfig.json`, `.npmrc`, `orders.json`. poly: `package.json`, `poly.json`, `.npmrc`, `orders.json`, and the language reference in `tools/poly/` (below). In both, the toolchain is in `.harness/` and declared in `package.json` as `file:.harness/<folder>`, so `npm install` installs it with no network and a later `npm install` keeps it (amendment 1, H1). The TypeScript arm declares `typescript`, `@types/node` and `undici-types`. The poly arm declares those and the eleven poly and engine packages the checker needs. The examples that model this task (the concierge, the retry variants, the inbox, the OMS) and the `demo/` folder are not in it. `orders.json` is the same file, byte for byte, in both.

## Amendment 1: four faults of the harness (DB10 to DB15)

The pilots of 2026-10-15 and 2026-10-16 showed four faults of the harness, not of the arms. The pre-registration is not edited. The change is `PREREGISTRATION.amendment-1.json`, committed by the owner before any run that it governs. It keeps the prompt, the arm texts, the cleaned reference, the model, the agent, the caps and the turn limit, with the same hashes.

| Finding | What it was | What removes it |
|---|---|---|
| H1 | The poly workspace held its packages in `node_modules` without declaring them, and `typescript` was missing. `npm run poly check` failed before the agent acted, and `npm install` pruned all eight packages. | The toolchain is declared (`file:.harness/...`). `smoke.mjs` builds a throwaway workspace per arm and runs, with no network, `npm install`, a check of `hello-empty.poly` (CLEAN) and `hello.poly` (the PL3201 finding, to show the checker runs), a second `npm install --save-dev` of a local package, and the check again; the TypeScript arm runs `npx tsc --version`. `run-arm.mjs --check` runs it, and a run refuses to start if it fails. |
| H2 | Tools reached the owner's home, the owner's own checkout, the global npm folder and the other arm's run; the `Agent` tool was used. | `hook.mjs`, a PreToolUse hook for both arms, denies every tool call that names a path outside the workspace (`guard.mjs`), and `--tools` and `--disallowedTools` remove `Agent`, `Task`, `WebFetch` and `WebSearch`. Workspaces sit in `work/`, not in the runs folder. `commit-run.mjs` audits the saved session and marks the run `escaped` if any call went outside or used a disallowed tool, even one the hook refused. |
| H4 | Bash permission depended on the shape of a command: the first Bash call of `ts-pilot-1` (`cd`, `ls`, `cat` piped to `head`, `node --version`, `npm --version`) was denied command by command, and the agent took Bash to be blocked and never ran its tests. | One read-only set for both arms, decided by the guard: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `cd` within the workspace, and the exact commands `node --version`, `npm --version` and `npx tsc --version`, joined by `&&`, `;` or a pipe, every path inside the workspace (`isReadOnlyBash`). The whole first Bash call of `ts-pilot-1` is in the set. The hook allows such a command whatever its shape. For any other Bash command it says nothing, and the arm's tool list decides as before (so a hook allow never stands in for the list). A pipe into a command outside the set (`cat x | node -e ...`, `find . | grep y`) is refused by the guard; a command of the arm's own tool list, with `2>&1` or `2>/dev/null` and one or more pipes into `head`, `tail` or `wc` that take only flags (`npm run poly check f 2>&1 | tail -30`, `npm test 2>&1 | tail -40`), is allowed by the hook too (`isAllowedWithTail`): the hook reads the arm's own `Bash(...)` patterns from `POLY_DEMO_ALLOWED_BASH`, set by `runArm` from the same list the run uses. A tail with a path after the pipe is not allowed by the hook, and the tool list decides it. |
| H3 | `RECORD.json` called a run that wrote no file of its own `stopped: success`. | `RECORD.json` keeps `sdkResult` (the agent's own label) and adds `agentFiles`, `finalMessage` and `audit`. The runner never prints the label alone. |

The second pilots (2026-10-18) showed three more. `PREREGISTRATION.amendment-2.json` records them, excludes `poly-pilot-2`, lets `ts-pilot-2` stand as the TypeScript pilot and allows one new poly pilot, `pilot-3`. It keeps everything the TypeScript arm meets at run time (its scaffold, tool list, settings, hook and guard).

| Finding | What it was | What removes it |
|---|---|---|
| H5 | The poly workspace declared `@poly/runtime` from `package.json` and `dist` only. The runtime reads a `model/` folder of its own at load, so `load` threw, and `poly-pilot-2` rebuilt the folder into `node_modules` from the specification text. | `.harness/poly-runtime/` now holds `model/` byte for byte (DB16). The smoke test of the poly arm admits the clean example and loads, creates and dispatches through the runtime (steps `admit` and `runtime`), and the TypeScript smoke test runs one trivial `node --test` (step `node-test`). |
| H6 | The audit called `poly-pilot-2` `escaped` for a pipe into `grep -v` inside its workspace. | `audit.mjs` splits the audit: `escaped` (a place outside the workspace, or a disallowed tool) marks the run, `refused` (the guard or the tool list said no, inside the workspace) is listed and does not (DB17). `guard.mjs` and `hook.mjs` are not edited. |
| H7 | The reference prescribes `poly admit` (PT14) and `poly lint handlers` (PT6.5), and the poly tool list refused their `npm run poly` form (`poly-pilot-2` was refused `npm run poly lint handlers .`). | The poly list gains `Bash(npm run poly admit*)` and `Bash(npm run poly lint*)` (DB16 item 6). The TypeScript list is unchanged. |

The same review found that `std`, the standard library the reference describes (the channel kinds, credentials, routing), was not reachable from the poly workspace: the tools read it at `node_modules/std`. `.harness/std` is now a declared package (`std`), and the poly smoke test checks a channel of the `whatsapp` kind (step `std`, DB16 item 7).

The hook reads tool inputs. It does not read what an agent's own program does at run time, so the audit and the tool list are the other controls. It was tested on the recorded inputs of both pilots and not yet in the live agent: the first pilot under the amendment is read for that (DB14).

## What is fixed, and where

| What | Value | Where |
|---|---|---|
| Model, both arms | `claude-opus-5-5` (Q13) | `arms.mjs`, recorded |
| Agent | Claude Code, the version installed when the record is written (2.1.287 on the machine this was drafted on) | recorded; a run refuses if `claude --version` differs |
| Cap per run | 25 USD for each arm, by the agent's own `--max-budget-usd` | `arms.mjs`, recorded |
| Turn limit | 200 for each arm (confirmed 2026-10-15), by `--max-turns` | `arms.mjs`, recorded |
| Billing | the owner's subscription; no API key in either environment; the runner refuses if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set | `procedure.mjs`, recorded as `subscription` |
| Network | neither arm in a container; ordinary network access and no keys | recorded |
| Pilots | one per arm (Q8), reported with the kept run; the number is in the record | recorded |
| Total | four runs at 25 USD at most, 100 USD in all, on the subscription and not on the API ceiling of plan section 5 | recorded as `totalCapUsd` |
| Login | the owner's own, in a folder of its own (`~/.poly-demo/claude`) kept to the login and one setting; no `CLAUDE.md`, memory, plugin, skill or connector reaches the agent | `experiments/m3/runner/isolation.mjs`, reused |

## What the owner types, step by step

Each step is in the owner's terminal, at the repository root, on the branch `demo`.

1. **Read the prompt and the two arm texts** (above, or `PROMPT.md`, `arm-ts.md`, `arm-poly.md`). Approve the wording, or change it (the hashes then change). Confirm the turn limit of 200, or give another (`MAX_TURNS` in `arms.mjs`).
2. **Make sure no API key is set.** In PowerShell: `Get-ChildItem Env:ANTHROPIC*` must print nothing. If it prints a name, remove it with `Remove-Item Env:<name>` in that window. The runner refuses to start while either variable is set.
3. **Set up the agent's login folder, once.** In PowerShell: `$env:CLAUDE_CONFIG_DIR = "$HOME\.poly-demo\claude"; claude`, then `/login` with the subscription, then exit. Put exactly `{"env":{"DISABLE_AUTOUPDATER":"1"}}` in `settings.json` in that folder. `node demo/baseline/run-arm.mjs --arm ts --run pilot-1 --check` then reports what is still wrong, and starts nothing.
4. **Know what the record can and cannot fix.** The cap on a run is the agent's `--max-budget-usd`, measured to hold on the subscription in M3. The turn limit is `--max-turns` (200), an option the installed version accepts but does not list in its help. Whether it is enforced can be known only by a run, so the record fixes the setting, not the enforcement. The first pilot's `result.json` and session show the number of turns taken, and the report says whether the limit held. The owner may first run one throwaway call with `--max-turns 1` on a trivial prompt in the login folder to see it stop; that costs a little and is the owner's choice.
5. **Write the record.** `node demo/baseline/preregister.mjs` (add `--pilots-ts 0` or `--pilots-poly 0` to change a pilot count). It reads `claude --version`, hashes the prompt, the two arm texts, the poly reference and the two scaffolds, records the two tool lists in full, writes `demo/baseline/PREREGISTRATION.json`, and prints the commit command. Read the record: it names the model, the version, the caps, the turn limit, `subscription`, the network, the tool lists and the hashes. A changed tool list, arm text or reference is refused by the runner.
6. **Make the pre-registration commit.** `git add demo/baseline/PROMPT.md demo/baseline/PREREGISTRATION.json`, then the `git commit` the script printed. This is the commit that fixes the prompt and the arm texts before any run. Nothing may run before it, and the runner refuses to.
7. **Commit amendment 1.** (Needed once, after the pilots of 2026-10-15 and 2026-10-16.) Read `demo/baseline/PREREGISTRATION.amendment-1.json`, then `git add demo/baseline/PREREGISTRATION.amendment-1.json` and the `git commit` that `node demo/baseline/preregister.mjs --amend 1` printed. The runner refuses every run until it is committed. The two pilot-1 runs stay in the record as findings of the harness, excluded from results.
7a. **Check, then run the new pilots** (one per arm, named `pilot-2`; a pilot is never discarded for its outcome or swapped for the kept run): `node demo/baseline/run-arm.mjs --arm ts --run pilot-2 --check` (it runs the smoke test and prints each step), then `node demo/baseline/run-arm.mjs --arm ts --run pilot-2`, then `node demo/baseline/commit-run.mjs --arm ts --run pilot-2`, then type the three commands it prints. Read the line it prints first: the agent's own label, the number of files the agent made, and the audit. Do the same for `--arm poly`. Each run costs at most its cap.
8. **Run the kept runs.** `node demo/baseline/run-arm.mjs --arm ts --run kept`, then `commit-run.mjs --arm ts --run kept` and its commands; the same for `poly`. The run is committed verbatim before anything is run against it, and no file of it is edited afterwards. The command `git rev-parse HEAD:demo/baseline/runs/ts-kept/tree` gives the tree hash for the demo's record.
9. **Run each committed tree, on a copy.** Copy `demo/baseline/runs/<arm>-kept/tree` to a scratch folder, install what it needs there (the committed tree stays as it was), then `node demo/demo.mjs replay --build <scratch> --start "<the command its README gives>" --fault lost-answer --test-command "<its test command>"`, or in the container (`demo/README.md`) with Docker Desktop started. The report gives the five numbers, the control, and O1 to O4. For the poly arm, `poly check` on the build gives P1 to P4 and the witness.
10. **Record the outcomes as they fall,** in `docs/decisions-demo.md`, each as it is (O1 to O4, P1 to P4). None is replaced by another run.

## Limits to read before relying on it

- **The tool list is not a sandbox.** An arm that may write a file and run its tests can run any code it wrote, `poly new` included. So the session is read after each run for anything that would call a model, and each hit is recorded in `result.json` (`modelCallFlags`) for the owner to read. Neither arm has a model key in its environment (the runner refuses one), so a call to a model fails and the audit records the attempt.
- **The confinement is not yet seen in the live agent.** The hook is tested on recorded inputs and by child process, and the audit reads every saved session. Whether Claude Code runs the hook as installed (`--settings`, forward-slash path, `POLY_DEMO_WORKSPACE`) is shown by the first pilot, and the report says what it showed.
- **A repeat is a new pre-registration.** The runner takes the commit that introduced `PREREGISTRATION.json` as the pre-registration and refuses if the record, the prompt or an arm text has changed since, so a second experiment starts in a folder of its own, with its own record, before any of its runs.
- **The network is open.** Neither arm runs in a container, and the runner cannot limit the network. The record says so.

## Conclusion

The protocol is fixed in code that refuses: no run before the record is committed, none on a prompt or an arm text that does not hash as recorded, none on another agent version, none with an API key in the environment, none past the pilots the record names, and none that would repeat a run. The two arms get the same cap, the same turn limit and the same kind of text. What the agents do is the result, whatever it is.

## Glossary

- **Arm text:** the one paragraph pair appended to an arm's system prompt, naming its language and how to run its tests.
- **Pre-registration commit:** the commit that holds `PROMPT.md` and the record, made before any run.
- **Pilot:** a run decided in advance, reported with the kept run, never discarded for its outcome.
- **Kept run:** the one run of an arm that the demo uses, committed verbatim.
- **Preflight:** the checks a run must pass before the agent starts.
- **O1 to O4, P1 to P4:** the pre-registered outcomes of the TypeScript build and of the poly build (DB7).
