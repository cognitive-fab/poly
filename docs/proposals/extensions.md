# poly v2.0 proposal 28: extensions

*Cognitive Fab · 2026-10-31 · proposal only, no code · on v1.5.0 (`076f9539`)*

This proposal gives mundane code a declared place in a poly program. Mundane code is a parser, a protocol detail, or a source poly does not ship. It is entry 28 of `docs/proposals/v2.0.md`, which holds a summary and links here. The evidence comes from outside this repository: polylife, a poly program that reads mail across six accounts, and its list of fourteen gaps (`polylife/docs/poly-gaps.md`, with the host workarounds in `polylife/host/`). The owner decided seven points before this proposal was written, and seven more on its open questions (section 2). The proposal designs within them and does not reopen them. Nothing here changes a requirement until the owner accepts the proposal.

## 1. The problem

A poly program has two kinds of code: the program, which the checker reads, and the host, which it does not. Code that is neither state-machine logic nor a handler of a declared effect has no third place, so it goes in the host. There it breaks guarantees without any diagnostic:

- **SES mail has no account taint.** polylife reads the SES bucket in the host (`host/readers.mjs`, `s3Bucket`, `readSes`) and puts each body into the runtime with `rt.putContent`. A body that enters that way has the lowest taint, `⊥`, with no owner (PS17.1). A decision over it would send customer mail to a model as public data, and the flow rule (PS17.3) would find nothing. polylife avoids the leak by never letting a decision read SES mail (G6). The program cannot say why.
- **Due dates are outside every liveness proof.** An obligation goes overdue at a date carried by a message. poly's only timer is `after <duration>` (PT6.3), so the host is the clock: it keeps every date in its index and sends `SetDue(late)` and `Overdue()` (G4). A property such as "an open obligation becomes overdue or done" is a property of the host's loop, which the checker never sees.
- **Identity is the host's.** "One message in two mailboxes counts once" needs the RFC 5322 Message-ID. The host keeps a Message-ID index and decides which instance a message reaches (G5, `host/index.mjs`). No machine and no property can see that decision.

Allowing free code in the program would close these gaps and defeat the purpose of poly, whose claim is that the checked program is the running program (PS4.1b, PA0.2). This proposal adds a third kind of code: small JavaScript functions with declared types, isolated at run time, whose results the checker treats as unknown values within those types.

## 2. Decisions already made

The owner made these seven decisions on 2026-10-31. They are restated here so the rest of the document can cite them.

1. **D1. An extension is an npm package with three parts.**
   - A poly module (machines and declarations), composed with the program and checked like the rest of it.
   - JS leaf functions. Each is either pure or handed exactly one capability, a connection the runtime opened under a declared grant.
   - A manifest: the grants it requests, and the input and output type of each leaf.
2. **D2. Isolation.** Leaves run in a Node worker under a locked-down loader. There is no `require` or `import` of `fs`, `net`, `child_process`, `worker_threads` or any module outside an allow list, and no access to `process.env`. The only way out is the capability handle.
3. **D3. Taints.** The runtime, never the extension, stamps taints and provenance on what a leaf returns.
4. **D4. Types.** The runtime checks every leaf output against its declared type before the program sees it.
5. **D5. Pinning.** `poly admit` pins each extension by digest, and any change to the package fails admission.
6. **D6. Time and identity stay in the language.** A timer fires at a date carried in the data, and an identity key is declared. Extensions only supply the function that extracts the date or computes the key.
7. **D7. Authorship.** Cognitive Fab only at first. The contract format may change before it opens to others.

### 2a. Decisions on the open questions

The owner read the first draft of this proposal and decided its open questions on the same day, 2026-10-31. Each decision is recorded here and applied in the section it names. Section 15 lists what remains open.

8. **D8. The boundary ruling is granted,** on the six conditions of section 7. It is the second ruling of S507's kind; it takes its S-number when it is entered in the decisions log.
9. **D9. A pin carries a signed record from `poly admit`** (section 11.2). The admission key signs it; no person's record of a new kind is needed.
10. **D10. Node 22.15 or later is required,** for the synchronous module hooks (section 6.3).
11. **D11. An extension may carry a provider profile,** declared in its manifest's grants (section 3.3).
12. **D12. Mail read with a static AWS key is owned by the principal that `poly.json` names for that key** (sections 5.4 and 13.1).
13. **D13. A Message-ID is an identity for de-duplication only, never for authority.** When a message has none, the identity is a hash of its sender, date and subject (section 10).
14. **D14. Opening extension authorship beyond Cognitive Fab requires WebAssembly isolation** (sections 6.6 and 11.2).

## 3. What an extension is

### 3.1 The package

An extension is an npm package under the scope `@cognitive-fab/` whose name starts with `poly-x-`. Its root holds:

```
@cognitive-fab/poly-x-mailheaders/
  package.json             "dependencies": {} (section 11.3)
  poly-extension.json      the manifest (section 3.3)
  poly/mailheaders.poly    the extension's poly module, module x.mailheaders
  leaves/index.mjs         the leaf functions, ES modules
  leaves/rfc5322.mjs       a file the leaves import by relative path
  corpus/                  recorded inputs and outputs of each leaf (section 11.4)
  poly-extension.sig.json  the publisher's signature (section 11.2)
```

### 3.2 The extension's poly module

The module is named `x.<name>`. The prefix `x.` is reserved, as `std.` is: a module named `x.*` is found only among the project's pinned extensions, never among the project's files (PT1.3). The module may declare enums, record types, machines, properties and three new items: `grant`, `leaf` and `identity` (section 10). A leaf is declared by its signature:

```poly
module x.mailheaders

enum Precedence { None, Bulk, List, Junk, Other }
enum AutoSubmitted { No, AutoGenerated, AutoReplied, Other }

type Headers = { listed: bool, unsubscribe: bool, precedence: Precedence, auto: AutoSubmitted, list: Key }

// RFC 5322 and RFC 2369 headers of one message, read from its raw bytes. Pure: no grant.
leaf parse(m: Items one raw) -> Headers
```

A leaf that needs the world declares the grant it requests, and is bound to it:

```poly
module x.sesmail

// The S3 bucket SES writes received mail to. The program binds this grant to one of its credentials (section 4.4).
// It carries its provider profile (D11, section 3.3).
grant bucket: aws_sigv4 {
  service "s3"
  scopes { s3:ListBucket, s3:GetObject }
  profile "aws-s3" {
    base "https://{bucket}.s3.{region}.amazonaws.com/"
    source "https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html"
  }
}

type Page = { cursor: Key, more: bool }

leaf sync(cursor: Key) -> Page uses bucket class none
leaf resolve(id: Key) -> Content uses bucket class none
```

The grammar:

```
LeafDecl   = "leaf" Ident "(" Params ")" "->" Type [ "uses" Ident "class" Class [ Idempotency ] ] ;
GrantDecl  = "grant" Ident ":" CredentialKind "{" GrantItem* "}" ;
LeafParam  = Ident ":" Type [ "one" ] [ "raw" ] ;
```

- A leaf with no `uses` is **pure**: class `none`, no capability, any number of attempts.
- A leaf with `uses g` is a **capability leaf**: it receives exactly one capability, the connection the runtime opens under the grant `g` (D1). Its class is declared and is a floor the program cannot lower (section 8). `Idempotency` is PS23's `idempotent header "<Name>" window <duration>`, written on the leaf because only the extension's author can read the provider's documentation (K17).
- A leaf's input types are `bool`, ranges, checked strings, payload-free enums of the module, `Key`, `Instant` (section 9), `Content`, and `Items` with `one` (PS17.4b). `raw` on an `Items` parameter asks for the item's raw bytes rather than its rendered body (section 4.3).
- A leaf's output type is a record of the same types, or `Content`. A record output is how one leaf returns several values; a single value is a record with one field.
- A leaf has no state the program can see. Whatever a leaf keeps between calls in its worker is outside the program, and the checker assumes nothing that it could break (section 5.1).

