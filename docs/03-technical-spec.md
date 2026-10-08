# poly · Technical specification

*Cognitive Fab · September 2026 · draft v0.6 · specification only, no code*

The meaning of every construct is defined in [`04-semantics.md`](04-semantics.md) (`PS` ids); this document fixes syntax, formats and engineering. v0.2 to v0.6 answer the five reviews in [`reviews/`](reviews/), with a response to each.

This document fixes the grammar, the semantics and the formats. It covers the lowering of each construct to the Poly stack artefacts, the integration of the gate with the kernel, the diagnostics, the command surface, the implementation plan and the first experiment.

- Functional requirements are cited as `PF`.
- Architectural principles and decisions are cited as `PA` and `AD`.
- Engine formats are quoted from [`research/primitive-inventory.md`](research/primitive-inventory.md).

## PT1. Source files and modules

- **PT1.1** A module is a file with the extension `.poly`. It starts with `module <name>` and holds `enum`, `machine` and `workflow` declarations.
- **PT1.1a** By convention a policy lives in a `.policy.poly` file, because policies are read by different people. The convention is for readers. The two logics are separated by type (PS8.0), not by file.
- **PT1.1b** Worlds are deferred to v2 (appendix A).
- **PT1.2** A project is a directory with a `poly.json` manifest:

  ```json
  { "poly": "1", "name": "orders", "modules": ["src/*.poly"],
    "host": "typescript", "require": { "grade": false },
    "handlers": ["handlers/**/*.ts"],
    "engines": { "polygraph": "^8.3", "polyaxion": "^2" } }
  ```

  `people` and `agents` are the keyrings of PT12.5, each a list of `{ name, keyId, publicKey }` with the public key as PEM or `file:PATH`; admission certifies both (S150). Each key is parsed and its SPKI export is what is certified; text holding a private key is refused, and one key listed under two ids, in one ring or across both, is refused (review A3, A4). The keyring anchor of PT12.5 is never named here: the owner's per-user configuration names it (S194). `keys.admission` names the key `poly admit` signs with, by id and location, never by value: `{ "id": "ops-2026", "location": "env:POLY_ADMISSION_KEY" }` or `"file:/path/outside/the/repository.pem"`. A key file inside a version-controlled tree is refused (S126). `handlers` names the effect handler modules that `poly lint handlers` reads (PT6.5, S72), and that the certificate binds with the files they import (PT15, S142). `modules` may name `.poly` and `.ts` files; a `.ts` module is read by `poly-embed` (PT2.5, S71).

  `run` configures `poly run --mcp` (S188, S189, M8a), with its schema published at `schemas/manifest/run.json`; an unknown field under it is refused:

  ```json
  "run": { "certificate": ".poly/certificate.json", "store": ".poly/run/store.sqlite",
           "trust": { "ops-2026": "file:keys/admission.pub.pem" },
           "ledger": { "keyId": "ops-ledger", "signer": "file:/path/outside/the/project.pem" },
           "approvals": "approvals" }
  ```

  `trust` maps each admission key id to its public key, `file:` only; a private key there is refused at load. `ledger` is optional; its signer is `file:` only, never `env:` and never a value, and a signer whose path resolves inside the project (through links and 8.3 short names) is refused at load, since a key in the tree is one `git add` from being committed. The signer's path may appear in an error; its contents never appear in output, logs or the journal. `approvals` is the drop folder for people's signed approvals, outside `.poly/` by default, so cleaning build output never deletes a pending approval; an entry that is not a regular file or cannot be read is refused `not-a-record` and journaled like any bad record, and the pass goes on (M8a review A-F2). One process owns a store at a time, named by its one real path (a store file with a second name, a hard link, is refused): an exclusive OS lock on `<store>.lock.db` decides, held for the owner's life and released when its process ends; the lock file beside the store only records the owner's process id and start time, and a stale one is taken over, with the takeover journaled on the runtime's own `runtime:store` run. The store must be on a local disk, since OS file locks are unreliable on network shares.

