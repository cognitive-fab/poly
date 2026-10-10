# poly v1 · Release notes

Draft of 2026-10-10, written by the release session on `v1` at 0be8ef61, for the owner's reviewer. It is complete for the release branch. The examples session's entries (E1, the concierge, and E2, the inbox) are marked as waiting, and are filled in when both branches are merged for the V10 gate. `docs/release-notes.md` keeps the entry for each change, milestone by milestone. This page is the release's account in one place: what v1 holds, what it does not do, and what is ruled for after it. The specifications stay the source of truth (`docs/04-semantics.md`, `docs/03-technical-spec.md`).

## What v1 is

poly is a language and runtime for the stateful core of software written by coding agents. A program is a set of machines. `poly check` explores every reachable state with its own model checker, `poly-ref`, which is written from the semantics and shares no code with the compiler. The compiler lowers the program to the artefacts the engines already read: SAM v2 modules, polygraph contracts, polyrun manifests, polyflow workflows and Polyaxion policies. `poly admit` certifies the build, and the runtime runs the checked program under a gate, so the program that runs is the program that was checked (PS4.1b). Every verdict prints the instance it holds for. A check that did not run, or that hit a bound, is `INCONCLUSIVE` or listed as not run, never a silent clean.

v1 releases milestones M8 to M11, and the release steps V1 to V9 with the rulings that followed them.

## What v1 contains

### The milestones it releases

- **M8: workflows under the gate, `use`, `Content`, `never` and channels.** Workflows' effects cross poly's gate. A module may `use` another. `Content` is an opaque body held by digest, and erasable. `never … emit … while …` states what a step must not send. Channels (email, WhatsApp, SMS, Slack and webhooks) are written as a binding, and each gives its application a checked conversation with its own configuration, timers and thread creation.
- **M9: credentials, signed policies and erasure.** OAuth credentials are held in a vault and never reach a handler. Each grant is a checked `Grant` machine, granted by a person's signed request and revocable from three sources. Every policy and keyring change is signed by a person. Erasure is per body and per address.
- **M10: memory.** Audiences, sources and retrievals. The flow rule follows every value's taint to where it leaves, at check and at run time. A decision can cite the items it used, freshness is checked, and memory can be remembered and forgotten.
- **M11: routing and budgets.** A routed decision tries its tiers in order. Budgets are reservations with checked machines. Every tier's call is recorded in the ledger. `poly cost` sums the calls and `poly try` replays a session.

Each milestone's formats, commands and limits are in `docs/release-notes.md`.

### The language and the checker

- **Domains refuse by default (S400, V1).** Every parameter with a check domain is strict unless `disclosed` is written, so a value outside its domain is refused before the handler. SR3 measured it with agents: 0 of 20 runs with an escaped defect, against 5 of 20 in M3 (one-sided Fisher p = 0.0236).
- **A message its receiver would refuse is a finding (F4).** This is `PL5408 MESSAGE_OUTSIDE_DOMAIN`, in a configuration and on the sender alone.
- **`PL1301` follows a value through fields (F3).**
- **Ranges read only against constants are explored at their cuts (S458, PS4.1h).** A range used only in comparisons with constants, or passed unchanged into a payload, is explored at the least value of each class its constants make, and the instance prints the cut. The runtime still accepts the whole range. The concierge's refund amount, `0..500`, is explored at `{0, 101}`.
- **One value for a claims principal nothing reads (PS15.0a).** No handler, no policy and no `principal from` may read it.
- **A channel's configuration completes the application's pending decisions and effects (S456, PS15.5).** An application that answers through a decision reaches its reply, and its channel's rules are tested. The same configuration counts as holding its conversation for `PL6838`.
- **A warning, beside the verdict and never in it, for an action parameter named after a state field** (ruled 2026-10-10). The parameter shadows the field wherever the action is known (S19). It becomes `PL1002` after v1.
- **Two differing retrievals of one source within one machine are `PL1002`** (S41 with S451). So are two differing remembers.

### The runtime and the gate

- **An approved effect reads the state at approval (S401).** A re-proposal is judged against the emitting snapshot and the emitter's latest state. If only the later one denies, it is denied `stale-approval`.
- **Each intent runs the retrieval its own machine declares** (S41 with S451, ruled 2026-10-09). Before this, the last machine's retrieval of a source ran for the whole program.
- **Replay takes what the checker admits (PS11.4, ruled 2026-10-10).** Replay reads an `Items` of a step's data as the handler read it, so a handler that reads `x.count` replays as it ran. A standing test replays runs of every admitted program of `conformance/` and `examples/`.
- **A citation is required (PS17.6, ruled 2026-10-10).** A decision with `cites` refuses an answer whose citation list is empty or absent, `uncited`, as it refuses an item of another thread's retrieval; the `failed` outcome runs.
- **An `Items` is checked as a `Content` is** (PT10j, ruled 2026-10-10). The domain holds counts only. At run time the reference must be one the runtime stored, and the count must lie in the domain.
- **A work order's `idempotency_key`** (S173 as amended) is the same for every attempt of its intent.
- **Builds record the std modules replay needs (V4).** A credential's `Grant` and a channel's conversation replay like any run.