The module's machines are checked like any module's (section 5.3). An extension whose protocol has state of its own (a cursor that must only move forward, a session that must be closed) writes that state as a machine, so it is checked, and keeps the leaves to I/O and parsing.

### 3.3 The manifest

`poly-extension.json` is what the runtime reads. It is generated from the module by `poly extension pack`, never written by hand (PA0.3), and it is read back against the module at every admission (section 11.5).

```json
{
  "v": 1,
  "name": "@cognitive-fab/poly-x-sesmail",
  "version": "0.1.0",
  "publisher": "cognitive-fab",
  "module": { "name": "x.sesmail", "file": "poly/sesmail.poly", "digest": "sha256:..." },
  "runtime": "node-worker",
  "entry": "leaves/index.mjs",
  "files": { "leaves/index.mjs": "sha256:...", "leaves/s3.mjs": "sha256:...", "leaves/mime.mjs": "sha256:..." },
  "grants": {
    "bucket": { "kind": "aws_sigv4", "service": "s3", "scopes": ["s3:ListBucket", "s3:GetObject"],
                "profile": { "provider": "aws-s3",
                             "bases": ["https://{bucket}.s3.{region}.amazonaws.com/"],
                             "scopes": ["s3:ListBucket", "s3:GetObject"],
                             "source": "https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html" } }
  },
  "leaves": {
    "sync":    { "export": "sync", "grant": "bucket", "class": "none",
                 "input":  { "cursor": "Key" },
                 "output": { "record": { "cursor": "Key", "more": "bool" } },
                 "limits": { "timeoutMs": 30000, "memoryMb": 64, "outputBytes": 1048576 } },
    "resolve": { "export": "resolve", "grant": "bucket", "class": "none",
                 "input":  { "id": "Key" }, "output": "Content",
                 "limits": { "timeoutMs": 30000, "memoryMb": 64, "outputBytes": 26214400 } }
  },
  "source": { "kind": "records", "sync": "sync", "resolve": "resolve", "raw": "resolve", "keys": ["object"] },
  "corpus": "sha256:..."
}
```

- Types are written in a closed JSON form of poly's types: a scalar name, `{ "range": [lo, hi] }`, `{ "enum": "x.sesmail.E" }`, `{ "record": { … } }`, `"Content"`, `"Key"`, `"Instant"`, `{ "items": { "one": true, "raw": true } }`. No other form is read.
- `limits` bound each call (section 6.5). The program may lower them and never raise them.
- `source` names the leaves that implement a source adapter (section 4.3).
- **A grant may carry a provider profile (D11).** Today a provider profile is read only from std (`std/credentials/providers/<provider>.json`, `packages/poly-check/src/providers.ts`), which is why a polylife credential cannot reach Google Calendar (G9). An extension declares the profile its grant needs inside that grant, and nowhere else: its provider name, its base addresses, the scopes it may request, and the documentation it was read from. A base is written as a std profile's is (an absolute `https` URL, no user, query or fragment, `PL1201` otherwise), and may hold named parameters in braces, each standing for one DNS label that the program's credential supplies (`region "eu-west-1"`, `bucket "kanjo-support"`); a parameter is never a wildcard, and the base the credential spells out is checked against the template label by label. A profile carried by an extension reaches only the leaves of that extension: no effect handler and no other source may use it. It cannot shadow a std profile of the same provider name (`PL6416`), and it may not name a model provider (section 7, condition 5). The profile is part of the manifest, so it is pinned by the digest (section 11), printed in the certificate beside the grant, and read back against the module (section 11.5), with the broken variant `profile-base-widened` in the toolchain faults.
- `corpus` is the digest of the recorded calls admission replays (section 11.4).

## 4. Importing an extension and calling a leaf

### 4.1 The pin

`poly.json` names each extension with its version and digest:

```json
"extensions": [
  { "package": "@cognitive-fab/poly-x-sesmail",     "version": "0.1.0", "digest": "sha256:..." },
  { "package": "@cognitive-fab/poly-x-mailheaders", "version": "0.1.0", "digest": "sha256:..." },
  { "package": "@cognitive-fab/poly-x-messageid",   "version": "0.1.0", "digest": "sha256:..." }
]
```

The digest stays out of `.poly` source, so a module's digest (PT1.4) does not move when an extension is repinned. Section 11 says how the digest is computed and checked.

### 4.2 The import

```poly
module polylife
use x.mailheaders
use x.messageid
```

`use x.m` makes the module's enums, record types, leaves, grants and identities nameable as `x.m.N`, as `use m` does for machines and enums today (S176, S190). A machine of `x.m` may be named in `Ref<x.m.M>`, a detached spawn and a configuration, as any used machine. This is a language change in its own right: today a qualified name reaches only machines and payload-free enums, and a credential or a source of a used module cannot be named at all (G2). The same rule gives the program qualified names for credentials and sources (`credential creds.gmail_read`), which closes G2 for modules of the project too.

A record type of another module still cannot cross into a field or a parameter (`PL0901`, PT1.3). A leaf's record output does not need to: its fields are mapped onto the program's own parameters (section 4.3).

### 4.3 A leaf call is an effect

A leaf is never an expression in a handler. A handler is a total, pure function over its pre-state (PS2.1 to PS2.5), poly-ref interprets it, and translation validation compares it step by step (PS9.3). A call into JavaScript would break all three. A leaf call is an intent, like a retrieval (PS17.2): the handler emits it, the runtime runs it, and its result comes back as a completion.

```poly
machine Message {
  …
  action Headed(listed: bool, unsubscribe: bool, prec: x.mailheaders.Precedence, list: Key)
  action Unheaded()

  effect headers(m: Items) {
    one m
    call x.mailheaders.parse(m)
    ok(r) -> Headed(listed: r.listed, unsubscribe: r.unsubscribe, prec: r.precedence, list: r.list)
    failed -> Unheaded()
  }

  on Read(items) {
    require items.count == 1 else reject "not-one"
    …
    emit headers(m: items)
  }
}
```

- **The kind.** An effect whose body holds `call x.m.l(args)` has the kind `x.m.l` and is the runtime's own effect, as a retrieval is: `rt.handle` refuses the kind, and only the runtime delivers its completion (K10's rule, S130). Its manifest entry is `call: { extension, leaf, args }`, read back by poly-ref.
- **Arguments.** Each argument is a parameter of the effect, passed whole. Their names and types must be the leaf's (`PL6416 LEAF_MISBOUND` otherwise). A `Content` argument reaches the leaf as its body, which the runtime reads with `content.read` (PS17.4a). An `Items` argument with `one` reaches it as the item's body, or, for a `raw` parameter, as the raw bytes its source supplies (a source extension names a `raw` leaf; the std Gmail source would keep the raw message for this, section 12). A raw form that the item's source does not supply fails the call with the reason `raw-unavailable`.
- **Labels, class and retry.** The effect writes no `kind`, `labels`, `targets` or `class` (`PL1201`): they come from the manifest. A pure leaf has class `none` and no labels. A capability leaf has the class its declaration states and the labels its grant implies (`egress:external`, and `read:private` when the grant is the holder's). `retry` is the program's, under PS23 (section 8).
- **Completions.** `ok(r)` binds the output's fields as `r.x` (PT6.1). `failed` is delivered when the leaf throws, times out, exceeds a limit, or returns an output outside its type (section 5.2). A call effect must name `failed` (`PL6202`'s rule for decisions, extended).

**A leaf as a source.** A source extension's leaves are called by the runtime's own source machinery, not by an `emit`:

```poly
// A static key: its owner is the principal poly.json names for it (D12), never a holder of a grant request.
credential kanjo_s3: aws_sigv4 {
  provider x.sesmail.bucket
  bucket "kanjo-support"
  region "eu-west-1"
  scopes { s3:ListBucket, s3:GetObject }
}

source support: records {
  adapter x.sesmail
  credential kanjo_s3 binds x.sesmail.bucket
  audience account owned
  freshness 720h
  keys { object }
  identity x.messageid.MessageId
}
```

