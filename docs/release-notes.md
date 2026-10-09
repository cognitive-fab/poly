# Release notes

What a user of poly needs to know when a milestone changes a format, a command or what a guarantee covers. Each entry names the milestone and the requirement ids it rests on. The specifications stay the source of truth.

## M8: Workflows under the gate, `use`, `Content`, `never` and channels

- **Workflows run on `poly-runtime`, under the gate** (S173 to S175, PT10). Each work order is proposed to the gate and journaled before it is issued. The certificate lists each workflow as `{ runtime: "poly-runtime", gated: true }` with no `ungated` limit, and load refuses a certificate that lists one as run by polyflow.
- **An order id per attempt** (S173 as amended, PF8.5a). Each issued attempt has its own order id, `<intent>#<attempt>`, which agents treat as opaque. A retry is never proposed again, and a report naming a replaced attempt's order id is refused and audited.
- **A new command, `poly run --mcp [--project <dir>]`** (S174, S188). It loads the runtime from `poly.json` and serves polyflow's six workflow tools with their names and schemas. It serves no approve or accept tool, and takes the ledger key only from the configured signer. The Claude Code `install.json` now launches it in place of polyflow's server.
- **`poly.json` gains a `run` field** (S188, PT1.2): the certificate, the store, trust as admission public keys (`file:` only), an optional ledger signer and the approvals folder. A signer whose path resolves inside the project is refused at load. An unknown field under `run` is refused. Its schema is `schemas/manifest/run.json`.
- **The approvals drop folder** (S189, PT12.5). `poly run --mcp` takes each `*.json` record once a second, in file-name order, and applies it once. A refused record carries `not-a-record`, `wrong-key`, `unmatched`, `replayed` or `expired`. The file moves to `applied/`, or to `refused/` with `<file>.reason.txt`. `poly approve --out <file>` writes one.
- **The journal gains three runtime runs.** `runtime:approvals` holds a `verdict` event for every approval applied or refused, with the record kept by digest. `runtime:store` holds a takeover of a stale store lock, with the old process id and start time. `runtime:ingress` holds every refused webhook, every receipt and every message's sender claims.
- **The store lock is an OS lock** on `<store>.lock.db`. The lock file only records the owner's process id and start time.
- **`use` within a project** (S176, PS1.0). A machine of another module is always written `m.M`, and `use m.M` admits `m.M` alone. Two files that declare one module are `PL1002`. Imports across projects stay out of v1 (PT1.3).
- **Enums across modules** (S190, PS1.0). A payload-free enum of a used module is the type `m.E`. The certificate records each module whose enums a build uses, by a path relative to the project or to std, and load refuses one that changed (`PL6407`).
- **`Content`, an opaque body reference** (S180, PS1.4a). It is stored, passed and compared with `==` and `!=`, and nothing else (`PL1209`). A step whose `Content` names no body in the store is rejected `content-missing`, journaled, with the state unchanged. `$content` is a reserved name.
- **`never emit k(...) while P`** (S178, PS5.2, PS5.2a). A never that is never tested in its machine or configuration is listed as vacuous, and the verdict is at best `INCONCLUSIVE`. This changed `conformance/m8/never/chat-ruled-out.poly` from CLEAN to INCONCLUSIVE (and to FINDINGS in M9, below).
- **Channels** (PS15, PT10a). `channel c: k { adapter, thread, starts A.S [on inbound], P -> A.X ... }` expands into a detached conversation from `std/channels` (`whatsapp`, `sms`, `email`, `slack`, `webhook`), checked in a generated configuration under the channel's name. The expansion appends `send c <- Ack()` to every handler bound to a receipt; an author never writes or binds `Ack`.
- **The bounds of a channel's generated configuration** (PS15.5, A-F2). For an application bound to `n` channels the instance bound is `1 + n` and the transit bound `N + n - 1`.
- **Network code lives in `poly-io` alone** (S182). No check package imports it. Each channel's adapter is certified by package, version and digest (`poly.adapters`), and `rt.connectChannel` and `rt.receive` refuse any other (`PL6408`).
- **Sender claims come from the adapter only** (K11, review D-F4). `rt.inbound` takes no claims, so an `Inbound` that declares claims is refused `claims-unverified` there; `rt.receive` verifies a webhook with a certified adapter and delivers its claims.
- **New reserved refusals on `runtime:ingress` and on a conversation.** `unknown-thread`, `thread-not-started`, `creation-unavailable`, `outside-type`, `claims-unverified`, `token-replayed` and `team-mismatch` at ingress; `backlog` and `busy` on a conversation. Each is journaled.
- **The store gains two tables.** `poly_ingress_nonce` keeps a provider's nonce (Mailgun's token) until its timestamp leaves the tolerance. `poly_store_key` holds a 32-byte key the store makes when it is created and never exports, logs, journals or certifies.
- **A new proposal field, `effect.channel`** (S181, S185, PT10c): `{ name, kind, recipient, recipientClass, messageKind }`. The recipient is `hmac-sha256` under the store's key, never the address. A policy reads `effect.channel.*`; any other field is `PL1001`.
- **A note for policy authors.** A rule over `effect.*` is also read on a send between trust scopes, where `effect` is unknown; with `on unknown deny` it denies the send. Guard it with `proposal.kind == "effect" && ...`.
- **The policy engine is pinned** (E10). A build with policies records `poly.policyEngine` (`polyaxion` and its commit), and admission and load refuse an engine whose files differ from the pin, naming them.
- **A configuration not checked because its program was refused reads INCONCLUSIVE** (review A-F7), where it read CLEAN.