- **PT1.3** Imports are by module name within a project: `use payments.Payment`. Cross-project imports are out of scope for v1 (open question 4 in the architecture).

  **As built (M8a, S176, PS1.0).** `use m` makes the machines of module `m` nameable as `m.M`; `use m.M` makes `m.M` nameable and no other machine of `m`, and two `use` clauses admit both (as ruled; review B-F6). A machine of `m` still names `m`'s other machines in `m`'s own source. There is no unqualified alias. A qualified name of a module that is not used is `PL1001`; a module that uses itself is `PL1201`. A used module is found among the project's modules, or, for a file checked outside a project, among the `.poly` files of its directory, read only when their header names a module `use` asks for, so an unrelated file changes nothing; `std.*` is found under the repository's `std/`. Two files that declare one used module refuse the check (`PL1002`, naming both); cycles are allowed. Another module's machine may appear in `Ref<m.M>`, in `spawn detached m.M`, in a send to such an address, and as a configuration's instance `x: m.M`, whose detached instances form the group `m.M`. An attached spawn of another module's machine stays `PL0901`. A message across modules carries values whose types need no module (booleans, ranges, `int`, checked strings, `Principal`, addresses) and, since S190, the payload-free enums of the receiver's module. Each module is still checked, lowered and reported on its own; a configuration reads a used module's machine with that module's own types.

  **As built (S190, PS1.0).** A payload-free enum of a used module is the type `m.E` (the module may be dotted), in fields, parameters, effect payloads and message arguments, with the same check domains. `use m` admits its enums and `use m.E` that one alone, as for machines (`PL1001` otherwise). A member is `m.E.C`; a bare member stands only where the expected type fixes the enum, and one that could name a member of more than one admitted enum is `PL1005`. Two enums of different modules are different types whatever their members (`PL1201`). `==`, `!=` and `match` (covering every member, `PL1501`) work on them, in configuration properties too, where a field of another module's machine has its enum spelled `m.E`. A record, a union with payloads or a map of another module's types is `PL0901`, and so is `use m.T` naming one. Each lowered `contract.json` records, under `typeModules`, the AST digest of each module whose enums the machine uses; the certificate records the same modules under `poly.typeModules`, with the path of each module's file, relative to the project root or written `std:<path>` under the std root and never absolute, and the SHA-256 of its bytes, which alone decides at load. Load refuses a file that changed since the build, or a contract whose digest is not the certificate's: `PL6407 TYPE_MODULE_CHANGED`. Translation validation reads the enum's members from the declaring module's source, and the broken lowering `foreign-enum-member` (a member dropped from a parameter's domain) is in the explicit list of toolchain faults.
- **PT1.4** The canonical formatter defines one text per AST. The module digest is the SHA-256 of the RFC 8785 canonical JSON of the AST. This is the same canonicalisation the polyflow platform kernel uses. The digest becomes the `machineVersion` of each machine it contains.
- **PT1.4a** Comments and blank lines are trivia. They are kept by the formatter but are not part of the AST, so they do not change the digest. Two sources with the same AST have the same digest, whatever their comments.
- **PT1.5** Build output goes to `.poly/build/<machine>/`, one directory per machine, in the layout the engines already read (PT17). The directory name `<module>.<Machine>` is also the machine's `machineId` in every engine artefact that names a machine, such as polyrun's configuration and `spawnChild` intents (S28).

## PT2. Grammar

The core grammar in EBNF. Terminals are quoted. `Expr` is the expression sublanguage of PT2.2.

```ebnf
Module      = "module" Ident { Decl } ;
Decl        = [ "service" ] Machine | Workflow | Enum | TypeDecl | Policy | Configuration | Use ;
TypeDecl    = "type" Ident "=" ( [ "|" ] Ctor { "|" Ctor } | Record ) ;
Record      = "{" Ident ":" Type { "," Ident ":" Type } "}" ;
Ctor        = Ident [ "{" Ident ":" Type { "," Ident ":" Type } "}" ] ;
Use         = "use" QualIdent ;
Enum        = "enum" Ident "{" Ident { "," Ident } "}" ;

Machine     = "machine" Ident "{" [ Version ] StateBlock { MachineItem } "}" ;
Version     = "version" Int [ "from" Int Migrate ] ;
Migrate     = "{" "migrate" "{" { "new" "." Ident "=" Expr } "}" "}" ;
StateBlock  = "state" "{" { Field } "}" ;
Field       = Ident ":" Type [ Check ] "=" Expr [ "internal" | "derived" ] ;
Check       = "check" Domain [ "strict" | "disclosed" ] ;
MachineItem = Terminal | Action | Handler | Guard | Property | Never | Effect | Decision ;
Never       = "never" Ident ":" "emit" Ident [ "(" Ident ":" Expr { "," Ident ":" Expr } ")" ] [ "while" Expr ] ;   (* PS5.2a, S178 *)
Terminal    = "terminal" Expr ;
Action      = "action" Ident "(" [ Param { "," Param } ] ")" ;
Param       = Ident ":" Type [ Check ] ;
Handler     = "on" Ident [ "(" Ident { "," Ident } ")" ] Block ;
Guard       = "guard" "all" "when" Expr "reject" String ;
Block       = "{" { Stmt } "}" ;
Stmt        = "require" Expr "else" "reject" String
            | "reject" String
            | "let" Ident "=" Expr
            | Ident "'" "=" Expr
            | Ident "'" "=" Ident "with" "[" Expr "]" "=" Expr
            | "if" Expr Block [ "else" Block ]
            | "match" Expr "{" Arm { Arm } "}"
            | "emit" Ident "(" [ Args ] ")"
            | "after" Duration "->" Ident "(" [ Args ] ")" "as" Key
            | "cancel" Key
            | "spawn" [ "detached" ] QualIdent "as" Key [ "->" Ident "(" [ Args ] ")" ] [ ChildWiring ]
            | "send" Expr "<-" Ident "(" [ Args ] ")" [ "as" Ident ]
            | "signal" Key "->" Ident "(" [ Args ] ")"
            | "for" Ident "in" Int ".." Expr Block
            | "decide" Ident "(" [ Args ] ")"
            | "adjudicate" Ident "as" ( "Correct" | "Wrong" ) ;   (* PD2.4, S129 *)
Key         = Ident [ "[" Expr "]" ] ;
ChildWiring = "on" "complete" "->" Ident [ "on" "parent" "terminal" "->" Ident ] ;
Arm         = Pattern "=>" ( Block | Stmt ) ;
Pattern     = "_" | CtorName [ "{" Ident ":" ( Literal | Ident | "_" ) { "," Ident ":" ( Literal | Ident | "_" ) } "}" ] ;
CtorName    = Ident [ "." Ident ] ;
Property    = "invariant" Ident ":" Expr
            | "step" "property" Ident ":" Expr
            | "reject" "property" Ident ":" Expr
            | "path" "property" Ident ":" Expr
            | "compose" "invariant" Ident ":" Expr
            | "liveness" Ident ":" [ ( "forall" | "exists" ) Ident "in" Ident ":" ]
              ( "eventually" Expr | Expr "leads" "to" Expr )
              [ "under" "fair" "{" Group { "," Group } "}" ] ;
Group       = Fair { "|" Fair } ;
Fair        = ( Ident | InputRef ) [ "(" "*" ")" ] ;   (* InputRef in a configuration, S73 *)
Effect      = "effect" Ident "(" [ Param { "," Param } ] ")" "{" { EffectItem } "}" ;
EffectItem  = "kind" String | "labels" "{" Label { "," Label } "}" | "class" Class
            | "retry" "{" "attempts" Int "," "base" Duration "," "timeout" Duration "}"
            | ( "ok" [ "(" Ident ")" ] | "failed" | "exhausted" ) "->" Ident "(" [ Args ] ")" ;   (* ok(r), PD1.2g, S79 *)
Decision    = "decision" Ident "(" [ Param { "," Param } ] ")" "->" Type "{" { DecisionItem } "}" ;
DecisionItem = "provider" String | "labels" "{" Label { "," Label } "}" | "timeout" Duration
            | "band" Decimal ".." Decimal | ( "ok" "(" Ident ")" | "failed" ) "->" Ident "(" [ Args ] ")" ;
Decimal     = Int "." Digit [ Digit [ Digit ] ] ;   (* only where a Conf is expected, S76 *)
Class       = "none" | "reversible" | "compensable" | "irreversible" ;
Type        = "bool" | "int" | "string" | Ident | Int ".." Int
            | "map" "<" ( Ident | Int ".." Int ) "," Type ">" | "Ref" "<" QualIdent ">" | "Conf" ;
Configuration = "configuration" Ident "{" { Instance | Inputs | Bounds | Property } "}" ;
Instance    = Ident [ "[" Int "]" ] ":" QualIdent [ "{" Ident ":" Expr { "," Ident ":" Expr } "}" ] [ "scope" String ] ;   (* PS8.7, S160 *)
Inputs      = "inputs" "{" InputRef { "," InputRef } "}" ;
InputRef    = Ident [ "[" ( Int | "*" ) "]" ] "." Ident ;
Bounds      = "bounds" "{" "transit" Int [ "," "instances" Int ] "}" ;   (* required, S62 *)
Domain      = "{" Literal { "," Literal } "}" | Int ".." Int ;
```

The `Policy` production is in PT8, in its own file type. The `Workflow` production is in PT10.

- **PT2.1** Keywords are **contextual**: a keyword is reserved only in the grammar positions that use it, and anywhere an identifier is expected it is an ordinary identifier. So a field may be named `state`, `derived`, `internal`, `terminal` or `type`. The parser decides with at most two tokens of lookahead: after a field's initial expression, `derived` or `internal` followed by `:` begins the next field, and otherwise it is the modifier. Field and action names lower verbatim into `contract.json`, traces and diagnostics, so a corpus's own names are kept. There is no second, external name for a field. Identifiers follow TypeScript identifier rules. Rejection reasons and effect kinds are string literals, so agents can reuse the names already present in a system.
- **PT2.2** The expression sublanguage (AD-2) is a total, side-effect-free subset of TypeScript expressions:
  - literals, field and parameter names, `pre.` and `post.` (in step properties), enum members;
  - **name resolution (S19).** A bare name resolves to the innermost binding: a local (`let` or a pattern binder), then a parameter, then a field, as in TypeScript. `pre.f` always names the pre-state field `f`, in handlers as in properties, so a field hidden by a parameter of the same name stays readable. Parameters are visible only where the action is known: in a handler, and in a guard, step property or reject property only where `action == A` narrows it (PT5). With no narrowing, no parameter is in scope and a bare name is the field;
  - `== != < <= > >= && || !`, `+ - *`, and integer `/` and `%`. Division truncates toward zero, and `%` takes the sign of the dividend, as in TypeScript with the quotient truncated (`Math.trunc(a / b)`). A divisor whose static range contains 0 is `PL1204 DIVISION_BY_ZERO`, so division is total;
  - `implies`;
  - `emits(k, f: v, …)` (in step properties, PS5.2, S178): true iff the step emits effect `k` with those payload values. `k` is an effect's name, never a send, a timer or a spawn (`PL1001`); each `f` is a payload field of `k` (`PL1001`) and each `v` a constant of its type, an enum constructor, an integer, a boolean or `none` (`PL1201`);
  - `count(kind)` and `before(k1, k2)` (in path properties). Their arguments are effect kinds, string literals. `before("k1", "k2")` holds on a path iff every emission of `k2` is preceded by an emission of `k1` (S37);
  - `in { … }`;
  - in configuration properties only: `forall i in g: …`, `exists i in g: …`, the aggregates `count`, `sum`, `all` and `any` over `g[*]`, and `init(e)` for the initial value of `e` (PS13.6). The same quantifiers and aggregates range over a child family `f` in a compose invariant (S49);
  - map indexing `m[k]`, where `k` is a value of the map's key type;
  - map literals `{ k1: v1, …, kn: vn }`, which must list every key of the map's key type exactly once (`PL1502 INCOMPLETE_MAP_LITERAL`), and, for maps keyed by an integer range, the array literal `[v0, v1, …, vn]`; map update is the statement form `m' = m with [k] = v`, which writes one entry and leaves the others unchanged.

  It has no loops, no calls to host functions and no string operations beyond equality and membership. Every expression terminates by construction. Precedence and associativity are fixed in PS12; the formatter parenthesises any mix of `implies` with `&&` or `||`.
  Primed fields are write-only: an expression never reads `f'` (PS2.3), and a field written twice on one path is `PL2102 DOUBLE_WRITE` (PS2.4).
- **PT2.3** Policies use PX, Polyaxion's three-valued (Kleene) language. The two logics are separated by **type**, not by syntax (PS8.0):
  - machine expressions have type `Bool`; policy inputs are optional, so policy expressions have type `Tri`;
  - one operator set (`==`, `!=`, `&&`, `||`, `!`, `in`) serves both, with its meaning given by the operand types;
  - `unknown(x)` has type `Bool` and is legal anywhere an optional value is in scope;
  - a `Tri` where a `Bool` is expected is `PL1203 TRI_WHERE_BOOL_EXPECTED`.

  This follows the pattern of an option type, which agents know from TypeScript's `boolean | undefined`.
- **PT2.4** `e is C` tests a union value's constructor and has type `Bool`; `e is C1 | C2` is short for `e is C1 || e is C2`. `C { q: e }` constructs a union value. `match` is exhaustive (`PL1501 NON_EXHAUSTIVE_MATCH`). Enums are unions without payloads, so `==` and `is` agree on them.
  - **Names in patterns (S21).** In a payload pattern `C { q: x }`, the name `x` is read by these rules, in order: (1) a constructor of the payload's type is a literal pattern; (2) a constructor of another type in scope is `PL1201 TYPE_MISMATCH`, not a binder; (3) any other name binds the payload value. A binder that shadows a constructor in scope is an error (`PL1002`). A binder its arm never reads is `PL1504 UNUSED_BINDER`: write `_` to ignore a payload. An arm that the arms before it always cover is `PL1503 UNREACHABLE_ARM`. So a misspelled constructor cannot become a silent catch-all.
  - **Constructors shared by two types (S22).** A constructor name resolves against the expected type. In `a == b` (and `!=`), each side is typed first, and an ambiguous constructor on either side takes the other side's type, so `Open == s` and `s == Open` mean the same. The qualified form `Type.C` is always legal, in expressions and in patterns. A constructor still ambiguous after that is `PL1005 AMBIGUOUS_CONSTRUCTOR`, whose fix is the qualified form.
  - **Constructors and blocks.** In the condition of an `if` and the scrutinee of a `match`, an identifier followed by `{` is never read as a constructor: the `{` opens the block. Parentheses restore a constructor there, as in `if intent == (Proposed { decision: 1 }) { … }`. This is the rule Rust uses for the same ambiguity.
- **PT2.4c** **Claims at run time (PD5.1.2c, S155).** The claims travel with the action's data under the reserved key `$claims`, which no program may name and no outside dispatch may supply (`PL1208`). The lowered module's first acceptor applies PS3.2's claims row: claims missing, malformed, with a field outside its domain or with a field too many give `rejected("claims-unverified")`, before any guard. In check, a principal ranges over the representatives `p1` … `pn` of PS4.1c, which the contract's `dataDomain` lists; translation validation compares the row on missing, malformed and out-of-domain claims in every reachable state, and the deliberately broken lowering `skip-claims` leaves it out. At run time the host gives a verifier adapter at load (`load(…, { verifier })`, PD5.1.4): `rt.dispatch(id, A, d, { credentials })` asks it for the caller's claims, and an adapter that refuses or throws gives none, so the step is `rejected("claims-unverified")`, journaled, the state unchanged (PD5-A1, outage O10). poly checks the adapter's output against the type, never its cryptography (K11). Without one, the runtime uses the person-key adapter over the certified keyrings (S107): its credentials are a signed record of kind `invocation` whose subject is the digest of the one dispatch (instance, action, data, action id), and its output is `{ kind: Person, attest: Verified, assurance: 3, principal: <key owner> }`; an agent key, an unknown key or a record for another dispatch gives none (PD5-A8). PD4.2a is this adapter: `Declare` is written `by op: Caller` and requires a verified person (PD4-A3).
- **PT2.4d** **Lineage at run time (PD5.2, S105, S155).** The runtime writes each step's lineage in its transaction, beside the journal row: its origin, its intent and the digest of the previous hop, where a hop's digest binds the run, the seq, the origin, the intent and the hop before it. An outside dispatch starts a chain: its origin is its claims (or none), its intent its own machine and action. A step started by an effect's completion, by a fired timer or by a delivered message inherits the lineage of the step that caused it, found by the completion's, timer's or message's id, and appends one hop; an outside dispatch never inherits, whatever its action id. Lineage is runtime metadata, like ids and `seq`: the module never reads it, and the step event records its digest. A cross-scope message whose sending step's chain is missing or does not recompute is denied before the gate sees it, and `SendDenied(to, action, "lineage")` reaches the sender (PD5.2.2b). M5b limit: a child created in a cascade starts its own chain. **In check (S105).** Lineage is its origin class: a configuration's input with claims starts a chain whose class is its claims and its intent, `module.Machine.Action`; each message the step sends, each child it creates and each `SendDenied` the gate returns carries that class, and a delivered message's step inherits it. No hop is kept, so the global state stays finite: a message carries its class, and two messages that differ only in class are two (PD5-A5). A chain that starts with no claims has no class, so a program without claims is explored exactly as before. M5b limit: a completion or a timer given as a configuration's declared input (S61) is explored as an input, so a send from its step carries no class, where at run time it inherits one; no verdict reads the class, so only the counts differ (review C5).
- **PT2.4e** **Revocation (PD5.3, S106, M5b).** A security signal is an action on a mode machine, `security.Trust` in `conformance/m5/trust.poly`: `CredentialRevoked` and `AttestationFailed` take it to `Halted`, and only `Restore() by op: Caller` from a verified person at assurance 3 takes it back (PD5.3.3c, through the person-key adapter, PD5-A8). The halt is checked three ways. A policy's `never` statement that no compensable or irreversible effect is allowed while `machine("security.Trust").level == Halted` is proved over the decision table, and is a finding with a witness without the halt rule (PD5-A6, S149). The possibility property is the consistency stage per mode: a mandate whose only way to finish needs an irreversible effect is `PL6501` naming `Halted` (PD5-A7, PD4.4b). And no allow outlives the halt: an intent allowed before the revocation is rechecked when its handler would start, since the `Trust` singleton it read has moved, and the halt rule denies it (S147, PD5-A12).
- **PT2.4f** **Evidence beside claims (PD6, PS8.8, PS8.9, M9).** A verifier adapter may return its claims with evidence beside them, `withEvidence(claims, { verifiedAt?, statusAt?, mandates? })` (`@poly/runtime`): the times in milliseconds by the runtime's clock, and the mandate chain, outermost first, each `{ id, delegator, delegate, scope: { actions?, values?, max? }, expires }`. The evidence never enters `$claims`, whose type is the program's: the runtime keeps it with the step (`poly_evidence`), binds its digest into the step's ledger event as `evidence`, and `poly journal verify` checks the binding. A chain that widens, or holds a mandate revoked with `rt.revokeMandate(id)`, is refused before any step (`mandate-widened`, `mandate-revoked`, with an audit row). The gate reads `step.age`, `step.statusAge` and `step.mandate` from the evidence at the decision, and the worker denies `outside-mandate` before any policy when the innermost mandate does not cover the effect's kind, its payload or the decision time. A policy writes the ages as `age(step.claims)` and `statusAge(step.claims)`, in milliseconds. A rule over an age has severity `deny` (`PL1201` otherwise), and the gate reports its denial as `stale-claims`; the runtime never refreshes claims, and the host dispatches the action again with a fresh presentation (PS8.8, as ruled).
- **PT2.4b** **Claims (PD5.1.2, M5b).** `on A(x) by c: C { … }` names the claims type `C` the action requires and binds its value to `c` in the handler, as a parameter is bound. `C` must be a claims type (`PL1201` otherwise). The claims are part of the step's label (PS3.2, S101). On the embedded surface it is `on("A", ($) => […], ["x"], { by: ["c", "C"] })`, and a claims type is `claims("C", { … })`.
- **PT2.4a** **Handler parameters.** In `on A(x, y) { … }` the parameter list is optional. When present, it must repeat the action's declared parameter names in declaration order, otherwise it is `PL1201 TYPE_MISMATCH`. It neither renames nor selects parameters. The action's parameters are in scope in the body whether or not the list is written.

- **PT2.5** **The embedded surface.** poly also has a surface embedded in TypeScript. It is valid TypeScript, type-checked by `tsc` against the combinators' declarations, and it produces **the same AST** as the standalone syntax, so the same AST digest (PT1.4). Every AST node has exactly one embedded form, and the mapping is syntactic: `poly-embed` never infers a type to decide which node a form is (S71).

  ```ts
  import { module, enumType, machine, field, t, action, on, require, set, emit, effect, labels, cls, pathProperty, count } from '@cognitive-fab/poly/embed'

  export default module('orders', [
    enumType('Status', ['Draft', 'Placed', 'Paid', 'Shipped', 'Cancelled']),
    machine('Order', {
      state: { status: field(t.named('Status'), ($) => $.Draft), items: field(t.range(0, 3), () => 0) },
      items: [
        action('Place', {}),
        action('Pay', { amount: t.int.check([10, 20]) }),
        on('Place', ($) => [require($.status === $.Draft, 'not-draft'), require($.items > 0, 'empty-order'), set('status', $.Placed)]),
        on('Pay', ($) => [require($.status === $.Placed, 'not-placed'), emit('charge', { amount: $.amount })]),
        effect('charge', { amount: t.int }, [labels(['egress:external']), cls('irreversible')]),
        pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
      ],
    }),
  ])
  ```

  | AST node | Embedded form |
  |---|---|
  | module and its declarations, in order | `export default module('m', [decl, …])` |
  | `enum E { A, B }` | `enumType('E', ['A', 'B'])` |
  | `type U = C1 { p: T } \| C2` | `union('U', { C1: { p: T }, C2: {} })` |
  | `type R = { f: T }` | `record('R', { f: T })` |
  | `use a.b` | `use('a.b')` |
  | `[service] machine M { version n  state { … } items }` | `machine('M', { service?: true, version?: n, state: { f: field(T, init, opts?) }, items: [item, …] })` |
  | field `f : T check D mode = e flag` | `f: field(T, ($) => e, { check?: D, mode?: 'strict' \| 'disclosed', flag?: 'internal' \| 'derived' })` |
  | types | `t.bool`, `t.int`, `t.string`, `t.range(lo, hi)`, `t.named('N')`, `t.map(K, V)`, `t.ref('M')`, `t.conf`, `t.int.check([…])` or `.check(lo, hi)` for a parameter's check clause |
  | `action A(p: T)` | `action('A', { p: T })` |
  | `on A [(x, …)] { body }` | `on('A', ($) => [stmt, …], ['x', …]?)`, the list only when written |
  | `guard all when e reject "r"` | `guard(($) => e, 'r')` |
  | `terminal e` | `terminal(($) => e)` |
  | `invariant`, `step property`, `reject property`, `path property`, `compose invariant` | `invariant('n', ($) => e)`, `stepProperty`, `rejectProperty`, `pathProperty`, `composeInvariant` |
  | `liveness n: [forall i in g:] eventually e [under fair {…}]` | `liveness('n', { eventually: ($) => e }, { forall?: ['i', 'g'], fair?: [[member, …], …] })`; `leads to` is `{ from: ($) => p, to: ($) => q }`; a member is `'A'` or `'A(*)'` |
  | `effect k(p: T) { items }` | `effect('k', { p: T }, [kind('…'), labels([…]), cls('…'), retry(n, '200ms', '5s'), ok('A', args), failed('A', args), exhausted('A', args)])` |
  | a name `x` (field, parameter, local, constructor, `none`, `self`, `pre`, `post`, `action`) | `$.x`, a property of the arrow's one parameter |
  | `e.f` | `e.f` on any expression other than `$` itself |
  | `e[k]`, `g[*]` | `e[k]`, `$.g[ALL]` |
  | literals | number, `true`, `false`, a string literal |
  | `==`, `!=`, `&&`, `\|\|`, `!`, `-`, `+`, `*`, `/`, `%`, `<`, `<=`, `>`, `>=` | `===`, `!==`, and the operator itself |
  | `a implies b`, `e is C1 \| C2`, `e in { a, b }` | `implies(a, b)`, `is(e, 'C1', 'C2')`, `isIn(e, [a, b])` |
  | `C { p: e }`, `T.C { p: e }` | `ctor('C', { p: e })`, `ctor('T.C', { p: e })` |
  | `{ k: v, … }` (a map or a record) | an object literal: an identifier key is a name, a numeric key an int, a string key a string, and `[e]: v` any other key; as an operand of an operator it is `lit({ … })`, since tsc refuses `===` with an object literal (S84) |
  | `[v0, …]` | an array literal |
  | `count`, `before`, `rejected`, `init`, `sum`, `all`, `any` | the function of that name |
  | `k spawned`, `f[i] spawned` | `spawned($.k)`, `spawned($.f[i])` |
  | `forall i in g: e`, `exists …` | `forall('i', 'g', ($) => e)`, `exists(…)` |
  | `require e else reject "r"`, `reject "r"`, `let x = e` | `require(e, 'r')`, `reject('r')`, `let_('x', e)` |
  | `f' = e`, `f' = f with [k] = v` | `set('f', e)`, `setEntry('f', k, v)` |
  | `if c { … } [else { … }]` | `when(c, [...], [...]?)`, the second list only when written |
  | `match e { P => body, … }` | `match(e, [arm(P, [...]), …])`; `P` is `'_'` or `pattern('C', { p: bind('x') \| 1 \| 'lit' \| true })` |
  | `for i in lo..n { … }` | `forEach('i', lo, n, [...])` |
  | `emit k(args)` | `emit('k', args)`; args are an array when positional, an object when named |
  | `after d -> A(args) as k[i]`, `cancel k[i]` | `after('d', 'A', args, 'k', i?)`, `cancel('k', i?)` |
  | `spawn [detached] M as k[i] -> A(args) on complete -> P on parent terminal -> C` | `spawn('M', 'k', { index?, detached?, create?: ['A', args], complete?: 'P', parentTerminal?: 'C' })` |
  | `signal k[i] -> A(args)`, `send r <- A(args)` | `signal('k', i \| null, 'A', args)`, `send(r, 'A', args)` |
  | `decision`, `decide` (PD1) | `decision('d', { p: T }, R, [provider('…'), labels([…]), timeout('800ms'), band(lo, hi), okWith('r', 'A', args), failed('A', args)])`, `decide('d', args)` |
  | `adjudicate` (PD2.4, S129) | `adjudicate('d', 'Correct')` or `adjudicate('d', 'Wrong')` |
  | `configuration c { … }` | `configuration('c', { instances: [instance('x', 'M', { count?, init? })], inputs: ['g[*].A', …], bounds: { transit, instances? }, properties: [...] })` |

  - **Front end.** `poly-embed` reads the module with the TypeScript compiler API and accepts only the forms above; inside an arrow, only the PT2.2 subset. Anything else (a loop, a call to anything but a poly combinator, mutation, access beyond the arrow's parameter) is `PL0301 OUTSIDE_EMBEDDED_SUBSET`, with the offending node. The resulting AST goes through the same checks, lowering and translation validation as the standalone syntax.
  - **The printer.** poly also prints any AST in this surface. Parsing a standalone source, printing it as TypeScript and reading that back gives the same AST digest; the test runs over every conformance source, beside hand-written embedded sources, which catch a mapping both directions would get wrong alike (S71).
  - **Projects.** A project's `modules` globs may name `.ts` files, which `poly-embed` reads (S71).
  - **What the embedded surface gives up:** primes (writes are `set`), the canonical formatter (the host formatter applies; the AST digest is unaffected, PT1.4a), and some syntax for properties. It keeps the fixes of PT12.1 (M3-3).
  - **What it gains:** no training-data gap for agents, and the host's type checker, language server and package manager.
  - **Which surface is primary** is decided by the first experiment (PT13, arm 4).

## PT3. Types and check domains

- **PT3.1** The types are:
  - `bool`;
  - enums;
  - integer ranges `a..b`;
  - `int`;
  - `string`;
  - `map<K, T>`, where the key type `K` is an enum or an integer range `0..n`. A map keyed by an enum lowers to a JSON object keyed by constructor name. A map keyed by `0..n` lowers to a JSON array of length `n + 1`. A range key that does not start at 0 is `PL1602 ARRAY_MAP_NOT_ZERO_BASED`. So a corpus field such as `taskStatuses: ["QUEUED", "RUNNING", "FAILED"]` is `map<0..2, Status>`;
  - **tagged unions** `type U = C1 { … } | … | Cn { … }` (PS1.4), finite when their payload fields are. Handlers read a union with `match` or `is` and write it as a whole value. The lowering flattens it to a tag field and nullable payload fields, with an automatic `shape:` invariant (PS9.1b). Below the top of a field (a map's value, a payload, a parameter) it lowers to one JSON object `{ "$": "C", p: v, … }` with exactly its constructor's payloads, each lowered by the same rule; a union with no payload stays its constructor's name (S65). An effect parameter or a `childState` field of such a type is `PL0901`. Constructors of one union may share a payload name only with the same type, and then share one flat field; the same name with two types is `PL1601 PAYLOAD_TYPE_CONFLICT`.
  - **records** `type R = { f1: T1, …, fn: Tn }` (S25): a nominal type whose values have every field and no tag. A record is finite when its fields are; it has no optional fields and may not refer to itself, directly or through other types. It lowers to a plain JSON object and compares field by field. A record literal `{ f1: e1, … }` lists every field (`PL1502`). A literal `{ k: v, … }` is a map or a record according to its expected type, as S22 resolves constructors; with no expected type it is `PL1005`. A record may be used wherever a type may: as a field, a parameter, a payload, or a map value. `r.f` reads field `f` of a record value.
  - **claims types** `claims C { f: T … }` (PD5.1.2, M5b): a record whose fields are enums without payloads, integer ranges or `Principal`; an `int` or `string` field is `PL1101`, a `Tri` field `PL1203`, and any other (a `bool`, a record, a map, a union with payloads, another claims type) `PL1201` (S103). A binder may not be `pre`, `post`, `action`, `self` or `none`. A verifier outside poly asserts a value of it for an action's caller (PD5.1.4).
  - `Principal` (PD5.1.2b, M5b): an opaque identity, or `none`. It is compared for equality with another `Principal`, stored, or passed; any other use (an order, arithmetic, a comparison with a string, a map key) is `PL1206 PRINCIPAL_NOT_OPAQUE` (S109). In check it is explored by representatives (PD5.1.3).
  - `Content` (PS1.4a, PS4.1f, S180, M8a): an opaque reference to a body by its digest, or `none`. It is stored, passed, or compared with `==` and `!=`; any other use (an order, arithmetic, a comparison with a string, a map key, a record or payload field, a check domain) is `PL1209 CONTENT_NOT_OPAQUE`, and so is a digest written in source: the only constant is `none`. In check it is explored by `none` and representatives `c1 … cn`, by PS4.1c's rule applied apart, and the instance prints the count; `ci` is written as the digest `sha256:` followed by `i` in 64 hex digits, so every value of the contract's domain is in the runtime's type (S140). It lowers to the digest string `sha256:<hex>`, typed `content | null` in the contract. At run time a body enters through the runtime's content store (`rt.putContent`, and ingress in M8b); a Content that names no body there is marked by the runtime under the reserved key `$content`, and the module's first acceptor rejects the step `content-missing` (PS3.2): journaled, the state unchanged, whether the data came by dispatch, at creation or as an effect's completion. A decision over a Content is `PL0901` until the channels (M8b).
- **PT3.2** Every field and parameter has a finite check domain (PF1.2). Enums, `bool`, ranges and maps over finite value types are finite by construction. `int` and `string` need an explicit `check` clause. Without one, the compiler reports `PL1101 UNBOUNDED_DOMAIN`.
- **PT3.3** A `check` clause narrower than the runtime type is an assumption. It is written to `dataDomain` and to the certificate's `domains`, and it is graded by `poly grade` (polynv).
- **PT3.4** Each `check` clause has a mode, and the mode decides what the runtime does with a value outside the check domain:

  | Mode | Runtime behaviour | Certificate |
  |---|---|---|
  | `strict` | `dispatch` rejects the action with the reason `outside-check-domain` before the handler runs. | The checked domain is the running domain. |
  | `disclosed` | The action is accepted and journaled with the flag `outsideCheckDomain`. `poly export traces` surfaces these windows as domain-drift evidence for polynv. | The field is listed under `disclosedDomains`. |

  An explicit `strict` on a parameter of an action with no handler is `PL1302 STRICT_ON_UNHANDLED_ACTION`, at the declaration: such an action is not in the lowered module (S35), so the runtime answers it `unhandled` and never runs the check. The fixes are to remove `strict` or to add a handler (S53).

- **PT3.4a** The default mode is `strict` for every parameter and field whose value can flow into the payload of an `irreversible` or `compensable` effect. The compiler computes this flow from the handlers. It is `disclosed` elsewhere. An explicit `disclosed` on a field that flows into an irreversible effect is `PL1301 DISCLOSED_IRREVERSIBLE_INPUT`, `PL1302 STRICT_ON_UNHANDLED_ACTION`, and a person must accept it (PT12.5).
- **PT3.5** An assignment that can produce a value outside a field's declared type (for example `items' = items + 1` with `items: 0..3`) is not a compile error. It lowers to an automatic state invariant, `domain:<field>`. The model check then reports the shortest path that overflows (`PL3102 DOMAIN_ESCAPE`) with a witness.

## PT4. Handlers and step semantics

### PT4.1 Handler shape and evaluation order

Each action has at most one handler. A handler lowers to one keyed acceptor in the SAM v2 strict profile. A handler body runs in two phases:

1. **Guard phase.** Every `require` evaluates against the pre-state and the parameters.
   - The rule is per path. On every control path from the handler entry, every `require` on that path comes before the first write on that path. A `require` inside an `if` branch is legal when no write precedes it on that branch or before the `if`. A violation is `PL2101 WRITE_BEFORE_REQUIRE`, with the offending path.
   - A failing `require` calls `reject(reason)` before any write.
   - A `reject "reason"` statement (used, for example, in a `match` arm) rejects unconditionally. It is subject to the same rule: a `reject` after a write on the same path is `PL2101`.
   - Agent-written code therefore cannot raise the `rejectAfterWrite` frame error.
2. **Write phase.** Primed assignments write to `next`. `emit`, `after`, `cancel`, `spawn` and `signal` statements are collected as effect intents (PT6).

### PT4.2 Frame derivation

The compiler computes the set of fields written on each path. It emits `unchanged(...)` for the complement, on that path. The author never writes a frame.

### PT4.3 Cross-cutting vetoes

`guard all when <expr> reject "<reason>"` lowers to a broadcast acceptor. The profile allows it: one acceptor may reject after another has written. Guards run before handlers. A guard reads the pre-state and `action`; it reads an action's parameters only where `action == A` narrows the action, under the name resolution of PT2.2 (S19).

### PT4.4 Step classification

A step is:

- `accepted` when at least one field is written or an effect is emitted;
- `rejected` when a `require` or guard fails;
- `unhandled` when the action has no handler.

A handler that can complete with no write, no effect and no rejection is reported as `PL2201 SILENT_NOOP`. This follows the doctrine "every no-op is observable".

### PT4.4a Terminal states

`terminal <expr>` is a predicate over the state. The compiler requires it to depend only on the primary control field, which is the first field of the `state` block (the polygraph contract rule "the first key is treated as the primary control state"). It lowers to `terminalStates`, the list of values of that field that satisfy the predicate. A terminal predicate that reads any other field is `PL1401 TERMINAL_NOT_ON_CONTROL_FIELD`.

### PT4.5 Example and lowering

```poly
module orders

enum Status { Draft, Placed, Paid, Shipped, Cancelled }
enum Reason { Customer, Fraud }

machine Order {
  version 1
  state {
    status : Status = Draft
    items  : 0..3   = 0
    paid   : bool   = false
  }
  terminal status in { Shipped, Cancelled }

  action AddItem()
  action Place()
  action Pay(amount: int check { 10, 20 })
  action PaymentOk()
  action PaymentFailed(code: string check { "declined", "exhausted", "denied" })
  action Ship()
  action Cancel(reason: Reason)

  on AddItem {
    require status == Draft else reject "not-draft"
    items' = items + 1
  }
  on Place {
    require status == Draft else reject "not-draft"
    require items > 0      else reject "empty-order"
    status' = Placed
  }
  on Pay(amount) {
    require status == Placed else reject "not-placed"
    emit charge(amount)
  }
  on PaymentOk {
    require status == Placed else reject "not-placed"
    status' = Paid
    paid' = true
  }
  on PaymentFailed(code) {
    require status == Placed else reject "not-placed"
    status' = Cancelled
  }
  on Ship {
    require status == Paid else reject "not-paid"
    status' = Shipped
  }
  on Cancel(reason) {
    require status in { Draft, Placed } else reject "too-late"
    status' = Cancelled
  }

  invariant shipped-was-paid: status == Shipped implies paid
  step property cancel-is-final: pre.status == Cancelled implies post.status == Cancelled
  reject property place-empty: (action == Place && pre.status == Draft && pre.items == 0) implies rejected("empty-order")

  effect charge(amount: int) {
    kind "payment.charge"
    labels { egress:external }
    class irreversible
    retry { attempts 3, base 200ms, timeout 5s }
    ok -> PaymentOk()
    failed -> PaymentFailed(code: "declined")
    exhausted -> PaymentFailed(code: "exhausted")
  }
  path property charge-at-most-once: count("payment.charge") <= 1
}
```

This source contains three findings.

1. **Domain escape.** `AddItem` can overflow `items: 0..3`. The model check reports `PL3102 DOMAIN_ESCAPE` with the witness `AddItem, AddItem, AddItem, AddItem`, and offers two typed fixes:
   - add `require items < 3 else reject "cart-full"`;
   - widen the range.
2. **Double charge.** `Pay` accepts while the order is `Placed` but does not change its state, so a second `Pay` emits a second charge. The path property check reports `PL4001 PATH_PROPERTY` for `charge-at-most-once`, with the witness `AddItem, Place, Pay(10), Pay(10)`. The fix is a `Charging` status that `Pay` enters and `PaymentOk` / `PaymentFailed` leave. This is the double-charge sequence the Poly stack was built to find: each call is allowed, and the sequence is not.
3. **Emit without state change.** The same step is also `PL4002 EMIT_WITHOUT_STATE_CHANGE` on `Pay`: it is accepted, emits `payment.charge`, and leaves the state as it was, so on **check** it is enabled again after itself and repeats its effect without limit (S33). The witness is two repetitions, `AddItem, Place, Pay(10), Pay(10)`, and the fix is the same `Charging` status, which records the emission in the state.

`amount` flows into the irreversible `charge`, so its check domain `{ 10, 20 }` is `strict` by default (PT3.4a). A `Pay(15)` is rejected at dispatch with `outside-check-domain`, and the program that runs is the program that was checked.

The first handler of the fixed program lowers to the keyed acceptor below. Its form is the strict-profile form quoted in the inventory.

```js
acceptors: {
  AddItem: model => (proposal, { reject, next, unchanged }) => {
    if (!(model.status === 'Draft')) return reject('not-draft')
    if (!(model.items < 3)) return reject('cart-full')
    next.items = model.items + 1
    unchanged('status', 'paid')
  },
  // ...
}
```

Every action of `Order` has a handler. An action with no handler is not lowered: it is not an intent of `next.cjs` and not in the `actions` of `contract.json` (S35). The runtime reports it `unhandled` before any acceptor runs, after the terminal test (PS3.2, PS9.1a), and the broadcast acceptor for guards (PT4.3) never runs for it. polygraph explores only the module's intents, so a reject property that names such an action is decided by poly-ref alone, and the verdict record says so under its instance line.

The invariants lower to `invariants.mjs`:

```js
export const stateInvariants = [
  { name: 'shipped-was-paid', pred: s => !(s.status === 'Shipped') || s.paid },
  { name: 'domain:items',     pred: s => s.items >= 0 && s.items <= 3 },
]
export const transitionInvariants = [
  { name: 'cancel-is-final', pred: (pre, action, data, post) =>
      !(pre.status === 'Cancelled') || post.status === 'Cancelled' },
]
export const rejectionInvariants = [
  { name: 'place-empty', pred: (state, action, data, v) =>
      !(action === 'Place' && state.status === 'Draft' && state.items === 0) || (v && v.rejected && v.reason === 'empty-order') },
]
```

## PT5. Properties

The five kinds and their meanings are defined in PS5. This section fixes how each is lowered and which engine checks it.

| poly form | Meaning | Lowered to | Checked by |
|---|---|---|---|
| `invariant n: e` | state predicate on every reachable state (PS5.1) | `stateInvariants` | polygraph BFS; Polytrion monitors (v2) |
| `step property n: e` | predicate on every accepted step (PS5.2) | `transitionInvariants` | polygraph BFS |
| `never n: emit k(f: v) while P` | the step property `P(pre) implies !emits(k, f: v)` (PS5.2a, S178) | `transitionInvariants`, with the step's intents from a copy of the effects mapper embedded in `invariants.mjs` | polygraph BFS; each configuration that includes the machine, on its instances' steps |
| `reject property n: e` | predicate on every step, any verdict (PS5.3) | `rejectionInvariants` | polygraph BFS with step verdicts |
| `path property n: e` | prefix-closed predicate on emission paths (PS5.4) | `effect-invariants.mjs` | polyrun `check-effects` |
| `compose invariant n: e` | invariant of the joint machine (PS7.3) | `invariants.compose.mjs` | polyrun `check-product` |
| `liveness n: … under fair { … }` | eventually or leads-to under weak fairness (PS5.5, PS6) | `liveness.mjs`: the goal predicates, for exported witness tests only; no engine reads it, and it is read back like every artefact (S74) | `poly-ref` over the explored graph (PS6.4) |
| (automatic) `domain:<field>` | invariant (PT3.5) | `stateInvariants` | polygraph BFS |
| (automatic) deadlock freedom | no reachable non-terminal state without an accepting action (PS5.6) | none | `poly-ref` over the explored graph |
| (automatic) emit without state change | no reachable accepted step whose effect sequence holds an effect, a timer or a child intent leaves the state unchanged (S33, S63) | none (the lowered effects mapper) | polyrun `check-effects` (`identity-accept-emits`), confirmed by `poly-ref` |

**Emit without state change (S33).** A step that is accepted, emits at least one effect, timer or child intent and leaves the state unchanged is `PL4002 EMIT_WITHOUT_STATE_CHANGE`, a finding in the path-property range, whatever the effect's class. A `send` is not counted (S63): a reply is one step per request, and in a configuration a message takes one step at its receiver (PS13.3, PS14.3), so the repetition this finding is about needs a second request; the consequences of a repeated send are checked where its receiver is. The step stays legal (PS3.4); the finding is sound on **check**: every input is offered in every state (PS4.1), the step is deterministic, and its post-state is its pre-state, so it is enabled again and repeats its effects without limit. The witness is the path to the step followed by two repetitions. polyrun `check-effects` reports it as `identity-accept-emits`; poly-ref confirms it as an accepted step with a non-empty effect sequence and an unchanged state, and the two must name the same steps (a disagreement is `PL2501`). The fix is to record the emission in the state. A person may accept the finding under PT12.5.

The engine formats keep their names (`transitionInvariants`, `effectInvariants`). Only the poly keywords changed, so each keyword now says what kind of property it is.

**What a property may mention.**

| Kind | Names in scope |
|---|---|
| `invariant` | the state's fields |
| `step property` | `pre.f` and `post.f` for every field `f`; `action`, compared with `==` or `!=` to an action name; the parameters of the step's action; `emits(k, f: v)` (S178) |
| `never … while P` | `P` reads the pre-state's fields alone: `pre.`, `post.`, a parameter, `action` or `emits` there is `PL1201` (S178) |
| `reject property` | `pre.f`, or the bare field `f`, for the state the step starts from; `action`; the parameters of the step's action; `rejected("reason")`, true iff the step's verdict is `rejected` with that reason |

Names resolve as in PT2.2 (S19): a bare name is a parameter where one is in scope and a field otherwise, and `pre.f` always names the field. A parameter is in scope only on steps of an action that declares it, so a property that reads one must first compare `action`: in `(action == Pay && amount > 10) implies …`, `amount` is read only when `action == Pay` holds. A parameter read where no declaring action is established is `PL1201 TYPE_MISMATCH`, not `false`. Step and reject properties are lowered with the step's verdict as an extra argument, so a step property is evaluated on accepted steps only (PS5.2), even though the engine calls `transitionInvariants` on every step.

**`never` and unconstrained witnesses (S178, M8a).** A never's finding is `PL3002 STEP_PROPERTY`. Its witness is marked `environment: unconstrained` when a step takes a completion no earlier step asked for (an effect's or decision's outcome, a timer, a child's completion) or a message that a machine of the program sends to this one and no earlier step sent (PS4.4). The finding's witness is a constrained one where any violating step has one, so a configuration never rules out a violation the machine's own inputs reach (M8a review D-F1). Two effects of one kind cannot be told apart by `emits`, which is then `PL1201`. Each configuration checks the never statements of its instances' machines on their global steps, and reports a violation as `PL3002` named `<instance>.<never>`. A machine's unconstrained finding is ruled out when at least one configuration includes the machine and every such configuration checked it to the end with no violation; it is then listed under the machine's `ruledOut` with its witness and the configurations, and not counted. A configuration that finds the violation confirms it, and the finding stays. Translation validation compares each lowered never with PS5.2a on every reachable step, and the broken lowerings `drop-never`, `invert-never-while`, `drop-never-filter` and `never-post-state` are in the explicit list of toolchain faults.

**poly-ref is poly's model checker.** It is written from 04-semantics as a reference interpreter, and it explores the checked instance for translation validation. The same exploration yields the reachable graph, on which poly-ref checks deadlock freedom, liveness and configurations of communicating machines. No engine checks these today. The architecture states this plainly (PA0.1): poly has its own checker for everything that concerns how machines relate over time. It is also the part most likely to have bugs of its own, so its first acceptance tests are the evidence scripts in `reviews/evidence` (PT18, M0 and M1). If polygraph gains any of these checks, poly defers to it.

A named invariant is a forbidden region when it carries `region "<name>"`. The name is copied to the Polyaxion `security.json` `forbiddenRegions` entry when the machine is referenced by a policy (PT8.4).

## PT6. Effects, timers and children

### PT6.1 Effects

`emit k(args)` in an accepted step lowers to an entry in `effects.cjs`. The mapper `effects(pre, action, data, post, stepKind)` returns the intents for that `(action, stepKind)` pair. Rejected and unhandled steps emit nothing.

Each `effect` declaration lowers to one manifest kind. An effect with no `kind` has its name as its kind. polyrun keys handlers by kind, so two effect declarations in one project with the same kind and a different payload, completions or class are `PL1002 DUPLICATE_DECLARATION` (S41).

A completion (`ok`, `failed`, `exhausted`) names an action with a handler. Its data are constants of finite types, encoded as a value of that type is encoded everywhere else: an enum or a union with no payload as its constructor's name, a union with payloads as `{ "$": "C", … }` (S65), a record as a plain object (S25); a field or a parameter is not a constant, because a manifest cannot compute (S67). `ok(r) -> A(p: r.x)` binds the handler's result: `r.x` takes the type of the parameter `p` it is bound to, `p` is strict by default, and the manifest maps it with `"map": { "p": "$.result.x" }`. A result without `x`, or with `x` outside the domain, is rejected at dispatch and journaled as a rejected step (S79). An action that is not declared is `PL1001 UNKNOWN_NAME`. A declared action with no handler is `PL6101 COMPLETION_WITHOUT_HANDLER`, `PL6102 SHARED_COMPLETION_ACTION`, at the completion's line: such an action is not in the lowered module (S35), and polyrun refuses a manifest whose completion action is outside the action surface. The fix is to add a handler (S40).

The manifest for `charge` in PT4.5:

```json
{ "effects": { "payment.charge": {
    "payloadSchema": { "amount": { "type": "number", "required": true } },
    "onSuccess":   { "action": "PaymentOk" },
    "onFailure":   { "action": "PaymentFailed", "data": { "code": "declined" } },
    "onExhausted": { "action": "PaymentFailed", "data": { "code": "exhausted" } },
    "retry": { "maxAttempts": 3, "baseMs": 200, "timeoutMs": 5000 },
    "labels": ["egress:external"], "class": "irreversible" } } }
```

**Retry (S137).** Every manifest entry declares its retry bound, which the outbox machine is checked at (S120). An effect with no `retry` clause lowers with polyrun's own default written out, `{ "maxAttempts": 5, "baseMs": 500, "timeoutMs": 30000 }`, so the runtime behaves as it did and poly-ref's read-back expects the same value. A decision is tried once (PD1.7).

**Adjudication (PD2.4, S129).** `adjudicate d as o` names a decision `d` of the same machine (`PL1001` otherwise) and lowers to an effect intent of kind `outcome.d` with payload `{ "outcome": "Correct" | "Wrong" }`. The manifest declares the kind with class `none`, no labels, no completions and `retry.maxAttempts` 1, and a path property may name it as it names `decision.d` (M4 review D6); its handler is built into poly-runtime and does nothing. The runtime writes the `outcome` event in the adjudicating step's transaction, linked to the hash of the run's most recent `decision` event for `d` (PT16). An accepted adjudication reachable without a preceding accepted `ok` completion of `d` on its path is `PL6203 ADJUDICATION_WITHOUT_DECISION`, a finding with the path as its witness. The runtime has no rejection reason for it: a checked program cannot reach the case, and if it is reached anyway the dispatch is refused before any step, like K9.

`labels` and `class` are new manifest fields, read by the gate (PT9). M1 confirms whether polyrun's manifest loader tolerates unknown fields. If it does not, the two fields move to a sidecar `effects.labels.json`, and the manifest stays unchanged.

### PT6.2 Labels

Labels come from the closed Polyaxion vocabulary:

- `read:repo`, `read:private`, `read:store`, `read:web`;
- `write:store`, `write:repo`, `write:workspace`;
- `egress:public`, `egress:external`;
- `exec`, `admin`.

An effect with no labels is reported as `PL6301 UNLABELLED_EFFECT`. In any scope where an obligation mentions `effects`, `labels` or `class`, it is refused instead (`PL6302 UNLABELLED_IN_LABELLED_SCOPE`, verdict `REFUSED`), because an unlabelled effect would make a label-based rule's condition unknown at runtime (PS8.4). Outside such scopes, `unlabelled: "report"` keeps the finding a finding, as in the polyflow platform policy field.

### PT6.3 Timers

`after 30m -> Expire() as expiry` lowers to a built-in `timer` intent with `{ key: "expiry", fireIn, action: "Expire", data }`. `cancel expiry` lowers to `cancelTimer`.

Timer keys are declared by use and scoped to the machine. Arming a key replaces any pending timer with that key. Timers are not state (PS1.2), so the compiler cannot know whether a key is armed: every `after` lowers to `cancelTimer` then `timer`, in that order, in the same step. polyrun applies a step's cancellations before its new timers in one transaction, and a cancellation of an unarmed key changes nothing. Without the cancellation, polyrun keeps both timers and both fire (decision S26). Two `after` statements with the same key on one control path are `PL2301 DUPLICATE_TIMER_KEY`. The machine handles staleness, not the scheduler: a timer that fires into a state where its action is rejected is a normal rejected step.

### PT6.4 Children

`spawn payments.Payment as pay -> Start(amount: amount) on complete -> Paid on parent terminal -> Abort` lowers to `spawnChild` with:

- `machineId: "payments.Payment"` (S28);
- `childKey: "pay"`;
- `creation: { action: "Start", data: { amount } }`;
- `onComplete: "Paid"`;
- `onParentTerminal: "Abort"`.

The child is created in its initial state and then takes `Start(amount: amount)` as its first step, in the same cascade, as polyrun does. `spawn M as k` with no `-> A(…)` creates the child in its initial state and nothing more (S43).

The runtime delivers a completion to the parent with the data `{ childKey, childState }`, where `childState` is the child's terminal state, and a parent-terminal cancel to each active child with `{ reason: "parent-terminal" }`. So a completion action declares `(childKey: string, childState: R)`, where `R` is a record type whose fields match the child's state (S25), or declares no parameters. A cancel action declares `(reason: string check { "parent-terminal" })`, or none. Any other parameter list is `PL1201 TYPE_MISMATCH` at the action, because the runtime will not supply it (S44).

`signal pay -> Refund()` lowers to `signalChild`. The child instance id is `hash(parentId, childKey, seq)`, as polyrun defines it.

**Child families (S49).** A key may be indexed: `spawn Shipment as f[i] -> Start(…)` lowers to the key `f<i>` (`f0`, `f1`, …), and `signal f[i] -> A()`, `after … as t[i]` and `cancel t[i]` name keys the same way. `i` has an integer range type, and that range bounds the family, so the compiler knows every key. A loop `for i in 0..n { … }` is unrolled at compile time. `n` is an integer literal, or a field or parameter whose range type bounds it; when `n` is not a literal, the loop unrolls to the bound of its type and each copy is guarded by `i <= n`. Inside the loop, `i` is a local of type `0..K`. A loop body contains only `spawn`, `signal`, `emit`, `after` and `cancel` with keys indexed by `i`, and map-entry writes `m' = m with [i] = v`: any other write is refused by the existing rule on its second copy (`PL2102`), and a timer key not indexed by `i` is `PL2301`. Spawning `f[i]` twice for one `i` on one path is `PL5101 CHILDKEY_COLLISION`. There is no unbounded loop, and no key is built from a string at runtime.

A completion action that declares `childKey: string` has as its check domain the keys of the families and single children whose completion names that action, computed by the compiler (S51).

**One signal per child and action per step (S66).** A step that signals one child with one action twice is `PL5105 DUPLICATE_SIGNAL`, on the second copy, beside `PL2301` (timers) and `PL5101` (spawns): the kernel poisons such a step.

**One action, one source of delivery (S52, S81).** The runtime delivers a child's completion itself and refuses it from outside (K9, S80). An action that is both a child's completion action and an effect completion (`ok`, `failed`, `exhausted`) or a timer's action would then be refused when the effect or the timer delivers it. So it is `PL6102 SHARED_COMPLETION_ACTION`, at the second wiring. A parent-terminal cancel action is not named: the runtime accepts it from outside (S81).

These are **attached** children: checked as a cascade (PT7) and co-located with their parent on one kernel shard (PS7.4). `spawn detached …` creates a separate actor instead (S60, built in M2). Its address is `<parent address>/<k>`, known in the handler: `as k` binds `k`, a local of the handler of type `Ref<M>`, which the handler may store. In the lowered handler the address is the marker `{ "$ref": "child", "key": "k" }`; the kernel resolves it to the absolute address when it commits the step that creates the child, in the post-state and in every outgoing intent, so every later copy is absolute, and translation validation compares after that resolution (S78). The instance starts in `M`'s initial state and takes its creation action (S43) as its first message. From then on the two communicate only by `send`, and they are checked together as a configuration (PT7a). A detached spawn takes no `on complete` wiring, because completion is a message the child sends. A second spawn of a key whose instance exists is `PL5101 CHILDKEY_COLLISION` in a configuration, with its witness, checked before the instance bound (S83). polyrun gains a `createInstance` intent for it.

### PT6.5 Handlers receive capabilities, not ambient authority

A label is a claim until the code is unable to exceed it. Two mechanisms make it so.

**1. Capability passing (default, v1).** An effect declares its targets next to its labels:

```poly
effect charge(amount: int) {
  kind "payment.charge"
  labels { egress:external }
  targets { egress: "https://api.psp.example/v1/charges" }
  class irreversible
  …
}
```

The runtime passes the handler only the capabilities its labels and targets grant:

| Label | Capability passed | Bound to |
|---|---|---|
| `egress:external`, `egress:public` | `egress.post / get` | the declared URL prefixes only |
| `read:store`, `write:store` | `store.read / write` | the declared tables or keys |
| `read:private` | `secrets.get` | the declared secret names |
| `exec` | `exec.run` | the declared commands |
| none of the above | nothing | none |

- **Handler modules are checked by a lint pass** (`poly lint handlers`), over the files `poly.json`'s `handlers` names and every file they reach through relative imports, each read once (S72, S142). A relative import that names no file or a file outside the project, or an import by absolute path or URL, cannot be certified: `PL6402 HANDLER_NOT_CERTIFIABLE`, and the program is not admitted. An installed package (a bare specifier) is followed through Node's resolution into `node_modules` (S154): its `package.json` and every file reached from its entry (by its `exports` map or `main`) through relative imports and the packages it imports are hashed and certified under `packageFiles`; an import that resolves to no installed file is `PL6402`. Packages are hashed, not linted: a package may use `node:fs`, and the certificate's limits say the sandbox is what stops it. Each exports or imports entry is followed under every condition but `types` (a superset of what Node picks), subpath patterns included, and CommonJS's `.json` and a directory's own `main`; an import inside a package that resolves to no file is listed in the certificate's limits, never dropped. A file a package loads by a computed name is not reached. The runtime imports the verified copy of the handlers, so the certified package files are copied beside it, where Node resolves them first (review D-F3, D-F4); a package above the project is copied above the copy's root, which sits that many directories deep, and every copy is re-checked before import. An imports-map specifier (`#…`) in a handler file is `PL6402`, since the project's map would resolve it to the original files and not the copy (polywatch on M5b). The nearest lockfile above the project is recorded too, and a handler that imports a package with no lockfile is `PL6402`. A project with effects and no `handlers` field lists the lint as not run under the instance line; it is never silently clean. It rejects imports of ambient-authority modules, such as `fs`, `net`, `http`, `child_process`, global `fetch` and `process.env`. A violation is `PL6401 AMBIENT_EFFECT_IN_HANDLER`, and the program is not admitted.
- **As built (M5a, S134, S151).** `targets { egress: "<prefix>" | [ … ], secrets: [ … ], exec: [ … ], store: [ … ] }` is an effect item. Each kind of target needs a label that grants it, by the table above (`PL6303 TARGET_NOT_GRANTED`); an egress target is an absolute http or https URL with no user, query or fragment, written in the form the parser gives it, with no dot segment, backslash, encoded dot or separator, upper-case host or default port (`PL1201`), so the text read is the prefix bound. The lowering writes them to the effect's manifest entry as `targets`, and the read-back compares them with the source (a widened prefix is the toolchain fault `widen-target`). The host gives the transports at load, `load(…, { transports: { egress, secrets, exec, store } })`, and poly-runtime imports no network module, which the boundary check enforces. For each call the runtime builds a frozen capability object from the entry's labels and targets: `egress.get(url)` and `egress.post(url, body)` (for `egress:external` or `egress:public`), `secrets.get(name)` (`read:private`), `exec.run(command, args)` (`exec`), and `store.read(table, key)` or `store.write(table, key, value)` (`read:store`, `write:store`). A URL is parsed by the WHATWG parser, which lowercases the host, drops a default port and resolves dot segments and their encoded forms; it is within a prefix when the scheme and host with port are equal and the path equals the prefix's or continues it past a `/`. A URL with a user is refused, and so is one whose path holds an encoded slash or backslash, or a `..;` segment, which some servers read as a separator or as `..`. The egress transport makes one request and follows no redirect: the capability reads each 3xx `Location`, resolves it against the current URL, and checks the hop against the prefixes before it asks the transport for it; 303, and 301 or 302 after a POST, continue as a GET with no body and no body headers; more than five hops is an error. A secret name, a command and a table match exactly. A call outside the bounds writes a `PL6406` audit row and then throws `CapabilityRefused`, before the transport is called. A label with no targets of its kind gives a capability bound to nothing, so every call of it is refused. Capabilities are bound in-process: the certificate's limits say the lint is what keeps a handler from reaching around them, until the sandbox (S152).
- **This is a discipline, not a proof.** TypeScript cannot stop determined code from reaching ambient authority, for example through dynamic `import()` or `globalThis`. The lint rejects both forms, but only the sandbox below enforces the boundary.

**2. Generated sandbox (opt-in, M5).** With `handlers: { isolation: "openshell" }` in `poly.json`, each effect kind's handlers run in an NVIDIA OpenShell sandbox. Its policy is **generated from the effect's labels and targets**: network egress only to the declared prefixes, no filesystem beyond a scratch directory, and secrets scoped to the declared names. A wrong or missing label then fails closed at the sandbox boundary instead of silently widening what the gate believes. The stack's existing polyaxion-openshell work supplies the integration. **As built (M5b, S152).** With `isolation: "openshell"` in `poly.json`, the lowering writes `openshell.policies.yaml` beside each machine's artefacts: one OpenShell policy (schema version 1) per effect kind, deterministic, written as JSON, which is YAML. Its filesystem is `/sandbox/scratch` read-write and `/usr`, `/lib` and `/etc/ssl` read-only, with Landlock required; each declared egress prefix is a REST endpoint by host, port and path (the prefix and below it), bound to each declared secret as a credential provider; a kind with no egress label has no network policy at all. OpenShell has no per-command allowlist, so declared commands stay enforced in process, by the capability object. The file is an artefact: admission certifies it, `load` verifies it, and translation validation reads it back against the source, so the broken generator `widen-sandbox` is a listed toolchain fault. Enforcement needs an OpenShell gateway on Linux 6.2 or later; where `POLY_OPENSHELL_GATEWAY` names none, the enforcement test is listed as not run, and a certificate with the policies says in its limits that this runtime does not enforce them (review D-F5). A composed child is lowered with the same option, so it keeps its policy; under isolation, translation validation reports a machine with effects and no policy as a mismatch (review D-F1). The sandbox reads a host or path as a pattern, so an egress target holding `*`, `?`, `[`, `]`, `{` or `}` is `PL1201` (review D-F2).

The principle, in both cases: **an effect's type is what it can do, not what it says it does.**

**Capabilities are addresses.** A capability is the address of a host actor that performs one kind of effect for declared targets. `emit k(d)` is a message to that address (PS2.2). The effect system and the message system are one mechanism: a machine can affect the world only by sending to an address it was given.

## PT7. Composition

A machine that spawns children is checked with its children as a product:

- Each cascade is atomic.
- Per-instance dispatch has a single writer.
- `MAX_CASCADE_DEPTH` is 8.

These rules are polyrun's composition semantics, unchanged, and they apply to **attached** children only. The compiler emits `invariants.compose.mjs` from `compose invariant` declarations. Joint state is addressed as `parent.<field>` and `children.<key>.<field>`. The runtime places an attached tree on the shard of its root and refuses to place a descendant elsewhere (`PL5202 ATTACHED_ACROSS_SHARDS`, PS7.4).

A compose invariant reads `children.k.f` only under a `k spawned` narrowing, as `action == A` narrows parameters (S19): `k spawned implies children.k.shipState == Delivered`. A read without it is `PL5103 CHILD_READ_WITHOUT_SPAWNED`, and the fix is the narrowing (S48). A family is reached through `forall` and the aggregates: `forall i in f: f[i] spawned implies children.f[i].ship != Pending`, and `count(children.f[*].ship == Delivered)`, where an aggregate counts only the spawned members (S49).

polyrun's built-in doctrine findings are surfaced as poly diagnostics (S47):

- child-key collision: `PL5101 CHILDKEY_COLLISION`;
- a cascade delivery (completion, cancel or signal) that reaches an action with no handler: `PL5102 UNHANDLED_CASCADE_DELIVERY`;
- a signal to a child that is not spawned, on which the runtime halts the parent: `PL5104 SIGNAL_TO_ABSENT_CHILD`, a finding with its path (S50);
- an unnamed reject, or the poison class: `PL2501 LOWERING_MISMATCH`, since every poly reject has a reason and only a lowering that lost something can reach either.

## PT7a. Configurations

A configuration (PS13) is the unit of checking for machines that talk to each other. It has no engine artefact. poly-ref explores it, as it explores liveness.

```poly
module checkout

service machine Inventory {
  state { onHand: 0..1 = 1 }
  action Query(from: Ref<Order>)
  action Take(from: Ref<Order>)

  on Query(from) { send from <- Available(n: onHand) }
  on Take(from) {
    if onHand > 0 { onHand' = onHand - 1   send from <- Taken() }
    else          { send from <- OutOfStock() }
  }
}

type OrderState = Idle | Asked | Taking | Done | Refused

machine Order {
  state { st: OrderState = Idle   inv: Ref<Inventory> = none }
  terminal st is Done | Refused
  action Place()  action Available(n: 0..1)  action Taken()  action OutOfStock()

  on Place      { require st is Idle   else reject "not-idle"    st' = Asked   send inv <- Query(from: self) }
  on Available(n) { require st is Asked else reject "not-asked"
                    if n > 0 { st' = Taking   send inv <- Take(from: self) } else { st' = Refused } }
  // Taking waits for the inventory's answer before the order is confirmed (Done)
  on Taken      { require st is Taking else reject "not-taking"  st' = Done }
  on OutOfStock { require st is Taking else reject "not-taking"  st' = Refused }
}

configuration two-buyers {
  inv       : Inventory
  order[2]  : Order { inv: inv }
  inputs    { order[*].Place }
  bounds    { transit 4 }
  invariant confirmed-within-stock: count(order[*] is Done) <= init(inv.onHand)
  liveness  settle: forall i in order: order[i] is Asked leads to order[i] is Done | Refused
}
```

Both machines are safe on their own: the inventory never lets `onHand` go below zero, and each order's handlers respect its own states. Now make the order **optimistic**. On `Available(n)` with `n > 0`, it confirms at once (`st' = Done`) and sends `Take` afterwards, instead of waiting in `Taking`. That is the classic check-then-act race between actors. Every message is handled correctly by its receiver, the per-machine checks stay clean, and the interleaving confirms two orders against one unit of stock:

```
$ poly check checkout.poly
checkout.poly:33  PL5401 CONFIGURATION_INVARIANT  confirmed-within-stock
  witness (6 global steps):
    input   Place@order[0]
    input   Place@order[1]
    deliver Query(order[0])   -> inv
    deliver Query(order[1])   -> inv          both queries answered with onHand = 1
    deliver Available(1)      -> order[0]     order[0] confirmed
    deliver Available(1)      -> order[1]     order[1] confirmed; one unit, two confirmations
verdict: FINDINGS (exit 1)  over 2 orders, 1 inventory, transit ≤ 4
```

With the order waiting for `Taken`, the configuration is clean over 44 global states within the same bounds. No quiescent state is stuck, and every placed order settles. An independent exploration of both versions is in [`reviews/evidence/config_check.py`](reviews/evidence/config_check.py). No per-machine check can find this defect. It lives in the arrival order and in an invariant that spans instances, and neither machine sees both.

**Lowering and runtime.**

- A `send` lowers to a new built-in intent kind, `sendTo { target, action, data }`, beside polyrun's `spawnChild` and `signalChild`. This is a small change to polyrun (architecture §2a). An address is the target instance's id, and `none` is `null` (S58).
- A detached child's address is resolved at the commit of the step that creates the child, not at delivery: resolving against the sender would be wrong once the parent passes the address to a third machine (S78).
- `self` is legal only as a whole argument of a `send`. It lowers to the marker `{ "$ref": "self" }`, which the kernel replaces with the sender's instance id when it writes the message, since neither the acceptor nor the mapper knows that id (S58). `send … as n` is `PL0901`.
- The runtime delivers it through the outbox, at least once, as a `dispatch` to the target with the intent's idempotency key as its `actionId`. So each message takes exactly one step at its receiver (K4, PS14.3). The outbox row is keyed `<sender>:<seq>:<position>`, PS13.2's message identity, and the receiver's dedupe on it for the life of the instance is K4. There is no fixed delivery order: unordered is the default (PT9.8), and `fifo` needs the in-order worker. A send to an instance that does not exist goes to the dead-letter list and is journaled on the sender's run. Tests and the M3 adapter may deliver one message at a time (S89).
- A delivery the receiver rejects is a rejected step there. The sender is not notified unless the receiver sends a reply, which is the actor discipline.
- `fifo` between a pair of instances is available only when they share a kernel shard, and it is checked with the narrower arrival order. **Not in v1's runtime (S125):** polyrun delivers messages with the parallel worker only, so `load` refuses a build that declares a `fifo` pair with `PL5405 FIFO_WITHOUT_IN_ORDER_WORKER` until an in-order worker exists.

**Names in configuration properties (S32).** In a configuration property, `x.f` and `g[i].f` name field `f` of instance `x` or `g[i]`. `g[i] is C` and `g[*] is C` resolve `C` against the machine's fields: the test is legal when exactly one field's type has the constructor `C`, and it then tests that field; otherwise it is `PL1005 AMBIGUOUS_CONSTRUCTOR`, whose fix is `g[i].f is C`. So `count(order[*] is Done)` tests `st`, the one field of `Order` whose type has `Done`, and `init(inv.onHand)` is the inventory's initial stock. A field access on an instance is legal only in configuration properties, never inside a machine (PS1.6).

**A send to `none` (S29).** Inside a configuration, a step that sends to `none` is `PL5404 SEND_TO_NONE`, a finding with the path to the step; the message is not added to `μ`. In a single-machine check, the send is an ordinary intent (PS4.4).

**Configurations in the pipeline.** Stage 4b of the check pipeline (architecture §5) explores every declared configuration. Every verdict carries the configuration's bounds (PT12.3a). A bound hit is `INCONCLUSIVE` (`PL5301`, `PL5302`), never `CLEAN`. A configuration without `bounds { transit n }` is `PL5303 CONFIGURATION_WITHOUT_BOUNDS` (S62): the program may type-check perfectly, and without the bound the exploration need not end. `instances n` is required only when a machine of the configuration spawns detached children, and reaching it is `PL5302` (S60). A configuration whose machine spawns attached children is `PL0901` until a later milestone (S61).

**Liveness in a configuration (S56).** A liveness property may begin with `forall i in g:`, which scopes over the whole `leads to` (PS13.6), and may leave out `under fair { … }`: delivery is fair by PS14.2, and an input is assumed fair only when the clause names it. In a machine the clause stays required.

## PT8. Policies

### PT8.1 Syntax

A policy lowers to `polyaxion.policy.json` version 2. The document fields are `polyaxion`, `id`, `version`, `scope`, `description`, `vars` and `obligations`.

The file is `repo-hygiene.policy.poly`. It uses the same operators as machines; its expressions have type `Tri` because its inputs are optional (PT2.3).

```poly
policy repo-hygiene {
  scope "claude-code"
  var deploys: 0..5 = 0

  obligation tests-before-deploy "After changing source, run the tests before deploying." machine {
    states clean, dirty, tested
    initial clean
    from * when action.kind == "fs.write" && glob(action.path, "src/**") -> dirty
    from dirty when action.kind == "process.run" && action.target == "test" -> tested
    deny in dirty when action.kind == "custom.deploy" reason "untested-changes"
    end clean, tested
  }

  obligation no-egress-after-secret "Never send data out after reading a secret." rule {
    when action.effects has "egress:external"
    require !history.any(a => a.effects has "read:private") else deny
    on unknown escalate
  }

  obligation orders-irreversible "No irreversible effect on a cancelled order." rule {
    when effect.class == "irreversible" && machine("orders.Order").status == Cancelled
    require false else deny
  }

  recalled style "Follow the house style: short sentences, no dash asides."
}
```

**The policy production (M5a).** A policy is a declaration of a module, by convention alone in a `.policy.poly` file:

```ebnf
Policy      = "policy" Name "{" "scope" String { PolicyItem } "}" ;
PolicyItem  = "var" Ident ":" Type "=" Expr
            | "obligation" Name String ( RuleBody | MachineBody | "invariant" "{" Expr "}" )
            | "recalled" Name String
            | "never" Name String ":" "allow" "when" Expr ;                  (* S149 *)
RuleBody    = "rule" "{" [ "when" Expr ] "require" Expr "else" ( "deny" | "warn" | "escalate" )
              [ "on" "unknown" ( "escalate" | "deny" | "skip" ) ] "}" ;
MachineBody = "machine" "{" "states" Ident { "," Ident } "initial" Ident
              { "from" ( "*" | Ident { "," Ident } ) "when" Expr "->" Ident
              | "deny" "in" Ident { "," Ident } "when" Expr "reason" String }
              "end" Ident { "," Ident } "}" ;
```

The inputs of a poly policy are the runtime's proposal (PT9.1): `effect.kind`, `effect.class`, `effect.labels` (`effect.labels has "egress:external"`), `effect.machine`, `proposal.kind`, `step.claims.f` (PD5.1.2d, S104: the claims of the step that emitted the effect; a `Principal` field is not readable), `lineage.origin.f` and `lineage.intent` (PD5.2.2c: the origin's claims and the starting step's `module.Machine.Action`; no expression names a hop), `machine("m.M").f` (PT8.3) and `decision("d").f` (PD4.3: `taken`, `answer`, `conf`, `margin`, `model.id`, `model.reported`, `calibration.fittedFor`). Each name and field is checked against the program (`PL1001`, `PL1201`), and so is each string compared with an effect's kind or class or a machine id, and each label tested with `has`, so a misspelt one is `PL1001` rather than a rule that applies to nothing (review B6). The scope's policies are declared in one module, since they lower to one document. A `never` statement is proved by poly-ref over the decision table (S149): the finite product of the proposals the program can make and of every value its policies can read; a policy that allows a proposal its `never` forbids, or escalates it so that a person's approval would allow it, is `PL6503 NEVER_VIOLATED`, with the proposal and the policy states that lead to it as the witness; a `never` whose condition no proposal meets is `INCONCLUSIVE` (`vacuous`), and one over a value with no finite domain is `runtime-only`. A machine field takes the values of its type or its check domain. A model id is an open string, so the table gives it each string the scope's policies name and one more, each with a map fitted for it and one fitted for another. An obligation (not a `never`) over a value with no finite domain is listed as `runtime-only` too, and translation validation is `INCONCLUSIVE`, since it compared only the unknown case (review B2, B5). The Claude Code vocabulary of the example below (`action.path`, `glob`, `history`) is not part of M5a's surface (S159).

In PX, `glob(action.path, …)` is unknown when `action.path` is missing. What an unknown `when` does is fixed by the rule's `on unknown` (PS8.2), so no `?? ""` default is needed, and none is accepted.

### PT8.2 Lowering

| poly | `polyaxion.policy.json` |
|---|---|
| `obligation … machine { … }` | `kind: "machine"` with `states`, `initial`, `transitions` (`{from, when, to}`), `guards` (`{in, when, reason}`) and `end` |
| `obligation … rule { … }` | `kind: "rule"`, `when` / `require`; `else deny`, `else warn` and `else escalate` map to `severity`. `on unknown escalate \| deny \| skip` gives the outcome when `when` is unknown (PS8.2). The default is `escalate` for deny rules and `warn` for warn rules. `skip` must be explicit and is listed in the certificate under `skippedOnUnknown`. Polyaxion receives it as an `unknownWhen` field; if the engine does not yet support the field, the compiler rewrites the rule so that an unknown `when` yields the declared outcome. |
| `obligation … invariant { … }` | `kind: "invariant"` over declared `vars` |
| `recalled` | `kind: "recalled"`, compiled into `unenforced[]` |

Closed history predicates are lifted into counters and model-checked by Polyaxion. Open ones must be declared `coverage runtime-only`, exactly as Polyaxion requires.

**One document per scope, and PS8 by rewriting (M5a).** The policies of one trust scope lower to one document, `.poly/build/policies/<scope>.policy.json`, with every deny rule before every escalate rule and every warn rule, so that the engine's first refusal is PS8.3's. Polyaxion applies a rule whose `when` is unknown and refuses an unknown `require` as `indeterminate`, so PS8.2 is carried by rewriting: `when W require Q else s on unknown u` lowers to a rule `when P && coalesce(W, false) require coalesce(Q, false)` with severity `s`, and, unless `u` is `skip`, a rule `when P && isNull(W) require false` with severity `u`, where `P` holds only for the runtime's proposals (`custom.poly.effect` and `custom.poly.send`), so the engine's own actions, such as the end of a session, pass. A guard refuses when its condition is true or unknown, and a transition fires only when its condition is true. From a state, the first transition whose condition is true is taken, as written; the engine applies every matching transition, so each transition is lowered per source state and conjoined with the negation of the earlier ones out of that state, and with `P`, which also gives the engine an action condition to route a transition that reads only a var (review B7, B12). The proposal's fields are reserved action fields the gate host fills (S147). The emitting step's claims are `action.step.claims`, read from that step's journal row; the decision table gives them no value (an action without claims) and every value of each claims type the emitting machine's actions require, and the `verdict` event records their digest (PD5-A4). The emitting step's lineage is `action.lineage`, `{ origin, intent }`; the table gives the origin no claims and each value of each claims type's read fields, and the intent each action of the program when it is read. **Attribution (S156).** `scope "s" requires attribution` adds a deny rule to the scope's document, `<scope>.attribution`: a compensable or irreversible effect whose origin has no claims is denied, and PS8's decision in poly-ref says the same. The check finds such an effect before the program runs: an action is attributed when it has `by`, or when every step that starts it (an effect's or decision's completion, a timer) comes from an attributed action, and an unattributed action's compensable or irreversible effect is `PL6701 UNATTRIBUTED_EFFECT`, with the path to it. **Outside dispatch in an attributed scope (S162).** In a scope that requires attribution, an effect's completion action and a timer's target are started only by their completion or timer, which carry the origin of the step that emitted the effect or armed the timer; so `PL6701`'s fixpoint is exact. The runtime refuses an outside dispatch of either before any step, with an audit row (rule `S162`) and `RefusedDispatch`, as it refuses K9's and K10's. It reads them from the certified manifest: each effect's completions, and `timerTargets`, the actions the machine's timers start, which the read-back compares with the handlers (the broken lowering `drop-timer-target` is listed). The gate's attribution deny stays as the second line. In a scope that does not require attribution such a dispatch is a step, as before. A policy field that two claims types declare with different types cannot be read (`PL1201`), and reading `step.claims` or `lineage.origin` as a whole explores every field (review C2, C3). Engine change E7 (S158) would let Polyaxion combine a rule's escalation with a guard's deny itself; until then the host does it (PT9). Each lowered document is translation-validated: poly-ref's PS8 decisions and the engine's plan interpreter must agree over every reachable pair of policy states and every proposal of the decision table, or the program is refused with `PL2501`; three deliberately broken policy lowerings are listed in `test/toolchain-faults.mjs`.

### PT8.3 Referencing program state

`machine("<module>.<Machine>")` is new. It reads the snapshot of the instance that emitted the effect under decision, **as of the step that emitted it** (PT9.3). It never reads a later snapshot. **Singletons (S147).** It may also name a `service machine`, a singleton: the proposal then carries that instance's latest snapshot and `seq` at proposal time, recorded in the `verdict` event. Otherwise the value is unknown (Kleene) when the proposal is not an effect of that machine. A read that can never be known (a machine that is neither a service machine nor the emitter of any effect) is `PL6502 UNKNOWABLE_MACHINE_READ`, a finding: the policy form of a vacuous property.

### PT8.4 Admission

Policy admission runs Polyaxion `compile` and `harden`. Machines with regions or gates must be `fullyMediated`. The coverage grade (`checked` or `runtime-only`) is copied into the certificate. polycheck then runs the regions against the effect labels of every admitted machine and the tool labels of the declared scope. Its result, `PROOF`, `WITNESS` or `INCONCLUSIVE`, maps to `CLEAN`, `FINDINGS` or `INCONCLUSIVE`.

**Stage 5a as built (M5a, S161).** polycheck is a second optional peer, pinned like Polyaxion (`peers/polycheck/PROVENANCE.md`) and listed as not run where it is absent. For each trust scope it models the effects of the modules the scope governs: each effect kind is an action whose flags are its labels' by the table below, gated when an obligation of the scope names that kind (`effect.kind == "k"` or `effect.kind in { … }`); a `never` statement enforces nothing and gates nothing (review B10). polycheck's default regions (`lethal-trifecta`, `credential-egress`, `source-egress`) are checked over it. A region reached with no gate crossed is `PL7001 REGION_WITNESS`, a finding with the path. A region no effect of the program can provide is noted as unreachable, not left inconclusive: a program's effects are its whole capability surface, since its handlers are certified (PT6.5). The state-dependent cases stay with `never` statements (S149).

| Effect label | polycheck flag |
|---|---|
| `read:web`, `read:store` | `untrusted` |
| `read:private` | `sensitive` |
| `read:repo` | `proprietary` |
| `egress:external`, `egress:public` | `egress` |
| any other | none |

### PT8.5 Obligation consistency

After compilation, stage 5b checks that each mandate in scope is **dischargeable** under all obligations together: declared, promoted, recalled and native (PS8.6). This is Polyaxion's m2 condition, surfaced as a named stage with its own diagnostic.

- An undischargeable mandate is `PL6501 UNDISCHARGEABLE_MANDATE`. The finding lists the minimal conflicting subset of obligations, with each one's source (file, or the Polyx rule id and its adjudication record), and a path that shows the conflict.
- **Per mode (M5a, PD4.4a, PD4.4b).** A mode is an enum field of a service machine the scope's policies read with `machine(…)`. The stage runs once per value (per combination, when several are read), with the value fixed in the document and its examples narrowed to the proposals made in that mode; a mandate trapped in some modes is `PL6501` naming each, and one trapped in every mode is reported once. Each `allowed`, `denied` or `escalated` event records the singletons the decision read, so the mode a decision was taken in is in the ledger (PD4-A1). PD4-A3, a signed `Declare`, is M5b's (S107).
- **As built (M5a, S148, review B3, B4, B9, B11).** The stage is poly-ref's, over the whole decision table: the scope's policy machines are explored together from the initial Σ, along every proposal PS8 allows and every escalated one a person's approval lifts (an escalation is not a deny on the way), and a mandate is undischargeable when some reachable Σ has no such path to one of its end states. Polyaxion's own m2 check explores one machine at a time and counts an escalation as a deny, so it can miss a trap set by another machine's guard, and can refuse a scope PS8.6 finds dischargeable; such a refusal stays `PL6001`, since the engine will not serve the scope, and says so (engine change E8). A discharge check that hits its bound lists the mandate as not run. For each mandate the stage cannot discharge, the minimal subset is found by deletion: the obligations are tried for removal in declaration order, an obligation is dropped when the mandate stays undischargeable without it, and the number of discharge checks is reported with the finding. The subset is minimal, not the smallest. For admission, Polyaxion draws the actions it explores from a policy's examples, and its own sampler does not reach a runtime proposal's reserved fields, so the lowering gives each obligation, as examples, every proposal of the decision table one step from the initial state, allowed or refused as PS8 says of that obligation alone; admission then also requires the engine to agree with each.
- `poly mine` runs the stage again for each rule a person proposes to promote. A promotion that would make a mandate undischargeable is refused at that moment, before the rule is ever served.

## PT9. The gate in the runtime

This is the only new engine integration (architecture section 7.2).

**The policy gate (M5a, S146, S147).** A build with policies runs behind the policy gate, and only behind it: `load` refuses another gate, and refuses the build when the gate engine is not available (S145). Polyaxion decides in process. An instance's trust scope is its machine's module (S160): the policies whose scope selector matches the module govern it, and a module no policy matches is declared open at load, so a governed scope whose policy is missing refuses while an ungoverned one does not. Each scope has one session, `scope:<module>`, which the host serialises; it assigns `sseq` on every proposal and every settle, durably, and every `verdict` and `settled` event carries the session, its `sseq`, and Polyaxion's Σ digests before and after. The engine sees each proposal as a `custom.poly.effect` action whose reserved fields hold what the scope's policies read: the emitting step's snapshot for its own machine, the latest snapshot of a service machine (a singleton) with the `seq` read, and the run's latest `decision` events. The singletons read are recorded in the `allowed` event, and before each start of the handler the worker compares them with their current `seq`: an allow one of them has outlived is not acted on but rechecked (PT9.7), as a new proposal with a new `sseq`. An escalation is lifted only by a person's signed approval (PT12.5), passed to the engine with the approver's key id. The engine refusing, hanging past `proposeTimeoutMs`, answering `unavailable` or failing to journal its decision is an outage, and the intent is held (PT9.5). An engine that throws or does not answer takes no sequence number; one that answers in a way the host cannot act on does, and the answer is recorded as a `held` verdict, so the session still replays. An engine call cannot be cancelled, so a call that outlives the timeout stays the session's outstanding call: until it answers, the session takes nothing (each proposal is held at once), and its answer, when it comes, is recorded as a `late` verdict with its own `sseq`, since the engine did decide and Σ may have moved (review C1). The outage test (`test/gate-outage.test.mjs`) injects these faults under a seeded schedule, with a crash after an allow, a ledger that cannot write a verdict, a governed scope that loses its policy and a keyring that cannot be read, and observes from a log of handler calls the host cannot write that no allow is obtained during an outage and no handler runs without one. Polyaxion reports an escalate rule before a guard's deny; until engine change E7, the host asks the engine's own interpreter, with the escalations lifted, whether a deny stands behind, and decides deny when one does (PS8.3, S158). Each session's windows are signed by the engine's notary into receipts (AC4). **Session replay (S118, AC6).** Each `verdict` event keeps the engine action by digest, the gate's decision and Σ before it; each `settled` event its action, what was observed, and Σ before and after it. `poly journal replay` re-applies every session's events in `sseq` order on a fresh engine with the certified policies and must reproduce every decision and Σ digest, or reports `PL9001`; Σ after a decision or a settle is compared where it is recorded. A gap in a session's sequence (a decision whose event was never written, PT9.5) stops that session's replay, listed as not run; a gap at the end is found against the session's counter (review C4). A run's policy-gate decisions are replayed with their session, not one by one.

**The gate before M5 (S118).** M4 builds the gate interface in the worker (`propose(proposal, snapshot) → allow | deny | escalate`, `settle(observed) → ok | failed`), with an allow-all gate as the default and scripted, deterministic test gates; each decision is a `verdict` event in the run's chain. Session replay in `sseq` order, with Σ digests (PS11.1, PS11.2), comes with the policy gate in M5. Approvals in M4 are recorded API calls without a person-key signature, and the instance line states that limit until PT12.5 lands.

- **PT9.1 Proposal.** When an outbox worker claims an intent, it calls the gate before the handler with:

  ```json
  { "kind": "effect", "effectKind": "payment.charge", "labels": ["egress:external"],
    "class": "irreversible", "machine": "orders.Order", "instance": "ord-81",
    "seq": 14, "idempotencyKey": "…", "payloadDigest": "sha256:…", "stateDigest": "sha256:…" }
  ```

  An approved re-proposal carries `approved: { by, ref }`, and a rechecked one the count of its rechecks, `rechecks` (S147). The payload body is not sent. Only its digest is, following the polyflow platform ledger rule "only digests are stored".

- **PT9.2 Decisions.**
  - **allow:** the handler runs.
  - **deny:** the worker marks the intent `denied` and dispatches the effect's `failed` action with `{ reason, witnessDigest }` merged into its data. A denied intent is not retried.
  - **escalate:** the intent is held as `escalated` until a recorded approval (`poly approve <intent> --by <person> --ref <escalation>`) re-proposes it with `approved: { by, ref }`. An unmatched approval is refused with `wrong-participant:polyaxion:approval-unmatched`. An escalation that is not approved within `escalation.timeoutMs` is denied (PT9.7).
- **PT9.3 Snapshot semantics.** The gate evaluates a proposal against exactly one snapshot: the post-state of the step that emitted the intent, identified by the `seq` and `stateDigest` the proposal carries (PT9.1).
  - The worker loads that snapshot from the journal by `(instance, seq)` and passes it with the proposal. The gate keeps no mirror of application state, so there is nothing to go stale.
  - A gate decision is a function of three inputs: the policy digest, the gate's session state Σ at proposal, and the snapshot at the emitting `seq` (kernel assumption K6).
  - Σ depends on the order in which the session received proposals and settles, and a session spans runs. The gate therefore assigns a **session sequence** `sseq` to every proposal and settle, and each ledger event records its `sseq` and the digest of Σ before it (PS11.1). Replaying a session in `sseq` order reproduces every decision and every Σ digest (PS11.2). Replaying a run reproduces its gate decisions when the sessions it touched are replayed with it (PS11.3).
  - If the snapshot at `seq` cannot be loaded (archived and not restored), the proposal is refused with class `unavailable`, never evaluated against a newer state.
- **PT9.4 Settle.** After the handler returns, the worker calls `SETTLE { observed: { ok, output digest } }`, then dispatches the completion action. Taint only grows, as in Polyaxion today.
- **PT9.5 Unavailability.** If the gate is unreachable, the intent stays pending and is not executed. The failure class is `unavailable`. The runtime never fails open.
- **PT9.6 Budget.** Polyaxion measures a 0.63 ms p50 composite merge with durable writes. The in-process placement (AD-4) targets the same order. The first implementation reports:
  - p50 and p99 latency for PT9.1 to PT9.4;
  - throughput in effects per second on one runtime, with 1, 8 and 64 concurrent instances, so that any serialisation point shows up as a flat line;
  - throughput **per gate session**, with 1, 8 and 64 concurrent runs in one session. The gate is an actor, and a session is its serialisation point (PS11.0).

  **As measured (M5a, AC4).** `poly bench gate [--sizes 1,8,64] [--out <file>]` admits AC4's program (`conformance/m5/orders.poly` under `orders.policy.poly`) outside the repository with a key generated for the run, and runs each order through Reserve and Charge, so each instance proposes two allowed effects. It times propose and settle by wrapping the worker's gate, and the path from a proposal to the end of its settle, handler included. Throughput is effects per second from the first dispatch to the last settle, once with no policy (the runtime's own path, the baseline) and once under the policy gate; the program has one trust scope, so the gated series is the per-session series. In-memory SQLite, one process, one worker. Without the Polyaxion peer the gated series and the latencies are listed as not run. `docs/m5/gate-bench.json` holds the run on an Intel Core Ultra 7 155H under Node 24.12: propose p50 0.67 ms and p99 16.0 ms, settle p50 0.52 ms and p99 2.9 ms, the whole path p50 5.2 ms and p99 21.7 ms (146 proposals); 52, 96 and 112 effects per second at 1, 8 and 64 instances with no policy, and 16, 84 and 90 in the one session. The gate's propose is of the order of Polyaxion's own 0.63 ms merge; throughput is bound by the runtime's steps and SQLite writes, which the baseline shows, not by the session. The size-1 figures include the first run's warm-up. There is no pass threshold.
- **PT9.6a Sharding.** The gate is sharded along sessions and only along sessions. A policy that needs state across sessions is refused at admission (`PL6601 CROSS_SESSION_STATE`) unless that state lives in a separate machine that the policy consults by message.

- **PT9.7 The outbox intent is a checked machine.** The interleavings of retry, gate decision, handler execution and settle are the most dangerous part of the runtime. They are specified as a poly machine, lowered like any other, and model-checked by polygraph as part of the runtime's own test suite. The runtime's outbox worker is the host of this machine.

  ```poly
  module runtime

  type Intent =
    | Pending
    | Proposed  { decision: 1..2, attempts: 0..2, rechecks: 0..2 }   // decision 2 only for an approved re-proposal
    | Escalated { approved: bool, attempts: 0..2, rechecks: 0..2 }
    | Allowed   { attempts: 0..2, rechecks: 0..2 }                   // attempts already made; rechecks of a stale allow
    | Running   { attempt: 1..3, rechecks: 0..2 }
    | Settled   { attempt: 1..3, rechecks: 0..2 }
    | Done | Denied | Dead

  machine OutboxIntent {
    state { intent: Intent = Pending }
    terminal intent is Done | Denied | Dead

    action Propose()   action GateAllow()   action GateDeny()   action GateEscalate()
    action Approve()   action EscalationTimeout()   action Recheck()
    action Start()     action HandlerOk()   action HandlerFailed()   action HandlerFailedPermanent()
    action SettleOk()  action SettleFailed()

    on Propose {
      match intent {
        Pending => intent' = Proposed { decision: 1, attempts: 0, rechecks: 0 }
        Escalated { approved: true, attempts: n, rechecks: r } => intent' = Proposed { decision: 2, attempts: n, rechecks: r }
        _ => reject "not-proposable"
      }
    }
    on GateAllow    { match intent {
                        Proposed { attempts: n, rechecks: r } => intent' = Allowed { attempts: n, rechecks: r }
                        _                                     => reject "no-proposal" } }
    on GateDeny     { require intent is Proposed else reject "no-proposal"
                      intent' = Denied }
    on GateEscalate { match intent {
                        Proposed { decision: 1, attempts: n, rechecks: r } => intent' = Escalated { approved: false, attempts: n, rechecks: r }
                        _                                                  => reject "escalate-once" } }
    on Approve      { match intent {
                        Escalated { approved: false, attempts: n, rechecks: r } => intent' = Escalated { approved: true, attempts: n, rechecks: r }
                        _                                                       => reject "not-waiting" } }
    on EscalationTimeout { match intent {
                        Escalated { approved: false, attempts: _, rechecks: _ } => intent' = Denied
                        _                                                       => reject "not-waiting" } }
    on Recheck      { match intent {
                        Allowed { attempts: n, rechecks: r } => if r < 2 { intent' = Proposed { decision: 1, attempts: n, rechecks: r + 1 } }
                                                                else     { intent' = Denied }
                        _                                    => reject "not-allowed" } }
    on Start        { match intent {
                        Allowed { attempts: n, rechecks: r } => intent' = Running { attempt: n + 1, rechecks: r }
                        _                                    => reject "not-allowed" } }
    on HandlerOk    { match intent {
                        Running { attempt: n, rechecks: r } => intent' = Settled { attempt: n, rechecks: r }
                        _                                   => reject "not-running" } }
    on HandlerFailed { match intent {
                        Running { attempt: n, rechecks: r } => if n < 3 { intent' = Allowed { attempts: n, rechecks: r } }
                                                               else     { intent' = Dead }
                        _                                   => reject "not-running" } }
    on HandlerFailedPermanent { match intent {
                        Running => intent' = Dead
                        _       => reject "not-running" } }
    on SettleOk     { require intent is Settled else reject "not-settled"
                      intent' = Done }
    on SettleFailed { match intent {
                        Settled { attempt: n, rechecks: r } => if n < 3 { intent' = Allowed { attempts: n, rechecks: r } }
                                                               else     { intent' = Dead }
                        _                                   => reject "not-settled" } }

    step property no-reproposal-after-allow:
      (action != Recheck && (pre.intent is Allowed || pre.intent is Running || pre.intent is Settled))
        implies !(post.intent is Proposed)
    liveness settles: eventually intent is Done | Denied | Dead
      under fair { Propose, GateAllow | GateDeny | GateEscalate, EscalationTimeout, Start,
                   HandlerOk | HandlerFailed | HandlerFailedPermanent, SettleOk | SettleFailed }
  }
  ```

  The state has 17 representable values, and all 17 are reachable. The v0.3 encoding as five fields had 432 representable combinations, of which 33 were reachable, plus three invariants and two step properties whose job was to rule out the rest. With the union, those properties are types:

  - a second gate decision after execution cannot be written, because `Allowed`, `Running` and `Settled` carry no decision;
  - a deny after execution cannot be written, because `GateDeny` only matches `Proposed`;
  - `executed` is not a field, because it is `intent is Running || intent is Settled || …`.

  One step property is kept as a regression guard, and the liveness property holds with `HandlerFailedPermanent` in the fair group of the handler's outcomes (S138), which adds three transitions and no state. **A stale allow is rechecked (S147).** `Recheck` takes `Allowed` back to `Proposed`, keeping the attempts made, when a singleton the allow read has moved on; each intent is rechecked at most twice, and a third stale allow is `Denied` with reason `stale-allow`. The bound keeps `settles` true under weak fairness, since `Recheck` is not in a fair group. The step property becomes "no re-proposal except by `Recheck`". With the rechecks the machine has 17m + 8 states at bound m: 59 at the bound 3, all reachable. An independent exploration of the machine before S138 ([`reviews/evidence/outbox_sum_check.py`](reviews/evidence/outbox_sum_check.py)) confirms 17 reachable states, no deadlock and no fair cycle outside the terminal states.

  Three rules follow from the machine and are normative:

  1. **One decision per execution.** Once the gate allows an intent, a retry after a timeout or a failed settle goes back to `Allowed`, not to `Proposed`. The gate is not asked again for the same idempotency key, except by `Recheck`, when the state the allow read has moved on (S147). In v0.4 this is a consequence of the type.
  2. **Escalation happens once and has a timeout.** An approved re-proposal can be allowed or denied, never escalated again, so an intent takes at most two gate decisions. `escalation.timeoutMs` (the polyflow platform policy field) fires `EscalationTimeout`, which denies the intent.
  3. **Denial is final.** A deny can only happen from `Proposed`: before any attempt ran, or after a `Recheck` found the state the allow read had moved on (S147), when the attempts already made are kept and no further one is.
  4. **A permanent failure is final (S138).** A handler may report a permanent error (a declined card is a result, not an infrastructure failure). `HandlerFailedPermanent` takes `Running` to `Dead` whatever attempt it is, the worker dispatches the effect's `failed` completion, and no further attempt is made. A crash is never permanent: it is `HandlerFailed`.

  **The worker hosts the machine (S119).** poly-runtime runs its own effect worker, and polyrun's `tickEffects` is never started. Each intent's state is an `OutboxIntent` value in a poly-runtime table, and every worker transition is an action on the lowered `OutboxIntent` module, written in one transaction with the matching `pr_outbox` change. An action the module rejects is a runtime fault: the worker stops on that intent and reports it, and never takes the transition. A terminal transition and the completion it delivers commit in one transaction, behind the claim's fence: K1 extends to the hosted machine, so neither exists without the other, and a worker whose claim was taken over delivers nothing (review C1, C2). `Approve` and `EscalationTimeout` race, and whichever commits first wins; the other is a rejected step of the machine, journaled with its reason, and a late approval's caller gets an error saying the escalation timed out (review C3). Every park has a retry deadline. An outside dispatch to a hosted instance is refused before any step, with an audit row (review C4). A gate that throws holds only the intent it was asked about, `Proposed` with a backoff and never allowed (review C6, PT9.5). An intent keeps the bound it was created under: the runtime registers the machine of every bound the build declares and of every bound an intent in the store was created under, so a redeploy that changes a manifest's `maxAttempts` strands nothing (review C8). The machine for bound m is `runtime<m>.OutboxIntent` (`runtime.OutboxIntent` at 3), and these ids are the runtime's own: a program machine in a module named `runtime` or `runtime<m>` is `PL1208`, and `load` refuses one again, so whether a program loads never depends on the bounds or the store (S143). The only module the checker takes under those names is this model at a bound, identified by its module digest. A crash or lease expiry while `Running` is `HandlerFailed` and counts an attempt; the idempotency key (PT15) keeps a re-run of an effect that did execute from repeating it. A row the worker cannot place (machine or manifest unavailable) takes no transition. `Dead` is terminal: an operator who wants another try creates a new intent through a governed action, never by resurrecting a dead one.

  **The attempt bound (S120).** The machine above is the instance with `maxAttempts` 3. The runtime's CI checks it once per distinct `retry.maxAttempts` in the build, with `Allowed`, `Running` and `Settled` ranged over that bound, and the worker conformance runs at each. `load` refuses a manifest entry without `maxAttempts`, and admission refuses one above 10 (PT19, S137). The runtime's CI checks every bound from 1 to 10 and records the state count of each.

  **Each handler outcome is observed (S138).** With every `HandlerOk`, `HandlerFailed` and `HandlerFailedPermanent`, the worker writes an `observation` event on the emitting run, in the same transaction, naming the intent, the attempt and the outcome the handler gave (`ok`, `failed`, `permanent`, or `lost` for a crash). The runtime's CI pairs each observation with the transition taken, so a worker that retries a permanent error is `PL2401`.

  The check of this machine is gate M4b in PT18. Adding a state or a transition to the worker without changing this machine first is `PL2401 RUNTIME_MODEL_DRIFT` in the runtime's own CI.

- **PT9.8 The delivery protocol is a checked machine.** "Each message takes exactly one step at its receiver" (PS14.3) depends on the outbox worker, the network path and the receiver's dedupe table working together, with retries and archiving in between. The protocol is specified as a poly machine, with the network's choices as the environment's inputs, and checked. Two messages from one sender to one receiver are enough to exhibit every interleaving that matters: loss, duplication by resend, acknowledgement loss, archiving and ordering.

  ```poly
  module delivery

  type Msg = M1 | M2
  type Status = Unsent | Pending | InFlight | Acked

  service machine Delivery {
    state {
      status   : map<Msg, Status> = { M1: Unsent, M2: Unsent }
      req      : map<Msg, 0..2>   = { M1: 0, M2: 0 }            // request copies in the network
      ack      : map<Msg, 0..2>   = { M1: 0, M2: 0 }            // acknowledgement copies in the network
      lost     : map<Msg, 0..1>   = { M1: 0, M2: 0 }            // the network loses at most one copy per message
      seen     : map<Msg, bool>   = { M1: false, M2: false }    // the receiver's dedupe table (K4)
      steps    : map<Msg, 0..2>   = { M1: 0, M2: 0 }            // steps taken at the receiver
      archived : bool = false
    }
    action Emit(m: Msg)     action Send(m: Msg)       action Resend(m: Msg)
    action LoseReq(m: Msg)  action DeliverReq(m: Msg) action LoseAck(m: Msg)
    action DeliverAck(m: Msg)  action Archive()

    on Emit(m) {
      require status[m] == Unsent else reject "emitted"
      require m == M1 || status[M1] != Unsent else reject "emit-order"
      status' = status with [m] = Pending
    }
    on Send(m) {
      require status[m] == Pending && req[m] < 2 else reject "not-pending"
      require m == M1 || status[M1] == Acked else reject "in-order"      // the in-order worker
      status' = status with [m] = InFlight
      req' = req with [m] = req[m] + 1
    }
    on Resend(m) {
      require status[m] == InFlight && req[m] < 2 else reject "not-in-flight"
      req' = req with [m] = req[m] + 1
    }
    on LoseReq(m) {
      require req[m] > 0 && lost[m] < 1 else reject "no-loss"
      req' = req with [m] = req[m] - 1
      lost' = lost with [m] = 1
    }
    on DeliverReq(m) {
      require req[m] > 0 else reject "nothing-in-transit"
      req' = req with [m] = req[m] - 1
      if ack[m] < 2 { ack' = ack with [m] = ack[m] + 1 }
      if !seen[m] { seen' = seen with [m] = true
                    steps' = steps with [m] = steps[m] + 1 }
    }
    on LoseAck(m) {
      require ack[m] > 0 && lost[m] < 1 else reject "no-loss"
      ack' = ack with [m] = ack[m] - 1
      lost' = lost with [m] = 1
    }
    on DeliverAck(m) {
      require ack[m] > 0 else reject "no-ack"
      ack' = ack with [m] = ack[m] - 1
      if status[m] == InFlight { status' = status with [m] = Acked }
    }
    on Archive {
      require !archived && steps[M1] == 1 && steps[M2] == 1 else reject "not-done"
      archived' = true                                  // the dedupe table is kept (K4)
    }

    invariant at-most-once: steps[M1] <= 1 && steps[M2] <= 1
    invariant in-order: steps[M2] >= 1 implies steps[M1] >= 1      // M2 never steps before M1 (S64)
    liveness exactly-once:
      eventually (status[M1] == Acked && status[M2] == Acked && steps[M1] == 1 && steps[M2] == 1)
      under fair { Emit(*), Send(*), Resend(*), DeliverReq(*), DeliverAck(*) }
  }
  ```

  Losses are not in the fairness list: the network may lose, but only finitely often (`lost` bounds it). The results of an independent exploration ([`reviews/evidence/delivery_check.py`](reviews/evidence/delivery_check.py)) are:

  | Variant | Result |
  |---|---|
  | In-order worker, dedupe kept on archive (the machine above) | 1,147 states; `at-most-once` and `in-order` hold; `exactly-once` holds under the stated fairness |
  | Parallel worker (no `in-order` guard), dedupe kept | 2,368 states; `at-most-once` and `exactly-once` hold |
  | Parallel worker, `in-order` required | violated in 4 steps: `Emit(M1), Emit(M2), Send(M2), DeliverReq(M2)` |
  | In-order worker, dedupe cleared on archive | `at-most-once` violated in 10 steps: `M1` is resent, delivered, acknowledged; `M2` is delivered; the receiver is archived; the duplicate of `M1` arrives and takes a second step |

  Three rules follow and are normative for the runtime:

  1. **Dedupe records live as long as the instance** (K4). Archiving keeps them.
  2. **`fifo` requires the in-order worker.** A pair declared `fifo` is served by a worker that sends a message only after the previous one to the same receiver is acknowledged. For co-located pairs this is local, in-order dispatch.
  3. **Unordered delivery is the default.** Without `fifo`, the parallel worker is used. Exactly-once still holds, and order is not promised.

  The runtime's conformance to this machine is kernel assumption K8, checked by trace replay at M4. polyrun's message worker is the parallel one, so its traces replay against the parallel variant (`examples/delivery/delivery-parallel.poly`), through an abstraction function written down in the test: `Emit` is the sender's commit, `Send` a claim, `Resend` a claim after a lease recovery, `LoseReq` a crash before the receiver commits, `DeliverReq` the receiver's commit or dedupe hit, `LoseAck` a crash between that and the mark, `DeliverAck` the mark `done`, `Archive` the purge (S125).
- **PT9.9 Sends across trust scopes.** A `send` from one trust scope to another is proposed to the gate like an effect (PS8.7). The proposal carries `kind: "send"`, the target's machine and scope, the action, and the payload digest. On deny, the runtime does not deliver the message. It delivers `SendDenied(to, action, reason)` to the sender instead, with its own idempotency key. Sends within one scope are not proposed. **As built (M5a, S160).** An instance's trust scope is its machine's module, unless its configuration assigns one with `scope "x"`. A policy reads a send through `proposal.kind == "send"` and `send.to` (the target machine), `send.action` and `send.scope`. The runtime proposes each message between two scopes in the sender's session before polyrun delivers it: allowed, it is delivered; denied, it is marked dead and `SendDenied(to, action, reason)` is dispatched to the sender with the action id `<message>:send-denied`; a gate that cannot decide leaves it pending. A message has one gate decision: a delivery retried after an allow goes under the recorded allow, and a recorded deny is finished without a new proposal. The proposal's `send` also carries the target instance (`send.instance`) and the payload's digest (`send.payloadDigest`), so the verdict binds the data it allowed. A send has no approval path in M5a, so an escalation of one is denied, with the reason saying so. The configuration check explores the gate's choice on every message between instances of different scopes: delivered (allow), turned into `SendDenied` to the sender (deny), or held and then delivered or denied (escalate). **M5a limit:** a scope is a module and a cross-module address is not lowered (`use`, PL0901), and the runtime has no configuration instances before S153 (E5), so no program makes a cross-scope send at runtime in M5a; the runtime path is tested with a message injected below the language, and M5b adds the end-to-end test.

## PT10. Workflows

```poly
workflow customer-brief runs Brief {
  input Start
  key "{date}" where date matches "^\\d{4}-\\d{2}-\\d{2}$"
  tool "brief.post" -> slack_send target "#cs" why "publish the approved brief"
}
```

This lowers to `polyflow.workflow.json`:

- `name`, `inputAction`;
- `key.template`, `key.fields`;
- `tools: { <effect kind>: { tool, target, why } }`.

It also produces the five machine files. The run key is derived as `agent | instance | workflow | key`, so starting and attaching are one call. Effects become work orders over the existing MCP tools:

- `workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal`, `workflow_journal`, `workflow_list`;
- with polycrew, also `workflow_next` and `workflow_claim`.

**As built (M6, S166).** `workflow w runs M { input A  key "t" where f matches "re", …  tool "kind" -> t target "x" why "y" … }` is a top-level declaration on both surfaces; the embedded form is `workflow(name, { runs, input, key: { template, where }, tools: { kind: { tool, target, why } } })`. `M` is a machine of the same module (`PL1001` otherwise). The input is an action of `M` with a handler (`PL6801`). The key's template names at least one field; each is a parameter of the input action; a `where` field is one the template names; each pattern compiles; and each value of the field's check domain matches its pattern (`PL6802`). Each effect kind of `M` maps to exactly one tool, and each mapped kind is an effect of `M` (`PL6803`). `target` is optional; `why` is required.

**Lowering and admission as built (M6, S165).** For each workflow, `poly check` writes `.poly/build/workflows/<name>/polyflow.workflow.json`: `name`, `inputAction`, `tools` by effect kind, `key` with its template and the patterns of its `where` fields, and the paths of the machine's lowered files beside it (`../../<module>.<Machine>/next.cjs` and the rest), so nothing is copied. Translation validation reads each descriptor back against its source, and the broken lowerings `workflow-tool` and `workflow-key` are listed. In M6 a `workflow` stage ran polyflow's own admission, the vendored library's `certify`, at its bounds; since M8a it is retired (S175), and a workflow's machine is checked by poly's own stages like any other. A workflow's machine always has `effect-invariants.mjs`, and `PL6804 WORKFLOW_UNCHECKED` guarantees its list is never empty (S165 as amended by S172). The rule first mirrored polyflow's admission; it stays after S175 because the gate checks each work order, and only a path property checks their order, so a workflow whose machine declares none is refused by `poly check`, at the workflow's line, with no fix offered.

**Workflows run on `poly-runtime`, under the gate (M8a, S164, S173 to S175).** In M6 a workflow ran on polyflow's daemon, outside the gate, and the certificate listed it as `ungated: polyflow runtime`. Since M8a it runs on `poly-runtime`:

- A run is an instance of the workflow's machine, named `<workflow>|<key>`, with the key derived from the input by the key template and its patterns, as polyflow derives it; a key the caller passes is ignored, with a note, so starting and attaching are one call.
- Each effect kind the workflow maps is a **work order**. The outbox worker proposes it to the gate like any effect. On an allow the order is issued, with the tool, target, reason and arguments, observed on the run by digest after the gate's `verdict` event; on a deny no order is issued and the effect's failure completion is delivered; on an escalation the order is issued only after a person's signed approval (PT12.5).
- The gate's decision is bound to the intent, once (PF8.5a). Each issued attempt has an order id of its own, derived from the intent and the attempt number and opaque to agents. An order not reported by its deadline (the effect's declared timeout) is a lost attempt, re-issued under a new order id at the next attempt and never proposed again. An order exists only once its issue is in the ledger.
- The agent's report settles the intent, through the gate's settle and the completion, as a handler's result does. A report of an unknown order, of an order not issued, of a replaced or lapsed attempt, or a second report of one order, is refused and audited. A work order's kind takes no handler.
- A work order's completion actions are delivered by the runtime only (K9): an outside dispatch of one is refused and audited.
- The six tools keep polyflow's names and schemas; `workflow_report` names only `order_id`. They are served by `poly run --mcp`, which loads the runtime from `poly.json`'s `run` field (PT1.2, S188), with no approve or accept tool (S174). Once a second, in the same queue as the calls, the server takes every due step, signs the ledger's heads when a signer is configured, and takes the approvals drop folder (S189): each `*.json` record, in file-name order, is verified against the certified keyring and must name the open escalation (intent and gate sequence); it is applied once, and refused as `replayed` if it appears again under any name, as `expired` after its escalation timed out, as `unmatched` or `wrong-key` otherwise; every outcome is journaled on the runtime's own `runtime:approvals` run with the record kept by digest, and the file is moved to `applied/`, or to `refused/` with its reason in a sidecar file.

The certificate lists each workflow as `{ runtime: "poly-runtime", gated: true }`, with no `ungated` limit, and a certificate that lists one as run by polyflow is refused at load. The descriptor `polyflow.workflow.json` stays the artefact the runtime reads, with its read-back unchanged. E9 is withdrawn (S175). The vendored polyflow server stays only as AC5's oracle in the tests.

## PT10b. Ingress and the runtime channel adapters, as built (M8 plan step 8, S182, S183)

- **Where.** `packages/poly-io` holds ingress and the five channel adapters, and is the only package with a network module. It imports node builtins and the adapter interface `@poly/runtime/adapters` as types only; no check package imports it. The boundary check enforces both directions.
- **The interface** (`@poly/runtime/adapters`, PT20.2). An adapter has a `kind` (the std channel kind whose `Inbound` fields it produces), a `provider`, `verify(webhook, now)` and `send(out, transports)`. `verify` takes the raw webhook (method, full URL, headers, body) and returns the inbound messages (the provider's message id, the `Inbound` fields, the body, the sender claims), the provider's receipts, and the answer to a handshake, or a refusal. Receipts arrive as webhooks, so `verify` returns them; PT20.2's `receipts() → stream` is that sequence. `send` returns the provider's id, or a failure marked permanent when a retry would fail the same way. A send reaches the network only through a transport it is given (HTTP or SMTP), so a test replays recorded traffic.
- **The adapters.** `whatsapp` (WhatsApp Cloud API), `sms` (Twilio), `email` (Mailgun route webhook in, RFC 8058 one-click unsubscribe, SMTP submission out), `slack` (Events API in, `chat.postMessage` out), `webhook` (Standard Webhooks both ways). Each checks its provider's signature in constant time and refuses a forged, changed or stale webhook. Its rules and sources are in `packages/poly-io/PROVENANCE.md`.
- **Ingress** (PT21.4). `ingress(host, channels)` returns a handler: a refusal is recorded on `runtime:ingress` (stage `verify`, the provider, the reason) and nothing is dispatched; a receipt is recorded (stage `receipt`); a message's body goes to the content store, its claims are recorded (stage `claims`, K11), and it is dispatched with `rt.inbound`. `serveIngress` puts the handler behind `/channels/<name>`. The runtime is the host: `rt.ingressRecord` journals on `runtime:ingress`, and `rt.claimNonce(channel, key, until, now)` takes a provider's nonce (Mailgun's token) once, in the store, and keeps it until `until`, the time the adapter stops taking its signature (the provider's timestamp plus the tolerance, review D-F6), so a replay after a restart, or at any clock skew, is refused. **Claims only from the adapter (review D-F4, M8b):** a host that is a poly runtime receives each webhook itself, `rt.receive(channel, webhook, adapter?)`, by its own clock and with a certified adapter of the channel (the one `ingress` hands it with the webhook, else the one connected; any other is `PL6408`); `rt.inbound` takes no claims from its caller, so an `Inbound` that declares claims is refused `claims-unverified` there. `rt.connectChannel(channel, adapter, transports)` makes the adapter the handler of `channel.<c>.send`; a failure it reports with provider events delivers each to the conversation before the failure completes. **Certified (plan step 10, S182):** admission binds each channel's adapter by package name, version and digest (`poly.adapters`), `load` refuses another installed package, and `rt.connectChannel` takes only an adapter the certified package made, of the adapter the channel declares (`PL6408 ADAPTER_NOT_CERTIFIED`). **Claims (AC14):** each std conversation's `Inbound` takes the claims `Sender { verified: Verification }`; ingress passes the adapter's, which only the runtime supplies, and the application's steps carry them by lineage.
- **Addresses and erasure, as built (M9 step 9, S191, S205; PS3.2, PS15.4).** The content store is erasable. `putContent` and the address store mark what they keep as erasable (`poly_erasable`); `rt.erase(digest)` deletes the body, records the digest in `poly_erased` and journals `{ stage: 'erasure', digest }` on `runtime:content`, and refuses any other digest (a step's data, a proposal, a verdict's record), since the journal keeps those. An erased digest is never stored again. A thread key and each field it reads are kept by `store.keepAddress` under their HMAC-SHA256 digest by the store's own key; `rt.threadId(channel, key)` gives the application instance `<channel>:<keyed digest>`, which ingress delivers to and a host that creates a thread itself names; the conversation's `Inbound` is dispatched with each field the template reads replaced by its keyed digest; and the claims ingress records carry the sender's keyed digest. The send handler of `channel.<c>.send` reads the recipient from the store by the thread's digest, and fails permanently when it is erased. The certificate no longer names the limit S191. The fault `address-in-clear` (`RUNTIME_FAULTS`) is the address scan's seeded control. As fixed by the review of M9: a provider event delivered on a failed send has each field the template reads replaced by its keyed digest, and the provider's error text has the recipient replaced by the thread's digest, before either is journaled (B1); and the records the journal keeps by digest are stored apart from bodies and addresses (`poly_kept`), so a body whose bytes are a record's canonical form (`{}`, say) shares its digest and is still another entry: erasing it deletes no record, and each reads back as what it is (B5).

## PT10d. The provider's clock and the tested measure, as built (M8 plan step 10, PS15.5, PS5.2a)

- **Timers in a channel's generated configuration.** poly-ref's global state for a channel's generated configuration holds the conversation's armed timers; the environment fires any of them, a firing disarms its key, a `cancel` disarms it, and an `after` arms or re-arms it. Since S206 (ruled 2026-10-06) every configuration does the same for every instance that arms a timer, declared ones included, which closes the limit S192. **The joint configuration (S207).** The compiler's expansion and poly-ref's reading each add, for an application whose handler of one channel's message emits on another channel, a configuration named after the application with `joint` naming its channels, every conversation live, instances `1 + n` and transit the sum of the `pending` bounds; poly-ref explores it to `JOINT_CAP` (10,000) global states, and the cap is `PL3901`.
- **A `never` tested, or vacuous.** For a machine checked alone and for each configuration, a `never` is tested when an action whose handler can emit its effect is taken from a reachable state where its `while` holds; an untested `never` is listed under `vacuous` with its reason, and the verdict is at best `INCONCLUSIVE`.
- **Faults** (`REF_FAULTS`): `no-timer-firing`, `fire-disarmed`, `weak-vacuity`, for one test each; `checkFile` takes one as `refFault`, for the tests only.

## PT10c. The proposal field `channel`, as built (M8 plan step 9, S181, S185, PT25.1)

- **The field.** A proposal for `channel.<c>.send` carries `effect.channel = { name, kind, recipient, recipientClass, messageKind }`: the channel, its std kind, the recipient as `hmac-sha256` of `<kind>:<thread key>` under the store's own key (never the address, and not invertible by enumerating addresses, G10), the class `external` (every recipient in M8; audiences come in M10, S181), and the message kind of the send's payload where the kind has one (`FreeForm`, `Templated`, `Direct`, `Bulk`). Any other proposal has no `channel`.
- **The front end** types `effect.channel.*` against the program: `name` among its channels, `kind` among their kinds, `messageKind` among their conversations' kinds, `recipientClass` `external`, `recipient` any string; another field is `PL1001`. A missing field is unknown (PS8.2).
- **The engine.** Polyaxion reads the field as it reads every reserved action field, with no change (E10 not needed for `channel`, settled by test). The certificate pins its commit (`poly.policyEngine`); admission and `load` read the pinned files afresh and refuse a checkout whose files differ, naming them, and `load` refuses a build admitted with another commit.

## PT10a. Channels, as built (M8b step 1, PS15)

**The std kinds (M8b step 2).** `std/channels` holds `whatsapp`, `sms`, `email`, `slack` and `webhook`, each written from its provider's documentation and recorded in its `PROVENANCE.md` with the date it was read. A conversation is a `service`, accepts a forbidden send and sends `Rejected(reason)`, holds one slot for a send and then its receipt until the application's `Ack()`, queues a reply that answers a waiting message while the slot is held (a template, or a reply that answers none, is refused `busy`, which the configuration reports as `PL5407`), keeps at most two messages waiting or queued (`backlog` refuses a third), and declares `pending: 0..3`. A status a rule reads reaches the conversation as a provider event (PS15.4): `email`'s `Bounce` (a permanent failure reported after the send, or a 5yz reply to `RCPT TO`), `slack`'s `Archived` from `is_archived`, `webhook`'s `Undelivered`. Review of M8b: the queue's order is three step properties of every kind (`queue-shifts-in-order`, `queue-appends-first`, `queue-appends-second`); a WhatsApp message opens a closed window even when the backlog is full, and only its message to the application is dropped (`message-always-opens-window`); an SMS's consent changes only on a keyword; an email bounce is counted only from the provider event `Bounce` (`bounces-only-from-the-recipient`); and a Slack reply queued behind a post waits for the one-second timer in the slot `Waiting` and is posted when it fires (`queued-reply-waits-for-the-clock`), never refused `rate-limited`. The expansion appends `send c <- Ack()` to each handler of the application bound to a receipt (PS15.3); an author never writes or binds it, and a kind without `Ack()` is `PL6811`. Each states its provider's rules as `never` statements and step properties, and each rule has a seeded mutant in `test/std-channels.test.mjs`.

A channel is the top-level declaration of PT21.1 with a binding per Peer action:

```poly
channel support: test {
  adapter "test"
  thread "{from}"
  starts Ticket.Start on inbound
  Message -> Ticket.Got
  Delivered -> Ticket.Delivered
  Rejected -> Ticket.SendRejected
  Failed -> Ticket.SendFailed
}
```

- **The kind** names `std.channels.<kind>`, which declares the interface machine `Peer` (actions only), the machine `Conversation` with `Open(app: Ref<Peer>)`, `Inbound(…)`, `Reply(…)`, `Template(…)`, an effect `send`, and a field `pending: 0..N`. A kind without them is `PL6811 CHANNEL_KIND_UNKNOWN`.
- **The thread key** reads checked-string fields of the conversation's `Inbound` (`PL6812 THREAD_KEY_INVALID` otherwise).
- **The binding** `P -> A.X` is total (`PL6813`), one-to-one (`PL6814`) and typed against the Peer action's parameters by name and type (`PL6815`). `starts` names an action of `A` with no parameters and a handler; `on inbound` declares that an inbound message for an unknown thread creates the application.
- **The expansion** (PS15) is the compiler's and, separately, poly-ref's. `A`'s `starts` handler gains `spawn detached m.c.Conversation as c -> Open(app: self)`; in `A`'s handlers `c` is the conversation's address and `emit c.reply(…)`, `emit c.template(…)` are sends; the module `m.c` holds the conversation with `Peer` read as `A`, its sends renamed, and its effect kind `channel.c.send`; the configuration `c` is generated, and declared configurations that include `A` gain the conversation. A `never` or `emits` on `c.reply` in `A` is `PL1001`.
- **The report** lists the conversation as the machine `c.Conversation` and the generated configuration under the channel's name. The build holds `.poly/build/m.c.Conversation/` and the descriptor `.poly/build/channels/<c>.json` (the application, the conversation, `starts`, the inbound route, the binding, the effect kind, the library and its digest), read back by translation validation against PS15 and certified like a workflow's descriptor (`poly.channels`).
- **At run time** `rt.inbound(channel, fields, { messageId })` follows PS15.4: the application instance is `<channel>:<key>` and its conversation `<channel>:<key>/<channel>`; the reserved reasons `unknown-thread` and `thread-not-started` are journaled on `runtime:ingress`, with `outside-type` for fields outside the `Inbound` type and `claims-unverified` for an `Inbound` that declares claims, which only `rt.receive` supplies (review D-F4, D-F7, M8b); the message's action id is `<channel>:<messageId>`. Creating a conversation needs polyrun's `createInstance` intent, which waits on E13.
- **The broken lowerings** `channel-drop-spawn`, `channel-swap-rename` and `channel-inbound-to-app` are in the explicit list of toolchain faults.

## PT10e. Credentials, as built (M9 step 5, PT22.1, S203)

A credential is a top-level declaration, and an effect names the one it uses:

```poly
credential payments: oauth2 {
  provider "stripe-connect"
  grant authorization_code
  scopes { read_write }
  holder Principal
}

effect refund(merchant: Principal, amount: 0..500) {
  kind "payments.refund"
  labels { egress:external }
  targets { egress: "https://api.stripe.com/v1/refunds" }
  uses payments { read_write } for merchant
  class irreversible
}
```

- **The declaration.** `oauth2` is the one kind. `grant` is `authorization_code`, with `pkce` where the provider supports it (on behalf of a person, the holder), or `client_credentials` (the service itself, no holder). `scopes` is a finite set of provider scope names, each an identifier or a dotted one; `holder Principal` is required for `authorization_code` and absent for `client_credentials`. Each item is written once.
- **The provider profile.** `provider "p"` names `std/credentials/providers/p.json`, data the vault adapter and the checker both read: the provider's base addresses, its authorization, token and revocation endpoints, the grants it supports, whether it supports PKCE, the scope names it defines, and the source and date they were read from (`PROVENANCE.md` beside it). A provider with no profile is `PL1001`; so is a scope the profile does not define. A grant the provider does not support, or `pkce` where it has none, is `PL1201`. The example's profile is Stripe Connect's, as its OAuth reference documents it: the scopes `read_write` and `read_only`, the authorization code grant, and no PKCE.
- **`uses c { s… } for p`** in an effect. `c` names a credential of the module (`PL1001`); each scope is one `c` declares (`PL6821 SCOPE_NOT_DECLARED`); an `authorization_code` credential needs `for p` (`PL6822 HOLDER_NOT_NAMED`), and `p` names a `Principal` parameter of the effect (`PL1201`); a `client_credentials` credential takes no `for` (`PL1201`). Every egress target of the effect lies under one of the provider's base addresses (`PL6823 TARGET_OUTSIDE_PROVIDER`), and an effect with `uses` declares at least one egress target.
- **Lowering.** Each credential an effect uses is written to `.poly/build/credentials/<c>.json` (the provider, the grant, PKCE, the scopes, whether it has a holder, and the profile's digest), and the effect's manifest entry gains `uses: { credential, scopes, holder }`. poly-ref reads both back from the source on its own; the broken lowerings `credential-scope-added`, `credential-holder-dropped` and `credential-base-widened` are in the explicit list of toolchain faults.
- **Both surfaces.** The embedded form is `credential(name, { kind, provider, grant, pkce?, scopes, holder? })` and the effect item `uses(credential, [scopes], holder?)`. A credential's name is an identifier in both (`PL1201` otherwise), since it names a file of the build and a module (review A2, M9).
- **The grant, as built (M9 step 6, PS16, S204, S209).** `std/credentials/grant.poly` is `module std.credentials`: the record `ScopeSet` (two scopes when checked alone) and the machine `Grant` with the state `g` (`Requested`, `Granted`, `Refreshing`, `Expired`, `Revoked`), the scopes granted, and `attempt : 0..3`; the effects `credential.refresh`, whose completion `Refreshed(valid)` carries the token endpoint's answer (`valid` false for RFC 6749's `invalid_grant`), and `credential.revoke` (RFC 7009), which `Revoke()` emits from every state but `Revoked`, `Requested` included: a grant asked again after it was granted still holds tokens until the holder answers, and a revocation in between forgets them (review C1, M9). Its rules and their sources are in `std/credentials/PROVENANCE.md`. A module with a credential uses `std.credentials`; `expandCredentials` writes the module `m.c` for each credential, which `poly check` checks and lowers like a channel's conversation and reports as `c.Grant`, and poly-ref writes the same module from PS16.1 on its own. The tests' std holds the same file, byte for byte.

## PT10f. Vault adapters, as built (M9 step 7, S200, S202, S208)

- **Where.** `packages/poly-io/src/vault.ts`: the vault adapter of PT22.3 and PT22.5, made like a channel adapter (frozen when made, recognised by `madeHere`). Its interface is `@poly/runtime/adapters`' `VaultAdapter`. It is built and tested against a generic OAuth 2.0 provider written from RFC 6749, RFC 7636 and RFC 7009 (the tests' profile `test-oauth`), with recorded traffic only.
- **Provider profiles.** A profile may add, beside PT10e's fields: `scopeValues` (the value a scope name is sent as, Google's scope URLs for example), `authParams` (fixed parameters of the authorization request, Google's `access_type=offline`), `attach` (`bearer`, by default, or `stripe-account`) and `revocationStyle` (`rfc7009`, by default, or `stripe-deauthorize`). `std/credentials/providers` holds `stripe-connect` (S208: the platform's secret key attached as `Authorization: Bearer`, the connected account as `Stripe-Account`, and Stripe's own deauthorization) and `google` (Gmail's `gmail.readonly`, `gmail.compose` and `gmail.send`, PKCE, RFC 7009 revocation), each with its sources in `providers/PROVENANCE.md`.
- **`oauthVault(profile, client, store, transports)`.** `client` is the host's OAuth client (`clientId`, `redirectUri`, and `clientSecret` for a confidential client), given at load as runtime configuration, never journaled. `authorize({ grantId, scopes, now })` returns the authorization URL (`response_type=code`, the client, the redirect URI, the scopes' values, `state`, and, where the profile has PKCE, `code_challenge` with `S256`), the `state` and its expiry; the state and the PKCE verifier are kept in the vault store, never in the journal. `verify(webhook, now)` reads the provider's redirect to `/credentials/<name>`: an error or an unknown or expired state is a refusal; otherwise it exchanges the code at the token endpoint (with the verifier), keeps the token set, and returns the grant id, the scopes granted (the response's `scope`, or the scopes requested when it has none, RFC 6749 section 5.1) and the state as the nonce, which ingress takes once. `refresh(grantId)` answers `{ valid }`, false for `invalid_grant`, and throws on a failure worth a retry; `revoke(grantId)` revokes at the provider and forgets the token set; `withToken(grantId, request)` sends a request under the profile's base addresses with the credential attached inside the adapter, and returns the response with `authorization`, `proxy-authorization`, `set-cookie` and `www-authenticate` removed. No method returns a token. As fixed by the review of M9: a grant's operations run one at a time per grant id, so a refresh and a revocation never interleave (C3); an exchange that returns no refresh token keeps the one the grant held (C4); each token set is sealed with its grant id inside the encryption, and one read under another id is refused (C5); a revocation answered `400 invalid_token` forgets the token set, since the provider says it is already invalid (C6); and a state the store does not hold is refused without being remembered (C7).
- **The stores.** A store keeps each grant's token set encrypted by grant id, outside the project and the content store. `devKeychain({ key, dir })` encrypts with AES-256-GCM under a key read from `key`, an absolute `file:` path outside any project, as the ledger signer's; `kmsStore({ wrap, unwrap, dir })` takes the host's wrapping pair, so a cloud KMS is the host's code. With no `dir` a store keeps its ciphertext in memory.
- **The callback through ingress.** `credentialIngress(host, vaults, clock)` serves `/credentials/<name>`: the vault's `verify`, the state taken once with `host.claimNonce`, and on success `host.grantCallback(credential, grantId, scopes)`; every refusal is recorded on `runtime:ingress`. A callback the grant does not take (it was revoked, or is not `Requested`) is refused `not-accepted`: the vault revokes the token set it has just received, and nothing is recorded as granted (review C2, M9). `serveIngress` routes both paths.
- **Certified.** `poly.json` names each credential's store, `credentials: { "<name>": { "store": "dev-keychain" | "kms" } }`, and a project for production is one whose keyring anchor says so (S210; until S210, a field of `poly.json`). Admission binds each credential's vault in the certificate (`poly.vaults`: the credential, the store, and `@poly/io` by name, version and digest) and refuses the development keychain in a production build (`PL6826 VAULT_NOT_FOR_PRODUCTION`). `rt.connectVault(credential, adapter)` takes only an adapter the certified package made, of the certified store and of the credential's provider (`PL6408`). The certificate's `poly.credentials` (each name and its descriptor) is read back at admission, with the broken writer `rename-credential` in the certificate's faults; load reads each descriptor once with the certified bytes, refuses one whose `credential` is not the name the certificate gives it, and the runtime keeps what it read (review D4, D5, B7, M9).

## PT10g. Grants at run time, the grant check and `api`, as built (M9 step 8, PS16.3, PS16.4, S199, S201)

- **Grant instances.** The instance of `m.c.Grant` for credential `c` and holder `h` is `grant:<c>:<keyed digest of h>#<n>`, the digest an HMAC under the store's key (S191), and `grant:<c>#<n>` for a `client_credentials` credential, `n` the grant's generation (a new one after a revocation). A grant id belongs to `c` only with one of these two prefixes (review C8, M9). Only the runtime takes a grant's transitions other than `TokenExpiring`: `Callback` from the vault's callback, `Reauthorize` from `rt.requestGrant`, `Refreshed` and `RefreshFailed` from the refresh's completion, and `Revoke` from the sources of PS16.4. Any other dispatch of them is refused before any step and audited (rule `PS16.4`, review B2, M9). `rt.requestGrant(c, holder)` creates it (or asks again, `Reauthorize`, from `Granted` or `Expired`) and returns the vault's authorization URL for the host to deliver (PT22.3); the URL is never journaled. `rt.grantCallback(c, grantId, scopes)` dispatches `Callback(granted)` with one field per scope; `rt` is the `CredentialHost` of `credentialIngress`, recording each callback's outcome on `runtime:ingress`. `rt.connectVault` registers the handlers of `credential.refresh` (the vault's `refresh`, whose `{ valid }` completes `Refreshed`) and `credential.revoke` (the vault's `revoke`). Nothing dispatches `TokenExpiring` on its own: the host does, from the token lifetimes it knows.
- **The grant check (PS16.3).** The worker's `grantCheck` reads the effect's manifest entry `uses`, the payload field it names as holder and the instance as of the proposal: no vault, no instance or a state other than `Granted` is `credential-unavailable`; a scope not granted is `insufficient-scope`; both before the mandate and the policy. A passing intent is proposed with `credential: { name, grantState, scopes }`, and the allow's `reads` include the instance's sequence number, so a grant that steps before the intent starts makes the allow stale (S147).
- **Policies.** `effect.credential.name` and `effect.credential.grantState` are readable in a policy, typed as strings of the program's credentials and the grant's states. On a proposal with no credential they are unknown: a rule over them denies under `on unknown deny`, which is how E11 is settled, by test, on the pinned Polyaxion (S199). Since the grant check precedes the policy, poly-ref's decision table gives each proposal of an effect with `uses c` the credential `{ name: c, grantState: Granted }`; and where a policy reads `step.mandate.delegate` or `step.mandate.delegator`, the table takes no mandate, and each pair of distinct values among the strings the scope's policies name and one more (review A1, M9).
- **`api` (PT22.5, S201).** The handler of an effect with `uses` receives `api` in place of `egress`: `api.get(url, { headers })` and `api.post(url, body, { headers })`, each checked against the effect's declared egress targets (`PL6406`, audited, otherwise) and sent through the vault's `withToken` for the intent's grant. It follows no redirect.
- **Revocation (PS16.4).** `rt.revokeGrant(c, holder, { source })` dispatches `Revoke()` and records the source on `runtime:ingress`: `provider` (the provider's notice, such as Stripe's `account.application.deauthorized`), `security` (a PD5.3 signal on the holder), or `person`, with a signed record of the kind `revocation` over `rt.revocationSubject(c, holder)`, the digest of `{ grant: <instance id> }`, by a key of the `people` ring; an agent's key is refused. `poly grant-revoke --grant <id> --by <key id> --key file:PATH` writes such a record, and `poly grant-request --credential <c> --for <holder> --by <key id> --key file:PATH` writes a request to the approvals folder, which `rt.takeApprovals` takes. Neither is served over MCP. As ruled on S210 (B3, D6), a request is signed as a revocation is: the file is `{ kind: "grant-request", credential, holder, record }`, the record of the kind `grant-request` over the digest of `{ credential, holder }`, by a key of the `people` ring. `rt.takeApprovals` takes each record once (its digest is kept in `poly_used_record`) and refuses, journaled, an unsigned request (`not-a-record`), one by an agent's or an unknown key or over another subject (`wrong-key`), and one taken before (`replayed`), so a `Granted` grant cannot be pushed back to `Requested` by anyone who can only write to the folder.
- **The lint.** A handler that imports `@poly/io` is `PL6401`. A handler that reads a response header that carries a credential (`authorization`, `proxy-authorization`, `set-cookie`) by name is `PL6824 TOKEN_READ_IN_HANDLER`.
- **`PL6825 SECRET_IN_CONFIG`** (as ruled, 2026-10-07). No secret value lives in a project file: an adapter receives its secrets from the vault or the environment at run time. Admission refuses `poly.json`, and every file the certificate binds (the sources, the handler files and the installed package files they import, the lockfile, and every certified artefact, adapter configuration among them), when one holds a token-shaped string, naming the file and the kind of string and never repeating it: a Stripe secret or restricted key (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`), a Slack token (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`), a Google access token (`ya29.`), a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), an AWS key id (`AKIA`), a JSON Web Token, or a PEM private key. A secret in another shape is not found; the limit is stated.

## PT10h. Generated host types and edit-and-check, as built (M10 step 0, PT28.1, PT28.4, Q9, S311 to S313)

Q9 placed these two at the start of M10 (decisions-m9.md); neither adds a construct to the language.

- **`types.d.ts` (PT28.1a, S311).** Lowering writes `types.d.ts` beside each machine's artefacts, `.poly/build/<module>.<Machine>/types.d.ts`. Its first line names the machine and its module digest, the `machineVersion` of its `contract.json`. It declares, in this order:
  - `Content` and `Principal`, each a branded string (`string & { readonly __poly: "Content" }`), so host code passes one it was given and cannot build one from a string by accident;
  - `State`, the state as the host reads it from `rt.dispatch` and `rt.getState`: the flat keys of PS9.1b in the contract's order, each with its type;
  - `Action`, the union of `{ action: "A"; data: { … } }` over every action the machine declares, in declaration order, with each parameter's declared type (claims are the verifier's, never the caller's, and are not in `data`);
  - `Effects`, each effect's and decision's kind with its payload type;
  - `Completions`, each kind with each outcome it declares (`ok`, `failed`, `exhausted`) and the data type of the action that outcome dispatches.

  A type is written as the runtime carries the value: `boolean`; an integer range of at most 64 values as the union of its literals, and any other integer, and a `Conf`, as `number`; `string`; an enum, or a union's tag, as the union of its constructors' names; a union with payloads below the top of a field as `{ "$": "C"; p: T }` per constructor (S65); a record as an object of its fields; a map keyed by an enum as an object with one key per member, and a map keyed by a range as an array; an address as `string | null`; `Content` and `Principal` with `| null`. A payload field of a union at the top of the state is its flat key, `T | null`.
- **The typed dispatch (PT28.1b).** `rt.dispatch<A>(id, action, data)` takes a machine's `Action` as its type argument: with it, the action name must be one of `A`'s and the data must be that action's; with none, the call is untyped, as before.
- **The read-back (PT28.1c).** poly-ref writes the declarations it expects from its own model of the machine and compares them with the file, line for line; the first line's digest must be the contract's `machineVersion`. A difference is `PL2501`. The broken lowering `types-widen-param`, which writes the first parameter of the first action that has one as `unknown`, is in the explicit list of toolchain faults. `types.d.ts` is a certified artefact: the certificate lists its digest, and load compares it like any other.
- **`poly check --host <tsconfig>` (PT28.1d, S312).** After the check, the TypeScript compiler (the `typescript` package as installed beside poly) compiles the project named by the tsconfig, with no output, and each error it reports is `PL6836 HOST_TYPE_ERROR`, a finding at the host file's line and column with the compiler's message. A host check that cannot run (no `typescript` package, or a tsconfig that does not read) is listed as not run with its reason, and the verdict is at best `INCONCLUSIVE`.
- **`poly edit-check` and `poly_edit_check` (PT28.4, S313).** The input is a module file, an edit (`old` and `new`, a replacement of exact text that occurs exactly once; or `text`, the whole file), an optional `project` (the directory whose `poly.json` names the program the module is checked with; PT28.4a's configuration) and `apply`. The edited text is checked in memory, never written first: its build goes to `.poly/edit-check/build` under the project or the module's directory, and the full report to `.poly/edit-check/<digest>.json`, where the digest is the edited text's. The reply holds the verdict, each diagnostic's code, line and column and, for a finding, its witness's id, length and actions, and the path of the full report. An edit whose `old` text does not occur exactly once is refused before any check, and nothing is written. With `apply: true`, the edited text is written to the module only after the check ran and only when the verdict is neither `REFUSED`, `ERROR` nor `NONDETERMINISM`; the reply says whether it was written. It is a registry command, served on the command line, over MCP and through the language server; it calls the check alone, and never admits, signs or runs anything (PT28.4d).

## PT10i. Memory: audiences, sources, retrieval and the flow descriptor, as built (M10 step 3, PS1.4b, PS17, S303)

```ebnf
Audience     = "audience" "{" Ident { "<" Ident } "}" ;                       (* PS1.4b, the lowest first *)
Source       = "source" Ident ":" ( "records" | "documents" | "memory" ) "{" { SourceItem } "}" ;
SourceItem   = "adapter" String | "audience" Ident [ "owned" ] | "freshness" Duration | "stale" ( "escalate" | "deny" ) ;
EffectItem  += "retrieve" Ident [ "where" "owner" "==" Ident ] "limit" Int      (* PS17.2 *)
             | "remember" Ident "as" ( "observed" | "derived" | "verified" ) "about" Ident   (* PS17.5 *)
             | "to" Ident | "audience" Ident ;                                (* PS17.3 *)
DecisionItem += "cites" Ident ;                                               (* PS17.6 *)
ChannelItem  += "audience" Ident ;                                            (* PS15.0a *)
```

- **Declarations.** Each source clause is written once; `audience` is required, `stale` defaults to `escalate`. `Items` is a built-in type like `Content`, unless the module declares one of that name. The embedded surface writes `audience([…])`, `source(name, { kind, adapter?, audience, owned?, freshness?, stale? })`, and in an effect `retrieve(s, { owner?, limit })`, `remember(s, provenance, about)`, `to(p)` and `audience(c)`, in a decision `cites(x)`, and `audience` among a channel's options.
- **The checks (S303).** `PL6833 AUDIENCE_UNDECLARED`: a source, a channel or an effect names a class `audience` does not declare, or there is no `audience`. `PL6834 SOURCE_ADAPTER_UNKNOWN`: a `records` or `documents` source names no adapter or one poly-io does not make (`postgres`, `opensearch`), or a `memory` source names one. `PL6835 OWNER_ON_UNOWNED`. A retrieval's or a remember's source must exist (`PL1001`), its owner or subject must be a `Principal` parameter (`PL1201`), a remember's source must be of kind `memory` and its payload must hold a `Content`; such an effect names no `kind`, `labels`, `targets`, `uses`, `to` or `audience` (`PL1201`), since its kind and labels are the runtime's. `to p` names a `Principal` parameter. `cites x` names an `Items` parameter of the decision, and its ok outcome may bind `r.cites`. A retrieval's ok outcome binds `r.items`. An `Items` field, record field, payload, map, comparison or check domain is `PL1209`; `x.count` is `0..L`. An `Items` or `Content` parameter bound from a reply is not strict: the runtime gives it.
- **The manifest.** A retrieval's entry has kind `source.<s>.retrieve`, the labels of PS17.2, and `retrieve: { source, owner, limit }`; a remember's has kind `source.<s>.remember`, `labels: [write:store]` and `remember: { source, provenance, about }`; an effect with `to` or `audience` has `recipient: { to, audience }`; a decision with `cites` has `decision.cites`, and one whose answer is a `Content` has `decision.result: "content"`. Each is read back by poly-ref.
- **The descriptors.** Each source of a module is `.poly/build/sources/<s>.json`, `{ v, module, source, kind, adapter, audience, class, owned, freshnessMs, stale }`, which binds its adapter at load; each module with sources or an audience has `.poly/build/flow/<module>.json`, `{ v, module, audience, sources: { s: { class, owned } }, claims }` (`claims` from PT10k), which the runtime's flow check reads with each channel's descriptor, `channels/<c>.json`, which gains `audience` when the channel declares one. poly-ref reads both back against the source. The broken lowerings `source-unowned` (an owned source written unowned), `flow-class-lowered` (a source's class written as the lowest) and `flow-recipient-dropped` (an effect's declared recipient class dropped from the manifest) are in the explicit list of toolchain faults.
- **Representatives (PS17.4).** A module with an owned source explores one more principal representative, in poly-ref and in the contract's domains alike.

## PT10j. Memory at run time: sources, retrieval and what a decision reads, as built (M10 steps 7 and 8, PS17.2, PS17.4, S302, S308)

- **Certified descriptors and adapters (S308).** Admission certifies each `sources/<s>.json` and `flow/<module>.json` under `artefacts`, and lists them in `poly.memory`, each source with its adapter bound by package, version and digest, as a channel's is; load reads each once and keeps what it read. `rt.connectSource(s, adapter)` takes only an adapter the certified poly-io made, of the kind the source declares (`PL6408` otherwise); a `memory` source has none.
- **The adapters (PT20.2, K14).** poly-io makes `postgresSource({ query, table, id, owner?, asOf, body })`, over the host's `query(text, params)`, and `openSearchSource({ base, index, transport, owner?, asOf, body })`, over an HTTP transport and the OpenSearch REST API (`_search` with a `term` filter, `_doc`, `_delete_by_query`). Each writes only names checked at construction, and passes the owner and the limit as values, never as query text. `retrieve(query)` returns `{ id, owner, asOf }` by reference, `resolve(id)` a body, and `forget(subject)` removes a subject's items.
- **Retrieval (PS17.2).** A retrieval is the runtime's own effect: `rt.handle` refuses its kind. It calls the source's adapter with the owner's value and the limit, refuses an answer longer than the limit, an item with no id or `asOf`, an item of an owned source with no owner, and, for `where owner == p`, an item of another owner (all permanent, K14). It keeps the item set in the store (`poly_items`: its source, its taint, its oldest `asOf`, its items by id, never a body) and completes with `{ ref, count }`. Only the runtime delivers a retrieval's completion: an outside dispatch is refused before any step, as K10 refuses a decision's.
- **Taint records (PS17.4).** The content store keeps each body's taint (`poly_taint`, by digest), joined over every time it was stored. In a build with a flow descriptor, `rt.putContent` (ingress among its callers) records `⊥`.
- **What a decision reads (PF13.3).** The provider is called with the question as before and, beside it, its materials: each `Content` argument's body and each `Items` argument's items with their bodies, resolved from the source then and kept in the erasable content store with the item's taint. The recorded question holds digests and references only (S310). A decision whose answer is a `Content` takes the provider's answer text, stores it with the join of the taints of everything the decision read, and completes with its digest; its record and its distribution hold digests, never the text.

## PT10k. The flow check, freshness and the proposal fields `taint` and `items`, as built (M10 steps 6 and 8, PS17.3, PS17.4, PS17.6, S302, S305, S307)

- **The flow check (S302).** Before the grant check and the policy, the worker applies PS17.3 to every intent of a module with a flow descriptor, other than a retrieval, a decision, a remember or an adjudication's outcome. Each payload value that is a body's digest is a `Content`. Its taint is the content store's record, and a body with no record denies the intent `audience` (fail closed). The recipient's principal is the payload field the manifest's `recipient.to` names; its class is the emitting step's claims field of type `Audience` when the action has one, which the flow descriptor lists as `claims: { "<Machine>.<Action>": "<field>" }`, else the manifest's `recipient.audience`, else, for `channel.<c>.send`, the channel descriptor's `audience`, else the lowest class. A recipient that may not read a taint denies the intent `audience`, final whatever a policy says, and the verdict is recorded with the reason.
- **Freshness (S307).** For an intent whose payload holds an `Items`, the runtime computes its age at the decision, the runtime's clock minus the set's oldest `asOf`. An item set older than its source's `freshness` denies the intent `stale-items` when the source says `stale deny`, and escalates it, `stale-items`, when it says `stale escalate`; an approved escalation is not escalated again for it (PT9.7, rule 2). Both come before the policy.
- **The proposal (PT25.1).** An intent carrying a `Content` is proposed with `taint: { class, owners }`, the join over its `Content` values, the class by name and the owners by their keyed digests; one carrying an `Items` with `items: { count, class, ageMs }`, the sum of the counts, the highest class and the greatest age. The proposal is kept by digest in the `verdict` event, so the ages computed are recorded and replay never reads a clock.
- **Policies.** A policy reads `effect.taint.class`, a string of the audience's classes, and `effect.items.count`, `effect.items.class` and `effect.items.age`, an integer in milliseconds; each is unknown on a proposal that does not carry it, and `on unknown` decides (PS8.2). poly-ref's decision table gives a proposal of an effect with a `Content` parameter each class and no taint, and a decision with an `Items` parameter each class, each count to the largest limit, and each age the policies' thresholds cut, and none; it gives them only where a policy reads them.
- **The flow descriptor's claims.** `flow/<module>.json` gains `claims`, each action whose claims type has exactly one field of type `Audience`, with that field; poly-ref reads it back.

## PT11. Versions and migration

```poly
machine Order {
  version 2 from 1 {
    migrate { new.status = old.status  new.items = old.items  new.paid = old.paid  new.giftWrap = false }
  }
  state { … giftWrap: bool = false }
}
```

- `migrate` lowers to `migrate.cjs`: a pure `migrate(oldState)`. Migration uses `old.` and `new.`, never primes, because a migration maps one shape to another and is not a step.
- A new field without a migration expression is scaffolded with a `HOLE()` that throws, as polyvers does today. It is reported as `PL8101 MIGRATION_HOLE`.
- `poly check --since 1` runs the polyvers lanes: semantic, shape, migration, vocabulary and intent. The corpus is `--snapshots` (fleet) or `--synthesize`, and an empty corpus is refused.
- Renaming a rejection reason is a vocabulary break ("deprecate, don't delete").
- The per-instance decision at deploy is `auto-upgrade`, `migrate` or `pin`.

## PT12. Diagnostics, verdicts and witnesses

### PT12.1 Diagnostic format

Every diagnostic has this JSON form (schema `poly.diagnostic/1`):

```json
{ "code": "PL3102", "name": "DOMAIN_ESCAPE", "severity": "finding",
  "stage": "model-check", "engine": "polygraph@8.3.0",
  "at": { "module": "orders", "machine": "Order", "node": "n:4f1c…", "line": 22, "col": 5 },
  "message": "items can leave 0..3",
  "witness": { "id": "sha256:…", "length": 4,
    "trace": [ { "pre": {"status":"Draft","items":0,"paid":false}, "action": "AddItem", "data": {},
                 "post": {"status":"Draft","items":1,"paid":false} } ] },
  "fixes": [
    { "id": "add-require", "pre": "sha256:9a0e…",
      "edit": { "op": "insert-before-first-write", "handler": "n:4f1c…",
                "stmt": "require items < 3 else reject \"cart-full\"" } },
    { "id": "widen-range", "pre": "sha256:77b2…",
      "edit": { "op": "replace-type", "node": "n:0c3a…", "with": "0..4" } } ] }
```

- Fixes are typed edits addressed to AST nodes, not to lines. Node ids are stable across formatting because they derive from the node's path in the AST.
- Each fix carries `pre`, the digest of the target node when the fix was computed. `poly fix <id>` applies it only if the node still has that digest; otherwise it is refused with `PL0201 STALE_FIX`. Applying several fixes in sequence is therefore safe: a fix invalidated by an earlier one is refused, never misapplied.
- Line and column are kept for display only.
- A fix is a proposal. `poly check` must run again after it is applied.
- **The catalogue (S70).** M2 offers: for `PL3102`, `add-require` (before the handler's first write) and `widen-range` (to the escaped value); for `PL1202`, reading the pre-state field; for `PL1504`, the binder becomes `_`; for `PL1005`, the qualified constructor; for `PL1501`, an arm `_ => reject "unmatched"`; for `PL2101`, the `require` moved before the first write. The edit operations are `replace-node`, `insert-before-first-write` and `move-before-first-write`. A `.poly` file is reprinted by the canonical formatter, comments kept. An embedded module is offered the same fixes, with the same ids and preconditions (the AST and its digest are the same, PT2.5): the edit is made on its AST, the changed node alone is reprinted by the embedded printer and spliced in at its span, and the result must read back as the edited AST, or the fix is refused with `PL0201` (M3-3). The author's formatting and comments outside the node are kept, and a combinator the new text calls is added to the file's import.
- **Ids and staleness (S69).** A fix id is `<name>@<prefix>` of the digest of `{ moduleDigest, nodeId, edit }`. `PL0201 STALE_FIX` follows directly from a digest mismatch or a failed precondition.

### PT12.2 Code ranges

| Range | Stage | Examples |
|---|---|---|
| PL0xxx | parse, format, fixes, embedded subset, milestone | `PL0001 SYNTAX`, `PL0201 STALE_FIX`, `PL0301 OUTSIDE_EMBEDDED_SUBSET`, `PL0901 NOT_IN_MILESTONE` |
| PL1xxx | names, types, domains | `PL1001 UNKNOWN_NAME`, `PL1002 DUPLICATE_DECLARATION`, `PL1005 AMBIGUOUS_CONSTRUCTOR`, `PL1101 UNBOUNDED_DOMAIN`, `PL1201 TYPE_MISMATCH`, `PL1202 READ_OF_PRIMED_FIELD`, `PL1203 TRI_WHERE_BOOL_EXPECTED`, `PL1204 DIVISION_BY_ZERO`, `PL1206 PRINCIPAL_NOT_OPAQUE` (PD5.1.2b, S109), `PL1209 CONTENT_NOT_OPAQUE` (PS1.4a, S180), `PL1207 RESERVED_REJECT_REASON` (S101, S127, S180: `content-missing` among the reasons), `PL1208 RESERVED_NAME` (M4 review D1, S143: an effect kind beginning `decision.` or `outcome.`, which the toolchain generates, or a machine in a module named `runtime` or `runtime<m>`, which are the runtime's own OutboxIntent ids; a declared name `$claims`, `$lineage` or `$content`, the runtime's data keys, S155, S180; an effect kind `channel.<c>.send` that the channel expansion did not write, review D-F8, M8b), `PL1301 DISCLOSED_IRREVERSIBLE_INPUT`, `PL1401 TERMINAL_NOT_ON_CONTROL_FIELD`, `PL1501 NON_EXHAUSTIVE_MATCH`, `PL1502 INCOMPLETE_MAP_LITERAL`, `PL1503 UNREACHABLE_ARM`, `PL1504 UNUSED_BINDER`, `PL1601 PAYLOAD_TYPE_CONFLICT`, `PL1602 ARRAY_MAP_NOT_ZERO_BASED`, `PL1701 NOT_PREFIX_CLOSED` |
| PL2xxx | lowering, strict validate, translation validation | `PL2001 STRICT_VALIDATE`, `PL2101 WRITE_BEFORE_REQUIRE`, `PL2102 DOUBLE_WRITE`, `PL2201 SILENT_NOOP`, `PL2301 DUPLICATE_TIMER_KEY`, `PL2401 RUNTIME_MODEL_DRIFT`, `PL2501 LOWERING_MISMATCH` |
| PL3xxx | model check, deadlock, liveness | `PL3001 INVARIANT_REACHABLE`, `PL3002 STEP_PROPERTY`, `PL3003 REJECT_PROPERTY`, `PL3102 DOMAIN_ESCAPE`, `PL3201 DEADLOCK`, `PL3301 LIVENESS_LASSO`, `PL3901 BOUND_HIT` |
| PL4xxx | path properties | `PL4001 PATH_PROPERTY`, `PL4002 EMIT_WITHOUT_STATE_CHANGE` (effects, timers and child intents; not `send`, S63) |
| PL5xxx | composition, configurations | `PL5403 UNQUANTIFIED_GROUP`, `PL5405 FIFO_WITHOUT_IN_ORDER_WORKER` (S125), `PL5406 RECEIPT_REJECTED`, `PL5407 REPLY_REFUSED` (PS15.5), `PL5001 COMPOSE_INVARIANT`, `PL5101 CHILDKEY_COLLISION`, `PL5102 UNHANDLED_CASCADE_DELIVERY`, `PL5103 CHILD_READ_WITHOUT_SPAWNED`, `PL5104 SIGNAL_TO_ABSENT_CHILD`, `PL5105 DUPLICATE_SIGNAL`, `PL5201 CASCADE_DEPTH`, `PL5202 ATTACHED_ACROSS_SHARDS`, `PL5301 TRANSIT_BOUND_HIT`, `PL5302 INSTANCE_BOUND_HIT`, `PL5303 CONFIGURATION_WITHOUT_BOUNDS`, `PL5401 CONFIGURATION_INVARIANT`, `PL5402 STUCK`, `PL5404 SEND_TO_NONE` |
| PL6xxx | policy admission, labels, capabilities | `PL6001 NOT_FULLY_MEDIATED` (M5a: any refusal of Polyaxion's admission, with its reason), `PL6501 UNDISCHARGEABLE_MANDATE`, `PL6502 UNKNOWABLE_MACHINE_READ` (S147), `PL6503 NEVER_VIOLATED` (S149), `PL6101 COMPLETION_WITHOUT_HANDLER`, `PL6201 UNGATED_DECISION`, `PL6202 DECISION_WITHOUT_FAILURE`, `PL6203 ADJUDICATION_WITHOUT_DECISION` (S129), `PL6204 DECISION_COMPLETION_SENT` (M4 review C5: a `send` of an action that completes one of the receiver's decisions), `PL6301 UNLABELLED_EFFECT`, `PL6302 UNLABELLED_IN_LABELLED_SCOPE`, `PL6303 TARGET_NOT_GRANTED` (S151: a target whose capability none of the effect's labels grants), `PL6401 AMBIENT_EFFECT_IN_HANDLER`, `PL6402 HANDLER_NOT_CERTIFIABLE` (S142: a handler import the certificate cannot name), `PL6403 HANDLER_CHANGED` (S142: at load, a certified handler file or the lockfile that differs), `PL6404 HANDLER_NOT_CERTIFIED` (S142: `rt.handle` given a function that is not an export of a certified handler file as loaded), `PL6405 KEYRING_CHANGED` (S150: at load, a people or agents keyring that differs from the certified one), `PL6406 CAPABILITY_REFUSED` (S151: at run time, a capability call outside its targets, refused before the transport and audited), `PL6407 TYPE_MODULE_CHANGED` (S190: at load, a module whose enums the build uses changed since it was built), `PL6408 ADAPTER_NOT_CERTIFIED` (S182: `rt.connectChannel`, or `rt.receive` since the review of M8b, given an adapter the certified package did not make, or of another kind), `PL6409 POLICY_NOT_SIGNED` (S194, Q8, M9: at admission or load, a policy scope with no `policy` record by a person over its document, sources and engine), `PL6410 KEYRING_NOT_SIGNED` (S194, M9: at admission, rings not anchored, or changed without a `keyring` record by a key of the previous `people` ring), `PL6601 CROSS_SESSION_STATE`, `PL6701 UNATTRIBUTED_EFFECT` (PD5.2.3, S156: in a scope that requires attribution, a compensable or irreversible effect from an origin with no claims), `PL6801 WORKFLOW_INPUT`, `PL6802 WORKFLOW_KEY`, `PL6803 WORKFLOW_TOOLS` (PT10, S166), `PL6804 WORKFLOW_UNCHECKED` (PT10, S172: a workflow whose machine declares no path property), `PL6811 CHANNEL_KIND_UNKNOWN`, `PL6812 THREAD_KEY_INVALID`, `PL6813 CHANNEL_BINDING_INCOMPLETE`, `PL6814 CHANNEL_BINDING_NOT_ONE_TO_ONE`, `PL6815 CHANNEL_BINDING_MISTYPED` (PT10a, PS15), `PL6821 SCOPE_NOT_DECLARED`, `PL6822 HOLDER_NOT_NAMED`, `PL6823 TARGET_OUTSIDE_PROVIDER` (PT10e, M9), `PL6824 TOKEN_READ_IN_HANDLER`, `PL6825 SECRET_IN_CONFIG` (PT10g, M9), `PL6826 VAULT_NOT_FOR_PRODUCTION` (PT10f, M9), `PL6831 AUDIENCE_LEAK`, `PL6832 TAINT_DOWNGRADE` (PS17, M10: findings of the flow rule), `PL6833 AUDIENCE_UNDECLARED`, `PL6834 SOURCE_ADAPTER_UNKNOWN`, `PL6835 OWNER_ON_UNOWNED` (PT10i, M10), `PL6836 HOST_TYPE_ERROR` (PT10h, M10: a type error in host code compiled against the generated declarations) |
| PL7xxx | capability proof | `PL7001 REGION_WITNESS` |
| PL8xxx | version gate | `PL8001 LANE_FAILED`, `PL8101 MIGRATION_HOLE` |
| PL9xxx | replay and verification | `PL9001 SPEC_DIVERGENCE` (a post-state that differs from the fold, PS11.4), `PL9002 LEDGER_BROKEN` (a chain, signature or anchor that does not verify), `PL9003 DECISION_PROVENANCE` (PD2.2d), `PL9101 CONTROL_FAILED` |

`PL2001 STRICT_VALIDATE` and `PL2501 LOWERING_MISMATCH` are addressed to the toolchain, never to the author: a lowered module that fails strict `validate()`, or that disagrees with poly-ref, is a toolchain fault, and the verdict is `REFUSED` (S20). A user error must be reported at its source line with a user-facing code; a user program that reaches either code is a checker bug.

`PL0901 NOT_IN_MILESTONE` refuses a construct that parses but is not lowered by the toolchain in use (in M0: `emit`, `send`, `spawn`, `signal`, timers, `Ref` fields, path, compose and liveness properties). It is a refusal, never a silent pass. From M1, a liveness property is not refused: the program is checked, the property is listed as not run with the milestone that runs it, and the verdict folds to `INCONCLUSIVE` at best (decision M1-2). `PL1202` is the code of the error PS2.3 describes, so a fix can address it.

### PT12.3 Verdicts and exit codes

The verdicts and exit codes follow the polygents codes:

| Verdict | Exit code |
|---|---|
| `CLEAN` | 0 |
| `FINDINGS` | 1 |
| `REFUSED` | 2 |
| `UNDERPOWERED` | 2 |
| `INCONCLUSIVE` | 2 |
| Non-determinism detected by the double pass | 3 |
| Error | 4 |
| Usage | 64 |

**Vacuous properties (S113, S128).** A property whose antecedent is never true where it is judged is reported as `INCONCLUSIVE` with reason `vacuous`, naming the property and its antecedent's source text. It is never `CLEAN`, and no new verdict or code is needed: the report lists it under `vacuous`, beside `notRun`, and the fold makes the verdict `INCONCLUSIVE` at best.

- **The antecedent.** The antecedent of an implication is the conjunction of the left sides along its right spine: `a implies b implies c` has antecedent `a && b`. A property whose body is a conjunction is judged conjunct by conjunct, and one vacuous conjunct makes the property vacuous. An implication nested inside any other operator is not judged.
- **Where it is judged.** An invariant over the reachable states; a step property over the accepted transitions; a reject property over all transitions; `P leads to Q` over the reachable states (`P` never true); `before(k1, k2)` over the explored paths (no `k2` ever emitted); a configuration property over the global states, and for a quantified one over every instance of its group. `eventually P` and `count` forms have no antecedent.
- **Not judged.** The automatic properties (`domain:`, `shape:`, deadlock, emit without state change).

### PT12.3a Every verdict carries its instance

A verdict is printed with the checked instance it holds for (PS4.3), and the same record is written to the certificate under `instance`:

```
CLEAN  orders.Order  over items ∈ 0..3, amount ∈ {10, 20}, code ∈ {declined, exhausted, denied};
       children ≤ 0; cascade depth ≤ 8; 212 states; kernel assumptions K1, K2, K4, K7
```

The line above is illustrative; the counts are not measured. A `CLEAN` without its instance is not a valid output of the toolchain.

### PT12.4 Witness export

`poly witness <id> --trace` writes the witness as `{pre, action, data, post}` windows. `poly witness <id> --test` writes a host test that drives the runtime API through the witness sequence and asserts the violated predicate. The test fails on the unfixed program by construction (acceptance criterion AC3).

- **The report.** `poly check` writes its JSON report to `.poly/report.json` under the root; `poly witness` and `poly fix` read it (S69).
- **Ids.** A witness id is the SHA-256 of the RFC 8785 canonical JSON of `{ moduleDigest, subject, property, trace }`, where `subject` is the machine or configuration the witness is about, so the same trace in another version of the module, or in another machine with the same defect, is another witness (S69, S86). A fix id is `<name>@<prefix>` of the digest of `{ moduleDigest, nodeId, edit }`, so a fix is tied to the AST it was computed on (S69).
- **Before the runtime API (S68).** Until PT15's runtime API exists (M4), the exported test drives the lowered artefacts: the SAM module, the effects mapper, polyrun's kernel for attached children, and a small harness that delivers a configuration's messages. The test pins the build by its module digest and refuses to run against another build. A step the program rejects ends the walk, and the test passes; after each accepted step it asserts the violated predicate. When M4's runtime API lands, exported tests are regenerated against it.
- **Through the runtime (S139).** An exported test admits the source as it is now with `poly admit --witness`: the same check and certificate format, `purpose: "witness"`, the findings listed, signed with a key generated for the run and never stored. It loads the build with `allowWitness: true`, which `load` requires for a witness certificate and refuses when `NODE_ENV` is `production`. A machine's witness is walked through the runtime API, each step a dispatch; a decision's completion is delivered as the worker delivers it, with its decision event (K10). A configuration's witness, and a machine that spawns children, are walked through the certified lowered artefacts of the runtime's verified copy, since the runtime API cannot start instances from a configuration's initial values or let the witness drive a child the runtime would run (S141, open). No test can pass on a build older than its source, so the stale-build refusal of S68 is no longer needed.
- **Liveness (S74).** A liveness witness is the trace of the prefix followed by the cycle, with `witness.cycle` the index where the cycle begins. The exported test replays the prefix and the cycle and checks that the cycle returns to its first state, that the goal never holds on it, and that every fair group is taken on it or disabled somewhere on it. The goal predicates come from `liveness.mjs`.

### PT12.5 Acceptances and approvals are signed by people

`poly accept` (an accepted finding) and `poly approve` (an escalation approval) write records that must be signed with a key registered in the project's `people` keyring (`poly.json` `people: [{ name, keyId, publicKey }]`).

- **The record (S150).** `{ v: 1, kind: "approval" | "acceptance", subject, by, at, sig }`: `sig` is ed25519 over `poly-record\n<digest>`, the digest being the SHA-256 of the RFC 8785 canonical JSON of the other fields. An approval's subject is the hash of the escalated `verdict` event, so one record lifts one escalation, once; `rt.approve(record)` verifies it, and the `approved` verdict event records the key, the person and the record's digest. An acceptance's subject is `<module digest>:<witness id>`; `poly accept` writes it to the project's `accepted/`, and admission admits a `FINDINGS` program only when each finding has one and nothing else is unclean, listing them in the certificate's `boundAccepted` and claiming no accepted property. `at` is recorded, never trusted. Person key files are read by location, never from a tree under version control (S126).
- **The keyrings are certified (S150).** Admission writes both keyrings into the certificate, and `load` refuses a `poly.json` whose keyrings differ: `PL6405 KEYRING_CHANGED`. A keyring change needs re-admission.
- **A keyring change is signed, and the first rings are anchored (S194, M9).** Without this, an agent that can edit `poly.json` and holds the admission key could add its own key under `people` and sign as a person.
  - **The digest of the rings** is the SHA-256 of the RFC 8785 canonical JSON of `{ people, agents }`, each a list of `{ name, keyId, publicKey }` sorted by `keyId`, with each public key as its SPKI export: the form admission certifies.
  - **The keyring anchor.** A file the owner keeps, outside the project and outside any tree under version control, holds the digest of the project's first rings (`sha256:<hex>`). Its location is read from the owner's per-user configuration, `.poly/anchors.json` under the home directory the operating system gives the user (never from the environment), which maps each project's name to `file:PATH`. `poly.json` never names it and cannot override it (ruled on the keyring change). `poly anchor keyrings --out PATH` writes the anchor from the rings in `poly.json` and records its location in that configuration: the owner's command, never served over MCP. An agent that can write the owner's per-user configuration can redirect the anchor; against it, the owner's file permissions are the control.
  - **The history.** `keyrings/history.json` in the project lists each certified pair of rings in order, `{ rings, record }`. The first entry's rings have the anchor's digest and no record. Each later entry carries a signed record of a fifth kind, `keyring`, whose subject is the digest of `{ parent, rings }` (the digests of the previous rings and of these), signed by a key of the previous entry's `people` ring. `poly sign keyrings --key file:PATH` appends the rings in `poly.json` with such a record: the owner's command, never served over MCP. With no history, the rings in `poly.json` are the first rings.
  - **Admission** refuses `PL6410 KEYRING_NOT_SIGNED` when a ring is not empty and: no anchor is named; the first rings do not have the anchor's digest; a later entry has no record, or one by a key outside the previous `people` ring (the new key signing itself among them), or one over another subject; or the last rings are not the rings in `poly.json`. The certificate binds the anchor's digest, the digest of the last entry and where the anchor came from (`poly.keyringChain`: `anchor`, `head`, `source`), and the read-back recomputes them from disk (the certificate fault `stale-keyring-chain`). A project whose rings are both empty needs no anchor. A malformed anchor, history or record is refused `PL6410` like any other failure of the chain.
  - **Load** refuses rings in `poly.json` that differ from the certified ones, `PL6405`, as before.
  - **Tests** point the per-user configuration at a folder of their own through an API call, for tests only (`useTestAnchors(dir)` of `@poly/check`); no command-line flag and no `poly.json` field carries it. A certificate whose anchor came that way has `source: "test"`, and `load` refuses it unless the process has called `acceptTestAnchors()` of `@poly/runtime`, as a witness certificate is refused without `allowWitness` (S139); a production runtime never calls it, so a certificate admitted around the owner's anchor never runs.
- **What a person decides is anchored outside the project and only moves forward (S210, as ruled 2026-10-07).** The project's own environment, the admission key included, could otherwise undo what a person decided: widen the people ring at load, roll back a ring or a policy, replay a keyring change in another project, or turn production off.
  - **The anchor's format.** The anchor is a JSON file at the location the per-user configuration names, `{ v: 2, id, project, first, head, policies, production }`: `id`, the anchor's identifier, `anchor-` and 32 hex digits drawn at random when it is written; `project`, the project's name; `first`, the digest of the first rings; `head`, the digest of the last rings admitted; `policies`, the highest sequence admitted for each policy scope, by its name; `production`, whether the project is a production project. `poly anchor keyrings --out PATH [--production]` writes it, with `head` the first rings and no policies; `poly anchor production on|off` changes that field alone. Both are the owner's commands, never served over MCP. Admission advances `head` and `policies` and never moves them back. An anchor that holds only a digest, as before S210, is refused `PL6410` until the owner anchors the project again.
  - **A keyring record names its project (D3).** Its subject is the digest of `{ anchor, parent, rings }`, `anchor` being the anchor's `id`, so a change signed for one project does not verify in another whose rings were the same.
  - **No rollback of the rings (D2).** Admission refuses `PL6410` a history in which the anchor's `head` is not the rings of one of its entries; the chain then extends the kept head. Once the certificate is read back, admission writes the history's last rings to `head`.
  - **Load verifies the chain (D1).** Load reads the anchor named for the certificate's project (from the test configuration only for a certificate of `source: "test"` in a process that accepts test anchors, else from the owner's), verifies `keyrings/history.json` from it as admission does, and refuses `PL6410` unless the certified rings are the history's last rings and the history extends the anchor's head. Certified rings that are not empty with no anchor are refused. Holding the admission key is no longer enough to widen the `people` ring, and a certificate whose rings a later admission has moved past no longer loads.
  - **No rollback of a policy (D7).** A scope's signature file is `{ v: 2, sequence, record }`, `sequence` a positive integer, and the subject of its `policy` record is the digest of `{ scope, sequence, document, sources, engine }`. `poly sign policy` signs the next sequence after both the file's and the anchor's. Admission and load refuse `PL6409` a scope whose sequence is lower than the anchor's for it; admission then writes it to the anchor. The certificate binds each scope's sequence beside its record. A signature file of the form before S210, a bare record, is refused `PL6409` until it is signed again.
  - **Production is the anchor's (D9).** `poly.json` has no `production` field, and admission refuses one that names it: production is set on the anchor. With the anchor's `production` set, admission refuses the development keychain (`PL6826`), `rt.connectVault` refuses a development keychain, and `load` refuses `LoadOptions.fault`, so no test hook is reachable in production.
- **A person signs every policy (S194, Q8, M9).** An agent may draft a policy and the checker proves it, and a person signs it before it is admitted, since the policies decide what the program may do and an agent may write the one that governs its own effects.
  - **The record** is of kind `policy`, by a key of the certified `people` ring. Its subject is the digest of `{ scope, document, sources, engine }`: the scope's name; the digest of its lowered document (`.poly/build/policies/<scope>.policy.json`, the bytes the engine runs); the digest of each source file that declares a policy of the scope, by its path in the project; and the engine pin (`{ name: "polyaxion", commit }`). A change to any of them needs a new signature.
  - **Where it lives.** `policies/<scope>.sig.json` in the project, committed with the sources. `poly sign policy <scope> --by <keyId> --key <file>` checks the module that declares the scope as `poly check` does, and signs the document it lowers, with the engine as pinned now: the owner's command, never served over MCP.
  - **Admission** recomputes the subject of each scope and verifies its record against the certified `people` ring; a scope with no record, a record by any other key (an agent key, or a key added to `people` without a keyring record, which PL6410 refuses first), or one over another subject is refused `PL6409 POLICY_NOT_SIGNED`. The certificate binds each scope's record beside its policies, and the read-back verifies it again against the document on disk (certificate faults `omit-policy-signature` and `stale-policy-signature`).
  - **Load** verifies each bound record again: against the certified `people` ring, the document's bytes it loads, the certified source digests and the engine it runs, and refuses on any mismatch, `PL6409`.
- A refused approval (unsigned, an agent key, a key outside the keyring, another escalation, a bad signature, or a lifted escalation) has no effect, and is written to the audit log.

- `poly check` and the runtime verify the signature and the key's presence in the keyring. An unsigned or agent-signed record has no effect.
- Agent keys (the key an MCP server or a CI job holds) are listed separately under `agents` and are rejected for these two record kinds.
- The enforcement is the signature check, not the transport. Not exposing the commands over MCP is a convenience, not a control. An agent with a shell and a person's private key can sign; keeping person keys out of agent environments is an operational requirement, stated as such.

## PT13. The first experiment

The experiment is milestone M3 (PT18). It runs on the M0 to M2 toolchain and needs no poly runtime: the poly arm's delivered program is lowered and executed on polyrun as it exists today.

- **Questions.**
  1. Can a coding agent reach an admitted poly program for a stateful feature within the same budget as a TypeScript implementation?
  2. Does it ship fewer escaped defects than the same agent writing TypeScript, with or without polygraph after the fact?
  3. At what cost in tokens and wall time?
  4. Which surface works better for agents: the standalone syntax or poly embedded in TypeScript (PT2.5)?
- **Tasks.** Ten stateful features, fixed before any run. At least three of them involve two or more machines that talk to each other (for example an order and an inventory), so the configuration check (PT7a) is exercised. They are drawn from three families:
  - order and payment lifecycles;
  - workflow status derivation (modelled on the hatchet study);
  - leader election roles (modelled on the raft study).

  Each task has a written brief and a **host interface**: a small TypeScript API (for example `place(order)`, `pay(order, amount)`) that every arm must implement. The poly arm implements it with a thin generated adapter over the runtime API; in M3 the adapter drives polyrun's kernel directly (decision M3-4). In the poly arms the agent writes `host.map.json` as part of its solution: which machine, instance and action each host method drives, and which fields each query reads. The adapter generator validates it, and a map that names a machine or action that does not exist is a failed build (S90). A multi-machine task's host interface includes a network API, `inFlight()`, `deliver(id)` and `deliverAll()`, in the brief and for all four arms; messages may arrive in any order, and O1 tests arrival orders only through it (S91).
- **Arms.**
  1. TypeScript alone.
  2. TypeScript, then polygraph after the fact, with the agent allowed to fix findings.
  3. poly, standalone syntax.
  4. poly, embedded TypeScript surface (PT2.5). Same core, same checks, same lowering; only the front end differs.

  The same agent and model are used in every arm, with the same token budget and wall-time limit per run.
- **Runs.** Five independent runs per task per arm: 200 runs in total.
- **Oracles.** Three, kept separate so the result cannot be an artefact of the formalism:

  | Oracle | Written by | Form | Role |
  |---|---|---|---|
  | O1 · scenario tests | an independent agent session that has read the brief and host interface and has **not** seen any reference machine, oracle or arm output (decision M3-1) | end-to-end tests against the host interface | **primary** |
  | O2 · hidden invariants | the task author | predicates over the host interface's observable state | secondary |
  | O3 · reference traces | the task author's reference machine | traces replayed through the host interface | secondary |

  An escaped defect is a failing O1 test for the primary measure. O2 and O3 findings are reported separately, per arm.
- **Evolution.** Each task has three follow-up changes to the brief, delivered in sequence to the same run. The measures are the regressions introduced and the regressions caught before delivery, scored by O1 after each change. Each change has its own brief delta, reference machine, mutant, O2 and O3; its O1 comes from the same independent session, which receives the change briefs in order and never the references (S92).
- **Measures.**
  - **Co-primary:** escaped defects per delivered task (O1), and tokens per delivered task.
  - **Secondary:** wall time; delivery rate within budget; O2 and O3 findings; regressions introduced and caught; for arm 3, diagnostics by code and the share of typed fixes applied unchanged.
- **Analysis, fixed before any run.**
  - Per-task means over the five runs. Paired comparisons across the ten tasks use the Wilcoxon signed-rank test, Holm-corrected over all comparisons, at 0.05. The comparisons are arm 3 and arm 4 each against arms 1 and 2, and arm 4 against arm 3.
  - **A win for poly:** at least one poly arm reduces mean escaped defects by at least 30% against both arms 1 and 2, with tokens per delivered task no more than twice arm 1's.
  - **The surface decision:** if arm 4 is not worse than arm 3 on escaped defects (difference within 10% of arm 3's mean) and uses fewer tokens, the embedded surface becomes the primary surface. The standalone syntax is then deferred, and the parser, formatter and language server leave the v1 scope. Otherwise the standalone syntax stays primary and the embedded surface remains supported.
  - **A stop for poly as specified:** neither poly arm delivers an admitted program in 70% of its runs within budget. M4 and later are then not started; the language surface is revised first.
  - Anything between is reported as it is, with the effect sizes and intervals.
- **Controls.** Each reference machine replays its own corpus at 100%, and a mutated reference fails. Each O1 suite passes on the reference implementation and fails on a mutated one. A task whose controls fail is removed before any arm is scored.
- **Reporting rule.** Every arm and every measure is reported, including a null or negative result for poly. The raw journals, prompts and O1 suites are kept.

## PT14. Command surface

| Command | MCP tool | What it does |
|---|---|---|
| `poly new "<description>" [--into module]` | `poly_new` | Drafts a machine with polygen. The draft is not admitted. |
| `poly fmt` | `poly_fmt` | Canonical formatting. Prints the module digest. |
| `poly check [--since v] [--against traces] [--snapshots dir]` | `poly_check` | Runs the pipeline. Returns verdict, diagnostics, witnesses and notRun. |
| `poly explain <code or witness>` | `poly_explain` | Returns the rule, the witness narrative and the fixes. |
| `poly witness <id> --trace/--test` | `poly_witness` | PT12.4. |
| `poly edit-check <module> --old t --new t (or --text t) [--apply]` | `poly_edit_check` | Checks a module with an edit applied in memory and returns the verdict, the findings and a handle to the full report; writes the edit only with `apply`, after the check (PT10h, PT28.4). |
| `poly fix <id>` | `poly_fix` | Applies one typed fix if its precondition digest still holds (PT12.1). |
| `poly grade` | `poly_grade` | polynv adequacy. |
| `poly admit` | `poly_admit` | Writes and signs the certificate (PT15). A `CLEAN` program is admitted, and a `FINDINGS` program whose every finding a person accepted (PT12.5). |
| `poly accept <witness id> --by <keyId> --key <file>` | (not exposed over MCP) | Records an accepted finding, signed with a person key, in `accepted/` (PT12.5, S150). |
| `poly deploy [--pin/--migrate/--upgrade]` | `poly_deploy` | Loads a certified version into a runtime, with the version gate against live snapshots. |
| `poly run`, `poly dispatch` | `poly_dispatch` | Development runtime. |
| `poly approve <intent> --by <keyId> --key <file> --db <store>` | (not exposed over MCP) | PT9.2 escalation approval: signs the record of the intent's escalation with a person key, for `rt.approve` (PT12.5, S150). |
| `poly journal verify/replay/export` | `poly_journal` | Ledger verification and replay (PF8.6). Verify refuses with `PL9002` or `PL9003`; replay reports `PL9001`. |
| `poly journal eval --decision d --candidate <provider>` | `poly_journal` | Replays recorded questions to a candidate provider and reports agreement and calibration (PD3.3, S132). Writes to no chain. |
| `poly journal fit --decision d` | `poly_journal` | Fits a monotone calibration map by isotonic regression from `decision` events and their outcomes (PD1.6, S132). Writes to no chain. |
| `poly export traces` | `poly_export` | PF10.1. |
| `poly mine` | `poly_mine` | Passes journals to Polyx. Returns proposed obligations. |
| `poly propose` | `poly_propose` | Passes agent journals to polyness. Returns proposed workflows. |

**The command registry as built (M6, S167).** Each command poly has is defined once in `packages/poly-check/src/commands.ts`, with an input schema, an output schema and a function from input to a JSON result; the command line is a projection of it, printing the result's text or, with `--json`, its JSON. The schemas are published under `schemas/<command>.input.json` and `schemas/<command>.output.json` (`node scripts/publish-schemas.mjs`), and every command's output fits its own (PF9.2). The registry has `check`, `fmt`, `witness`, `fix`, `lint`, `admit`, `admit-witness`, `approve`, `accept`, `journal` and `bench`; `approve`, `accept` and `admit-witness` take a person's or a test key and are the command line's only. The rows of this table poly does not have yet (`new`, `explain`, `grade`, `deploy`, `dispatch`, `export`, `mine`, `propose`) are listed in the registry as not built, each with the milestone that builds it, so a command is served or said to be missing. `poly fmt <file> [--write]` prints the canonical text, or rewrites the file and prints the module digest; it formats the standalone surface, and an embedded module is TypeScript's to format.

**The servers as built (M6, S167, S168, S171).** `poly mcp` serves the registry's commands that have a tool name as MCP tools over stdio, with the published schemas as `inputSchema` and `outputSchema` and each result as `structuredContent`. `poly lsp` is the language server over stdio, on both surfaces: it publishes the diagnostics of stages 0 to 2 of the text the editor holds on every open and change, and every stage on save, each at poly check's line and column; it formats a standalone module with `poly fmt`'s text and leaves an embedded one to TypeScript; it offers each typed fix as a code action on both surfaces, applied to the text the editor holds, and offers none whose node no longer has its digest (`PL0201`); and it serves the registry's commands as `workspace/executeCommand` `poly.<name>`, returning their JSON. A check of stages 0 to 2 alone (`through: 2`) lists the later stages, configurations and policies as not run, and is never `CLEAN`. Both servers are in `poly-agent`, written with no SDK, and know no host.

**Host adapters as built (M6, S167, S170).** A host adapter is a directory under `adapters/` that holds configuration only (`.json` and `.md`), and the boundary check refuses anything else there, and a host's name or SDK anywhere in `packages/`. `adapters/claude-code` is a Claude Code plugin: its `.claude-plugin/plugin.json` declares the MCP server `poly mcp` and the language server `poly lsp` for `.poly` files, and `skills/poly/SKILL.md` tells the agent how to write, check and fix poly; `adapters/.claude-plugin/marketplace.json` lists it, so `claude plugin marketplace add <poly>/adapters` installs it. `poly install --host <adapter> [--project <dir>]` prints a host's entries for a project from the adapter's `install.json`, with the project and poly's checkout filled in: for Claude Code, a `.mcp.json` with `poly mcp` and polyflow's server over the project's lowered workflows. The DeepSeek Harness adapter (`adapters/dsh`) is listed as waiting until its plugin API is declared stable.

**`poly new` as built (M6, S169).** `poly new "<description>" --into <file.poly>`, and the MCP tool `poly_new`, draft a module with a provider: each draft is checked by `poly check`, its diagnostics go back to the provider with the draft, and the loop stops at `CLEAN` or after five rounds. The last draft is written with a header saying it is not admitted; nothing admits it. Over MCP the provider is the client's model, by sampling, when the client offers sampling; otherwise, and on the command line, Claude Code run headless under the user's own login, which refuses to start while `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present (checked by name, never by value), since a key would bill per token. No API provider is built or configured, no provider reads or records the environment, and tests use recorded drafts only. The command lives in `poly-new`, the only package that may call a model; the boundary check refuses any other package that loads it, but for `poly-agent`, which serves it, and the command line, which loads it by name.

The language server publishes the same diagnostics as `poly check` stages 0 to 2 on every edit. Stages 3 and later run on save or on request, because they explore state spaces.

## PT15. Host runtime API (TypeScript)

```ts
import { load } from '@cognitive-fab/poly'

const rt = await load('./.poly/build', {
  certificate: './.poly/certificate.json',
  store: 'sqlite:./orders.db',          // or 'postgres://…'
  gate: { policy: 'repo-hygiene', mode: 'in-process' },
  ledger: { keyId: 'ops-2026', signer: kms('…') },
})

// handlers/payments.ts, named by poly.json's `handlers` and certified with the program (S142):
//   export async function charge(payload, { egress }, ctx) {
//     // runs only after the gate allows; receives only the capabilities its labels grant (PT6.5)
//     // ctx.idempotencyKey is stable across retries
//     return egress.post('https://api.psp.example/v1/charges',
//                        { amount: payload.amount }, { idempotencyKey: ctx.idempotencyKey })
//   }
rt.handle('payment.charge', rt.handlerExports('handlers/payments.ts').charge)

const order = await rt.create('orders.Order')
const r = await rt.dispatch(order.id, 'Place', {}, { actionId: 'req-7781' })
// r: { seq, stepKind: 'accepted' | 'rejected' | 'unhandled', rejectReason?, state }
await rt.startWorkers({ effectConcurrency: 8, timerPollMs: 200 })
```

The API is polyrun's `createRuntime` with three additions:

- certificate verification at load (PF8.1);
- the gate (PT9);
- the ledger writer (PT16).

`rt.getState`, `rt.getStateAt(id, seq)` and `rt.list(machine, filter, status)` are unchanged.

**The certificate (S126).** `poly admit` writes `.poly/certificate.json` in the polyflow certificate's shape (`v`, `subject`, `artefacts`, `guarantees`, `checks`, `domains`, `boundAccepted`, `toolchain`, `issuedAt`, `buildId`, `signatures`, `digest`), with poly's fields: the source and module digests, every artefact of every machine by path and SHA-256 (including `invariants.compose.mjs` and `liveness.mjs`), the instance of PT12.3a, the kernel assumptions, `decisions` (PD3.2b), and `handlers` (S142): the handler files `poly.json` names (`roots`) and every file they reach through relative imports, by path and SHA-256, the version and verdict of the lint that read them, the installed packages they import with every file reached inside them (`packageFiles`, S154), and the lockfile's path and digest; `load` refuses a changed package file as `PL6403`. It is signed, ed25519, with the admission key `poly.json` names by id and location (`keys.admission`); **no private key is ever committed**, and test keys are generated at test time. At load, the runtime reads only public keys. It reads each artefact once, checks its digest and the signature, writes the verified bytes to a directory named by the build id, and registers polyrun's machines from that copy, so the bytes polyrun loads are the bytes checked. Any difference (a changed, missing or extra artefact, an edited certificate, a bad signature or an unknown key) refuses the load, naming the artefact and both digests.

**Certified handlers (S142).** `load` reads each certified handler file and the lockfile itself, hashes them first and refuses any difference as `PL6403 HANDLER_CHANGED`, naming the file and both digests; a certificate without `handlers` predates S142 and is refused the same way. It writes the verified bytes beside the artefacts' copy and imports the roots from there. `rt.handle` takes only a function that is, by identity, an export of a root as the runtime loaded it, which `rt.handlerExports(path)` returns. A closure, or a function of any other module (the same file imported by the host is another module), is `PL6404 HANDLER_NOT_CERTIFIED`, refused before any step. The rule holds for every certificate, witness certificates included (S139). A decision's provider is registered with `rt.provide`, not `rt.handle` (PD2.2). Installed packages are not hashed in M4: their lockfile's digest is, and hashing the packages is on M5's list.

**What M4's runtime does not do.** Handlers receive an empty, frozen capability object, and the instance line says capabilities are not bound until M5 (S134). M5a binds them (PT6.5, S151). The store is SQLite only; Postgres is not built (S135). `poly-runtime`'s `dispatch` refuses an outside dispatch of a decision's completion (K10, S130), as polyrun refuses a child's (K9).

**Streams.** The runtime is a stream transformer: inputs flow in, intents flow out, and the state is the fold of the step over the inputs (PS11.4). The API exposes both streams for host code that prefers that model:

```ts
rt.inputs(order.id).subscribe(step => log(step))          // every labelled step, in seq order
rt.intents('payment.charge').subscribe(i => metrics(i))   // every intent of a kind, after the gate
```

Handlers remain the only way to execute an effect. The intent stream is for observation.

## PT16. The ledger

The ledger uses the polyflow platform event format. It is **chained per run**: each instance (each `run`) has its own hash chain, so the ledger follows polyrun's single writer per instance and adds no runtime-wide serialisation point.

```json
{ "v": 1, "run": { "ns": "orders", "wf": "orders.Order", "run": "ord-81" }, "seq": 14,
  "kind": "verdict", "at": 1790704931412,
  "body": { "stage": "gate", "outcome": "denied", "reason": "wrong-state:orders-irreversible", "witness": "sha256:…" },
  "prev": "sha256:…", "hash": "sha256:…" }
```

**Event kinds.** The existing kinds are `admission`, `proposal`, `verdict`, `effect`, `observation` and `closure`. poly adds `step`, which carries the polyrun journal row (`seq`, `action`, `data` digest, `stepKind`, `rejectReason`, pre and post digests), `advice`, which carries the Polyx verdict with no write path (architecture section 9), `decision` (PD2.2) and `outcome` (PD2.4). The polyflow verifier accepts the four new kinds with engine change E2.

**Format (S122).** `ns` is the module, `wf` the machine, `run` the instance id. `at` is a number of milliseconds, as polyflow writes it. The event's `seq` is its position in the run's chain, and a `step` event's body carries the journal's own `seq`. Bodies are kept in a content store by digest, under a retention setting; the chain holds digests only. Every event of a step is written in the step's transaction (K1, S121). `closure` is written when an instance is archived, not when it becomes terminal, since a terminal instance still takes rejected steps (PS3.2). A poisoning is an `observation`. A K9 or K10 refusal writes no event; it is in the audit log.

**Signing and verification.** Signed heads are `{ run, seq, hash, keyId, alg: "ed25519", sig }`, one per run. Verification runs the four Polyaxion checks: signature, chain, binding and replay. **Heads are signed off the step path (S123):** a signer loop signs the latest head of each run that moved since its last signature, every `ledger.headMs` and at closure, since a remote signer cannot sign inside a transaction. A live run verifies as `open-and-signed` through the `seq` its newest head covers, never as fully signed. `poly journal verify` also requires every run to carry a trusted signed head and the latest anchor to verify and cover each run's latest signed head; a missing head, a run absent from the anchor or a head signed after it is `PL9002`, and the command exits non-zero (review B1). **Attributed provenance (PD5.4, M5b).** Each `step` event also carries `claims`, the digest of the claims that admitted the step (of null for a step without any), and `lineage`, the digest of its lineage record (PT2.4d); verify binds both, the first to the journal row and the second to the lineage record, which must recompute, and replay reports a difference as `PL9001` (PD5-A11). **Countersignatures (S108).** Heads and certificates stay ed25519. A workload-identity signature is an additional countersignature over a signed head's hash, made by the host's adapter (`rt.countersignHeads({ scheme, sign })`) and kept in its own record; `poly journal verify --countersign <module>` checks each through the adapter the module exports, a countersignature that does not verify or names no signed head is `PL9002`, and without an adapter each is listed as not verified (not run), never as ok (PD5-A9).

**Runtime anchor.** When a runtime-wide statement is needed (for an audit period), the runtime publishes an **anchor**: a Merkle root over the current signed heads of all runs, itself signed. Anchoring is periodic and off the step path. The tree uses RFC 6962 hashing over the latest signed heads, ordered by run, and the anchor record is `{ v: 1, period, root, runs, keyId, alg: "ed25519", sig }` (S123). A run's chain can be verified alone; the anchor proves that no run was dropped from the period.

**Trace export.** Export joins `step` events with the snapshots store to produce `{pre, action, data, post}` windows. Bodies are stored by digest, and a separate content store holds bodies under the operator's retention policy.

## PT17. Repository layout

```
poly/
  README.md
  docs/                      01 functional · 02 architecture · 03 technical · research/
  packages/
    poly-core/               AST, types (incl. unions), domains, diagnostics; the pivot every surface produces
    poly-lang/               standalone surface: lexer, parser, formatter
    poly-embed/              embedded TypeScript surface: subset checker, AST builder, combinators
    poly-ref/                reference interpreter from 04-semantics: translation validation, deadlock, liveness
    poly-lower/              construct → artefact (one module per row of the lowering map)
    poly-check/              pipeline orchestration, verdict fold, certificate
    poly-runtime/            polyrun host with certificate, gate hook, ledger writer
    poly-mcp/                MCP server over the command set
    poly-lsp/                language server
  plugin/                    Claude Code plugin: skill, commands, hooks
  examples/
    orders/                  PT4.5, with its lowered build checked in for review
    turnstile/ raft-roles/ hatchet-status/ checkout/ (PT7a)
  conformance/               lowering conformance, generated from the lowering map (02 §4): one case per row, poly source vs hand-written artefacts
  .poly/build/<module>.<Machine>/   contract.json, next.cjs, invariants.mjs, effects.cjs, effects.manifest.json,
                             effect-invariants.mjs, invariants.compose.mjs, liveness.mjs (S74): the engines' artefacts, each read back (PT9.3)
    field-studies/<name>/    copied traces, contracts, invariants and hand-written controls (data, not engine code),
                             with PROVENANCE.md (source path and commit, upstream project and its licence, SHA-256 of
                             every file) and a sync script that re-verifies the hashes against the local sources when
                             they exist. CI reads only these copies.
```

The build directory per machine matches the engines' expected layout:

```
.poly/build/orders.Order/
  contract.json  next.cjs  invariants.mjs  effects.cjs  effects.manifest.json
  effect-invariants.mjs  migrate.cjs  polyflow.workflow.json (workflows only)
.poly/build/policies/repo-hygiene/polyaxion.policy.json
.poly/certificate.json
```

## PT18. Implementation plan

Each milestone ends with a gate. A milestone is not started until the previous gate passes. The gates reuse the stack's doctrine: controls first, and a defect becomes a gate. The experiment comes as early as the toolchain allows, and everything after it depends on its result.

| Milestone | Scope | Gate |
|---|---|---|
| M0 · Language core | `poly-core` AST, parser, formatter with PS12 precedence, AST digest and node ids, types and domains (with `strict` / `disclosed`, tagged unions, `match`, `Tri`), lowering of `state`, `action`, `on`, `guard`, `terminal`, invariants, step properties and reject properties; `poly-ref` written from 04-semantics with translation validation (PS9.3) and the deadlock check (PS5.6) | The turnstile, raft-roles and hatchet-status machines and their broken controls, written in poly, give **the same pass or fail on every window** as the hand-written controls do today: turnstile 12/12 (broken 9/12), raft 54/67 (broken 44/67), hatchet 19/19 (broken 18/19). Identity is required window by window, not only in the counts; a window the poly version passes and the control fails is also a gate failure. Raft's 13 failing windows are explained in its `REPORT.md` (the term observed on either side of a deferred increment), and no deterministic machine passes them. Lowered `next.cjs` passes strict `validate()`. Translation validation agrees on every transition of every conformance case, and a deliberately broken lowering is caught (`PL2501`). poly-ref reproduces the evidence scripts for single machines: the turnstile (7 states, the deadlock witness), `OutboxIntent` in its v0.3 five-field form (33 states, 40 accepted steps, no deadlock), in its v0.2 form, which is AC9's variant (35 states, deadlocked at `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)`), and in its union form (17 states, clean). The field-study corpora and controls are read from `conformance/field-studies/`, copied with provenance (PT17). |
| M1 · Effects, composition and configurations | `emit`, effect declarations, timers, attached and detached children, `Ref` and `send`, configurations explored by poly-ref, emission and compose invariants, maps | The `polyrun-oms` order machine in poly agrees window by window with the hand-written module on the copied corpus (53/81 each), replays at 100% the corpus that polyrun's kernel records from the hand-written artefacts, and gives the same `check-effects` and `check-product` results (AC1, decision S24). The `checkout` configuration finds the double-confirmation witness with the optimistic order and is clean with the waiting order (AC10). poly-ref reproduces the configuration and delivery evidence scripts: the checkout results (six-step witness; 44 states clean) and the safety results of all four `Delivery` variants of PT9.8 (state counts, `at-most-once`, `in-order`, and both violation witnesses). `exactly-once` is liveness and is checked in M2. A disagreement with a script is investigated until one side is shown wrong. |
| M2 · Diagnostics and second surface | `poly-embed` front end producing the same AST; handler capability lint (PT6.5); diagnostic model, verdict fold with instances (PT12.3a), witness export to trace and test, node-addressed fixes with preconditions, liveness checks with lasso witnesses (PS6.4), `poly check` CLI; `spawn detached` (S60); typed decisions (proposal PD1: `decision`, `decide`, the `Conf` type explored by intervals, calibration maps, `PL1205`, `PL6201`, `PL6202`) | For every seeded defect in the conformance suite, the exported test fails before the fix and passes after it (AC3). Applying every fix in a random order never misapplies one. poly-ref reproduces the liveness evidence: `exactly-once` holds under the stated fairness for the two `Delivery` variants that keep dedupe records, and `settles` holds for the v0.3 and union forms of `OutboxIntent` and fails for the v0.2 form, with a fair cycle at each of its two deadlocked states. Typed decisions pass PD1-A1 to PD1-A4 of `docs/proposals/pd-model-decisions.md`, with a recorded provider: no test calls a model. |
| **M3 · Experiment** | PT13, on the M0 to M2 toolchain. Prerequisites (M3-2, M3-3): polyrun's `sendTo` intent with `self` and child addresses resolved at commit and the K9 refusal (S88, S89), re-vendored; the fixes of S70 on embedded modules | Results published with every arm reported. **Go / stop decision** for M4 onward, by the rule fixed in PT13. |
| M4 · Runtime | `poly-runtime`: certificate check, polyrun host, per-run ledger, anchor, journal verify and replay; the outbox intent machine of PT9.7; decision provenance and model independence (proposal PD2, PD3, K10); in the checker, the two rules ruled during M3 and frozen out of it: reserved reject reasons (`PL1207`, PS3.2, S101) and vacuous properties reported `INCONCLUSIVE` with reason `vacuous` (PT12.3, S113) | M4a: journal replay reproduces every post-state and every gate decision of the M4 gates (S118); a tampered artefact is refused at load. Session replay in `sseq` order (AC6's second half) is M5's. M4b: the `OutboxIntent` machine is clean for its invariants and step properties, deadlock-free, and satisfies `settles` under its stated fairness; the worker conforms to it by trace replay. M4c: the runtime's delivery traces replay against the `Delivery` machine of PT9.8 (K8), including traces captured across an archive. M4d: an external dispatch of an action wired as a child completion is refused (K9, S45, S80). M4e: PD2-A1 to PD2-A4, PD3-A1 and PD3-A3 (PD3-A2 needs PD4.3 and is M5's, S131). M4f: a handler that rejects with `terminal` or `outside-check-domain` is `PL1207`; a property whose antecedent is never true in the explored states is `INCONCLUSIVE` (`vacuous`, naming the antecedent), never `CLEAN`, and the conformance sources and M3's references are re-checked under both rules. |
| M5a · Governance | `.policy.poly` lowering, gate hook with emitting-step snapshots (PT9.3), sessions with `sseq` and session replay (S118, S146), polycheck stage, obligation consistency (PT8.5), escalation with timeout, person-key signatures (PT12.5), the gate proposing cross-scope sends with `SendDenied` (PS8.7, PT9.9), operating modes (proposal PD4) with PD3-A2, bound capabilities (S134) | AC4. Gate latency and throughput are reported (PT9.6). The gate never fails open under an injected outage. PD4-A1, PD4-A2, PD3-A2; signed approvals (PT12.5). |
| M5b · Identity | identity and lineage (proposal PD5, S112); instances started from a configuration's initial values (S141, after E5); hashed handler dependencies (S142); the opt-in OpenShell sandbox (PT6.5) | PD5-A1 to PD5-A12, and PD4-A3 through the person-key adapter (S107). Each carried item has its test; sandbox enforcement is listed as not run where no gateway is configured. |
| M6 · Agents | Workflow lowering, MCP server, language server, Claude Code plugin, `poly new` | AC5. A workflow in poly runs through unchanged polyflow tools. |
| M7 · Feedback | `poly mine`, `poly propose`, `poly export traces` | A Polyx rule adjudicated `real` round-trips to an admitted obligation. A polyness proposal arrives as poly source and is admitted or refused by the pipeline. |

**Named item before the v1 release: workflows on `poly-runtime` (S164). Done in M8a.** M6 ran workflows on polyflow, outside the gate (PT10). Since M8a they run on `poly-runtime`: every work order crosses the gate (G5) and is journaled in the ledger, and the certificate lists each workflow as gated (PT10, S173 to S175).

Worlds (appendix A) are planned after M7 and are not part of v1.

## PT19. Limits

- **Bounded checks.** Checks are exhaustive only over declared check domains. A defect that needs a value outside the domain is not found. For `strict` fields, out-of-domain input is rejected at dispatch, so the checked domain is the running domain. For `disclosed` fields, drift is journaled (PT3.4), not prevented.
- **Model-code gap.** poly removes the gap between model and code for the machine itself. It does not check host handlers. Handler behaviour is observed only through completion actions and the `SETTLE` record.
- **State explosion.** It is managed by small machines and atomic cascades, not by abstraction. A check that hits its bound reports `INCONCLUSIVE` (`PL3901 BOUND_HIT`).
- **Liveness.** Liveness holds only under the fairness stated with each property plus the delivery guarantee of PS14. At runtime, delivery is obligation R1: it is monitored, and a missed delivery is a runtime fault, not a program fault.
- **Configurations.** Checks cover the bounded fragment: finite instances and a declared bound on messages in transit (PS4.1e, PS13.5). A bound hit is reported. The state space of a configuration grows with its instances, and that growth is the cost of checking interactions.
- **Retries.** A manifest's `retry.maxAttempts` is at most 10, refused at admission otherwise, so the `OutboxIntent` machine checked for each bound stays small: 17m + 8 states at bound m, 178 at 10 (S120, S137, S147).
- **Kernel assumptions.** Every guarantee about a running program holds under the kernel assumptions K1 to K10 of PS10. Their evidence is listed there. poly does not verify the kernel.
- **Over-approximation.** The checked instance lets the environment offer any action at any time (PS4.4). Clean results are sound; some witnesses may be infeasible and are marked `environment: unconstrained`.
- **Advice.** Advice is recorded but not enforced until it is promoted, adjudicated and admitted.
- **Worlds.** Not in v1 (appendix A).
- **Language models.** The toolchain calls a language model only in `poly new` and in optional explanation text. No verdict depends on one.

## Conclusion

The meaning of poly is fixed in 04-semantics: one machine, interpreted by checking, simulation and running. The technical core is a lowering table checked against that meaning on every run, and a verdict fold. Tagged unions make most invalid states unrepresentable, handlers receive capabilities rather than ambient authority, and which surface agents write (standalone or embedded TypeScript) is decided by the experiment:

- Every construct maps to an artefact an existing engine reads.
- Every engine result maps to a diagnostic with a stable code, a witness and typed fixes.

The new engineering is a compiler and a runtime integration, not a new engine. Its full extent is in the scope table of the architecture (section 2a):

- the language front end, with node-addressed fixes;
- the gate hook in the outbox worker, evaluated against the emitting step's snapshot;
- the outbox intent as a checked machine;
- a per-run ledger with periodic anchors;
- the certificate that binds what was checked to what runs.

The plan reaches its first measurable claim at M3, before any runtime is built. The experiment tests whether an agent writing poly ships fewer escaped defects than the same agent writing the host language. Its tasks, oracles and decision rule are fixed before any run, and M4 onward depends on its result.

## Appendix A. Worlds (deferred to v2)

Worlds are not in v1. They are not needed to test the two claims the first experiment tests (PT13), and they bring a fourth expression language (distributions). The v0.1 sketch is kept here so the lowering target stays recorded.

```poly
world checkout {
  tick 1ms
  node order[1..50]: orders.Order
  responder "payment.charge": delay lognormal(mean 200ms, sd 80ms) -> ok p 0.97 else failed
  driver arrivals: poisson(rate 2/s) -> AddItem to order[*]
  probe paid-share: share(status == Paid)
}
```

This lowers to `topology.json` (`tickMs`, `nodes`, routes), `responders.mjs`, `drivers.mjs` and `probes.mjs`. The layout follows Polytrion's principle P-1.1: "Responders draw, machines decide, the kernel schedules". Machines are the lowered artefacts, unchanged. Running a world requires the hosted Polytrion (AD-6). Its refusal codes, such as `UNDERPOWERED` and `MONITOR_FINDING`, surface as poly verdicts.
