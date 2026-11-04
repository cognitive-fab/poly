# The gateway VP adapter: design note (P2 step 1)

Status: reviewed by the owner on 2026-11-04, decisions D1 to D5 taken (below). Step 2 does not start until the second account's capture exists (section 10). Written 2026-11-04.

The adapter takes a request that an Affinidi Agent Gateway forwarded to the desk, verifies the verifiable presentation (VP) the gateway put in it, and delivers the caller's claims to the runtime. It follows M8 and K11: sender claims come from a certified adapter only, never from the request. It has the shape of `packages/poly-io/src/adapters/webhook.ts`.

**Sources.** One live capture of 2026-11-04 at 16:36:53Z (08:36 Pacific), trace `820ce133-0396-4085-8c42-c167af509b2b`, kept in `poly-agentlab/fixtures/` (commit `ff75c1a`):

| File | What it is |
|---|---|
| `forwarded-request.json` | An MCP `initialize` that surface_a of `helium-sunset.p3w7om.agentgateway.affinidi.io` forwarded to an echo server behind `https://agentlab.2dee.org/mcp`: headers, and the body byte for byte. No credential header. |
| `audit-presentation.json` | The same presentation, from the gateway's audit. It is identical to the one in the body. |
| `gateway-did.jsonl` | The gateway's DID log, captured 2026-10-27. Fetched again on 2026-11-04: byte-identical (sha256 `2e7b0a88…b38255`). |
| `holder-did.jsonl` | The holder's DID log, fetched on 2026-11-04 and kept byte for byte (commit `ec7e2eb`, sha256 `b61dd35a…a3d28c`). |

Also read on 2026-11-04 to write this note, and copied nowhere: both `did-witness.json` files and the two JSON-LD contexts. Where the capture and Affinidi's documentation differ, the capture wins. The prompt `poly-agentlab/prompts/P2-vp-adapter.md` stands, item 4 (the owner's trust rule of 2026-11-03) included.

## What the capture changes

- The presentation sits under the extension key `agent-identity-binding/v1`, not `agent-identity-credential/v1`. It is a JSON string inside the JSON body, so it is parsed twice.
- There are two proofs, and two DIDs sign them. The gateway's DID signs the credential. The presentation is signed by its holder, a DID the gateway made for the caller on this surface. Both DID documents have to be resolved.
- The presentation proof carries `expires`, five minutes after `created`. That expiry is what makes a presentation fresh. The credential is valid for a year.
- `workloadBinding` holds no policy decisions, no identity hash and no attestation mode. Its fields are `agentIdentity`, `caller`, `delegated`, `traceId` and `target`.
- The header `X-Caller-Did` said `anonymous` and `X-Caller-Identity-Source` said `self-presented`, while the signed presentation named an attested caller. Headers are never claims.
- No signature covers the JSON-RPC body outside the presentation. The gateway itself rewrote `params.protocolVersion` (to `2024-11-05`, "in place of unsupported 2025-11-25", its log says). The presentation says who asked. It does not say what was asked.
- The gateway signed with `#key-2`, which its own DID document does not list under `assertionMethod` (decision D2).

## The owner's decisions (2026-11-04)

| # | Question | Options weighed | Decided |
|---|---|---|---|
| D1 | How to canonicalise for `eddsa-rdfc-2022` (section 3) | **A.** `jsonld` 9.0.0 as a dependency of poly-io. **B.** `rdf-canonize` 5.0.0 vendored, with a closed JSON-LD-to-RDF step written in poly-io for the one shape captured. | **B.** `rdf-canonize` 5.0.0 vendored, with a converter for the captured shape only. Boundary rule 5 is amended for it. `verify` becomes asynchronous. |
| D2 | The gateway's `#key-2` is not in its `assertionMethod` (section 4) | **a.** Refuse, as a strict verifier does. **b.** Accept a method whose key bytes equal a key the document lists under `assertionMethod`. **c.** Accept any Ed25519 method in the document. | **b.** The mismatch is recorded for a report to Affinidi (section 4). |
| D3 | Where the issuer, trace id and presentation digest go (section 6) | **a.** Journaled on `runtime:ingress` as evidence, beside the claims. **b.** Added to the claims the program sees. | **a.** The program sees `verified` and the holder DID only. |
| D4 | How the fixtures enter the public repository (section 10) | As captured; a redacted copy for refusal tests only; or a new capture with another Lab account. | **A new capture with a second Lab account**, which the owner creates, committed as captured with the IP headers replaced. |
| D5 | When a pinned gateway log is fetched again (section 4) | On an unknown key only; or on an unknown key and on a schedule. | **Both:** on an unknown key, and every 24 hours. |

## 1. Where the presentation is

The body is a JSON-RPC request. The presentation is the string at:

```
params._meta["https://fabric.affinidi.io/extensions/agent-identity-binding/v1"].verifiablePresentation
```

`JSON.parse` of that string gives the presentation. It is the same object as `audit-presentation.json`. The field tree, with values elided (`<…>`) and the caller's email shown as `<email>`:

```
body
├─ jsonrpc: "2.0"
├─ id: 0
├─ method: "initialize"
└─ params
   ├─ protocolVersion: "2024-11-05"            (written by the gateway)
   ├─ capabilities: {…}
   ├─ clientInfo: {…}
   └─ _meta
      └─ "https://fabric.affinidi.io/extensions/agent-identity-binding/v1"
         └─ verifiablePresentation: "<JSON string>"
            ├─ @context: ["https://www.w3.org/ns/credentials/v2"]
            ├─ id: "urn:uuid:<…>"
            ├─ type: ["VerifiablePresentation"]
            ├─ holder: "did:webvh:<SCID-h>:<gateway domain>:surface:<uuid>"
            ├─ verifiableCredential
            │  ├─ @context: ["https://www.w3.org/ns/credentials/v2",
            │  │             "https://d2oeuqaac90cm.cloudfront.net/TAgentIdentityCredentialV1R0.jsonld"]
            │  ├─ id: "urn:uuid:<…>"
            │  ├─ type: ["VerifiableCredential", "AgentIdentityCredential"]
            │  ├─ credentialSubject
            │  │  ├─ id: <the holder DID>
            │  │  └─ workloadBinding
            │  │     ├─ agentIdentity
            │  │     │  ├─ credential_type: "jwt_claim"
            │  │     │  ├─ claim: "email"
            │  │     │  ├─ value: "<email>"
            │  │     │  └─ ns: { iss: "https://idp.agentlab.choosemission.com/realms/mission-agent-lab" }
            │  │     ├─ caller
            │  │     │  ├─ fields: { email: "<email>" }
            │  │     │  ├─ identity_source: "jwt_bearer"
            │  │     │  └─ assurance: "gateway_attested"
            │  │     ├─ delegated: true
            │  │     ├─ traceId: "<uuid>"                 (equal to the X-Gateway-Trace-Id header)
            │  │     └─ target: "https://agentlab.2dee.org/mcp"
            │  ├─ issuer: "did:webvh:<SCID-g>:<gateway domain>"
            │  ├─ validFrom:  "<t>"                       (the call's time, nanoseconds, +00:00)
            │  ├─ validUntil: "<t + 1 year>"
            │  └─ proof
            │     ├─ type: "DataIntegrityProof"
            │     ├─ cryptosuite: "eddsa-rdfc-2022"
            │     ├─ created: "<t>"
            │     ├─ verificationMethod: "<issuer>#key-2"
            │     ├─ proofPurpose: "assertionMethod"
            │     └─ proofValue: "z<base58btc, 64 bytes>"
            └─ proof
               ├─ type: "DataIntegrityProof"
               ├─ cryptosuite: "eddsa-rdfc-2022"
               ├─ created: "<t + 3 ms>"
               ├─ verificationMethod: "<holder>#key-2"
               ├─ proofPurpose: "assertionMethod"
               ├─ expires: "<created + 300 s>"
               └─ proofValue: "z<base58btc, 64 bytes>"
```

The adapter accepts a `POST` with `content-type: application/json` and one JSON-RPC object (not a batch). A body that does not parse, or has no string at that path, is refused `presentation-missing`. A presentation whose shape is not this tree is refused `presentation-malformed`: other types, other cryptosuites, a missing proof, a `@context` entry that is an object.

## 2. Which DID names the caller

The presentation's `holder`, `did:webvh:<SCID-h>:<gateway domain>:surface:<uuid>`. It is also `credentialSubject.id`, inside the credential the gateway signed. The capture has no identity hash: Affinidi's documentation lists one, and this `workloadBinding` has none. `agentIdentity.value` is the email itself, in the clear.

The Desk is keyed on the holder (P1: thread `"{source}"`, `principal from principal`). The adapter puts the holder DID in `fields.source` and in `claims.sender`. Section 9 says what binds it to the gateway, and what one capture cannot show.

### If the holder is per surface (the owner's rule of 2026-11-04)

The second account's capture settles whether the holder is one DID per caller or one per surface (section 9). If it is per surface, the Desk is keyed on the gateway-signed `agentIdentity` instead, hashed, and never on the email in the clear:

- The key is `agentIdentity:` followed by the base64url SHA-256 of the RFC 8785 JSON of `{ "iss": <ns.iss>, "value": <value> }`. Both fields are inside the credential, so the gateway's signature covers them. The adapter refuses `presentation-malformed` unless `credential_type` is `jwt_claim` and `claim` is `email`, the values captured.
- The adapter puts that key in `fields.source` and `claims.sender`. The holder DID moves to the evidence (section 6). Every check of the holder (section 9) still runs.
- A plain hash of an email can be reversed by guessing the address, so the key is never journaled as it is. The runtime replaces the thread key and the sender by their keyed digests, HMACs under the store's key (S191), before anything enters the journal or the ledger. The email itself stays only in the erasable content store, with the body.
- Only the adapter changes. The program and its check do not change: the desk reads `source` and the principal, not where they came from. The recipe's limit "a Desk is one caller on one surface" then reads "a Desk is one sign-in identity on one gateway".

The tests that change if the key changes:

- The acceptance test expects the identity key, not the holder DID, as `sender` and `source`, and the holder DID in the evidence.
- The one-byte tests add `ns.iss` and `value` to the deciding fields, each refused `signature-invalid`.
- New: the two accounts' presentations, which share one holder, reach two Desks. The same account's two presentations reach one Desk.
- New: a presentation whose `claim` is not `email`, or whose `credential_type` is not `jwt_claim`, is refused `presentation-malformed`.
- New: neither the email nor the unkeyed hash appears anywhere in the store outside the content store.
- The desk's own tests (P1) and the host's (P4) keep their cases. Only the value they feed as the thread key changes.

## 3. How the two proofs are verified

Each proof follows the Data Integrity EdDSA Cryptosuites v1.0 procedure for `eddsa-rdfc-2022`:

1. The proof options are the proof without `proofValue`, given the document's `@context`. They are canonicalised with RDFC-1.0 and hashed with SHA-256.
2. The document without its `proof` is canonicalised with RDFC-1.0 and hashed with SHA-256.
3. The Ed25519 signature, `proofValue` decoded from base58btc (64 bytes), is checked over the two hashes, options first.

The credential is the document of its own proof, under its own `@context`. The presentation is the document of the holder's proof. That document contains the credential, with the credential's proof: in `credentials/v2`, `verifiableCredential` and `proof` are `@graph` containers, so the credential and its proof are named graphs inside the presentation's dataset. The holder's signature therefore covers the credential and the gateway's signature too. `expires` is part of the holder's proof options, so it is signed.

**What Node already gives.** Ed25519 and SHA-256 are in `node:crypto` (`createPublicKey` with a JWK `{ kty: "OKP", crv: "Ed25519", x }`, then `verify(null, …)`). Base58btc and the Multikey prefix `0xed01` take a few lines. The DID logs need RFC 8785 (JCS) for their `eddsa-jcs-2022` proofs. poly-core has `jcs.ts`, but poly-io may not import poly-core, so poly-io gets its own copy, tested against poly-core's vectors.

**What Node does not give: RDF canonicalisation.** RDFC-1.0 needs the JSON-LD document turned into RDF, which needs the contexts. Nothing in the repository does it today. **No library for it is a dependency.** The two options of D1:

- **A. `jsonld` 9.0.0** (Digital Bazaar, BSD-3-Clause), which brings `rdf-canonize` 5.0.0, `canonicalize`, `lru-cache` and `@digitalbazaar/http-client` (with `ky` and `undici`). Its document loader is replaced by a static map of the pinned contexts (section 8), and canonicalisation runs in its safe mode, which fails on a dropped term. The costs:
  - `check-boundaries.mjs` rule 5 (S182, review C-F8) lets poly-io import Node builtins and the adapter types only, so the rule must be amended.
  - `jsonld` loads its Node document loader, and with it a second HTTP client, when it is imported. That client is never called, but it ships inside the package with the network code.
  - `toRDF` is asynchronous, and `ChannelAdapter.verify` is synchronous (`rt.receive` does not await it). The runtime's interface would have to change: `verify` may return a promise, and `rt.receive` and `ingress` await it.
- **B. `rdf-canonize` 5.0.0, vendored** (BSD-3-Clause; one dependency, `setimmediate`). It is copied unchanged into `vendor/rdf-canonize`, pinned by hash and commit in its `PROVENANCE.md`, as the engines are. poly-io turns the presentation into RDF itself, with a closed converter: the two pinned contexts, the one tree of section 1, every key mapped, and any other key refused `presentation-malformed`. The costs:
  - Rule 5 is amended for one vendored path, not for npm. Vendoring a third-party library stretches the rule "engines are vendored": rdf-canonize is not a Poly engine.
  - Its public `canonize` is asynchronous, so `verify` still becomes asynchronous, as in A. The package also exports `_canonizeSync`, but its own comment says it "is no longer available in the public API, it is for testing only". Building on it would rest the adapter on an unsupported API that the next re-vendor may lose. This note does not propose it.
  - The converter is poly's own code. Agreement with the two signatures on the fixture shows that the converter matches the signer on that shape. It does not show the converter sound on other inputs. A disagreement on another valid input is a refusal, which fails closed. The danger is a converter that maps two different documents to one dataset. So it emits N-Quads exactly as RDFC-1.0 requires: escaping, `xsd:dateTime` literals, `sec:multibase` proof values, the `rdf:JSON` literal of `agentIdentity`, and the type-scoped `DataIntegrityProof` terms of `credentials/v2`. A differential test against `jsonld`, used as a test-only oracle over mutated fixtures, is possible. It needs that dependency in tests, which is still the owner's decision.
  - A new field from Affinidi is refused until the converter knows it. A `tools/call` that carries policy decisions would be refused until a capture shows their shape (section 6).