`adapter x.sesmail` names the extension where `adapter "gmail"` names a poly-io adapter, and `PL6834 SOURCE_ADAPTER_UNKNOWN` accepts a used `x.*` module whose manifest has a `source` entry. `credential c binds x.m.g` binds the extension's requested grant `g` to the program's credential `c`, whose kind and scopes must cover the grant's (`PL6416` otherwise). `provider x.sesmail.bucket` names the profile the extension's grant carries (D11), and `bucket` and `region` fill its base's parameters, so the credential reaches `https://kanjo-support.s3.eu-west-1.amazonaws.com/` and nothing else. **The owner of a static key (D12).** An `aws_sigv4` key is not granted by a person's OAuth consent, so no grant request fixes a holder (S457, S461). `poly.json` names the owner beside the key's store, `"credentials": { "kanjo_s3": { "store": "kms", "owner": "<principal>" } }`, and every item a source reads under the key is owned by that principal. The owner is certified with the credential (`poly.vaults`), so changing it is a new admission, and it is never a value a leaf or an adapter gives. A credential of kind `aws_sigv4` with no `owner` in `poly.json`, named by an `owned` source, is refused at admission (`PL6416`). The runtime builds a `SourceAdapter` (PT10j) whose `sync`, `retrieve`, `resolve` and `forget` call the named leaves in the worker, and keeps the source's cursor itself, so the leaves hold no state between calls. A source's leaves must be class `none` (`PL6419 SOURCE_LEAF_WRITES`).

### 4.4 Lowering and artefacts

| Item | Lowers to | Read back by poly-ref against |
|---|---|---|
| `call x.m.l(…)` in an effect | the manifest entry `call: { extension, leaf, args }`, with the leaf's class and labels | the extension's module, for the signature, class and labels |
| `adapter x.m` and `binds` in a source | `sources/<s>.json` `adapter: { extension }`, `grant: { credential, binds }` | the module's `grant` and the program's credential |
| `identity` in a source and `identified by` (section 10) | `sources/<s>.json` `identity`, the machine's contract `identifiedBy` | the declaring module |
| `at` (section 9) | a `timer` intent with `fireAt` in `effects.cjs` | PS's timer semantics, by the comparison of intents (PS9.2) |
| the pin | the certificate's `poly.extensions` | the package on disk (section 11) |

Each is an artefact the runtime reads, so each enters only with its read-back and a broken variant in `test/toolchain-faults.mjs` (the standing rule): `leaf-output-widened` (the manifest's output type wider than the module's), `leaf-class-lowered` (an `irreversible` leaf written `none`), `leaf-grant-dropped` (a capability leaf lowered with no grant, so it would run with nothing to bind), `source-binds-swapped` (a grant bound to another credential), `identity-leaf-swapped` (an identity computed by another leaf), `at-as-after` (a date timer lowered as `fireIn`), and the certificate fault `stale-extension-pin`.

## 5. What the checker assumes and what it proves

### 5.1 What the checker assumes about a leaf

A leaf is an opaque function within its declared type. In **check**, a call's completion is offered as any completion is (PS4.4, and S456 in a configuration): `ok` with every value of the output's check domain, and `failed`, in any state where the intent is pending. A `Key`, `Content` or `Instant` output is explored by representatives (PS4.1f, PS4.1g, section 9). The checker assumes nothing else: not that the leaf is correct, not that it is deterministic, not that it answers the same twice. So a property that is `CLEAN` holds whatever the leaf's code computes, as long as what reaches the program lies in the declared type.

This adds no machinery to the checker. A leaf call is an effect with completions, and poly-ref explores it as it explores a retrieval or a decision.

### 5.2 Why that assumption holds at run time

PS4.1b (checked is running) needs every run path to be a check path. A leaf output enters the program only through its completion, and the runtime checks it against the declared type before delivery (D4), as it checks any completion's data (S79, S140). An output outside the type, or larger than `outputBytes`, is not delivered as `ok`: the runtime delivers the effect's `failed` completion with the reason `leaf-output`, writes an audit row (`PL6417 LEAF_OUTPUT_OUTSIDE_TYPE`), and journals the refusal on the run. That is PS17.6's treatment of an uncited answer: a rejected `ok` would leave the intent with no completion and the machine waiting for ever (PS6.4, S463), so `failed` takes its place. Every `ok` a run delivers is then a value of the type, which **check** offers, and every `failed` is one **check** offers too. PS4.1b extends to programs with leaves, under the new assumptions of section 5.6.

**Replay never runs a leaf.** A call's answer is fixed by its recorded completion, as a decision's is (K10). Replay reads the recorded output and never starts a worker, so a leaf that is not deterministic changes nothing in replay.

### 5.3 What the checker proves about the extension's module

The extension's module is checked like the program's own modules, and with the program, on every `poly check`: parse and types, lowering and translation validation, model check, deadlock, liveness, the flow rule over its effects, and every configuration that holds its machines. Its verdict folds into the program's (PT12.3), and its properties are listed in the certificate under the extension's name. A module that is not `CLEAN` makes the program not `CLEAN`, whoever wrote it.

At admission, the module is also read against the manifest (section 11.5): every leaf, grant and type the manifest declares is the module's, and nothing more.

### 5.4 Taints and provenance

The runtime stamps every leaf output (D3). The leaf is never asked for a taint, an owner or a time.

- **A `Content` output** carries the join of the taints of the call's `Content` and `Items` arguments, as a decision's answer does (PS17.2). A leaf cannot launder a body: what it returns is at least as restricted as what it read.
- **A finite output** (a `bool`, an enum, a range, a record of them) carries no taint, as a decision's finite answer does not (S323). It is a declassification point: a leaf over tainted input can pass at most `log2` of the number of its outputs, in bits per call. The certificate lists each leaf called with a tainted argument and a finite output, with the highest class it reads and its number of outputs, beside S323's decisions. `x.mailheaders.parse` has 2 × 2 × 5 × 4 = 80 finite outputs, so about 6.3 bits per message, plus its `Key` (next point).
- **A `Key` or an `Instant` output** carries no taint, as a `Key` carries none (PS1.4c). Equality of two such values is information about the inputs they came from. The certificate lists every leaf whose `Key` or `Instant` output is computed from tainted input, with the same reading as S325's counts.
- **A source extension's items** carry the source's declared class, and, for an owned source, the owner is the runtime's, never a value the leaf returns: the holder of the grant the request ran under, for a credential granted by a person (S461), or the principal `poly.json` names for a static key (D12, section 4.3). K14 (the adapter gives each item's true owner) is replaced, for an extension source, by a fact of the runtime: the leaf never sees the owner. A leaf that returns an `owner` field has it ignored and audited. This is what gives SES mail its account taint.
- **The age of an item** (`asOf`, PS17.6) is the leaf's word, bounded by the runtime: an `asOf` after the time the runtime received the item is replaced by that time and audited, so a leaf can make an item older, never fresher.
- **Provenance.** Each call is journaled with the extension's name, version and digest, the leaf, the digests of its inputs and of its output, and the grant it ran under. The body itself is never journaled (PS17.4a).

### 5.5 What is not proved

- That a leaf computes what its name says. `x.mailheaders.parse` may misread a header; `x.sesmail.sync` may miss an object. The checker's verdict does not depend on it, and the extension's own tests and recorded corpus are the evidence (section 11.4).
- That a pure leaf is deterministic. Only identity keys depend on it (section 10, K21).
- That a capability leaf does only what its class allows beyond what the runtime can see. The runtime enforces the methods, the targets and one write per keyed attempt (section 8); it cannot see what the provider does with a request.
- That the worker contains the leaf. That is K20 (section 5.6), and section 6.6 says where it is weakest.

### 5.6 New kernel assumptions