**New codes.**

| Code | Meaning |
|---|---|
| `PL1209 CONTENT_NOT_OPAQUE` | An order, arithmetic, a string comparison, a map key, a record or payload field, a check domain or a digest literal on a `Content` (PS1.4a, S180). |
| `PL5406 RECEIPT_REJECTED` | In a configuration with a channel, a reachable delivery of a receipt the application rejects (PS15.5). |
| `PL5407 REPLY_REFUSED` | In a configuration with a channel, a `Reply` or `Template` the conversation can refuse `busy` (PS15.5). |
| `PL6407 TYPE_MODULE_CHANGED` | At load, a module whose enums the build uses changed since it was built (S190). |
| `PL6408 ADAPTER_NOT_CERTIFIED` | `rt.connectChannel` or `rt.receive` given an adapter the certified package did not make, or of another kind (S182). |
| `PL6811 CHANNEL_KIND_UNKNOWN` | A channel's kind lacks the `Peer`, `Conversation` and `Ack()` interface of PT10a. |
| `PL6812 THREAD_KEY_INVALID` | A thread key reads a field of the conversation's `Inbound` that is not a checked string. |
| `PL6813 CHANNEL_BINDING_INCOMPLETE` | A `Peer` action is not bound. |
| `PL6814 CHANNEL_BINDING_NOT_ONE_TO_ONE` | Two `Peer` actions are bound to one application action. |
| `PL6815 CHANNEL_BINDING_MISTYPED` | A binding does not match the `Peer` action's parameters by name and type. |

- **Stated limit: `emits` cannot tell two effects of one kind apart** (PS5.2). An intent, a witness and the journal carry the kind, not the name, so `emits` on either effect is `PL1201`. Give the two effects different kinds.
- **Stated limit: a configuration rules out only a never finding with no constrained witness.** A finding of a machine that no configuration includes stays a finding, marked `environment: unconstrained`.
- **Stated limit: the store must be on a local disk, and has one name.** OS file locks are unreliable on network shares, and a store file with a hard link is refused.
- **Stated limit: a provider rule a conversation module does not encode is not checked.** Each module's `PROVENANCE.md` lists what is and what is not. A rule the provider changes later is a new module version, and M8 ships first versions only.
- **Stated limit: poly checks no time.** A channel's durations (`24h` for WhatsApp, `1s` for Slack) are constants recorded with their sources; what is checked is the order.
- **Stated limit: a thread holds at most two unanswered messages.** A third is refused `backlog`.
- **Stated limit: a thread whose `starts` was refused stays dead.** The application exists with no conversation, and every later message on its thread is refused `thread-not-started`.
- **Stated limit: WhatsApp's window, on the safe side.** A message that finds the backlog full while the window is open does not reset the module's timer, so the module may refuse a free-form reply WhatsApp would take, and never sends one WhatsApp would refuse.
- **Stated limit, lifted in M9: a channel's journal holds its correspondents' addresses** (S191). Since M9 step 9 the journal holds only their keyed digests.
- **Stated limit, lifted in M9: a declared configuration fires no timer** (S192). Since S206 every configuration fires every armed timer.
- **Stated limit, corrected in M9: a reply on another channel** gets `PL5407` in the first channel's configuration (S193). S207 found the finding is the program's, not only the configuration's.
- **Stated limit, lifted in M9: no channel thread is created at run time** (E13, `creation-unavailable`). polygraph 8.4.0 vendored in M9 creates it.

## M9: Credentials, signed policies and erasure