**The owner chose B (D1).** It adds no network stack, and it refuses what it has not seen. That refusal is the stated limit already: the adapter verifies what the fixtures show and nothing it has not seen. With A or B, the runtime change is the same: `ChannelAdapter.verify` may return a promise, and `rt.receive` and `ingress` await it. An adapter that answers at once is unaffected. `verify` stays pure: it reads only the webhook, the clock, the pinned contexts and the pin store. The DID log fetch is separate, and runs outside `verify` (section 4).

## 4. How the keys are trusted

### The gateway's key

The owner's rule of 2026-11-03 stands:

- The issuer is `did:webvh:<SCID>:<domain>`. The domain is parsed into labels. It is accepted when it has at least one label before the three labels `agentgateway.affinidi.io`, and every label is lower-case letters, digits and hyphens. A port, a path, percent-encoding, the bare suffix, or a domain that only contains the suffix (`agentgateway.affinidi.io.example.com`, `xagentgateway.affinidi.io`) is refused `issuer-unknown`. A self-hosted gateway is accepted only from the owner's list: each entry is its DID and its pinned log, in the project's trust, signed as a keyring change is (S194, S210). Its log comes from the list and is never fetched.
- At first sight of an accepted domain, poly-io fetches `https://<domain>/.well-known/did.jsonl` and verifies it as did:webvh 1.0 requires:
  - the SCID is recomputed from the first entry;
  - each `versionId` is `<n>-<entry hash>`, and each entry hash is recomputed over the entry with `versionId` set to its predecessor's;
  - each entry's `eddsa-jcs-2022` proof is checked against an update key in force;
  - `versionTime` increases and is not in the future;
  - `state.id` is the DID.

  A log with parameters the capture does not have (witnesses, pre-rotation, portability) is refused. A deactivated log has no current key. `did-witness.json` is `[]` for both logs read.