| Id | Assumption | Evidence | Listed in a certificate |
|---|---|---|---|
| K19 | **A leaf's answer is fixed by its recorded completion.** The runtime writes the call's completion with its output in the completing step's transaction (K1), and only the runtime delivers it; replay never runs a leaf. | The runtime's call tests, as PD2-A1 to PD2-A3 are for decisions. | when the program calls a leaf |
| K20 | **A leaf reaches the world only through its capability.** The worker and its loader keep a leaf from every module, global and channel but its arguments and its one capability. | The escape corpus (section 6.6), every entry refused, run on each supported Node version. | when the program uses an extension |
| K21 | **An identity leaf is a function of its input.** The same bytes give the same key, on every call and every start of the worker. | The extension's corpus replayed at admission (section 11.4). | when the program declares an identity |

## 6. The locked-down loader

### 6.1 One worker per extension

The runtime starts one Node worker (`node:worker_threads`) per extension, never one shared by two extensions, so two extensions never share a heap. It is started from one fixed file of poly-runtime, the sandbox's bootstrap, with:

- `eval: false`, the bootstrap's own file as the entry, and `argv: []`;
- `execArgv: []`, so no flag of the parent (`--inspect`, `--require`, a loader) reaches it;
- `env: {}`, so `process.env` inside the worker is an empty object. Measured on Node 24.12.0: a worker started with `env: {}` reads `JSON.stringify(process.env) === "{}"`;
- `resourceLimits` from the leaf's `limits` (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb`);
- `stdout: true` and `stderr: true`, so the leaf's console reaches the runtime's log as data and never the terminal.

The worker is recycled after a number of calls and after any failure, so a leak or a poisoned global does not outlive a few calls.

### 6.2 What the bootstrap removes before any leaf code loads

A worker starts with Node's whole global surface. Measured on Node 24.12.0, a worker started as in 6.1 still has `fetch`, `WebSocket`, `process.getBuiltinModule`, `process.dlopen`, `process.binding`, `WebAssembly`, `SharedArrayBuffer` and `performance.now`. So the bootstrap removes, before it imports the extension's entry:

- the network globals: `fetch`, `Request`, `Response`, `Headers`, `WebSocket`, `EventSource`, `XMLHttpRequest` where present;
- every way to a module by name: `process.getBuiltinModule`, `process.binding`, `process._linkedBinding`, `process.dlopen` (native addons), `require` where CommonJS would give it;
- process control: `process.kill`, `process.exit` and `process.abort` (a leaf ends by returning or throwing), `process.chdir`, `process.setuid` and the rest of the identity setters;
- the clock and randomness in a pure leaf: `Date.now`, `new Date()` with no argument, `performance.now` and `Math.random` throw. A pure leaf that needs a time takes it as an input. A capability leaf keeps them; the time it signs with is the runtime's (section 6.4);
- `SharedArrayBuffer` and `Atomics.wait`, the parts of the timing channel a leaf does not need;
- `WebAssembly`, the whole namespace: removing `compile` and `instantiate` alone would leave `new WebAssembly.Module(bytes)`, which compiles synchronously. So a leaf cannot carry code the static lint (section 11.3) did not read.

It then freezes the intrinsics it kept (`Object`, `Function`, `Array` and their prototypes, `globalThis`), so the leaf cannot restore a removed global or change a built-in that the bootstrap's own code relies on. The list is a deny list over a full runtime. Section 6.6 says why that is the weakest part.

### 6.3 What the loader allows

The bootstrap installs synchronous module hooks (`module.registerHooks`, in Node from 22.15 and 23.5). Node 22.15 or later is required (D10): the package's `engines` field moves from `>=22` to `>=22.15`, and the asynchronous `module.register` hooks, which run on a thread of their own, are not used. Every resolution, static or dynamic, goes through the `resolve` hook, which allows exactly:

- a file of the extension, by relative path, whose digest is the pin's (section 11);
- nothing else. No `node:` builtin is allowed: `Buffer`, `TextDecoder`, `TextEncoder`, `URL`, `atob` and `structuredClone` are globals and are enough for parsers.

A refused specifier throws before anything is read, and the refusal is audited with the extension's name and the specifier. The worker never reads a file. Before it starts the worker, the host thread reads each file of the verified copy (section 11.3), checks its digest against the certificate, and passes the sources in `workerData`; the `load` hook serves each allowed specifier from that memory. So the bootstrap needs no `node:fs` and no `node:crypto` (section 7, condition 2), and `fs`, `net`, `child_process` and `worker_threads` cannot be loaded (D2), nor `module` (which gives `createRequire`), nor `inspector`, `vm` or any package. `import.meta.resolve` resolves through the same hook.

### 6.4 The capability is a port

The worker holds no socket and no secret. A capability leaf receives an object with one method per operation of its grant's kind, each of which posts a message on a `MessagePort` and waits for the answer:

```js
// leaves/index.mjs, x.sesmail
export async function sync({ cursor }, bucket) {
  const r = await bucket.request({ method: 'GET', path: '/', query: { 'list-type': '2', 'start-after': cursor } });
  …
}
```

On the other side of the port, in the runtime's main thread, the request is checked and sent exactly as a handler's `api` request is today (PT22.5, PT10j): the path is resolved against the credential's declared `base` (the leaf never names a host); a URL outside the base is refused with `PL6406`; the method is held to the class (PS23.10: `GET` and `HEAD` only for class `none`, `PL6412` otherwise); the request is signed in poly-io under the grant (SigV4 for `aws_sigv4`, a bearer token for `oauth2`), so the key never reaches the worker; the idempotency header is attached for a keyed leaf (PT33.4); and the request runs only while the grant is `Granted` (PS16.3). The answer the leaf receives is status, the headers that carry no credential (`PL6824`'s list is removed), and the body.

So the network code stays in poly-io (S182), and the runtime sees every request and every answer of every capability leaf. Section 8 uses that.

### 6.5 Limits

Each call runs under the leaf's `timeoutMs`; at the limit the runtime terminates the worker (`worker.terminate()`), delivers `failed` with the reason `leaf-timeout`, and starts a fresh worker for the next call. A heap beyond `memoryMb` ends the worker with `ERR_WORKER_OUT_OF_MEMORY`, delivered as `failed` with `leaf-memory`. An output beyond `outputBytes` is `leaf-output`. A capability leaf's requests count against a per-call cap of requests and of bytes received, declared in its limits.

### 6.6 Known limits

A worker is weaker than WebAssembly. A WebAssembly module starts with no authority at all: it can call only the functions the host passes it, so its sandbox is an allow list by construction. A Node worker starts with the full JavaScript and Node surface, and the bootstrap removes what it knows about, so its sandbox is a deny list. What that leaves open:

- **A global the list does not name.** Each Node release can add one. The escape corpus (K20) runs on every supported Node version, and a release of poly names the versions it was run on. A new Node is unsupported until it passes.
- **One process.** The worker shares the runtime's process. A defect in V8 or Node that escapes a worker reaches the runtime's memory: the vault's keys, the store and the journal. WebAssembly in a separate process, or OpenShell (PT6.5, part 2), would not share it.
- **Side channels.** Timing is reduced, not removed: a capability leaf keeps the clock, and any leaf can measure its own work. A leaf can also encode what it read into what its capability allows: a `GET` path under the bucket's base reaches the bucket's owner. The capability bounds where data can go, not what it says.
- **State between calls.** A leaf can keep values in its module's scope between calls of one worker. The checker assumes nothing that this breaks (section 5.1); identity keys are computed once and recorded (section 10) so that it cannot split an identity.
- **Denial of service.** Bounded by the limits of 6.5, per call, never across calls: a leaf that is slow on every call slows its source.

What stays possible later: a manifest field `"runtime": "wasm"` with the same contract, the leaves compiled to WebAssembly and run with the capability as their only import; or the worker run inside an OpenShell sandbox, where the policy is generated from the grants as it is today from labels. The contract of section 3 does not depend on the worker, so either can replace it without changing a program.