### Channels

- **The thread's principal (S450).** `principal from principal` fixes a thread's principal from the verifier, and never from a message. That principal becomes the recipient of the channel's send and owns the bodies received on the thread. A later message from another principal is refused `principal-mismatch`. An application action bound to the conversation's message may take the verified claims.

### Credentials

- **A person's credential may name no holder (S457).** It then has one grant, and the first signed grant request fixes the holder by keyed digest. Replacing the holder needs a revocation.
- **A source names its credential (S460).** The certificate binds its vault, and its `Grant` tracks it. The adapter reaches the provider only through `rt.credentialHandle(c)`, which never yields a token, keeps to the provider's base addresses, and stops once the grant is not `Granted`. So revoking the grant stops the source's sync.
- **Per-owner grants for an owned source (S461).** An owned source's credential may name `holder Principal`. Each owner then has its own grant, keyed by the owner's principal, so one assistant can hold several accounts' grants. Each retrieval names its owner and runs under that owner's grant only: a request for one owner's items through another owner's handle is refused `owner-mismatch`. Revoking one owner's grant stops that owner's sync and no other.
- **Exact egress targets (S455).** `exact "<url>"` admits that URL and nothing under it, so a Gmail draft effect cannot reach `…/drafts/send`.

### Memory

- **Keys (S451).** `Key` is an opaque type. A retrieval may narrow by key equality, and never by taint.
- **Envelopes (S459).** A source may give a thread's reply envelope by key: the recipient, the subject, `In-Reply-To` and `References`. A draft's envelope must come from that envelope retrieval: any other origin is `PL6830 ENVELOPE_NOT_FROM_SOURCE` at check, and `envelope-origin` at run time, an erased envelope included. So no model answer and no message chooses where a reply goes.
- **A handler reads its own payload's bodies (S459).** `content.read(d)` reads only the bodies of the intent's own payload, only after the flow check allowed it, and records each read by digest.

### Routing and budgets

- **A routed decision reads `Content` and `Items` (S402).** Each tier's call carries the decision's taint and items.
- **An unrouted decision may name a budget (S454).** It has its embedded form.

### The examples (E1 in part, E2 waiting)

- **The concierge** (`examples/concierge`, E1): a WhatsApp customer desk with a staff thread on Slack. A routed classification over the message body, a refund through Stripe Connect under a person's grant with no holder named (S457), an escalation above 100, a reply written by a decision, an acknowledgement for a message that arrives while the desk is busy, and a staff notice. Its module checks `CLEAN`, with both generated configurations, at the AC30 domain `0..500` (on `ex`, 2026-10-09):
  - `Desk`: 1,826 states, and its flow rule 2,978; translation validation agrees on 107,734 transitions. The refund's amount is explored at `{0, 101}`, cut by 100 (S458).
  - `Notice`: 28 states. `support.Conversation`: 342. `staff.Conversation`: 666. `payments.Grant`: 13. `triage.Route`: 6. `spend.Budget`: 96.
  - The configuration `support`: 26,211 global states and 650,210 global steps, its flow rule 34,179. The configuration `staff`: 3,620 global states and 194,795 global steps.
  - Every rule of both conversations is tested, and no `PL6838` remains. The check took 6 min 27 s on `ex` with other tests running, an upper bound; the release session's probe took 69 s alone.
  - **Pending:** the project's check with its policy, which waits on the audience rule; its move to `examples/concierge/` and its run in the serial after-suite group; and AC27's replay.
- **The inbox assistant** (`examples/inbox`, E2): Gmail by key, triage, to-dos, and drafts only, each draft escalated to its owner. Its acceptance tests IAC1 to IAC9 run on recorded traffic. It is in progress on `ex`.

### Formats a reader must expect

- **Claims and grants.**
  - The Inbound's claims carry `principal` (S450).
  - `poly_grant_holder` holds a holder-less grant's holder by keyed digest (S457).
- **Envelopes and reads.**
  - `poly_envelope` holds the digests of stored envelopes (S459).
  - `runtime:content` records each `content.read` as `{ stage: 'read', intent, digest }` (S459).
- **Artefacts.**
  - `sources/<s>.json` records `envelope` and `credential` when declared (S459, S460).
  - An effect's manifest entry records `envelope`, and an envelope retrieval's entry records `retrieve.envelope` (S459).
  - A contract's `dataDomain` lists a cut parameter's representatives (S458).
- **Proposals and verdict events.** An approved re-proposal and its verdict event carry `later` (S401).
- **Certificates and reports.**
  - A certificate records `std.credentials` and each `std.channels.<kind>` among its type modules (V4).
  - `poly check`'s report may carry `warnings`.

### New codes

- `PL5408 MESSAGE_OUTSIDE_DOMAIN` (F4).
- `PL6830 ENVELOPE_NOT_FROM_SOURCE` (S459).
- `PL1002` covers two differing retrievals or remembers of one source in one machine.
- `PL6839` covers only a routed decision's `Content` result and `cites` (S402).

