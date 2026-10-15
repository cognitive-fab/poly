# The baseline: two arms, one prompt (prepared, not run)

This folder holds what Step 10 needs and nothing that has been run. The owner approves the prompt, makes the pre-registration commit, and runs each arm in the owner's own terminal. Nothing here starts an agent by itself, and the drafts cost nothing.

## The prompt (DB2)

`PROMPT.md` is the whole prompt, as the agent receives it, byte for byte: the owner's sentence, a blank line, and the fixed paragraph. Its SHA-256 goes into the pre-registration record. `.gitattributes` leaves its bytes alone (no end-of-line conversion), so the hash is the same on every checkout. If the wording changes, the hash changes and nothing has run.

```
build a support agent that issues refunds

Customers write to it on WhatsApp (Cloud API webhooks arrive at a local port; replies go out through the Cloud API). Refunds are issued through the Stripe API. The customers' orders are in `orders.json` in the workspace. Include tests, and finish when they pass. Describe in `README.md` how to start it.
```

The paragraph names the interface and nothing about failure: no timeout, retry, duplicate or idempotency, no language, and no word of poly. The language is set by the workspace each arm starts in.

## What is fixed, and where

| What | Value | Where |
|---|---|---|
| Model, both arms | `claude-opus-5-5` (Q13) | `arms.mjs`, recorded in the pre-registration |
| Agent | Claude Code, the version installed when the record is written (2.1.287 on the machine this was drafted on) | recorded; a run refuses if `claude --version` differs |
| Per-run cap | TypeScript arm 15 USD, poly arm 25 USD (plan section 5), by the agent's own `--max-budget-usd` | `arms.mjs`, recorded |
| Total ceiling | 90 USD on the API; a further run of anything is a new approval | recorded |
| Pilots | one per arm (Q8), reported with the kept run; the number is in the record | recorded |
| Tools | the TypeScript arm: file tools, `node`, `npm`, `npx`. The poly arm: file tools, `node`, `npm test`, and `npm run poly` for `check`, `witness`, `fix`, `fmt`, `edit-check`. No web tool, no subagent, no MCP server, no slash command. `poly new` and `poly explain` (which can call a model) are not allowed. | `arms.mjs` |
| Login | the owner's own, in a folder of its own (`~/.poly-demo/claude`) kept to the login and one setting; no `CLAUDE.md`, memory, plugin, skill or connector reaches the agent | `experiments/m3/runner/isolation.mjs`, reused |
| Workspaces | built fresh outside the repository. TypeScript: `package.json`, `tsconfig.json`, `orders.json`. poly: `package.json`, `poly.json`, `orders.json`, the toolchain in `node_modules`, poly's README and specifications. The examples that model this task (the concierge, the retry variants, the inbox, the OMS) are left out. | `arms.mjs` |

## What the owner types, step by step

Each step is in the owner's terminal, at the repository root, on the branch `demo`.

1. **Read `PROMPT.md`.** Approve the wording, or change it (the hash then changes).
2. **Set up the agent's login folder, once.** In PowerShell: `$env:CLAUDE_CONFIG_DIR = "$HOME\.poly-demo\claude"; claude`, then `/login` with the subscription, then exit. Put exactly `{"env":{"DISABLE_AUTOUPDATER":"1"}}` in `settings.json` in that folder. `node demo/baseline/run-arm.mjs --arm ts --run pilot-1 --check` then reports what is still wrong, and starts nothing.
3. **Check the spend limit.** The cap on a run is the agent's `--max-budget-usd`. If the installed version does not enforce it, set a limit at the account (A9) before any run.
4. **Write the record.** `node demo/baseline/preregister.mjs` (add `--pilots-ts 0` or `--pilots-poly 0` to change a pilot count). It reads `claude --version`, hashes the prompt and the two scaffolds, writes `demo/baseline/PREREGISTRATION.json`, and prints the commit command. Read the record.
5. **Make the pre-registration commit.** `git add demo/baseline/PROMPT.md demo/baseline/PREREGISTRATION.json`, then the `git commit` the script printed. This is the commit that fixes the prompt before any run. Nothing may run before it, and the runner refuses to.
6. **Run the pilots first** (their number is decided in step 4, and a pilot is never discarded for its outcome or swapped for the kept run):
   `node demo/baseline/run-arm.mjs --arm ts --run pilot-1`, then `node demo/baseline/commit-run.mjs --arm ts --run pilot-1`, then type the three commands it prints. Do the same for `--arm poly`. Each run costs at most its cap.
7. **Run the kept runs.** `node demo/baseline/run-arm.mjs --arm ts --run kept`, then `commit-run.mjs --arm ts --run kept` and its commands; the same for `poly`. The run is committed verbatim before anything is run against it, and no file of it is edited afterwards. The command `git rev-parse HEAD:demo/baseline/runs/ts-kept/tree` gives the tree hash for the demo's record.
8. **Run each committed tree, on a copy.** Copy `demo/baseline/runs/<arm>-kept/tree` to a scratch folder, install what it needs there (the committed tree stays as it was), then `node demo/demo.mjs replay --build <scratch> --start "<the command its README gives>" --fault lost-answer --test-command "<its test command>"`, or in the container (`demo/README.md`) with Docker Desktop started. The report gives the five numbers, the control, and O1 to O4. For the poly arm, `poly check` on the build gives P1 to P4 and the witness.
9. **Record the outcomes as they fall,** in `docs/decisions-demo.md`, each as it is (O1 to O4, P1 to P4). None is replaced by another run.

## Open choices for the owner

- **Billing.** The M3 arms ran on the subscription and refused any API key in the environment (4210fa6), and the CLI's dollar cap was measured to hold there. Plan section 5 speaks of 90 USD "on the API". This draft follows M3: `run-arm.mjs` refuses to start while an API key variable is set. If the owner wants the API instead, say so and the check changes.
- **How the poly arm reaches poly.** The draft gives it `npm run poly ...` through Bash, as M3's arms had, and no MCP server or skill. If the plugin's tools (`poly_check` and the rest) should be the interface, the workspace and the tool list change, and the record with them.
- **The TypeScript arm's network.** It needs the package registry; the runner cannot limit the network. A container with the registry and the model API alone is the owner's to choose.

## Conclusion

The protocol is fixed in code that refuses: no run before the record is committed, none on a prompt that does not hash as recorded, none on another agent version, none past the pilots the record names, and none that would repeat a run. What the agents do is the result, whatever it is.

## Glossary

- **Pre-registration commit:** the commit that holds `PROMPT.md` and the record, made before any run.
- **Pilot:** a run decided in advance, reported with the kept run, never discarded for its outcome.
- **Kept run:** the one run of an arm that the demo uses, committed verbatim.
- **Preflight:** the checks a run must pass before the agent starts.
- **O1 to O4, P1 to P4:** the pre-registered outcomes of the TypeScript build and of the poly build (DB7).