**Why the worker is enough for Cognitive Fab, and only for it (D14).** The worker's limits are acceptable while every leaf is code Cognitive Fab wrote, reviewed and signed: the deny list is a second line behind an author who is not trying to escape it. A leaf by another author would make the deny list the first line. So opening authorship beyond Cognitive Fab requires WebAssembly isolation: an extension whose publisher is not Cognitive Fab is admitted only with `"runtime": "wasm"`, and a publisher ring that names another publisher is refused while the toolchain has no WebAssembly runtime for leaves. The worker stays the runtime for Cognitive Fab's own extensions.

## 7. The boundary rule

`scripts/check-boundaries.mjs` lists `node:worker_threads` among `PROCESS_MODULES`, and only poly-new may import one (rule 2, review finding P8). A worker in poly-runtime is therefore a change to how a standing rule is enforced. S507 is the precedent: poly-mine became the only other package that may start a process, on six conditions the boundary script and a test hold. **The owner granted a ruling of the same kind on 2026-10-31 (D8), on the six conditions below.** It takes its S-number when it is entered in the decisions log, and the boundary script cites that number in rule 8. The conditions:

1. **One place.** Only `packages/poly-runtime/src/extensions/host.ts` imports `node:worker_threads`, and it starts a `Worker` only with the bootstrap's file as its entry, `eval` false, `env: {}` and `execArgv: []`. The script checks each, as rule 6 checks `execFileSync`.
2. **The bootstrap imports nothing.** `packages/poly-runtime/src/extensions/sandbox.ts` imports `node:worker_threads` (for `parentPort`) and `node:module` (for `registerHooks`) and nothing else; it names no network module and no process module.
3. **No check package starts or names a worker.** `poly-core`, `poly-lang`, `poly-lower`, `poly-ref`, `poly-embed`, `poly-check` and `poly-agent` never import `node:worker_threads` (unchanged) and never import `@poly/runtime/extensions`. The check reads an extension's module as source text and its manifest as JSON. No check ever runs a leaf.
4. **No network in poly-runtime.** Unchanged: the capability's requests are sent by poly-io's transports over the port (S182).
5. **No model call.** A grant's provider profile, whether std's or one the extension carries (D11), may not be a model provider: admission refuses a grant whose base is the base of a provider any route names, or of a profile marked `model` (`PL6416`). A leaf's files are linted for model SDKs at admission (section 11.3). So PA0.5 holds: a leaf is never a model call, and a leaf used as a deterministic tier (G3, section 12) is not one either.
6. **The pin before each start.** The extension's files are compared with the pin before a worker starts (section 11), and a mismatch starts nothing.

The rule is new as rule 8 of the script, with a test that runs the sandbox against the escape corpus (`test/extension-sandbox.test.mjs`), as `test/polyx-seam.test.mjs` runs poly-mine.

## 8. Retry safety for leaves that write

A capability leaf of class `compensable` or `irreversible` is a write, and PS23 applies to the effect that calls it exactly as to any effect:

- **The class is the leaf's.** The effect takes its class from the manifest and writes none. A program cannot call an `irreversible` leaf as `none`.
- **`PL4003` holds unchanged.** An irreversible call with `retry { attempts m }`, `m >= 2`, needs G2 (the leaf's `idempotent header … window …`, which the runtime attaches on every write through the capability, PT33.4) or it is `PL4003 UNGUARDED_RETRY` at check, admission and load. G4, idempotent by nature, stays the standard library's (`PL4005`): an extension is not std, even one Cognitive Fab wrote. G3, a person's acceptance, is unchanged.
- **K17 is the extension's word.** A leaf that declares a header cites the provider's documentation in its manifest (`"idempotency": { "header", "window", "source" }`), and the certificate prints the citation beside K17, as for any keyed effect.
- **The runtime can check the leaf's claim of `permanent`.** S138 lets a handler report a definite refusal, which PS23.1 reads as "the target did not execute". A host handler is believed. A leaf is not: the runtime saw every request of the attempt. A leaf that throws `Permanent` after a write in the same attempt that got a `2xx` answer has its claim refused: the attempt ends `failed` (possibly executed, PS23.2), audited. A `permanent` stands only when no write of the attempt was answered with success. That makes PS23's G1 path (at most once, an ambiguous end delivered as `exhausted`) sound for leaves in a way it cannot be for host handlers.
- **One write per keyed attempt** (PT33.4) and **safe methods for class `none`** (PS23.10) are the port's, as section 6.4 says.
- **A worker ended mid-call** (timeout, memory, crash) ends the attempt `lost` (PS23.1).

Pure leaves have class `none` and no capability; any number of attempts is safe, and the default retry applies.

## 9. The date timer

### 9.1 Syntax

```poly
state { … due : Instant = none … }

action SetDue(d: Instant)

on SetDue(d) {
  require opened && phase != Done else reject "not-open"
  require d != due else reject "same-date"
  due' = d
  phase' = Open
  at d -> Overdue() as overdue
}
```

```
TimerStmt += "at" InstantExpr "->" Call "as" TimerKey ;
InstantExpr = Expr [ ( "+" | "-" ) Duration ] ;
```

### 9.2 The type `Instant`

`Instant` is a point in time, or `none`. On the wire it is an integer number of milliseconds since the Unix epoch, a non-negative safe integer; the runtime refuses any other value as outside the type (S140). A module stores an `Instant`, passes it, compares two with `==`, `!=`, `<`, `<=`, `>` and `>=`, and uses one in `at`. Any other use (arithmetic outside `at`, a comparison with a number, a literal other than `none`, a map key, a check domain) is `PL1209`, as for `Key`. An `Instant` enters only as data at run time: a leaf's output, a completion, or an input the host or a person dispatches.

**Check (a new lemma, PS4.1i).** In a module where `Instant` is used as above, every order-preserving bijection `π` on instants gives `(s, l, s') ∈ R_M` iff `(π s, π l, π s') ∈ R_M`: no handler, guard or property can tell two instants apart except by equality and order, no constant other than `none` names one, and `at` does not read its time in **check** (9.3). So every path of **run** is the renaming of a path of **check** over `none` and `n` ordered representatives `i1 < … < in`, `n` following PS4.1c's rule for `Instant` apart. The verdict prints the count. polylife's rule that an estimated date only tightens another estimate (`shouldSetDue`, `host/facts.mjs`) is then a comparison in the machine, explored both ways, and leaves the host.

### 9.3 Semantics

- **In check**, `at e -> A() as k` is a timer intent exactly as `after d -> A() as k` is (PT6.3, PS15.5): it arms `k`, replacing any pending timer with that key, and the environment may fire an armed timer at any time. Durations are not compared today, and instants are not either. So `at` needs nothing new from poly-ref's exploration, and whatever fairness a property gives an `after` timer's action (the timer's action named in its fair set, as the v1.4 examples do), it gives an `at` timer's.
- **`at none` disarms `k`**, as `cancel k` does. A due date that is removed is written `at none`.
- **`at e + D`** adds a constant duration at run time. It is allowed only in `at`, so no sum is stored or compared, and the lemma holds.
- **In run**, the lowering writes a `timer` intent with `fireAt` (the instant's value, plus `D`) in place of `fireIn`. polyrun already resolves `fireAt` as an absolute epoch (`vendor/polygraph/polyrun/src/duration.mjs`, `resolveFireAt`), and fires every timer whose `fire_at <= now` on its next pass (`store.mjs`, `dueTimers`). So an instant already past fires on the worker's next pass, and the host's `SetDue(late)` has no reason to exist. **No engine change is needed.**
- **Replay** reads the journaled firing, never the clock (PS11).

### 9.4 What it gives polylife

The `Obligation` above replaces the host's two messages (`SetDue(late)`, `Overdue()`) with one (`SetDue(d)`), and the clock is the runtime's. A property can then be stated and checked:

```poly
liveness due-becomes-overdue: phase == Open && due != none leads to phase == Overdue || phase == Done
  under fair { Overdue }
```

Before, the same statement would have been a property of the host's loop. A wait that restarts when JJ writes again (G12) stores the time of the last message and re-arms from it, `at t + 120h -> Stale() as stale`, guarded by `require t != since`. The step changes the state, so `PL4002` no longer fires, and the `round` bit goes.

## 10. The identity key

### 10.1 Syntax

An identity is declared by the extension that computes it (D6), as a name and a pure leaf:

```poly
module x.messageid

// RFC 5322 Message-ID, angle brackets and folding whitespace removed, case kept (RFC 5322, 3.6.4). A message with
// no Message-ID gets the SHA-256 of its sender, date and subject, each normalised, so one message read from two
// mailboxes still gets one value (D13).
leaf of(m: Items one raw) -> { value: Key, fallback: bool }
// The thread's root: the first of References, else In-Reply-To, else the message's own identity as `of` gives it.
leaf root(m: Items one raw) -> { value: Key, fallback: bool }

identity MessageId by of
identity ThreadRoot by root
```

A source declares the identities its items carry, and a machine may be identified by one:

```poly
source mail: records { adapter "gmail" … identity x.messageid.MessageId, x.messageid.ThreadRoot }
source support: records { adapter x.sesmail … identity x.messageid.MessageId, x.messageid.ThreadRoot }

machine Message identified by x.messageid.MessageId { … }
machine Fact identified by x.messageid.ThreadRoot { … }
```

### 10.2 Semantics

- **The value.** For each item of a source that declares `identity I`, the runtime computes `I`'s value once, when the item first enters the runtime (at sync or at retrieval), by running `I`'s leaf on the item. No `Items` value exists yet at sync, so the runtime gives an identity leaf the item directly, as a one-item set of its raw bytes (or its body, for a source with no raw form), which is what `m: Items one raw` reads; the leaf's signature is the same whether the runtime or an effect calls it. The value is recorded beside the item's keys with the leaf's digest. It is never the adapter's word, so the Gmail source and the SES extension give one value for one message. A leaf that fails, or returns an empty value, leaves the item with no identity, recorded.
- **A key.** A value of `I` is a `Key` (PS1.4c) named `I`. A retrieval can filter by it as by any declared key (`retrieve mail where owner == p and MessageId == x limit 1`, S451), PS4.1g's lemma covers it, and `items.read` gives it to host code (PS17.4b).
- **An identified machine.** `identified by I` names the machine's instances by `I`'s value. The host dispatches by item, `rt.dispatchItem("polylife.Message", "support", itemId, "Arrived", data)`, and the runtime reads the item's recorded identity and dispatches to the instance `<machine>:<keyed digest of the value>`, creating it at the first dispatch, as a channel's thread key names its application instance (PS15.4). The first mailbox a message reaches creates the instance; the second dispatches into it, and the machine's own handler decides what a second sighting means. A dispatch for an item with no identity is refused `identity-unavailable` before any step, with an audit row. The host no longer keeps a Message-ID index or chooses an instance name.
- **De-duplication only, never authority (D13).** An identity says that two items are one message. It never says who may do anything. So an identity key is never a `Principal` and never a field of claims; no policy reads it (`PL1201` on `item.identity` or a field holding one in a policy); an identified machine's instance gets no claims, no mandate and no audience from its name; and a step's verdict never depends on which owner's item created the instance. What an identified machine may decide is what it decides from its inputs' owners and claims, as any machine. In polylife, a `Fact` confirmed "through another mailbox" is confirmed because its second observation comes from another account's item, an owner the runtime stamped; the `ThreadRoot` only brings the two observations to one instance.
- **The fallback (D13).** A message with no Message-ID gets an identity all the same: the SHA-256 of its sender (the `From` address, lower-cased), its date (the `Date` header as an instant, or the item's `asOf` when the header is missing or does not parse) and its subject (unfolded, with leading `Re:` and `Fwd:` prefixes kept, since they make another message). The leaf reports which rule gave the value (`fallback`), and the runtime records it with the value, so a property or a report can tell a fallback identity from a Message-ID. The fallback is computed by the same pinned leaf, never by the host.
- **Check.** An instance name is a keyed digest of a key, so naming by it is a renaming of keys, as PS15.4 argues for thread keys. An identified machine is checked as any machine. Two arrivals at one instance from items of different owners are two inputs, which **check** already offers.
- **Declassification.** An identified machine whose items come from more than one owner joins their observations in one instance. A step's verdict there (a second `Arrived` rejected `"seen"`) tells whoever reads it that another owner holds the same message. The certificate lists each identified machine and the sources and owners that can reach it, as S325 lists counts across owners. In polylife every account is JJ's, so the listing is the record of a choice, not a leak.

### 10.3 Limits

- **The sender chooses the Message-ID.** A forged Message-ID merges a message into another's instance. The identity is as good as the header. Because an identity is for de-duplication only (D13), a forged collision can make two messages look like one sighting; it can never give the forger any authority, since nothing that decides who may act reads the key. A program that must not lose the second message keeps it as a second observation, as polylife's `Fact` keeps two, rather than refusing it.
- **The fallback can collide and can split.** Two different messages from one sender, at one second, with one subject, get one fallback identity. A relay that rewrites the `Date` header splits one message in two. Both are rare against the messages that carry a Message-ID, and the recorded `fallback` flag says which values to trust less.
- **A changed identity leaf splits instances.** Values are recorded when items enter, so a repinned leaf does not change them; a new item with the new leaf can get another value for the same message. Repinning an identity leaf whose corpus outputs differ is refused at admission unless a person signs it as a migration (proposal 6).
- **Proposal 1.** The identity key is the first part of proposal 1's conceptual data layer: a declared key of an entity, computed by the runtime, comparable across sources. Reading the key of a cited item (`cites.key(…)`) stays proposal 1's.

## 11. Admission and pinning

### 11.1 The digest

The digest in `poly.json` is the SHA-256 of the RFC 8785 canonical JSON of `{ name, version, manifest, files }`: the manifest's own digest, and the SHA-256 of every file the package holds, by its path in the package, `package.json` included. It is computed by `poly extension pin <package>`, which writes it into `poly.json`. It covers the whole package, not only the files the leaves import, so a file that no import reaches cannot change unseen.

### 11.2 Who may publish, and who accepts

- **Publisher (D7).** The manifest names `"publisher": "cognitive-fab"`, and `poly-extension.sig.json` holds an ed25519 signature over the digest by a key of the publisher ring. The ring is a file of the standard library, `std/extensions/publishers.json`, pinned by digest with the toolchain as the `runtime` models are (S143). In the first release it holds Cognitive Fab's keys and no other. An extension with no signature, a signature by another key, or another publisher is refused at admission with `PL6414 EXTENSION_NOT_SIGNED`. Opening extensions to others is a change to the ring and to this contract (D7), and it requires WebAssembly isolation first (D14, section 6.6). It is not part of this proposal.
- **The pin record (D9).** `poly admit` writes a signed record for each pin it admits, of a new kind, `extension`: `{ v: 1, kind: "extension", subject, by, at, sig }`, its subject the digest of `{ project, package, version, digest, publisher }`, signed with the admission key (`keys.admission`) as the certificate is. It is written to `extensions/<name>.pin.json` and bound in the certificate. Load verifies it against the admission keys `run.trust` names, and refuses a pin whose record is missing, signed by another key, or over another subject (`PL6414`). A changed pin is a new admission and so a new record. No person's record of a new kind is needed: the pin is part of what `poly admit` certifies, and who may run `poly admit` is already decided by who holds the admission key.

### 11.3 What admission checks

1. The installed package's files give the pin's digest. A difference is `PL6413 EXTENSION_CHANGED`, and the program is not admitted (D5).
2. The publisher's signature (11.2). Admission then writes the pin record.
3. `package.json` has no `dependencies`, `optionalDependencies` or `bundledDependencies` (a leaf imports only its own files, 6.3), no `install`, `preinstall` or `postinstall` script, and no `exports` condition that names a file outside the package.
4. **A static lint of the leaves**, the boundary script's own patterns applied to each file the manifest lists: an `import` or `require` of anything but a relative file of the package; a model SDK; a network module named in a string; `process.env`; `getBuiltinModule`, `process.binding`, `dlopen`; `globalThis[…]`; `eval` and `new Function`; `WebAssembly`. Each is `PL6415 EXTENSION_AMBIENT`. The lint is the first line and the loader the second (6.3), as for handlers (PT6.5).
5. The manifest is read back against the module (11.5) and the corpus is replayed (11.4).
6. The certificate binds, under `poly.extensions`, each extension's name, version, digest, publisher key id, pin record, provider profiles (D11), and the files with their digests. The verified copy of the files is written to `.poly/build/extensions/<name>/`, which the loader reads (6.3), as the handlers' verified copy is (PT6.5).

**At load** the runtime verifies each pin record (`PL6414`), compares the verified copy with the certificate (`PL6413`), and the host's `before each worker start` check does it again (section 7, condition 6).

### 11.4 The corpus

Each extension ships recorded calls: for each leaf, inputs and the outputs the leaf gave when the package was built, and for a capability leaf the requests it made and the answers it was given. Admission runs each pure leaf over its inputs in the sandbox and requires the recorded outputs; it runs each capability leaf against the recorded answers through a port that replays them and requires the recorded requests and outputs. A difference refuses admission. This is the evidence for K21, and a check that the worker loads the package the pin names. It proves nothing about inputs outside the corpus.

### 11.5 The read-back

poly-ref reads the extension's module source and the manifest, with no code shared with the compiler (the standing rule), and requires: every leaf of the manifest declared by the module with the same input and output types, class, grant and idempotency; every grant with the same kind and scopes; and the `source` entry naming leaves of the right signatures. A difference is `PL2501 LOWERING_MISMATCH`, addressed to the toolchain, as for any artefact. The broken variants of section 4.4 are what show the read-back can fail.

## 12. polylife's fourteen gaps

Each gap is mapped to an extension, a language primitive, or out of scope. Some need a change elsewhere first, which the last column names.

| Gap | Mapped to | How | Needs first |
|---|---|---|---|
| G1 a used module with a route is refused | out of scope (a defect) | `poly-check`'s pipeline does not pass the routing files of a used module (`pipeline.ts`, after `resolveRouting`). It is a fix of the pipeline, not a feature. | It is a prerequisite: until it is fixed, an extension's module may not declare a route, a budget or a priced decision (refused at admission). |
| G2 another module's credential or source | language, part of this proposal | the import of section 4.2 gives qualified names to credentials, sources, leaves, grants and identities of a used module | none |
| G3 a rules labeller is a priced, calibrated model | extension, with a tier kind | a route tier `tier rules leaf x.<m>.<l>` whose answer is a pure leaf's: no price table, no map, its confidence certain or the tier fails. It is a deterministic call, not a model call (section 7, condition 5). | a grammar item in routes (PS18.1), and a ruling that a leaf tier carries no price table and no calibration map (`PL6841`, `PL6843` do not apply to it) |
| G4 no timer at a date carried by data | language primitive: the date timer (section 9) | `at e` and `Instant`; an extension leaf extracts the date from a message or a calendar entry | none (polyrun already takes `fireAt`) |
| G5 no identity across mailboxes | language primitive: the identity key (section 10) | `identity` and `identified by`; the Message-ID extension computes `MessageId` and `ThreadRoot` | the raw message kept for leaves by the Gmail source (see G7) |
| G6 SES has no source | extension: `x.sesmail` (section 13) | a source extension over S3, its items owned by the principal `poly.json` names for the key, so SES mail carries its account's taint | S453: the `aws_sigv4` credential kind, with signing in poly-io; the S3 profile is the extension's (D11), and the owner is named in `poly.json` (D12) |
| G7 the Gmail source drops the list headers | extension: `x.mailheaders` (section 13) | a pure leaf over the raw message, its finite output listed as a declassification point | the std Gmail source keeps the raw message as an item's `raw` form, readable only by leaves |
| G8 the Gmail source reads the inbox only | out of scope (std) | a `labels { INBOX, SENT }` item in the Gmail source. Gmail is a source poly ships, so the fix is in poly-io, not an extension. | none |
| G9 the Google profile has no Calendar | extension: a Calendar source | `x.gcalendar`, a source extension whose items are events and whose leaf gives each an `Instant` | none: the extension carries its Calendar profile in its grant (D11), base `https://www.googleapis.com/calendar/v3/`, scope `calendar.readonly` |
| G10 the forecast has no world | out of scope | worlds stay deferred (PT1.1b, appendix A, AD-6) | none |
| G11 a first sync is one page | out of scope (std) | a `backfill <duration>` item in the Gmail source, which pages the listing as polylife's wrapper does | none |
| G12 a re-armed timer is a finding | out of scope (a rule) | `PL4002` stays. The date timer eases it: the re-arm stores the new time (section 9.4). | none |
| G13 the claims shape is fixed | out of scope | a claims profile for the person-key verifier (S107) is a change to the verifier, not code a program supplies | none |
| G14 close leaves the gate store open | out of scope (a defect) | `PolyRuntime.close()` should close the gate's session store. A runtime fix. | none |

Three gaps become extensions (G6, G7, G9), two become language primitives with a leaf (G4, G5), one is the import itself (G2), one is an extension with a small route change (G3), and seven are out of scope: two defects (G1, G14), two std adapter options (G8, G11), one rule (G12), worlds (G10) and the verifier (G13).

## 13. The first three extensions

### 13.1 `@cognitive-fab/poly-x-sesmail` (G6)

- **What it reads.** The S3 bucket SES writes received mail to, by `ListObjectsV2` and `GetObject` only, as polylife's `s3Bucket` does today.
- **Leaves.** `sync(cursor) -> { cursor, more }` lists the objects after the cursor; `retrieve` and `resolve` give items and their raw RFC 5322 bytes; `raw` is `resolve`; `forget` is pure (a forget uses no grant, PS17.7) and clears nothing the bucket holds, which is not poly's to erase.
- **Grant.** `aws_sigv4`, service `s3`, scopes `s3:ListBucket` and `s3:GetObject`, class `none`, so only `GET` and `HEAD` pass the port.
- **Taint.** The source is `owned`, and every item is owned by the principal `poly.json` names for the key (D12, section 5.4): the support account, in polylife. polylife's SES mail then carries that account's taint, and a decision over it is held to the flow rule like Gmail mail.
- **Its module.** A machine `x.sesmail.Cursor` whose invariant is that the cursor only moves forward, so a sync that would re-announce old objects is a finding of the extension, not a silent duplicate.
- **IMAP.** An IMAP variant (`x.imapmail`) needs a capability that is a session, not a request: the runtime would have to hold a TLS stream to class `none`, which means parsing IMAP commands in poly-io to refuse `STORE`, `COPY`, `MOVE`, `EXPUNGE`, `APPEND` and a `FETCH` that sets `\Seen`. It is listed for a later release and is not one of the first three.

### 13.2 `@cognitive-fab/poly-x-mailheaders` (G7)

- **Leaf.** `parse(m: Items one raw) -> Headers`, pure: `listed` (a `List-Id` is present), `unsubscribe` (a `List-Unsubscribe` is present), `precedence`, `auto` (`Auto-Submitted`), and `list`, the List-Id's identifier as a `Key`.
- **What changes in polylife.** The host's header index (`host/mailbox.mjs`, `onHeaders`) goes. The `Message` machine calls `parse` and a rule reads its answer, so bulk mail is placed by its headers inside the checked program, and the decision that places it lists its bits in the certificate.

### 13.3 `@cognitive-fab/poly-x-messageid` (G5)

- **Leaves.** `of` and `root`, pure, as in 10.1, each with the fallback of D13 for a message with no Message-ID.
- **Identities.** `MessageId` and `ThreadRoot`, for de-duplication only (D13).
- **What changes in polylife.** The host's Message-ID index (`host/index.mjs`) goes. `Message` is identified by `MessageId` and `Fact` by `ThreadRoot`, so "one message in two mailboxes counts once" is the runtime's naming, and "a reminder through another mailbox confirms a fact" is a second arrival at one `Fact`, which its handler decides.

## 14. What it touches

- **Specifications.** PS1 (`Instant`, PS4.1i), PS2.2 (`at`), PS15.5 (timers by instant), PS17 (leaf outputs, extension sources, identities), PS23 (leaf classes, the `permanent` check), PS10 (K19 to K21); PT1.3 (`x.*` modules, qualified names), PT2 (grammar), PT6.3, PT10i and PT10j, PT12 (the new codes, the certificate), PT14 (`poly extension pack`, `pin`), PT15 (`rt.dispatchItem`, the host API for identified machines), PT17 (layout), PT33; the architecture's scope table (2a) and a decision AD-16 for extensions.
- **Packages.** `poly-lang` and `poly-core` (grammar, types, the import), `poly-lower` (the call entry, `fireAt`, the source descriptor), `poly-ref` (the read-backs, `Instant`'s ordered representatives, identity naming), `poly-check` (admission, the lint, the corpus replay, the pin command), `poly-runtime` (the worker host and bootstrap, the port, the type check of outputs, identity dispatch), `poly-io` (SigV4, the `aws_sigv4` vault entry, the raw form of a Gmail item).
- **Scripts and tests.** `scripts/check-boundaries.mjs` (rule 8), `test/toolchain-faults.mjs` (seven variants of section 4.4 and `profile-base-widened` of section 3.3), `test/tv.test.mjs`, a sandbox test over the escape corpus, the evidence scripts unchanged.
- **Engines.** None. polyrun's `fireAt` already exists.
- **Not touched.** Every existing program: one that imports no extension and writes no `at` or `identity` lowers to the same artefacts.

## 15. Open questions

### 15.1 Decided (the owner, 2026-10-31)

The first draft listed eight open questions. Six are decided, and one decision was added:

| Question in the first draft | Decision | Applied in |
|---|---|---|
| 1. The ruling for rule 8 | Granted, on the six conditions of section 7 (D8) | section 7 |
| 2. A person's record for a pin | A pin carries a signed record from `poly admit` (D9) | 11.2, 11.3 |
| 3. Node versions | Node 22.15 or later is required (D10) | 6.3 |
| 4. Provider profiles in an extension | Allowed, declared in the manifest's grants (D11) | 3.2, 3.3, 4.3, section 7, G9 |
| 5. The owner of SES mail | The principal `poly.json` names for the static key (D12) | 4.3, 5.4, 13.1 |
| 6. Identity strength | De-duplication only, never authority; a hash of sender, date and subject when the Message-ID is missing (D13) | 10.1 to 10.3, 13.3 |
| (added) Authorship beyond Cognitive Fab | Requires WebAssembly isolation (D14) | 6.6, 11.2 |

### 15.2 Still open

1. **Instants in payloads.** Whether an `Instant` may leave in an effect's payload (a calendar write), and whether S458's cut-point reduction should extend to instants compared with each other.
2. **Recycling.** How many calls a worker serves before it is recycled, and whether a pure leaf should get a fresh worker per call when it computes an identity, at the cost of start time.
3. **The S-number of D8.** The ruling is granted; its number is assigned when it is entered in the decisions log, and rule 8 of the boundary script cites it.
4. **Parameters in an extension's profile.** D11 allows a profile; whether a base parameter (`{bucket}`, `{region}`) should be limited to declared values in the manifest, or any DNS label the program's credential gives, as section 3.3 proposes.

## 16. Left out on purpose

- **Leaves in expressions.** A leaf is called only as an effect (4.3). A handler stays a function poly-ref can interpret.
- **Free code by others.** D7. The format may change before it opens, and it opens only with WebAssembly isolation (D14).
- **Leaves that call a model.** A model is reached through a decision and a route, under PS18's prices and budgets. A grant cannot name a model provider (section 7).
- **npm dependencies of an extension.** An extension is self-contained, so its digest is its whole code. A later release may allow pinned dependencies under the same digest.
- **Routes, budgets and policies in an extension's module.** G1 first; and a policy governs the program, so a person signs it in the program's project (S194), never in a package.
- **IMAP in the first release.** 13.1.
- **WebAssembly leaves.** The contract allows them later (6.6). They are the precondition for other authors (D14), not part of the first release.
- **A leaf as the clock.** D6: a leaf extracts a date; the language fires the timer.

## Conclusion

An extension is a pinned package of three parts: a poly module the checker reads, a manifest the runtime reads, and leaves no one reads, run in a worker that can reach the world only through one capability. The checker treats a leaf as an unknown function within its declared type, so its verdict does not depend on the leaf's code, and the runtime makes that true by checking every output before delivery. The runtime stamps every taint, so mail an extension reads carries its account's taint, which closes the leak polylife works around. A leaf is called only as an effect, so handlers stay pure and translation validation is unchanged. A write by a leaf falls under PS23 as any effect does, and the runtime can refuse a leaf's false claim of a definite refusal, which it cannot do for a host handler.

Two primitives stay in the language. `at` fires a timer at a date carried by data, with no engine change, since polyrun already accepts an absolute fire time, and it puts due dates inside liveness properties. `identity` names instances by a key a pinned leaf computes once, so the runtime, not the host, decides that one message in two mailboxes is one. That key de-duplicates and never grants anything, and a message with no Message-ID gets a hash of its sender, date and subject.

Of polylife's fourteen gaps, three become extensions, two become primitives with a leaf, one is the import, one is a leaf tier, and seven stay out of scope. The weakest part is the worker: a deny list over a full runtime in the runtime's own process. The owner granted the boundary ruling for it on the six conditions of section 7, for Cognitive Fab's own extensions, and made WebAssembly isolation the condition for any other author. Six of the first draft's open questions are decided (section 15.1), and four smaller ones remain.

## Glossary

- **Capability leaf:** a leaf handed exactly one capability, a connection the runtime opened under a grant the program bound.
- **Date timer:** `at e -> A() as k`, a timer that fires at the `Instant` `e`, lowered to polyrun's `fireAt`.
- **Declassification point:** a place where information about tainted data leaves without a taint: a count (S325), a finite answer (S323), a leaf's finite or key output.
- **Escape corpus:** the list of known ways out of a worker that the sandbox test runs, each of which must be refused.
- **Extension:** an npm package of a poly module, a manifest and leaves, pinned by digest and published by Cognitive Fab.
- **Grant (in an extension):** a credential kind and scopes a capability leaf requests; the program binds it to one of its own credentials.
- **Identity key:** a `Key` computed by a pinned pure leaf from an item, comparable across sources, which can name a machine's instances.
- **`Instant`:** an opaque point in time, compared by equality and order only, explored by ordered representatives.
- **Leaf:** a JavaScript function of an extension with declared input and output types, called only as an effect or by the runtime's source machinery.
- **Manifest:** `poly-extension.json`, generated from the extension's module and read back against it; what the runtime reads.
- **Pin:** an extension's digest in `poly.json`, with the record `poly admit` signs for it.
- **Fallback identity:** the hash of a message's sender, date and subject, its identity when it has no Message-ID.
- **Provider profile (in an extension):** the provider name, base addresses and scopes an extension's grant carries, reachable only by that extension's leaves.
- **Port:** the `MessagePort` over which a capability leaf asks the runtime to make a request; the worker holds no socket and no secret.
- **Pure leaf:** a leaf with no capability, class `none`.
- **Verified copy:** the extension's files written under `.poly/build/extensions/` at admission, the only files the loader reads.