## Stated limits

Each limit is something v1 does not do. It is checked to fail closed where it can, and is listed here so no one relies on it.

- **The template retry.** A free-form WhatsApp reply refused `window-closed` is not sent again as a template. The exchange ends, and the customer's next message opens the window again (ruled on `ex`, 2026-10-09). AC15 holds as written: the variant that sends after the window gets a witness at check, and the conversation refuses the send at run time.
- **A policy cannot say "only with an approval".** S149 counts an escalation that a person's approval would allow as an allow. So a `never` cannot state that an effect happens only with an approval, and one that tries is violated by design (`PL6503`). The inbox gates its drafts by escalation instead, and labels them so that polycheck's region finds an ungated one (`PL7001`).
- **A decision with a finite answer is a declassification point (S323).** A decision that reads a tainted `Content` or `Items` and answers a `bool`, an enum or a range carries no taint on its answer. It can pass up to log2 of the number of its answers in bits per call to whoever the answer reaches, routed decisions included. The certificate lists each such decision with the highest class it reads and its number of answers, and a policy may deny it by `effect.taint.class`.
- **A count of foreign items is disclosed, not refused (S325).** A handler that reads `x.count` of the items of an owned source, where the retrieval's owner is not the claimant, learns how many items another owner has. The certificate lists each such read for the owner, and the runtime does not refuse it.
- **SES is deferred (S453).** v1 reads mail from Gmail only. SES comes after the release, with an `aws_sigv4` credential kind and its own ruling.
- **A retry is not proposed again (S401).** An allowed intent retried after a timeout does not read the state at its attempt, apart from S147's `Recheck`.
- **An unloadable later snapshot leaves no verdict event (S401).** The hold shows only in the outbox's last error.
- **Workflows (V5).**
  - The gate decides the issue of a work order, not the agent's tool call.
  - A work order's deadline is its effect's timeout.
  - Budgets cover a route's calls only.
  - A workflow has no actor attribution.
- **An unverified sender never fixes a thread's principal (S450).** SMS verifies no sender, so an SMS thread has no principal, and a reply carrying owned content is refused there.
- **A handler is held to its envelope as to its effect (S459).** The runtime gives the draft's handler only an envelope the source gave. The handler is the host's code, and it is held to taking the recipient and headers from that envelope as every handler is held to its effect.
- **Only `openSearchSource` takes a credential handle (S460).** A `postgres` source that names a credential checks clean but cannot be connected, which fails closed.
- **A parameter named after a state field is only a warning** (ruled 2026-10-10). S19's shadowing stays the meaning in v1.
- **A forget does not erase the provider's copy** (PS17.7, ruled 2026-10-10). `poly forget` erases what the runtime holds for the subject: its items, bodies, envelopes and taint records. When the subject is an owner of a source with a grant per owner, it also revokes that owner's grant first, so no later sync brings the data back. A forget never uses a grant, so the provider's own copy, such as the person's mailbox, is not erased: it is not poly's to erase. An adapter over a store that poly reaches with no credential (a `postgres` table, an OpenSearch index over the host's transport) still removes the subject's items there.
- **A token stays valid at the provider until its revocation succeeds** (PS16.4, ruled 2026-10-10). A revocation makes the grant `Revoked` locally first and unconditionally, so poly sends nothing more under it. The token is then revoked at the provider (RFC 7009) as an effect, retried and journaled. Until that request succeeds, or the token expires, the token stays valid at the provider. A failure there never undoes the local revocation, and never holds back a forget.
- **The earlier limits.** M8 to M11's stated limits stand as listed in `docs/release-notes.md`.

## After v1

What is ruled for after the release (`decisions-v1.md`, "After v1"):

- **S453: SES**, with an `aws_sigv4` credential kind and its own ruling.
- **`PL1002` for a parameter named after a state field.** It lands with std's channel kinds (`Conversation.Open(app)`), the conformance cases, the examples and the tests' fixtures renamed together, and `conformance/m0/shadowing.poly` turned into its error source. 35 such parameters were found in 275 sources.
- **Erasure at the provider, where the provider's copy is poly's own.** An example is a table poly wrote and reaches through a credential. It needs its own ruling, since a forget uses no grant in v1.
- **The journal records of a provider revocation are named in the spec.** In v1 each attempt is journaled, and the spec does not yet say by which records.
- **E3: the checked harness example** (Q-V2), and M7, which follows the release.

## Conclusion

v1 releases four milestones and the rulings that hardened them. Domains refuse by default. A message a receiver would refuse is a finding. A thread's principal and a reply's recipient come from the verifier and the source, never from a message or a model. Credentials reach providers only through vault handles that stop at a revocation. Each machine runs its own retrieval. The limits above are the places where v1 says what it does not cover, so a user knows where to look before relying on it. What remains for the release is the examples branch's two examples and the V10 gate run from a clean build after the merge.