- **A person signs every policy** (S194, Q8, PT12.5). `poly sign policy <scope> --by <keyId> --key <file>` writes `policies/<scope>.sig.json`. Admission and load refuse an unsigned scope, one signed by a key outside the `people` ring, or one signed over another document, source or engine (`PL6409`).
- **The keyring is anchored outside the project** (S194, S210, PT12.5). A change to `people` or `agents` is admitted only through `keyrings/history.json`, each entry signed by a key of the previous `people` ring (`PL6410`). The anchor's location is read from `.poly/anchors.json` under the user's home directory; `poly.json` cannot name it (`keys.anchor` is refused).
- **Four new owner's commands, never served over MCP.** `poly anchor keyrings --out PATH [--production]`, `poly sign keyrings` (the key from a file or stdin), `poly anchor production on|off` and `poly sign policy`.
- **What a person decides only moves forward** (S210). Load verifies the keyring chain from the anchor, as admission does. The anchor keeps the highest keyring head and the highest policy sequence per scope, and admission and load refuse a rollback of either. A keyring record names its project's anchor id.
- **Production is a property of the anchor** (S210, D9). `poly.json` naming `production` is refused. With the anchor's flag set, admission and `rt.connectVault` refuse the development keychain (`PL6826`), and load refuses `LoadOptions.fault`.
- **The anchor and signature formats changed** (S210, PT12.5). The anchor is `{ v: 2, id, project, first, head, policies, production }`. A policy signature file is `{ v: 2, sequence, record }`. A keyring record's subject is the digest of `{ anchor, parent, rings }`. Every change of the anchor holds a lock file beside it.
- **Credentials** (S203, PT10e). `credential c: oauth2 { provider "p" grant ... scopes { ... } holder Principal }` is a declaration, and `uses c { s, ... } for p` an effect item. Each credential means the module `m.c` with its own `std.credentials.Grant` (S209, PS16.1), reported as `c.Grant`. Provider profiles live in `std/credentials/providers` (`stripe-connect`, `google`).
- **`poly.json` names each credential's vault store**, `credentials: { "<name>": { "store": "dev-keychain" | "kms" } }` (S200). A credential with no store named is refused at admission. The certificate binds `poly.credentials` and `poly.vaults`.
- **The grant check runs before the mandate and the policy** (PS16.3). It refuses `credential-unavailable` or `insufficient-scope`, final whatever the policy says. A passing intent is proposed with `credential: { name, grantState, scopes }`; a policy reads `effect.credential.name` and `effect.credential.grantState`, not the scopes.
- **`api` replaces `egress` in a handler of an effect with `uses`** (S201, PT22.5). It sends through the vault, which attaches the token; the handler never holds it.
- **Two new commands for grants, never served over MCP.** `poly grant-request --credential <c> --for <holder> --by <key id> --key file:PATH` writes a signed request (a `grant-request` record since S210), and `poly grant-revoke --grant <id> --by <key id> --key file:PATH` a signed revocation, both to the approvals folder. An unsigned request is refused `not-a-record`.
- **Revocation from three sources** (PS16.4): the provider, a security signal, or a person's signed `revocation` record. Only the runtime takes a grant's transitions other than `TokenExpiring`.
- **Nothing refreshes a token on its own.** The host dispatches `TokenExpiring` from the token lifetimes it knows.
- **Claims' ages and mandates** (PD6, S195 to S198). A policy writes `age(step.claims)` and `statusAge(step.claims)`, in milliseconds, and reads `step.mandate.delegate` and `step.mandate.delegator`. A widened or revoked mandate chain is refused before any step, with an audit row (`mandate-widened`, `mandate-revoked`); an effect outside the innermost mandate is denied `outside-mandate`.
- **Stale claims are denied, never refreshed** (S198 as ruled). A rule over a claim's age denies `stale-claims`; one written `escalate` or `warn` is `PL1201`. The host dispatches the action again with a fresh presentation, as a new intent.
- **Timers fire in every configuration** (S206, PS15.5). `conformance/m8/never/chat-ruled-out.poly` changed from INCONCLUSIVE to FINDINGS: the unfired timer was hiding a real never violation.
- **A joint configuration for a reply across channels** (S207). An application that answers one channel's message on another gets one more configuration, named after it, explored to 10,000 global states; reaching the cap is `PL3901`, and the configuration reads INCONCLUSIVE.
- **The journal and the store changed for evidence and erasure.**
  - A step's ledger event binds the digest of its evidence as `evidence`, kept in `poly_evidence`; a verdict's action records the ages it computed, so replay reads no clock (PD6).
  - `rt.erase(digest)` keeps the digest in `poly_erased` and journals the erasure on `runtime:content`. An erased digest is never stored again (S205).
  - A channel's application instance is `<channel>:<keyed digest>`, the conversation's `Inbound` carries the fields' digests, and ingress journals the sender by digest; `rt.threadId(channel, key)` names a thread (S191).
  - Grants are kept in `poly_grant`, as `grant:<c>:<keyed digest of the holder>#<n>`; used records in `poly_used_record`; records the journal keeps by digest in `poly_kept`, apart from bodies.
- **The vendored engines changed.** polygraph is 8.4.0 (E13), and Polyaxion is vendored in `vendor/polyaxion` at its pin.

**New codes.**

