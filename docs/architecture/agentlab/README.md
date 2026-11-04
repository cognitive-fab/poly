# poly in the MISSION Agent Lab architecture

A support agent reaches the Lab's customer-records MCP server through an Affinidi Agent Gateway, with poly between the gateway's two surfaces: the gateway decides each request, and poly decides the sequence, holds no key, and signs a ledger of the run.

Analysed at [`6afdafe`](https://github.com/cognitive-fab/poly/tree/6afdafe35d692197870b5d4e0ee17b2b9d19bc28).

**Read from.** examples/agentlab/ (desk.poly, desk.policy.poly, desk-per-request.poly, README.md) (code); packages/poly-io/src/mcp.ts, packages/poly-io/src/net.ts, packages/poly-io/PROVENANCE.md, test/fixtures/agentlab/ (code); packages/poly-runtime/src/policy-gate.ts, ledger-store.ts; packages/poly-check/src/admit.ts, secrets.ts, cli.ts; demo/launch.mjs (code); C:/Users/jjdub/code/poly-agentlab/PROPOSAL.md and prompts/ (00-ORDER, G0, G1, P1 to P5) (document); the owner's session of 2026-11-02 and 2026-11-03 (conversation).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### A tool call reaches the caller's Desk

**How does one tool call get from the agent to the Desk of the right caller, and which parts of that path exist?**

The demo's claim is that each call is allowed by the gateway while the sequence is refused by poly. For poly to count a sequence it must know who is calling, and that knowledge may come only from the gateway's signature. Most of this path is still a design.

Only the last two steps exist: the channel and the Desk. Everything before them is planned: surface A signs who asked into each request, the tunnel brings it to the host, and the VP adapter, checking that signature against the gateway's pinned key, is the one place a caller's identity may come from.

[Open the diagram](inbound.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **Surface A** *(planned)* | Signs a verifiable presentation of who called into each request it forwards to the poly host (G1 step 3). |
| **2Dee tunnel** | Publishes the box's port 8787 as https://agentlab.2dee.org through Cloudflare, ending TLS at the edge; it answers 502 until the host runs (G0 step 3). |
| **Agent Lab host** *(planned)* | Serves the desk to surface A as an MCP server on loopback (P4). |
| **Gateway VP adapter** *(planned)* | Turns the gateway's signed presentation into a verified caller claim (P2). |
| **gateway channel** | Keys one conversation and one Desk per verified caller DID. |
| **Desk machine** | Refuses a caller's read once ten customers have been read (read-budget). |

**Deliberately not shown.** The agent and the OAuth discovery proxy before surface A, which the narrative describes; the gateway DID log the adapter pins, drawn by the trust question; what the Desk does with the call, drawn by the next question.

#### The long read

Before the left edge of the diagram, Claude Code calls MCP tools through the OAuth discovery proxy, which signs it in to the Lab and passes its calls to surface A with a JWT. The agent never holds a key of the Lab.

Start at surface A on the left, the gateway surface that faces the agent. It reads who is calling, applies its inbound Rego policy, and injects a verifiable presentation, signed by the gateway, into the request it forwards. Its target is https://agentlab.2dee.org, a Cloudflare tunnel onto port 8787 of the owner's Ubuntu box. Surface A is not configured yet; the tunnel rule exists and answers 502 because nothing listens behind it.

On the box, the host receives the request and hands it to the VP adapter. Both are planned. The adapter checks the presentation's proof against the gateway key pinned from the gateway's DID log, and delivers the caller's DID as a verified claim. Nothing in the request body becomes a claim any other way.

From here the code exists. The gateway channel keys one conversation, and one Desk, per caller DID: the first verified message fixes the caller, and a later one that names another is refused. The Desk then receives the call as a typed action, Find, Read or Update.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **Surface**: One configuration of an Affinidi Agent Gateway in front of one target, with checks on each leg of the request.
- **VP**: Verifiable presentation: a statement signed by the gateway about who made a request and what its policies decided.
- **DID**: Decentralized identifier: a name with a published key. Here it names the gateway, and a caller on one surface.
- **DID log**: The published history of a did:webvh identifier, from which its current signing key is read.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.
- **Rego**: The policy language of Open Policy Agent, which the gateway uses for per-request rules.

### The Desk decides, and only then the Lab is called

**What decides whether a call reaches the Lab's server, and what is recorded?**

This is where poly adds what a gateway cannot: a count over the caller's whole sequence, a person's approval for one kind of change, and a signed record of the run. The rules and the gate exist; the handler that connects the gate to the MCP client is part of the planned host.

The Desk refuses a read once ten customers are read; every effect it proposes goes to the gate, which escalates an email change to a person and records each verdict in the signed ledger. An allowed effect reaches the MCP client, which calls surface B with no credential, and surface B adds the Lab's key.

[Open the diagram](outbound.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **Desk machine** | Refuses a caller's read once ten customers have been read (read-budget). |
| **Desk policy** | Escalates an email change to a person. |
| **Polyaxion effect gate** | Decides every effect the Desk proposes before it runs. |
| **MCP client** | Calls the configured tools of one configured access point, with no credential. |
| **Surface B** *(planned)* | Adds the Lab's API key to the calls poly makes to customer-records. |
| **Lab customer-records** | Serves find_customers, read_customer, update_customer and export_all_customers over fifty fictional customers; a search returns at most ten. |

**Deliberately not shown.** How the call reached the Desk, drawn by the previous question; the ledger, the approval and the keys, drawn by the presenter and trust questions.

#### The long read

The Desk counts the customers each read returns. Once ten are read it refuses the next read with the reason read-budget, and the host returns that word to the agent. It allows one read in flight at a time, since two issued together would pass the same check.

Every effect the Desk proposes, a read or a write, goes to the Polyaxion gate before it runs. The gate reads the signed policy. A phone or address change is allowed. An email change is escalated: it waits until a person signs an approval with poly approve, and the record is applied.

The gate writes each step and verdict to the signed ledger, which replays exactly. With the host, each step will also carry the digest of the gateway's presentation, so the two signed records can be matched.

An allowed effect reaches the MCP client through a handler the host will provide. The client calls surface B's access point with no credential and the negotiated protocol version. Surface B adds the Lab's API key and forwards the call to customer-records. A write has one attempt: if no answer comes back, it is not retried.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **Surface**: One configuration of an Affinidi Agent Gateway in front of one target, with checks on each leg of the request.
- **Access point**: The URL of a surface, which a client calls in place of the server behind it.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.
- **Escalate**: The gate's third answer: the effect waits until a person's signed approval is applied.
- **Ledger**: poly's signed, hash-chained record of a run's steps, verdicts and effects, which replays exactly.

### Where the keys are, and who signs what

**Which component holds which key or signature, and what does poly trust?**

The demo composes two signers: the gateway signs what it decided about each request, and poly signs what happened over the run. It also promises that poly holds no key of the Lab. This diagram shows where each key lives and what crosses between them.

The key of the Lab's customer-records server lives only in surface B, as the Hello server's key lives only in the Hello surface; the gateway's signing key only behind its DID log, which poly pins. On poly's side the only keys are its own: the ledger signer and a person's approval key, both planned for the box and neither present yet.

[Open the diagram](trust.architecture.html). 10 components.

| Component | Responsibility |
|---|---|
| **Surface A** *(planned)* | Signs a verifiable presentation of who called into each request it forwards to the poly host (G1 step 3). |
| **Gateway DID log** | Publishes the gateway's identity and current signing key at /.well-known/did.jsonl, which poly pins to trust the presentations the gateway signs. |
| **Surface B** *(planned)* | Adds the Lab's API key to the calls poly makes to customer-records. |
| **Lab customer-records** | Serves find_customers, read_customer, update_customer and export_all_customers over fifty fictional customers; a search returns at most ten. |
| **Gateway VP adapter** *(planned)* | Turns the gateway's signed presentation into a verified caller claim (P2). |
| **MCP client** | Calls the configured tools of one configured access point, with no credential. |
| **Polyaxion effect gate** | Decides every effect the Desk proposes before it runs. |
| **poly approve** | Lets a person sign the approval of one escalated intent with their key, so the email change runs only on that record. |
| **Box keys** *(planned)* | Holds the ledger signer and the approver's key on the box, outside the checkout, mode 600 (G0 step 5); the box has neither yet. |
| **Signed ledger** | Keeps the signed, replayable record of the run. |

**Deliberately not shown.** The agent, the proxy and the tunnel, which carry requests but hold no key the demo depends on; the channel, the Desk and the policy, drawn by the run-time questions. The Hello surface, which holds the Hello server's key and is drawn by the status question.

#### The long read

Read the gateway box first. Surface B holds the Lab's API key and adds it to each call it forwards to customer-records. Surface A signs a verifiable presentation for each request, with the gateway's Ed25519 key, whose public half is published in the gateway's DID log.

The VP adapter trusts that one key and nothing else. The DID log is pinned in the project's trust, so a presentation signed by any other key is refused, and a key rotation is a new pinned log signed in like any keyring change.

The MCP client is the one path from poly to the Lab, and it carries no credential. It refuses a configuration that holds one, under any header name, and the checker's PL6825 scan refuses a token-shaped value in any file the certificate binds.

poly's own keys are on the right. The policy says an email change waits for a person; the gate holds it until a record signed with the approver's key arrives through poly approve. The ledger is signed with a key kept outside the checkout. Both keys are to live in ~/.poly-keys on the box, which has neither yet.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **Surface**: One configuration of an Affinidi Agent Gateway in front of one target, with checks on each leg of the request.
- **Access point**: The URL of a surface, which a client calls in place of the server behind it.
- **VP**: Verifiable presentation: a statement signed by the gateway about who made a request and what its policies decided.
- **DID**: Decentralized identifier: a name with a published key. Here it names the gateway, and a caller on one surface.
- **DID log**: The published history of a did:webvh identifier, from which its current signing key is read.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.
- **Escalate**: The gate's third answer: the effect waits until a person's signed approval is applied.
- **Ledger**: poly's signed, hash-chained record of a run's steps, verdicts and effects, which replays exactly.
- **Certificate**: The signed record that binds a program's source, its generated artefacts and its check results by digest.
- **PL6825**: The checker's refusal of a token-shaped value in any configuration poly reads.

### Act 1: the check finds the slow export

**How does poly find the slow export before the program runs?**

The Lab's recipes say themselves that an agent can collect the database ten customers at a time, each search allowed. No per-request rule can see that. Act 1 shows poly finding it at design time, from the program alone.

The checker explores every reachable state of the teaching variant, which has only per-request rules, and returns a five-step witness: two allowed searches of ten that read twenty customers, past the bound of nineteen (PL3102). The desk with its read budget checks CLEAN and is certified.

[Open the diagram](act1.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **poly check and admit** | Proves the program's properties over every reachable state before it may run. |
| **Teaching variant** | Keeps only the per-request rules of the Lab's recipes and no read budget, so the check finds the slow export: Act 1. |
| **Desk machine** | Refuses a caller's read once ten customers have been read (read-budget). |
| **Desk policy** | Escalates an email change to a person. |
| **gateway channel** | Keys one conversation and one Desk per verified caller DID. |
| **Refund demo** | Shows an agent that spends money: an irreversible refund issued at most once per intent and escalated to a person above 100, on a local Stripe stand-in. |

**Deliberately not shown.** Everything at run time: the gateway, the host and the MCP client.

#### The long read

The checker is poly check. It explores every state the program can reach over its declared domains, before anything runs.

The teaching variant is the first draft of the desk: it keeps the Lab's per-request rules (no export, no email change) and has no read budget. It keeps the bound of the real desk, customersRead in 0..19. The check finds a path that escapes it, and prints it as a witness: Got, Find, Returned(10), Find, Returned(10). Each Find passes every per-request rule; together they have read twenty customers. The check also offers the fix, a require before the write.

The real desk adds that require, read-budget, and checks CLEAN together with its channel and its policy. A clean check is certified: the certificate binds the source, the artefacts and the policy by digest, so the program that runs is the one that was checked.

One gap: the proposal and the build prompt call Act 1 a path-property violation. The code has no path property, and the finding is a domain escape. The README says the variant keeps a path property, and its own pasted output contradicts that.

The refund demo, Act 4, is admitted by the same checker at every launch.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **VP**: Verifiable presentation: a statement signed by the gateway about who made a request and what its policies decided.
- **DID**: Decentralized identifier: a name with a published key. Here it names the gateway, and a caller on one surface.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.
- **Escalate**: The gate's third answer: the effect waits until a person's signed approval is applied.
- **Certificate**: The signed record that binds a program's source, its generated artefacts and its check results by digest.
- **Witness**: The shortest concrete sequence of actions that violates a rule, printed by the check.
- **Domain escape**: A check finding, PL3102: some path drives a field outside the range its type declares.

### What has met the real gateway, and what waits on it

**Which parts of the demo have been run against the owner's gateway, and which wait on it?**

The build order runs P1 and P3, then the gateway work, then P2, P4 and P5. P1 and P3 are done (the desk and the checker are drawn under Act 1). The rest waits on one captured request, and the only live contact with the gateway so far is the MCP client's probes of the Lab's Hello server.

Only the MCP client has met the gateway: probed live against the Hello surface on 2 November, which shaped its version negotiation; it is otherwise tested on the recorded server. Surface A and the VP adapter are planned, and wait on one captured request.

[Open the diagram](status.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **MCP client** | Calls the configured tools of one configured access point, with no credential. |
| **Hello surface** | Injects the API key of the Lab's Hello server; the surface the MCP client was probed against live, and the one say_hello was called on. |
| **Lab Hello server** | Answers say_hello only to a call whose key a gateway injected. |
| **Recorded MCP server** | Plays the Lab's customer-records server for tests, over fifty made-up customers with export hidden, so no test leaves the machine. |
| **Surface A** *(planned)* | Signs a verifiable presentation of who called into each request it forwards to the poly host (G1 step 3). |
| **Gateway VP adapter** *(planned)* | Turns the gateway's signed presentation into a verified caller claim (P2). |

**Deliberately not shown.** The desk, the checker and the refund demo, built and drawn under Act 1; the host and launcher, drawn by the presenter question; the runbook and dry run (P5), which are documents with no component.

#### The long read

The MCP client is the new poly code that exists for this demo. It is tested against the recorded server, which plays the Lab's customer-records over fifty made-up customers, so no test leaves the machine.

It has also met the real gateway. On 2 November it was probed against the owner's Hello surface, which adds the Lab's key and forwards to the Lab's Hello server. Those probes changed the client. The server answered MCP 2024-11-05, refused any other version header with -32022, and labelled uncompressed answers as gzip. So the client now negotiates the version, sends the negotiated one on every request, and asks for no compression.

The planned pieces are on the right. Surface A, the surface that will sign each request's presentation, is not set up. The VP adapter cannot be written until one request forwarded by surface A is captured, because it verifies only what a fixture shows. Until then the host cannot be built either, and the run-time acts cannot be shown on the real gateway or on recorded traffic.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **Surface**: One configuration of an Affinidi Agent Gateway in front of one target, with checks on each leg of the request.
- **Access point**: The URL of a surface, which a client calls in place of the server behind it.
- **VP**: Verifiable presentation: a statement signed by the gateway about who made a request and what its policies decided.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.

### The presenter approves, and the ledger is the evidence

**How does a person approve an email change on stage, and what keeps the record?**

Act 2 ends with a person approving an email change, and Act 3 shows poly's ledger beside the gateway's audit. Both run through the launcher on the box, which does not exist yet, and through two keys the box does not hold yet.

Planned: the presenter types approve <intent> at the launcher, which signs a record with the approver's key through poly approve; the gate applies it and the effect runs. Built: poly approve, the gate and the signed ledger. The launcher, the host and both keys on the box are planned.

[Open the diagram](presenter.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **Launcher and prompt** *(planned)* | Gives the presenter one console over the running host (P4). |
| **Agent Lab host** *(planned)* | Serves the desk to surface A as an MCP server on loopback (P4). |
| **poly approve** | Lets a person sign the approval of one escalated intent with their key, so the email change runs only on that record. |
| **Box keys** *(planned)* | Holds the ledger signer and the approver's key on the box, outside the checkout, mode 600 (G0 step 5); the box has neither yet. |
| **Polyaxion effect gate** | Decides every effect the Desk proposes before it runs. |
| **Signed ledger** | Keeps the signed, replayable record of the run. |

**Deliberately not shown.** The gateway and the Lab, which an approval never reaches until the effect runs.

#### The long read

The launcher runs in tmux on the box, and the presenter attaches over ssh. It starts the host and offers a short set of commands: status, approve, deny, ledger, replay and kill.

When the gate escalates an email change, the agent is told at once that the change waits for a person, with the intent id. The presenter types approve with that id. The launcher calls poly approve, which signs a record with the approver's key and writes it to the approvals folder. The gate applies the record and lets the effect run; the agent sees the result on its next read.

The ledger is signed with its own key and kept in a store the presenter names, so it survives the end of the run for Act 3. There, ledger <caller> prints that caller's steps with the digest of each gateway presentation, and replay reproduces every verdict.

Today poly approve, the gate and the ledger exist; the launcher, the host and ~/.poly-keys on the box do not.

#### Terms used here

- **MCP**: Model Context Protocol: JSON-RPC messages by which an AI client lists and calls the tools a server offers.
- **Surface**: One configuration of an Affinidi Agent Gateway in front of one target, with checks on each leg of the request.
- **Desk**: The poly state machine, one per caller, that counts reads and holds the rules over a caller's sequence of calls.
- **Polyaxion gate**: The runtime decision, allow, deny or escalate, taken on every effect before it runs.
- **Escalate**: The gate's third answer: the effect waits until a person's signed approval is applied.
- **Ledger**: poly's signed, hash-chained record of a run's steps, verdicts and effects, which replays exactly.

## Boundaries

A boundary is a claim about everything inside it.

### Owner's Affinidi gateway

*ownership boundary.* Hosted by Affinidi at helium-sunset.p3w7om.agentgateway.affinidi.io; it holds the Lab's API keys and signs what it decided, and poly can only call it

Contains: Surface A, Surface B, Hello surface, Gateway DID log.

Crossed by:

- **OAuth discovery proxy → Surface A** over https. The tool call and a JWT bearer from the Lab sign-in, which surface A reads as the caller's email.
- **Gateway VP adapter → Gateway DID log** over file. The gateway's DID log, pinned in the project's trust; a key the pinned log does not hold is refused. Never fetched on a check path.
- **MCP client → Hello surface** over https. initialize and tools/list with no credential; the answers set version negotiation, the version header and accept-encoding identity.

### The Lab's servers

*ownership boundary.* Run by MISSION and used unchanged: their keys, tools and fifty fictional customers are the Lab's

Contains: Lab customer-records, Lab Hello server.

Crossed by:

- **Surface B → Lab customer-records** over https. The same call, with the Lab's API key injected by the gateway.
- **Hello surface → Lab Hello server** over https. The probe's request, with the key the gateway holds injected.

### Ubuntu box glm

*deployment boundary.* Runs the poly host on loopback, reachable from outside only through the 2Dee tunnel that cloudflared runs here; nothing here holds a key of the Lab

Contains: 2Dee tunnel, Agent Lab host, Launcher and prompt, Gateway VP adapter, gateway channel, Desk machine, Desk policy, Polyaxion effect gate, Signed ledger, MCP client, Box keys, poly approve.

Crossed by:

- **Surface A → 2Dee tunnel** over https. The forwarded request with the gateway's verifiable presentation in the JSON-RPC _meta (per Affinidi's docs, not yet captured). No target authentication.
- **MCP client → Surface B** over https. JSON-RPC to surface B's access point with the negotiated MCP-Protocol-Version and no authorization of any kind.

## Components

**Coding agent**: Turns a person's request into MCP tool calls, the sequence the demo governs.

**OAuth discovery proxy** *(planned)*: Signs the agent in to the Lab and forwards its MCP calls to surface A with the Lab's JWT, so the gateway knows who is calling (G1 step 4).

**Surface A** *(planned)*: Signs a verifiable presentation of who called into each request it forwards to the poly host (G1 step 3).

- Reads the caller from the Lab JWT and applies the inbound Rego policy first.

**Surface B** *(planned)*: Adds the Lab's API key to the calls poly makes to customer-records.

- Also hides export_all_customers by tool gating.
- G1 says it exists if the owner finished the Stop the export recipe; nothing read here confirms it.

**Hello surface**: Injects the API key of the Lab's Hello server; the surface the MCP client was probed against live, and the one say_hello was called on.

- Source: `packages/poly-io/PROVENANCE.md:150`

**Gateway DID log**: Publishes the gateway's identity and current signing key at /.well-known/did.jsonl, which poly pins to trust the presentations the gateway signs.

- Captured as poly-agentlab/fixtures/gateway-did.jsonl on 2026-10-27, outside the repository.

**Lab customer-records**: Serves find_customers, read_customer, update_customer and export_all_customers over fifty fictional customers; a search returns at most ten.

**Lab Hello server**: Answers say_hello only to a call whose key a gateway injected.

- It negotiated MCP 2024-11-05 in every probe, and issues a completion code to a gatewayed call.

**2Dee tunnel**: Publishes the box's port 8787 as https://agentlab.2dee.org through Cloudflare, ending TLS at the edge; it answers 502 until the host runs (G0 step 3).

- Built per the G0 checklist (2026-10-27); configured outside the repository.

**Agent Lab host** *(planned)*: Serves the desk to surface A as an MCP server on loopback (P4).

- Answers initialize and tools/list, hands each tools/call to the VP adapter, waits for the effect, returns the result or the refusal word for word.

**Launcher and prompt** *(planned)*: Gives the presenter one console over the running host (P4).

- Prints the verdict, starts the host, and offers status, approve, deny, ledger, replay and kill; --recorded runs on fixtures as the fallback.

**Gateway VP adapter** *(planned)*: Turns the gateway's signed presentation into a verified caller claim (P2).

- Checks the proof, the pinned issuer and key, freshness and replay; delivers the caller DID and the policy decisions, nothing else from the body.

**gateway channel**: Keys one conversation and one Desk per verified caller DID.

- Source: `examples/agentlab/desk.poly:38`
- The first verified message fixes the thread's principal; a later one naming another is refused principal-mismatch.

**Desk machine**: Refuses a caller's read once ten customers have been read (read-budget).

- Source: `examples/agentlab/desk.poly:53`, `examples/agentlab/desk.poly:96`
- It counts the customers each read returns, allows one read in flight and one write at a time, and marks an email change sensitive for the policy.

**Desk policy**: Escalates an email change to a person.

- Source: `examples/agentlab/desk.policy.poly:7`
- A phone or address change is not matched, so the gate allows it.

**Polyaxion effect gate**: Decides every effect the Desk proposes before it runs.

- Source: `packages/poly-runtime/src/policy-gate.ts`, `vendor/polyaxion/PROVENANCE.md`
- Allow, deny or escalate, from the signed policy and the state; an escalated effect waits for a signed approval.

**Signed ledger**: Keeps the signed, replayable record of the run.

- Source: `packages/poly-runtime/src/ledger-store.ts:149`
- Every step, verdict and effect, hash-chained; each step can carry the digest of the gateway's presentation as evidence.

**MCP client**: Calls the configured tools of one configured access point, with no credential.

- Source: `packages/poly-io/src/mcp.ts:136`, `packages/poly-io/src/net.ts:12`
- Streamable HTTP; negotiates the protocol version; refuses a configuration holding a credential; a failure with no answer spends the one attempt.

**Recorded MCP server**: Plays the Lab's customer-records server for tests, over fifty made-up customers with export hidden, so no test leaves the machine.

- Source: `test/fixtures/agentlab/recorded-mcp.mjs:42`, `test/fixtures/agentlab/customers.json`

**poly approve**: Lets a person sign the approval of one escalated intent with their key, so the email change runs only on that record.

- Source: `packages/poly-check/src/cli.ts:175`

**Box keys** *(planned)*: Holds the ledger signer and the approver's key on the box, outside the checkout, mode 600 (G0 step 5); the box has neither yet.

**poly check and admit**: Proves the program's properties over every reachable state before it may run.

- Source: `packages/poly-check/src/admit.ts:59`, `packages/poly-check/src/secrets.ts:1`
- Returns the shortest witness of each violation, scans for secrets (PL6825), and certifies a clean build.

**Teaching variant**: Keeps only the per-request rules of the Lab's recipes and no read budget, so the check finds the slow export: Act 1.

- Source: `examples/agentlab/desk-per-request.poly:1`

**Refund demo**: Shows an agent that spends money: an irreversible refund issued at most once per intent and escalated to a person above 100, on a local Stripe stand-in.

- Source: `demo/launch.mjs:1`, `demo/README.md`

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| Coding agent | OAuth discovery proxy | http | JSON-RPC tools/call requests on localhost. No Lab key: the agent never holds one. |
| OAuth discovery proxy | Surface A | https | The tool call and a JWT bearer from the Lab sign-in, which surface A reads as the caller's email. *(crosses Owner's Affinidi gateway)* |
| Surface A | 2Dee tunnel | https | The forwarded request with the gateway's verifiable presentation in the JSON-RPC _meta (per Affinidi's docs, not yet captured). No target authentication. *(crosses Ubuntu box glm)* |
| 2Dee tunnel | Agent Lab host | http | The same request, TLS ended at Cloudflare, onto the box's loopback. |
| Agent Lab host | Gateway VP adapter | in-process call | The raw headers and body, through the runtime's ingress (rt.receive). |
| Gateway VP adapter | Gateway DID log | file | The gateway's DID log, pinned in the project's trust; a key the pinned log does not hold is refused. Never fetched on a check path. *(crosses Owner's Affinidi gateway)* |
| Gateway VP adapter | gateway channel | in-process call | The caller's DID, the issuer, the verified flag and the gateway's policy decisions. Nothing else from the body. |
| gateway channel | Desk machine | in-process call | Got, Find, Read and Update on the Desk of that caller's thread, with the VP digest bound as the step's evidence (P4). |
| Desk machine | Polyaxion effect gate | in-process call | customers.read (reversible) and customers.write (irreversible, one attempt), with the Desk's state the policy reads. |
| Desk policy | Polyaxion effect gate | file | email-change-reviewed: a write while the Desk's write is sensitive is escalated, and so is an unknown. |
| Polyaxion effect gate | Signed ledger | database | Each step, its verdict and each effect's intent and completion, hash-chained. |
| poly approve | Polyaxion effect gate | file | A record signed by a key of the people ring, naming the escalated intent's hash, dropped in the approvals folder. |
| Polyaxion effect gate | MCP client | in-process call | The tool name and its arguments, through the effect's handler, which the host writes (P4). |
| MCP client | Surface B | https | JSON-RPC to surface B's access point with the negotiated MCP-Protocol-Version and no authorization of any kind. *(crosses Ubuntu box glm)* |
| Surface B | Lab customer-records | https | The same call, with the Lab's API key injected by the gateway. *(crosses The Lab's servers)* |
| MCP client | Hello surface | https | initialize and tools/list with no credential; the answers set version negotiation, the version header and accept-encoding identity. *(crosses Owner's Affinidi gateway)* |
| Hello surface | Lab Hello server | https | The probe's request, with the key the gateway holds injected. *(crosses The Lab's servers)* |
| MCP client | Recorded MCP server | in-process call | Recorded HTTP exchanges through a test transport; the fixture records every request's URL and headers. |
| poly check and admit | Teaching variant | file | Got, Find, Returned(10), Find, Returned(10): twenty customers read, each call allowed, past the bound of 19. |
| poly check and admit | Desk machine | file | The verdict over both modules with its checked instance, and the certificate that binds source, artefacts and policy by digest. |
| poly check and admit | Desk policy | file | Policy types, lowering, consistency, admission coverage and translation validation of email-change-reviewed. |
| Box keys | Signed ledger | file | The key that signs the ledger, read from outside the checkout. |
| Box keys | poly approve | file | The person's private key that signs an approval. |
| Launcher and prompt | Agent Lab host | in-process call | The store folder, the configuration, and the presenter's commands. |
| Launcher and prompt | poly approve | spawn | The intent id the presenter types; the signed record goes to the approvals folder (poly approve --out). |
| poly check and admit | Refund demo | file | The refund demo's concierge, checked CLEAN at every launch; the unkeyed TypeScript build has no such gate. |

## Doctrines, guarantees and trade-offs

### Doctrines

- **The gateway decides each request; poly decides the sequence. Neither does the other's job** A per-request policy cannot count across requests: the slow export is made of calls that each pass every per-request rule.

### Guarantees

- **A Desk refuses a read once it has read ten customers, and no path takes it past nineteen** The server decides how many customers a page holds, so the worst case is 9 + 10; the field's domain 0..19 states the bound and the check proves no path escapes it.
- **poly holds no key of the Lab. The MCP client refuses a configuration that carries a credential under any header name, and PL6825 finds none in the files the certificate binds** The key stays in the gateway, as the Hello, Gateway recipe teaches.
- **An email change runs only after a person signs its approval; a phone or address change runs at once.**

### Constraints

- **A write is irreversible and has one attempt. A failure with no answer spends it, and nothing retries** The Lab's server takes no idempotency key, so declaring one would assume what the server does not do.
- **No export is the absence of an effect, not a checked rule: the program declares no export effect, and the language refuses a never or count over an effect that does not exist (PL1001).**
- **The VP adapter and the host wait on one captured request: forwarded-request.json and audit-presentation.json do not exist yet, so the presentation's format and the MCP revision surface A sends are unconfirmed** P2 verifies what the fixtures show and nothing it has not seen; only gateway-did.jsonl has been captured (G1 step 6).
- **poly checks order, not rate, over finite declared domains; the budget is per Desk, which is per caller DID on one surface, not per person across surfaces.**

### Risks

- **Act 1's finding is a domain escape (PL3102), not a path-property violation as the proposal and P1 describe; the program has no path property, and the README's line saying the variant keeps one is contradicted by the check's own output** The read budget is stated as a require and as the type bound of customersRead; the check prints no path property for the Desk.
- **P4 assumes the host speaks MCP 2025-11-25; every live probe of the Lab's server through the gateway answered 2024-11-05** The client now negotiates and sends the negotiated version on every request; the host's revision is still to be read from the captured request.
- **The proposal's venue, the Lab office hours of 2 November 2026, has passed with the VP adapter, the host and the runbook not built, and the branch not pushed.**