- A log that verifies is pinned in the host's store: the log's bytes, its digest, its last `versionId`, the time, and how it was pinned (fetched, recorded, owner's list). A failed first fetch is never a pin. A log that cannot be fetched is refused `did-log-unavailable`, and a log that does not verify is refused `did-log-invalid`.
- The signing key is read from the **last** entry of the pinned log only. A key that only earlier entries held is not accepted.
- A later fetch must chain from the pin: the pinned entries are a prefix of the new log, and each new entry verifies. A log that does not chain is refused `did-log-unchained`, and the pin is kept.

**What the gateway's log says.** It has one entry, of 2026-10-27, unchanged since. The update key is `z6MkuUe…dP2a`. `#key-1` (JsonWebKey2020) and `#key-2` (Multikey) are the same Ed25519 public key as that update key. `assertionMethod` lists `#key-1` only, and the credential's proof names `#key-2` with `proofPurpose: assertionMethod`. A strict Data Integrity verifier refuses that proof, since the method is not listed for the purpose. Refusing it would refuse every presentation the live gateway signs today.

**The owner chose D2 b.** A proof's method is accepted when it is listed under `assertionMethod`, or when its key bytes equal those of a method listed there. `#key-2` passes on the second rule: its key is the key the document authorises for assertion under `#key-1`. The adapter refuses everything else `key-unknown`. Each presentation accepted on the second rule carries `keyMatch: "assertion-key-bytes"` in its evidence (section 6), so the journal counts how often the rule was used.

**For the report to Affinidi.** The gateway DID `did:webvh:QmdhonjC…GiPm:helium-sunset.p3w7om.agentgateway.affinidi.io` (log entry `1-QmVMui3g…c271`, 2026-10-27) lists `#key-1` under `assertionMethod` and `authentication`, and lists `#key-2` under neither. The `AgentIdentityCredential` of trace `820ce133-0396-4085-8c42-c167af509b2b` (2026-11-04T16:36:53Z) is signed with `#key-2` and `proofPurpose: assertionMethod`. Both methods hold one Ed25519 key, which is also the log's update key. The holder documents do not have the issue: they list both methods under `assertionMethod`. The fix on Affinidi's side is to list `#key-2` under `assertionMethod`, or to sign with `#key-1`. Either one would make the D2 b rule unnecessary.

**Where the fetch runs.** Network code lives in poly-io alone (S182), and nothing on a check path fetches. The adapter gets a `prepare(webhook)` step in poly-io. The request is not yet verified when `prepare` runs, so anyone can send one. `prepare` fetches in an order that limits what a forged request can make the desk fetch:

1. It checks the shape and the contexts, and applies the domain rule to the issuer. A request that fails any of these fetches nothing.
2. It pins the issuer's log, if no pin exists. First-sight fetches are limited per domain. A failed fetch is remembered for ten minutes, a negative cache, during which that domain is not fetched again. A failed fetch is still a refusal and never a pin.
3. It verifies the **credential** proof under that pin. This is computation, not network.
4. It requires `credentialSubject.id` to equal `holder`.
5. Only then does it fetch the holder's log, if no pin exists. The desk therefore fetches only logs of holders that an accepted gateway signed a credential for.

Each fetch goes through `httpsTransport` (15 s timeout), and its outcome is recorded in the pin store. `verify` then reads only the webhook, the clock, the pinned contexts and the pin store, and checks everything again from the start. It never fetches. A DID with no pin is refused with the reason of its last attempt (`did-log-unavailable`, `did-log-invalid` or `did-log-unchained`). All refusals are therefore taken in `verify` and journaled by `rt.receive`. The host (P4) calls `prepare` before `rt.receive`. If it does not, the request fails closed. The alternative is an optional `prepare` on `ChannelAdapter` that `rt.receive` awaits, a small change in poly-runtime.

**When a pinned log is fetched again (D5).**

- When a presentation names a verification method the pin does not hold. This happens at most once per DID per ten minutes, so junk key ids cannot make the desk hammer the gateway.
- Every 24 hours for each pinned gateway log (the owner's decision). Without a schedule, a key the gateway rotated out stays accepted for as long as it was the last one the desk saw. A scheduled fetch that fails keeps the pin. A scheduled fetch that does not chain keeps the pin and is journaled.

Pin events are journaled on `runtime:ingress`. That needs a stage `pin` in `ingressRecord`, a one-word change in poly-runtime's types.

**`--recorded`.** The host builds the pin store from `fixtures/gateway-did.jsonl` and `fixtures/holder-did.jsonl` (and the second capture's holder log once it exists), marked `recorded`. It gives the adapter no transport. `prepare` then fetches nothing, and any DID not in the fixtures is refused `did-log-unavailable`. The clock is the fixture's (section 5).

**The limit.** The first log the desk sees for a domain is the one it trusts. For a hosted gateway, that trust rests on TLS and on Affinidi's control of the domain at that moment. A second limit comes from the log itself: the gateway's credential-signing key is also its update key, so whoever holds that key can both sign presentations and rotate the log, and a rotation it signs chains.

### The holder's key

The holder is `did:webvh:QmT86K…7fV:helium-sunset.p3w7om.agentgateway.affinidi.io:surface:eca721d4-…-abc68630d004`. did:webvh puts a DID with a path at the path: its log is at

```
https://helium-sunset.p3w7om.agentgateway.affinidi.io/surface/eca721d4-6053-44d3-b96b-abc68630d004/did.jsonl
```

That URL answered 200 (`text/jsonl`) on 2026-11-04. The log has one entry, `versionTime` 2026-11-04T16:14:01Z (22 minutes before the call). Its SCID is the holder's own (`QmT86K…`), and its update key is its own (`z6Mkexa8…Gp3r`), not the gateway's. `#key-1` and `#key-2` are again one Ed25519 key, and here both are listed under `assertionMethod`. The holder's log is verified and pinned as the gateway's is, on first sight of each holder, and fetched again only for an unknown key. It is trusted because it sits under the issuer's domain: the holder DID's domain must equal the issuer's, label for label (section 9). The holder log is never fetched from any other host.

## 5. Replay and freshness

**Fresh.** The holder proof's `created` and `expires` decide it, with a clock skew (`skewSeconds`, 30 by default):

- A presentation is fresh when `created − skew ≤ now ≤ expires + skew`.
- A presentation is fresh only when the credential is valid too: `validFrom − skew ≤ now ≤ validUntil + skew`.
- A presentation whose `expires` is more than 300 s after `created` is not what the capture shows. It is refused `presentation-malformed`.

Anything else is refused `presentation-stale`. The times are RFC 3339 with up to nine fractional digits and `Z` or `+00:00`. The capture has `.66Z`, `.657Z` and `.660193227+00:00`. A strict parser is written for them, since `fresh()` in `util.ts` takes integer seconds only.

**The nonce** is the `traceId`, scoped by issuer: key `<issuer DID>#<traceId>`. It is kept in `poly_ingress_nonce` until `expires + skew`, the time after which the adapter refuses the presentation as stale anyway (review D-F6). The same value is the message's `providerMessageId`, so dispatch is idempotent on it. The adapter does not detect a replay itself. It hands the runtime the nonce, and `rt.receive` refuses the second sight with its own `token-replayed`.

The `traceId` is chosen over the presentation's `id` (also a signed `urn:uuid`) for two reasons. The gateway signs it in its own credential. It is also the id the gateway's audit and the `X-Gateway-Trace-Id` header show, so a ledger step can be matched to its audit row. Scoping by issuer keeps one accepted gateway from spending another's trace ids. One capture cannot show that a trace id is unique per request. If a gateway repeats one, the second request is refused `token-replayed`: the failure is closed and visible on the first test. The adapter would then switch to the presentation `id`.

**The audience.** The holder proof has no `challenge` and no `domain`. What ties a presentation to this desk is `workloadBinding.target`. It must equal, string for string, the desk's configured URL: the adapter's configuration field `target`, `https://agentlab.2dee.org/mcp` for the demo. The adapter is not made with an empty `target`. Any presentation signed by any Lab gateway for another target is otherwise valid. It is refused with the reserved reason `target-mismatch`. Together, the target, the nonce and the expiry make a presentation usable once, at this desk, for five minutes.

## 6. The claims the adapter delivers

**To the program**, through `SenderClaims`, which today holds only `{ verified, sender }` (K11):

| Claim | Value |
|---|---|
| `verified` | `true`. There is no unverified delivery: a presentation that fails any check is refused. |
| `sender` | the holder DID, which the runtime maps to the principal (S450) |

`fields.source` is the holder DID too, the thread key. The body given to the content store is the request body, unchanged: the host (P4) dispatches the tool call from it. That body is not a claim.

**As evidence, journaled on `runtime:ingress` with the claims (the owner's decision D3 a):** the issuer DID, the `traceId`, the SHA-256 of the presentation string's UTF-8 bytes (the digest PROPOSAL Act 3 binds to the step), `assurance`, `identity_source`, `delegated`, `keyMatch` when D2 b's rule was used (section 4), and the policy decisions once a capture shows them. `InboundMessage` gains an optional `evidence` record, and `ingressRecord` journals it. That is a poly-runtime type change. The program never reads evidence: it sees `verified` and the holder DID only. The std webhook kind's `Sender` and the desk do not change.

**Policy decisions.** This `initialize` has none, so their shape is unseen. Until a capture shows them, no decision is delivered, and under D1 B a presentation that carries any is refused `presentation-malformed`.

**Not delivered**, and not journaled outside the body: the email (`agentIdentity.value`, `caller.fields.email`), `ns.iss`, `credential_type`, `claim`, every header, and every other part of the body. The email stays where every body goes, in the erasable content store.

**Required, not delivered:** `assurance` must be `gateway_attested`. Any other value is refused `caller-unattested`. The capture has only that value. A presentation in which the gateway did not attest the caller must not fix a Desk.

## 7. The refusals

Each is journaled by `rt.receive` on `runtime:ingress` as `{ stage: "verify", outcome: "refused", provider: "affinidi-agent-gateway", reason }`, and nothing is dispatched. The reasons are reserved for this adapter. The desk's handlers never `reject` with them, so the journal always says whether the adapter or the desk refused.

| Reason | When |
|---|---|
| `presentation-missing` | Not a POST of JSON, a body that does not parse, a batch, or no string at the path of section 1 |
| `presentation-malformed` | A presentation that does not parse, or is not the tree of section 1, or has `expires` more than 300 s after `created` |
| `context-unpinned` | A `@context` entry outside the pinned set (section 8) |
| `issuer-unknown` | An issuer whose domain fails the suffix rule and is not on the owner's list |
| `holder-unbound` | `holder` is not `credentialSubject.id`, the holder's domain is not the issuer's, its path is not `surface:<uuid>`, or the holder proof's method is not the holder's |
| `did-log-unavailable` | No pin, and the log could not be fetched (or `--recorded` has none) |
| `did-log-invalid` | No pin, and the fetched log does not verify (SCID, hash chain, entry proofs, parameters) |
| `did-log-unchained` | A fetch for an unknown key returned a log that does not chain from the pin; the pin is kept |
| `key-unknown` | The pinned log's last entry holds no method of that id that is listed under `assertionMethod` or has the key bytes of one listed there (D2 b) |
| `signature-invalid` | Either proof fails |
| `target-mismatch` | `workloadBinding.target` is not, string for string, the desk's configured URL (the adapter's `target`) |
| `caller-unattested` | `caller.assurance` is not `gateway_attested` |
| `presentation-stale` | Outside the window of section 5 |
| `token-replayed` | The runtime's own reason: the nonce was taken before |

The checks run in this order: shape, contexts, issuer and holder, pins, keys, signatures, target, attestation, time. An unsigned field therefore decides nothing before the signatures are checked. The adapter's seeded mutants are the existing two (`signature-always-matches`, `timestamp-never-stale`), plus one new mutant, `target-never-mismatched`.

## 8. The JSON-LD contexts, pinned by digest

| URL | Bytes | SHA-256 of the bytes served on 2026-11-04 |
|---|---|---|
| `https://www.w3.org/ns/credentials/v2` | 10 131 | `59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734`, the digest the VC Data Model 2.0 publishes for this context |
| `https://d2oeuqaac90cm.cloudfront.net/TAgentIdentityCredentialV1R0.jsonld` | 787 | `1db899994941683f2870acff30cb028f3e64bb0a57d6ca0c1734fd14e8532150` |

Both are copied into poly-io (`packages/poly-io/contexts/`) at step 2, and `PROVENANCE.md` gives each one's URL, date and digest. The adapter is not made if a file's digest is not the pinned one. The document loader is a static map from these two URLs to those bytes. It never fetches, at run time or on a check path.

**A context that is not pinned.** A presentation or credential whose `@context` names any other URL, or holds an inline context object, is refused `context-unpinned` before canonicalisation begins. Nothing is fetched. The lists must be the ones captured: `[v2]` for the presentation, and `[v2, cloudfront]` for the credential. A new context from Affinidi is a new pin, read, digested and committed by a person.

**What the cloudfront context defines.** It defines `AgentIdentityCredential` and six terms: `identityFields`, `agentIdentity`, `llmInfo`, `softwareInfo`, `provisioningInfo` (all `@json`) and `region`. It does **not** define `workloadBinding`, `caller`, `fields`, `identity_source`, `assurance`, `delegated`, `traceId` or `target`. Those terms reach the signed RDF only through the `@vocab` of `credentials/v2`, as `https://www.w3.org/ns/credentials/issuer-dependent#…` IRIs. They are signed. Their meaning is Affinidi's alone, as the issuer-dependent vocabulary says. `agentIdentity` is signed as a canonical JSON literal. If either context changed what it maps, the dataset would change and the signatures would fail. That is why the bytes are pinned rather than the URLs.

## 9. The caller DID, and what binds it to the gateway

The Desk is keyed on the holder DID (section 2). Five checks bind the holder to the issuing gateway. Each one failing is `holder-unbound`, except the log, which has its own reasons:

1. `credentialSubject.id` equals `holder`. This check carries the weight: it is inside the credential, so the gateway's signature says the credential is about this DID.
2. The holder DID's domain equals the issuer DID's domain, label for label, after both are parsed. A suffix match is never used.
3. The holder DID's path is exactly `surface:<uuid>`, the one form captured.
4. The holder's log is fetched only from that domain and that path (section 4), verified, and pinned.
5. The holder proof's `verificationMethod` is `<holder>#<fragment>`, and the holder's pinned document lists that method under `assertionMethod`.

**What does not bind it.** No proof in the gateway's log reaches the holder's log. The holder's log has its own SCID and its own update key. The link is the gateway's signature over `credentialSubject.id`, and the gateway's control of its own domain. The holder proof was made 3 ms after the credential's, and `delegated` is `true`, so the gateway most likely holds the holder key as well. The holder proof then shows possession of a key the gateway made. It adds no second party.

**What one capture cannot show.** It has one caller. The holder's log was created at 16:14:01Z, 22 minutes before the call. That fits either a DID created on this caller's first call or a DID created with surface_a. If the uuid is the surface's, every caller of surface_a shares one holder, and the Desk is keyed on the hashed `agentIdentity` (section 2). The owner's statement is that the holder is the caller's DID on that surface. The second account's capture on the same surface settles it. If its holder differs, the statement holds. Comparing the uuid with surface_a's id in the portal also answers it.

**The holder's log fixture.** `--recorded` and the tests need the holder's log. The copy read on 2026-11-04 is `poly-agentlab/fixtures/holder-did.jsonl`, byte for byte (2 322 bytes, sha256 `b61dd35ae23a47b1ae2b5492acbd67382795b3025847420112d2727a94a3d28c`, commit `ec7e2eb`). The second capture brings its own holder's log, unless the two accounts share one holder.

## 10. Fixtures in the public poly repository

What the fixtures hold that is personal:

- The owner's work email, twice in the presentation (`agentIdentity.value`, `caller.fields.email`). Both signatures cover it.
- The client's forwarded IP address (`X-Forwarded-For`, first entry) and the gateway's egress address (`Cf-Connecting-Ip`). They are headers, which no signature covers.

The options weighed for D4:

1. **As captured.** Every test runs on real signatures. The email and the IP address become public, in history, for good.
2. **Captured kept private, a redacted copy public for refusal tests only.** Redacting the email breaks both signatures. The public tests could then show refusals only, and the acceptance test would run only where the private copy is.
3. **A new capture with another Lab account**, committed as captured, with the IP headers replaced. The headers are outside both signatures, so the replacement costs nothing.

**The owner chose 3 (D4).** The owner creates a second Lab account and makes the capture. It is committed as captured, its body byte for byte. The IP headers (`X-Forwarded-For`, `Cf-Connecting-Ip`) are replaced, and `PROVENANCE.md` names each header changed and what replaced it. The 2026-11-04 fixtures stay in poly-agentlab and do not enter the poly repository. This note quotes neither the email nor the addresses.

The capture session also brings what this capture lacks:

- an `initialize` and a `tools/call` through the echo server, which show whether every request carries its own presentation and trace id, and what policy decisions look like;
- that account's holder DID on surface_a, and its holder's log, which settle section 9.

**Step 2 does not start until that capture exists.**

## Recorded for P3 and P4

- **P3: the MCP client sends `Mcp-Method` on every request.** The gateway refuses a request with no `Mcp-Method` header (`-32020`). The client calls surface B's access point, so every request it makes, `initialize` and notifications included, carries that header.
- **P4: the host answers `initialize` with protocol version `2024-11-05`.** That is the version the gateway forwards ("in place of unsupported 2025-11-25", its log says), whatever the client asked.
- **P4, also.** A request without a presentation (a `GET` for a stream, or a notification if the gateway does not sign one) is refused before any Desk sees it. The host calls `prepare` before `rt.receive`. In `--recorded`, the presentations expired at 16:41:53Z on 2026-11-04, so the recorded clock must sit inside that window.

## Step 2 tests, as the capture now allows them

P2 asks that "one changed byte in the body is refused". That holds only inside the presentation. The tests become:

- The captured request verifies, with a clock inside its window, and its claims and evidence match `audit-presentation.json`.
- One byte changed in each delivered or deciding field (holder, `traceId`, `target`, the email value, `expires`, each `proofValue`) is refused.
- One byte changed outside the presentation (`clientInfo.version`) is accepted with the same claims. The test states the limit: the presentation signs who asked, not what was asked.
- Also refused: a clock after `expires`; the same request twice; a presentation signed by another key; a request with no presentation; an unpinned context; a wrong target; a holder under another domain; and the look-alike domains of section 4.
- A forged presentation that names a new holder under the captured gateway, with a credential proof that fails, is refused and makes `prepare` fetch nothing. The test's transport records every request.
- With the seeded mutant `target-never-mismatched`, a presentation for another target passes. That shows the target check is live.

## Stated limits

- The format is Affinidi's, read from one capture, and it may change. The adapter verifies what the fixtures show and nothing it has not seen.
- The only capture is an `initialize`. Whether each `tools/call` carries its own presentation and trace id, and whether a second caller gets a second holder, are unseen. If either fails, the nonce rule or the Desk key changes (sections 5 and 9).
- The presentation binds the caller, the target and five minutes. It does not bind the method or the arguments of the request. Those are trusted from the transport: the gateway, over TLS, through Cloudflare to the box.
- The first log seen for a domain, and for a holder, is the one trusted. The gateway's signing key is also its update key.
- The gateway's credential proof names a key its document does not list for assertion. It is accepted on its key bytes (D2 b), and the mismatch is reported to Affinidi.
- No policy decisions have been seen, so none are delivered.

## Conclusion

The capture answers most of what Affinidi's pages left open: where the presentation is, what it is signed with, and what makes it fresh. It also shows three things the plan did not expect. Two DIDs sign. No signature covers the request outside the presentation, so a target check is needed. The gateway's key is used under an id its document does not list for assertion. The owner has decided all five questions. The adapter is built in poly-io with no network on a check path, on a vendored `rdf-canonize` and a converter for the captured shape only, with a `verify` that the runtime awaits. The `#key-2` mismatch is accepted on key bytes and reported to Affinidi. The issuer, the trace id and the presentation digest are journaled as evidence, and the program sees `verified` and the holder DID only. Step 2 waits for one thing, the second Lab account's capture. That capture gives the public fixtures, shows whether each request carries its own trace id and what policy decisions look like, and says whether the Desk is keyed on the holder DID or on the hashed `agentIdentity`.