| Code | Meaning |
|---|---|
| `PL6409 POLICY_NOT_SIGNED` | At admission or load, a policy scope with no `policy` record by a person over its document, sources, engine and sequence (S194, S210). |
| `PL6410 KEYRING_NOT_SIGNED` | Rings not anchored, or changed without a `keyring` record by a key of the previous `people` ring; at load since S210 (S194). |
| `PL6821 SCOPE_NOT_DECLARED` | A `uses` names a scope its credential does not declare. |
| `PL6822 HOLDER_NOT_NAMED` | An `authorization_code` credential used with no `for p`. |
| `PL6823 TARGET_OUTSIDE_PROVIDER` | An egress target of an effect with `uses` outside the provider's base addresses. |
| `PL6824 TOKEN_READ_IN_HANDLER` | A handler reads `authorization`, `proxy-authorization` or `set-cookie` by name. |
| `PL6825 SECRET_IN_CONFIG` | A token-shaped string in `poly.json` or in any file the certificate binds; the message names the file and the kind, never the value. |
| `PL6826 VAULT_NOT_FOR_PRODUCTION` | The development keychain in a production project. |

- **Stated limit: anchors written before S210 hold only a digest** and are refused until the owner anchors the project again with `poly anchor keyrings`. A policy signature of the form before S210 is signed again with `poly sign policy`.
- **Stated limit: the anchor is protected by the owner's file permissions.** An agent that can write the owner's per-user configuration or the anchor file can still move it (PT12.5).
- **Stated limit: polygraph 8.4.0** is vendored from the branch `e13-create-instance`, not published and not merged into polygraph's main.
- **Stated limit: recorded OAuth traffic only.** Every vault test runs against the documented payloads of the tests' provider, Stripe and Google. A live consent on a real account is not gated.
- **Stated limit: the canary scan** finds a token plain, in base64, base64url or URL-encoded; another encoding is not found.
- **Stated limit: `PL6825` finds the shapes it lists.** A secret in another shape is not found (PT10g).
- **Stated limit: a refused callback whose revocation fails** leaves its token set in the vault under a grant that is not `Granted`, which the grant check never lets an intent use (review C2).

## M10: Memory

- **Forgetting a whole source** (`poly forget --source <s>`, PS17.7, PT10l) erases poly's copies: every body a decision read from the source, the item sets that came from it, and its memory items. The source's own data is the source owner's to erase: no adapter call takes a source, so poly asks none. Forgetting a subject (`poly forget --subject <principal>`) erases every body whose taint names the subject among its owners, derived ones included, removes the item sets and memory items that name the subject, and asks each connected source adapter to forget that subject.
- **The journal format changed.** A decision event now records the item set its answer cites, `cites: { ref, count }`, for a decision with `cites` (PS17.6, PT10l). Journals written before v1 are pre-release, and no reader is kept for decision events without it.
- **Two new owner's commands**, `poly memory-verify` and `poly forget`, sign a person's record from a key file outside the repository. Neither is served over MCP.
- **Stated limit: a decision with a finite answer** (S323, PS17.2). A decision whose answer is a `bool`, an enum or a range carries no taint, so it can pass up to log2 of the number of its answers in bits per call about what it read to whoever its answer reaches. The certificate lists every such decision that reads tainted data, with the class it reads and the number of its answers, and a policy can deny it by `effect.taint.class`.
- **Stated limit: a count** (S325, PS1.4b). `x.count` of an `Items` carries no taint, so whether another principal has any items, and how many, reaches whoever the count is sent to. The certificate lists each count read of an item set whose owner predicate is not the requester's principal.
- **Records bound to the project** (S321). `poly memory-verify` and `poly forget` sign over the project's anchor id; a record signed for another project is refused `wrong-project`.
- **Stated limit: the runtime may refuse what the checker passes** (S326, S327, PS17.4). A retrieval with no owner predicate is owned by every principal at run time, and a body received on a channel is owned by its sender; both exist only at run time and only narrow an audience. So a send `poly check` finds clean can still be denied `audience` when it runs, never the reverse.
- **Stated limit: freshness is judged when an intent is proposed** (S307, PS17.6). A decision whose first attempt fails and is retried reads its items again without a new freshness check, so a retry may read items that have since gone stale. An adapter's `asOf` in the future gives an age of 0.
- **Stated limit: recorded traffic only** (S308, K14). The source adapters are tested against documented Postgres statements and OpenSearch responses; a live database or index is not gated.
- **Stated limit: the canary scan** finds an item body plain, in base64, base64url or URL-encoded; another encoding is not found.
- **Generated host types** (PT28.1, S311). Lowering writes `types.d.ts` beside each machine, a certified artefact read back by translation validation. `rt.dispatch<Action>(id, action, data)` checks the action and its data when given the machine's `Action`; with no type argument it is untyped, as before.
- **A new option, `poly check --host <tsconfig>`** (PT28.1d, S312). It compiles host code against the generated declarations; each type error is `PL6836`. A host check that cannot run is listed as not run, and the verdict is at best `INCONCLUSIVE`. Type checking cannot be switched off.
- **A new command, `poly edit-check`** (`poly_edit_check` over MCP and the language server, PT28.4, S313). It checks a module with an edit applied in memory and writes the edit only with `apply`, and only when the verdict is not `REFUSED`, `ERROR` or `NONDETERMINISM`. It edits only a module, and never admits, signs or runs anything.
- **New declarations** (PT10i, PS1.4b, PS17): `audience { ... }`, `source s: records | documents | memory { ... }`, and in an effect `retrieve`, `remember`, `to p` and `audience c`; `cites x` in a decision; `audience` on a channel. A decision's answer may now be a `Content` (S318).
- **The flow check runs first, before the grant check, the mandate and the policy** (S302, PT10k). A body with no taint record, or a recipient who may not read a taint, denies the intent `audience`, final whatever a policy says. The claimed class is the recipient's only when the send has no `to`, or `to` is the claimant (S324).
- **New refusals.** `audience`, `stale-items` (denied or escalated by the source's `stale` clause), `uncited` (an answer citing an item it was not given), and `escalate-once` after an approval of another escalation.
- **New proposal fields** (PT25.1). An intent carrying a `Content` is proposed with `taint: { class, owners }`, owners by keyed digest; one carrying an `Items` with `items: { count, class, ageMs, provenance }`. A policy reads `effect.taint.class` and `effect.items.count`, `.class`, `.age` and `.provenance`.
- **The store and the journal gained memory's records.** Item sets are kept in `poly_items`, body taints in `poly_taint`, memory items in `poly_memory`, and the source a decision read each body from in `poly_body_source`; none holds a body. A forget is a `verdict` event on `runtime:content` naming the subject by its keyed digest, or the source by name, with the erased digests; a verification is recorded on `runtime:memory`. `poly journal replay` lists each forgotten step and counts it as no divergence (PS11.3a).
- **A `verify` or `forget` record's subject** is `<anchor id>:` followed by the digest of its target (S321).
- **The certificate gains `poly.memory`**: each source and flow descriptor, each source adapter by package, version and digest, and `declassify`, the decisions and counts of S323 and S325.
- **A tainted message no configuration follows makes the flow rule INCONCLUSIVE** (S322, `PL6838`), naming each message. A timer's firing keeps the taint of the step that armed it.

**New codes.**

| Code | Meaning |
|---|---|
| `PL6831 AUDIENCE_LEAK` | A finding of the flow rule: a tainted value reaches a recipient who may not read it (PS17.3). |
| `PL6832 TAINT_DOWNGRADE` | A finding of the flow rule: a remember about another subject, or below its content's class (PS17.5). |
| `PL6833 AUDIENCE_UNDECLARED` | A source, channel or effect names a class `audience` does not declare, or there is no `audience`. |
| `PL6834 SOURCE_ADAPTER_UNKNOWN` | A source names no adapter, or one poly-io does not make; or a `memory` source names one. |
| `PL6835 OWNER_ON_UNOWNED` | `where owner == p` on a source that is not `owned`. |
| `PL6836 HOST_TYPE_ERROR` | A type error in host code compiled against the generated declarations, or a host file marked `// @ts-nocheck`. |
| `PL6837 VERIFIED_BY_PERSON` | `remember ... as verified`: only `poly memory-verify` makes an item verified (S320). |
| `PL6838 FLOW_NOT_FOLLOWED` | A tainted `send`, `spawn` or `signal` to a machine no configuration holds with the sender's; inconclusive (S322). |

- **Stated limit, answered as low: a body two subjects own**. When forgetting one subject erases it, the other subject's memory item names a body that is gone, and a decision reading it gets none; nothing leaks.

## M11: Routing and budgets

- **Routes and budgets** (PS18, PT10r). `route r { tier ... escalate when ... budget b }` and `budget b { cap ... on exhausted deny | escalate }` are declarations, and `route r` in a decision names its route. Each means a module of `std.routing` (`m.r` with `Route`, `m.b` with `Budget`), reported as `r.Route` and `b.Budget`. A route serves one decision.
- **A tier must declare both token limits** (S360). A tier line is `tier t provider "p" prices "f" [calibration "f"] max input tokens I max tokens N`, and the embedded tier names `maxInputTokens`. The reservation prices `I` at the table's class `input`, which a route's price table must name (`PL1201`), and `N` at the highest other price.
- **Money is integer micro-units** (S350). A price table is `{ v: 1, provider, model, currency, perMillionTokens, source, readOn }`; one without an https `source` and its `readOn` date is `PL6843`. A price change is a new table.
- **The budget's fit runs before the grant check, the mandate and the policy** (S353, PS18.4), after the memory check. A call that does not fit is denied `budget`, or escalated under `on exhausted escalate`; an approval never raises a cap, so an approved call that still does not fit is denied. A route that exhausts its tiers fails the decision `route-exhausted`.
- **New proposal fields.** A tier's call is proposed with `route: { route, tier, reservation }` and `budget: { budget, scope, remaining }`; a policy of the route's scope reads `effect.route.route`, `effect.route.tier` and `effect.budget.budget`. A tier's call is governed under the trust scope `m.r`.
- **The journal records every tier's call.** Each answered call has its own `decision` event on the route's instance, with `route`, `tier`, `tierIndex`, `usage`, `cost` (`{ units, unit: "micro-<currency>" }`), `reservation`, `prices`, `run` and `scope`. The decision's own event repeats the answering tier's and links it by `via`. A settlement or a release is a `verdict` event with `stage: budget`.
- **More decision event fields.** A call whose completion was lost is written with `completed: false` (review B2). A usage report poly cannot price records `usageViolation` (`usage-missing`, `usage-invalid`) with `usage: null`, and the call is charged its full reservation (S361). A tier's answer outside the decision's result values is recorded by its digest with `answerOutsideType: true` (F1).
- **The store gains `poly_reservation` and `poly_route_call`**, the reservations held by intent and instance, and each call's record kept when its provider answers. A route's instance is `route:<intent>`.
- **The certificate gains `poly.routes` and `poly.budgets`**, read back at admission. A routed decision's entry binds each tier's provider, model and map with `modelBound: true`, `K15` joins the kernel assumptions, and a build with a route or a budget records `std.routing` among its certified type modules.
- **A new command, `poly cost`** (`poly_cost` over MCP, S358, PT24.4). `poly cost --db <store> [--run r] [--scope s] [--period YYYY-MM-DD | YYYY-MM] [--prices file]` sums each answered call's cost per run, scope and day from the ledger alone, and prices it again under another table. It writes nothing, and lists a run whose chain does not verify under `refused`.
- **A new command, `poly try`** (`poly_try` over MCP, `poly.try` through the language server, S362, PT28.2). A playground over one machine: `dispatch`, `state`, `intents`, `gate(policy)`, `witness(predicate)` and `reset`, replayed from the start on every call. It admits, signs, runs and writes nothing but the trace asked for.
- **The tier swap** (S355, PT24.5). A tier whose price table names a new model needs a map fitted for it, which `poly journal fit --model <id>` writes; otherwise the tier is `PL6842`, at check and at admission.
- **A routed decision's materials** (F1, S402). A routed decision with a `Content` result or `cites` is `PL6839`; since S402 its `Content` and `Items` parameters are allowed.
- **Names that reach the build are identifiers** (`PL1201`): a route's, a tier's, a budget's, and a channel's since the ruling on M11's review. A channel declared with another name must be renamed.
- **`PL1208` reserves the kind `route.<r>.call`** for a route's generated module.

**New codes.**

| Code | Meaning |
|---|---|
| `PL6839 ROUTED_DECISION_MATERIALS` | A routed decision with a `Content` result or `cites` (PS18.2). |
| `PL6841 TIER_WITHOUT_CALIBRATION` | A route's escalation reads `conf` or `margin` on a tier with no calibration map (PT24.1b). |
| `PL6842 MODEL_WITHOUT_REFITTED_MAP` | A tier's model is not the one its map was fitted for, naming the tier and both models. |
| `PL6843 PRICE_UNSOURCED` | A price table without an https `source` or its `readOn` date. |
| `PL6844 BUDGET_CURRENCY_MISMATCH` | A route's tiers priced in two currencies, or a cap in another. |
| `PL6845 RESERVATION_ABOVE_CAP` | A tier whose reservation is above a cap of its route's budget, so it could never be called. |
| `PL6846 TRY_OPERATION_REFUSED` | A `poly try` operation that is no step; the session stops there. |

- **Stated limit: a call with no answer** has no usage and its reservation is released, so what a provider bills for it is not counted (K15). The certificate of a build with a route lists it.
- **Stated limit: an overrun rests on K15.** An overrun is a provider reporting more than one of its limits (S360), and a report poly cannot price is charged the full reservation (S361); both are reconciled against invoices as a measure.
- **Stated limit: the budget is checked over small domains** (S352, PT3.4). `Budget` is checked with its cap, reservations and costs placed below, at and above each other; the micro-unit amounts at run time are far above them, so the domains are disclosed and the verdict says what it covered.
- **Stated limit: no policy compares an amount** in M11. The amounts are in the verdict, and a policy reads only the route's, tier's and budget's names. A proposal's `remaining` may be stale; the reservation reads the budget again inside the allow's transaction.
- **Stated limit: `poly try` gates by PS8 in poly-ref**, not by the engine the runtime calls, and replays its session from the start on every call.
- **Stated limit, lifted by V4: replay of a credential's `Grant`.** M11 closed with it needing `std.credentials`, which no build recorded. A build with a credential now records it, and `poly journal replay` reproduces the grant's states (AC27).

## v1: the release steps (V1 to V6)

- **Domains refuse by default** (S400, PT3.4a). Every parameter of a handled action whose type has a check domain is `strict` unless `disclosed` is written: a `bool`, a range, an enum, a union, a record, a map, a `Conf`, and an `int` or `string` with a `check` clause. A value outside the domain is refused at dispatch with `outside-check-domain`, before the handler runs. A `Principal`, `Ref`, `Content` or `Items`, and a completion's `childKey` and `childState`, have no dispatch row. Write `disclosed` after a `check` clause to accept values outside it and only report them; a range or an enum parameter is always strict, so widen the type to accept more. Before v1 only a value that reached an irreversible or compensable payload was strict by default. A program that relied on the old default to accept a value outside a domain now has it refused: std's channel addresses and the Budget machine's amounts, which are representatives for the check, now write `disclosed`.
- **A value of the wrong JSON type is refused by the engine's schema** (PT3.4a). A string sent for a `bool` never reaches the module: the SAM strict profile refuses it, and polyrun journals a rejected step whose reason is the schema's message, the state unchanged.
- **An approved effect reads the state at approval** (S401, PT9.3, PS8.5). A re-proposal triggered by an approval is judged against the emitting snapshot and against the emitter's latest post-state, and is allowed only if both allow. When only the later one denies, it is denied `stale-approval`. A later snapshot that cannot be loaded holds the intent, as an unavailable gate does.
- **The proposal and the verdict event gain `later`** (S401). An approved re-proposal carries `later: { seq, stateDigest }`, and its `verdict` event records `later` and, for a stale approval, `staleApproval: true`, with the action the engine was given. Session replay re-applies that action.
- **Stated limit: a retry is not proposed again** (S401, PT9.7 rule 1). An allowed intent retried after a timeout does not read the state at its attempt, apart from the `Recheck` of S147; its retries are bounded by the effect's retry policy.
- **The policy stage compares every approved decision** (S401). poly-ref's translation validation of a lowered policy now compares the engine's decision with PS8's under an approval on every row of the decision table, not only on an escalated one, since the later snapshot may be any row.
- **A routed decision may read `Content` and `Items`** (S402, PS18.2, PT10r). Each tier's call is given the decision's materials, as an unrouted decision's provider is, and is proposed with the decision's `taint` and `items`, so a policy of the route's scope can deny a tier by `effect.taint.class`, and freshness is judged on each call. A `Content` result and `cites` stay `PL6839`.
- **Stated limit: a routed decision's finite answer** carries no taint, as any decision's (S323): it can pass up to log2 of the number of its answers in bits per call about the body it read.
- **Builds record the std modules replay needs** (V4, PT10e, AC27). A build with a credential records `std.credentials`, and one with a channel its `std.channels.<kind>`, among the certified type modules, beside `std.routing`; load verifies them against the std it was given, and `poly journal replay` reads them from there, so a credential's `Grant` and a channel's conversation replay like any run. A build certified before v1 lacks these entries; admit it again before replaying a grant or a conversation.
- **Replay leaves out the runtime's own records** (V4). `runtime:ingress`, `runtime:approvals`, `runtime:content` and the like are events of no machine; replay no longer lists them as archived runs, and `poly journal verify` checks their chains.
- **Workflows run under the gate, as since M8a** (V5, S173 to S175). The Claude Code skill no longer says they are ungated. A workflow run replays with no diagnostic.
- **Stated limit: the gate decides the issue of a work order, not the agent's tool call** (V5). The tool, target and reason are given to the agent; what it calls, and its self-reported result, are outside poly's runtime, and no capability check applies to them. `workflow_report` has no authenticated reporter beyond the one local client on the stdio pipe.
- **Stated limit: a work order's deadline is its effect's timeout** (V5, PF8.5a). There is no heartbeat: an order a person takes longer to answer than the timeout is a lost attempt. Give a human-in-the-loop effect a `timeout` as long as its machine's own timer.
- **Stated limit: budgets cover a route's calls only** (V5, PS18.4), not work orders; a workflow has no actor attribution and no polycrew claims in v1.
- **The after-suite group runs one file at a time** (V6). `test/m3-isolation.test.mjs` runs there, so the suite's load cannot reach its CLI child's time limit.
- **Stated limit: a re-proposal held for an unloadable later snapshot leaves no `verdict` event** (S401, probe review B). The hold shows in the outbox's last error, as an unavailable gate's does when it gave no answer.
- **The thread's principal (S450, PS15.0a, PT10a).** A channel may declare `principal from principal`. The thread's principal is fixed by the first message whose verified sender the host maps to a principal (`rt.mapSenders(channel, f)`), becomes the recipient of the channel's send, and owns the bodies received on the thread; a later message mapped to another principal is refused `principal-mismatch` on `runtime:ingress`. An application action bound to the conversation's message may declare `by c: C` and receives the Inbound's verified claims, restricted to `C`. std's `Sender` claims gain `principal`: the mapped principal, or the keyed digest of the sender's address, which no source owns.
- **Stated limit: an unverified sender never fixes a thread's principal** (S450). The mapping is called only for a sender the adapter verified, and SMS verifies none, so an SMS thread has no principal and a reply carrying owned content is refused there (fail closed).
- **Format change: the Inbound's claims** carry `principal` beside `verified`, and the ingress record of claims names it by its keyed digest (S450).
- **Keys (S451, PS1.4c, PS17.0, PS17.2).** `Key` is a built-in opaque type. A source declares `keys { … }`, and a retrieval may add one equality on a key, `where owner == a and thread == t`, which narrows the items and never their taint. `postgresSource` and `openSearchSource` take `keys: { key: column }`; the runtime refuses an item of another key (K14). A retrieval by key from a `memory` source refuses every item, since the memory store keeps no keys.
- **A budget on an unrouted decision (S454, PS18.4a).** `prices "f" max input tokens I max tokens N budget b` after `provider` makes the decision's call reserve, settle and release as a tier's does, S361 included; its decision event records usage, cost, reservation and prices, and `poly cost` sums it. The embedded form is the decision item `budget(b, { prices, maxInputTokens, maxTokens })` after `provider(…)`.
- **Exact targets (S455).** `targets { egress: exact "<url>" }` admits that URL and nothing under it, a redirect included. Google's `gmail.compose` scope also permits sending mail (its scope list: "Manage drafts and send emails"), so a Gmail draft token could send; the exact target on `…/drafts` is what keeps a draft effect from reaching `…/drafts/send`.
- **A message its receiver refuses is a finding (F4, PS13.6).** A message whose data lies outside the receiving action's strict domain is `PL5408 MESSAGE_OUTSIDE_DOMAIN`, in a configuration that reaches it and on the sender alone. A program that checked `CLEAN` while sending such a message is now `FINDINGS`.
- **`PL1301` follows a value through fields (F3, PT3.4a).** A `disclosed` parameter stored in a field that an irreversible emit later reads is `PL1301`, naming the chain.
- **A work order's idempotency key (S173 as amended).** Each work order carries `idempotency_key`, the same for every attempt of its intent, for a tool that takes one; the order id stays per attempt and is the only name a report gives.
- **A channel's configuration completes the application's intents (S456, PS15.5).** A channel's generated configuration, and the joint one, offer the completions of the application's pending decisions and effects, each only while its intent is pending and once per intent, so an application that answers through a decision reaches its reply and its channel's rules are tested. More than 3 pending intents of one kind is `PL3901`. A program whose channel rules were untested for that reason may now be judged otherwise. A channel's generated configuration also counts as holding its conversation for `PL6838`, so a channel application that replies tainted content is no longer `INCONCLUSIVE` for that alone.
- **A person's credential with no holder named (S457, PS16.2).** An `authorization_code` credential may omit `holder`; it then has one grant, an effect uses it with no `for`, and the grant's holder is fixed by the first signed grant request (`poly grant-request`), kept by keyed digest and read by no program. A request naming another holder is refused `holder-mismatch` until the grant is revoked. `rt.requestGrant(c, null)` is refused until a signed request fixed the holder. A credential with `holder Principal` is unchanged.
- **Format change: `poly_grant_holder`** holds the fixed holder of such a grant, by keyed digest (S457).
- **One value for an unread claims principal (PS15.0a).** A claims `Principal` field is explored by one value only when no handler, no policy and no `principal from` reads it; a conversation of a channel with `principal from` is now explored with every representative on its own too.
- **Ranges read only against constants (S458, PS4.1h).** A range parameter whose every use is a comparison with an integer constant, or an unchanged argument of an `emit` or a `decide`, is explored at the least value of each class its cut points make; the constants of `emits` and `never … emit` on its payload field are cut points too. Any other use, a write to a field included, turns the reduction off. The runtime still accepts the whole domain and refuses a value outside it. The verdict's instance prints `A.p ∈ lo..hi at {…} cut by {…} (S458)`, and translation validation also steps each class's greatest value.
- **New codes in v1.** `PL5408 MESSAGE_OUTSIDE_DOMAIN`. `PL6839` now covers only a routed decision's `Content` result and `cites`.

## Conclusion

Each entry here is a change a user acts on: a command to run, a format a reader must expect, a code to read, or a limit to know. M8 put workflows under the gate and added channels, with addresses, timers and thread creation as the limits it closed with and M9 lifted. M9 put credentials under the gate, made a person sign every policy and keyring change, and anchored what a person decides outside the project. M10's entries are the scope of a forget, the decision event's `cites`, the records' binding to a project, memory's new records and codes, and the limits M10 closes with. M11 made budgets reservations and routes checked machines, recorded every tier's call in the ledger, and added `poly cost` and `poly try`. v1 makes domains refuse by default, judges an approved effect on the state at approval, lets a routed decision read bodies and items with each tier call carrying their taint, and records the std modules replay needs, gives a channel thread its principal from the verifier, reads mail by key, budgets an unrouted decision, binds a draft to an exact URL, and makes a message its receiver would refuse a finding; its limits are listed with them.
