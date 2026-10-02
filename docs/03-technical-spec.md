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

  `people` and `agents` are the keyrings of PT12.5, each a list of `{ name, keyId, publicKey }` with the public key as PEM or `file:PATH`; admission certifies both (S150). `keys.admission` names the key `poly admit` signs with, by id and location, never by value: `{ "id": "ops-2026", "location": "env:POLY_ADMISSION_KEY" }` or `"file:/path/outside/the/repository.pem"`. A key file inside a version-controlled tree is refused (S126). `handlers` names the effect handler modules that `poly lint handlers` reads (PT6.5, S72), and that the certificate binds with the files they import (PT15, S142). `modules` may name `.poly` and `.ts` files; a `.ts` module is read by `poly-embed` (PT2.5, S71).

- **PT1.3** Imports are by module name within a project: `use payments.Payment`. Cross-project imports are out of scope for v1 (open question 4 in the architecture).
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
MachineItem = Terminal | Action | Handler | Guard | Property | Effect | Decision ;
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
| `step property` | `pre.f` and `post.f` for every field `f`; `action`, compared with `==` or `!=` to an action name; the parameters of the step's action |
| `reject property` | `pre.f`, or the bare field `f`, for the state the step starts from; `action`; the parameters of the step's action; `rejected("reason")`, true iff the step's verdict is `rejected` with that reason |

Names resolve as in PT2.2 (S19): a bare name is a parameter where one is in scope and a field otherwise, and `pre.f` always names the field. A parameter is in scope only on steps of an action that declares it, so a property that reads one must first compare `action`: in `(action == Pay && amount > 10) implies …`, `amount` is read only when `action == Pay` holds. A parameter read where no declaring action is established is `PL1201 TYPE_MISMATCH`, not `false`. Step and reject properties are lowered with the step's verdict as an extra argument, so a step property is evaluated on accepted steps only (PS5.2), even though the engine calls `transitionInvariants` on every step.

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

- **Handler modules are checked by a lint pass** (`poly lint handlers`), over the files `poly.json`'s `handlers` names and every file they reach through relative imports, each read once (S72, S142). A relative import that names no file or a file outside the project, or an import by absolute path or URL, cannot be certified: `PL6402 HANDLER_NOT_CERTIFIABLE`, and the program is not admitted. An installed package (a bare specifier) is listed, not read or hashed (an M4 limit); the nearest lockfile above the project is recorded instead, and a handler that imports a package with no lockfile is `PL6402`. A project with effects and no `handlers` field lists the lint as not run under the instance line; it is never silently clean. It rejects imports of ambient-authority modules, such as `fs`, `net`, `http`, `child_process`, global `fetch` and `process.env`. A violation is `PL6401 AMBIENT_EFFECT_IN_HANDLER`, and the program is not admitted.
- **As built (M5a, S134, S151).** `targets { egress: "<prefix>" | [ … ], secrets: [ … ], exec: [ … ], store: [ … ] }` is an effect item. Each kind of target needs a label that grants it, by the table above (`PL6303 TARGET_NOT_GRANTED`); an egress target is an absolute http or https URL with no user, query or fragment (`PL1201`). The lowering writes them to the effect's manifest entry as `targets`, and the read-back compares them with the source (a widened prefix is the toolchain fault `widen-target`). The host gives the transports at load, `load(…, { transports: { egress, secrets, exec, store } })`, and poly-runtime imports no network module, which the boundary check enforces. For each call the runtime builds a frozen capability object from the entry's labels and targets: `egress.get(url)` and `egress.post(url, body)` (for `egress:external` or `egress:public`), `secrets.get(name)` (`read:private`), `exec.run(command, args)` (`exec`), and `store.read(table, key)` or `store.write(table, key, value)` (`read:store`, `write:store`). A URL is parsed by the WHATWG parser, which lowercases the host, drops a default port and resolves dot segments and their encoded forms; it is within a prefix when the scheme and host with port are equal and the path equals the prefix's or continues it past a `/`. A URL with a user is refused. The egress transport makes one request and follows no redirect: the capability reads each 3xx `Location`, resolves it against the current URL, and checks the hop against the prefixes before it asks the transport for it; 303, and 301 or 302 after a POST, continue as a GET with no body; more than five hops is an error. A secret name, a command and a table match exactly. A call outside the bounds writes a `PL6406` audit row and then throws `CapabilityRefused`, before the transport is called. A label with no targets of its kind gives a capability bound to nothing, so every call of it is refused. Capabilities are bound in-process: the certificate's limits say the lint is what keeps a handler from reaching around them, until the sandbox (S152).
- **This is a discipline, not a proof.** TypeScript cannot stop determined code from reaching ambient authority, for example through dynamic `import()` or `globalThis`. The lint rejects both forms, but only the sandbox below enforces the boundary.

**2. Generated sandbox (opt-in, M5).** With `handlers: { isolation: "openshell" }` in `poly.json`, each effect kind's handlers run in an NVIDIA OpenShell sandbox. Its policy is **generated from the effect's labels and targets**: network egress only to the declared prefixes, no filesystem beyond a scratch directory, and secrets scoped to the declared names. A wrong or missing label then fails closed at the sandbox boundary instead of silently widening what the gate believes. The stack's existing polyaxion-openshell work supplies the integration.

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

The inputs of a poly policy are the runtime's proposal (PT9.1): `effect.kind`, `effect.class`, `effect.labels` (`effect.labels has "egress:external"`), `effect.machine`, `proposal.kind`, `machine("m.M").f` (PT8.3) and `decision("d").f` (PD4.3: `taken`, `answer`, `conf`, `margin`, `model.id`, `model.reported`, `calibration.fittedFor`). Each name and field is checked against the program (`PL1001`, `PL1201`). The scope's policies are declared in one module, since they lower to one document. A `never` statement is proved by poly-ref over the decision table (S149): the finite product of the proposals the program can make and of every value its policies can read; a policy that allows a proposal its `never` forbids is `PL6503 NEVER_VIOLATED`, with the proposal and the policy states that lead to it as the witness; a `never` whose condition no proposal meets is `INCONCLUSIVE` (`vacuous`), and one over a value with no finite domain is `runtime-only`. The Claude Code vocabulary of the example below (`action.path`, `glob`, `history`) is not part of M5a's surface (S159).

In PX, `glob(action.path, …)` is unknown when `action.path` is missing. What an unknown `when` does is fixed by the rule's `on unknown` (PS8.2), so no `?? ""` default is needed, and none is accepted.

### PT8.2 Lowering

| poly | `polyaxion.policy.json` |
|---|---|
| `obligation … machine { … }` | `kind: "machine"` with `states`, `initial`, `transitions` (`{from, when, to}`), `guards` (`{in, when, reason}`) and `end` |
| `obligation … rule { … }` | `kind: "rule"`, `when` / `require`; `else deny`, `else warn` and `else escalate` map to `severity`. `on unknown escalate \| deny \| skip` gives the outcome when `when` is unknown (PS8.2). The default is `escalate` for deny rules and `warn` for warn rules. `skip` must be explicit and is listed in the certificate under `skippedOnUnknown`. Polyaxion receives it as an `unknownWhen` field; if the engine does not yet support the field, the compiler rewrites the rule so that an unknown `when` yields the declared outcome. |
| `obligation … invariant { … }` | `kind: "invariant"` over declared `vars` |
| `recalled` | `kind: "recalled"`, compiled into `unenforced[]` |

Closed history predicates are lifted into counters and model-checked by Polyaxion. Open ones must be declared `coverage runtime-only`, exactly as Polyaxion requires.

**One document per scope, and PS8 by rewriting (M5a).** The policies of one trust scope lower to one document, `.poly/build/policies/<scope>.policy.json`, with every deny rule before every escalate rule and every warn rule, so that the engine's first refusal is PS8.3's. Polyaxion applies a rule whose `when` is unknown and refuses an unknown `require` as `indeterminate`, so PS8.2 is carried by rewriting: `when W require Q else s on unknown u` lowers to a rule `when P && coalesce(W, false) require coalesce(Q, false)` with severity `s`, and, unless `u` is `skip`, a rule `when P && isNull(W) require false` with severity `u`, where `P` holds only for the runtime's proposals (`custom.poly.effect` and `custom.poly.send`), so the engine's own actions, such as the end of a session, pass. A guard refuses when its condition is true or unknown, and a transition fires only when its condition is true. The proposal's fields are reserved action fields the gate host fills (S147). Engine change E7 (S158) would let Polyaxion combine a rule's escalation with a guard's deny itself; until then the host does it (PT9). Each lowered document is translation-validated: poly-ref's PS8 decisions and the engine's plan interpreter must agree over every reachable pair of policy states and every proposal of the decision table, or the program is refused with `PL2501`; three deliberately broken policy lowerings are listed in `test/toolchain-faults.mjs`.

### PT8.3 Referencing program state

`machine("<module>.<Machine>")` is new. It reads the snapshot of the instance that emitted the effect under decision, **as of the step that emitted it** (PT9.3). It never reads a later snapshot. **Singletons (S147).** It may also name a `service machine`, a singleton: the proposal then carries that instance's latest snapshot and `seq` at proposal time, recorded in the `verdict` event. Otherwise the value is unknown (Kleene) when the proposal is not an effect of that machine. A read that can never be known (a machine that is neither a service machine nor the emitter of any effect) is `PL6502 UNKNOWABLE_MACHINE_READ`, a finding: the policy form of a vacuous property.

### PT8.4 Admission

Policy admission runs Polyaxion `compile` and `harden`. Machines with regions or gates must be `fullyMediated`. The coverage grade (`checked` or `runtime-only`) is copied into the certificate. polycheck then runs the regions against the effect labels of every admitted machine and the tool labels of the declared scope. Its result, `PROOF`, `WITNESS` or `INCONCLUSIVE`, maps to `CLEAN`, `FINDINGS` or `INCONCLUSIVE`.

**Stage 5a as built (M5a, S161).** polycheck is a second optional peer, pinned like Polyaxion (`peers/polycheck/PROVENANCE.md`) and listed as not run where it is absent. For each trust scope it models the effects of the modules the scope governs: each effect kind is an action whose flags are its labels' by the table below, gated when a policy of the scope names that kind (`effect.kind == "k"` or `effect.kind in { … }`). polycheck's default regions (`lethal-trifecta`, `credential-egress`, `source-egress`) are checked over it. A region reached with no gate crossed is `PL7001 REGION_WITNESS`, a finding with the path. A region no effect of the program can provide is noted as unreachable, not left inconclusive: a program's effects are its whole capability surface, since its handlers are certified (PT6.5). The state-dependent cases stay with `never` statements (S149).

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
- **As built (M5a, S148).** The stage runs Polyaxion's m2 check over the scope's lowered document. For each mandate (a machine obligation with end states) it cannot discharge, the minimal subset is found by deletion: the obligations are tried for removal in declaration order, an obligation is dropped when the mandate stays undischargeable without it, and the number of discharge checks is reported with the finding. The subset is minimal, not the smallest. Polyaxion draws the actions it explores from a policy's examples, and its own sampler does not reach a runtime proposal's reserved fields, so the lowering gives each obligation, as examples, every proposal of the decision table one step from the initial state, allowed or refused as PS8 says of that obligation alone; admission then also requires the engine to agree with each.
- `poly mine` runs the stage again for each rule a person proposes to promote. A promotion that would make a mandate undischargeable is refused at that moment, before the rule is ever served.

## PT9. The gate in the runtime

This is the only new engine integration (architecture section 7.2).

**The policy gate (M5a, S146, S147).** A build with policies runs behind the policy gate, and only behind it: `load` refuses another gate, and refuses the build when the gate engine is not available (S145). Polyaxion decides in process. An instance's trust scope is its machine's module (S160): the policies whose scope selector matches the module govern it, and a module no policy matches is declared open at load, so a governed scope whose policy is missing refuses while an ungoverned one does not. Each scope has one session, `scope:<module>`, which the host serialises; it assigns `sseq` on every proposal and every settle, durably, and every `verdict` and `settled` event carries the session, its `sseq`, and Polyaxion's Σ digests before and after. The engine sees each proposal as a `custom.poly.effect` action whose reserved fields hold what the scope's policies read: the emitting step's snapshot for its own machine, the latest snapshot of a service machine (a singleton) with the `seq` read, and the run's latest `decision` events. The singletons read are recorded in the `allowed` event, and before each start of the handler the worker compares them with their current `seq`: an allow one of them has outlived is not acted on but rechecked (PT9.7), as a new proposal with a new `sseq`. An escalation is lifted only by a person's signed approval (PT12.5), passed to the engine with the approver's key id. The engine refusing, hanging past `proposeTimeoutMs`, answering `unavailable` or failing to journal its decision is an outage, and the intent is held (PT9.5). An engine that throws or does not answer takes no sequence number; one that answers in a way the host cannot act on does, and the answer is recorded as a `held` verdict, so the session still replays. The outage test (`test/gate-outage.test.mjs`) injects these faults under a seeded schedule, with a crash after an allow, a ledger that cannot write a verdict, a governed scope that loses its policy and a keyring that cannot be read, and observes from a log of handler calls the host cannot write that no allow is obtained during an outage and no handler runs without one. Polyaxion reports an escalate rule before a guard's deny; until engine change E7, the host asks the engine's own interpreter, with the escalations lifted, whether a deny stands behind, and decides deny when one does (PS8.3, S158). Each session's windows are signed by the engine's notary into receipts (AC4). **Session replay (S118, AC6).** Each `verdict` event keeps the engine action by digest, the gate's decision and Σ before it; each `settled` event its action and what was observed. `poly journal replay` re-applies every session's events in `sseq` order on a fresh engine with the certified policies and must reproduce every decision and Σ digest, or reports `PL9001`; a gap in a session's sequence (a decision whose event was never written, PT9.5) stops that session's replay, listed as not run. A run's policy-gate decisions are replayed with their session, not one by one.

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
- **PT9.9 Sends across trust scopes.** A `send` from one trust scope to another is proposed to the gate like an effect (PS8.7). The proposal carries `kind: "send"`, the target's machine and scope, the action, and the payload digest. On deny, the runtime does not deliver the message. It delivers `SendDenied(to, action, reason)` to the sender instead, with its own idempotency key. Sends within one scope are not proposed. **As built (M5a, S160).** An instance's trust scope is its machine's module, unless its configuration assigns one with `scope "x"`. A policy reads a send through `proposal.kind == "send"` and `send.to` (the target machine), `send.action` and `send.scope`. The runtime proposes each message between two scopes in the sender's session before polyrun delivers it: allowed, it is delivered; denied, it is marked dead and `SendDenied(to, action, reason)` is dispatched to the sender with the action id `<message>:send-denied`; a gate that cannot decide leaves it pending. A send has no approval path in M5a, so an escalation of one is denied, with the reason saying so. The configuration check explores the gate's choice on every message between instances of different scopes: delivered (allow), turned into `SendDenied` to the sender (deny), or held and then delivered or denied (escalate). **M5a limit:** a scope is a module and a cross-module address is not lowered (`use`, PL0901), and the runtime has no configuration instances before S153 (E5), so no program makes a cross-scope send at runtime in M5a; the runtime path is tested with a message injected below the language, and M5b adds the end-to-end test.

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
| PL1xxx | names, types, domains | `PL1001 UNKNOWN_NAME`, `PL1002 DUPLICATE_DECLARATION`, `PL1005 AMBIGUOUS_CONSTRUCTOR`, `PL1101 UNBOUNDED_DOMAIN`, `PL1201 TYPE_MISMATCH`, `PL1202 READ_OF_PRIMED_FIELD`, `PL1203 TRI_WHERE_BOOL_EXPECTED`, `PL1204 DIVISION_BY_ZERO`, `PL1207 RESERVED_REJECT_REASON` (S101, S127), `PL1208 RESERVED_NAME` (M4 review D1, S143: an effect kind beginning `decision.` or `outcome.`, which the toolchain generates, or a machine in a module named `runtime` or `runtime<m>`, which are the runtime's own OutboxIntent ids), `PL1301 DISCLOSED_IRREVERSIBLE_INPUT`, `PL1401 TERMINAL_NOT_ON_CONTROL_FIELD`, `PL1501 NON_EXHAUSTIVE_MATCH`, `PL1502 INCOMPLETE_MAP_LITERAL`, `PL1503 UNREACHABLE_ARM`, `PL1504 UNUSED_BINDER`, `PL1601 PAYLOAD_TYPE_CONFLICT`, `PL1602 ARRAY_MAP_NOT_ZERO_BASED`, `PL1701 NOT_PREFIX_CLOSED` |
| PL2xxx | lowering, strict validate, translation validation | `PL2001 STRICT_VALIDATE`, `PL2101 WRITE_BEFORE_REQUIRE`, `PL2102 DOUBLE_WRITE`, `PL2201 SILENT_NOOP`, `PL2301 DUPLICATE_TIMER_KEY`, `PL2401 RUNTIME_MODEL_DRIFT`, `PL2501 LOWERING_MISMATCH` |
| PL3xxx | model check, deadlock, liveness | `PL3001 INVARIANT_REACHABLE`, `PL3002 STEP_PROPERTY`, `PL3003 REJECT_PROPERTY`, `PL3102 DOMAIN_ESCAPE`, `PL3201 DEADLOCK`, `PL3301 LIVENESS_LASSO`, `PL3901 BOUND_HIT` |
| PL4xxx | path properties | `PL4001 PATH_PROPERTY`, `PL4002 EMIT_WITHOUT_STATE_CHANGE` (effects, timers and child intents; not `send`, S63) |
| PL5xxx | composition, configurations | `PL5403 UNQUANTIFIED_GROUP`, `PL5405 FIFO_WITHOUT_IN_ORDER_WORKER` (S125), `PL5001 COMPOSE_INVARIANT`, `PL5101 CHILDKEY_COLLISION`, `PL5102 UNHANDLED_CASCADE_DELIVERY`, `PL5103 CHILD_READ_WITHOUT_SPAWNED`, `PL5104 SIGNAL_TO_ABSENT_CHILD`, `PL5105 DUPLICATE_SIGNAL`, `PL5201 CASCADE_DEPTH`, `PL5202 ATTACHED_ACROSS_SHARDS`, `PL5301 TRANSIT_BOUND_HIT`, `PL5302 INSTANCE_BOUND_HIT`, `PL5303 CONFIGURATION_WITHOUT_BOUNDS`, `PL5401 CONFIGURATION_INVARIANT`, `PL5402 STUCK`, `PL5404 SEND_TO_NONE` |
| PL6xxx | policy admission, labels, capabilities | `PL6001 NOT_FULLY_MEDIATED` (M5a: any refusal of Polyaxion's admission, with its reason), `PL6501 UNDISCHARGEABLE_MANDATE`, `PL6502 UNKNOWABLE_MACHINE_READ` (S147), `PL6503 NEVER_VIOLATED` (S149), `PL6101 COMPLETION_WITHOUT_HANDLER`, `PL6201 UNGATED_DECISION`, `PL6202 DECISION_WITHOUT_FAILURE`, `PL6203 ADJUDICATION_WITHOUT_DECISION` (S129), `PL6204 DECISION_COMPLETION_SENT` (M4 review C5: a `send` of an action that completes one of the receiver's decisions), `PL6301 UNLABELLED_EFFECT`, `PL6302 UNLABELLED_IN_LABELLED_SCOPE`, `PL6303 TARGET_NOT_GRANTED` (S151: a target whose capability none of the effect's labels grants), `PL6401 AMBIENT_EFFECT_IN_HANDLER`, `PL6402 HANDLER_NOT_CERTIFIABLE` (S142: a handler import the certificate cannot name), `PL6403 HANDLER_CHANGED` (S142: at load, a certified handler file or the lockfile that differs), `PL6404 HANDLER_NOT_CERTIFIED` (S142: `rt.handle` given a function that is not an export of a certified handler file as loaded), `PL6405 KEYRING_CHANGED` (S150: at load, a people or agents keyring that differs from the certified one), `PL6406 CAPABILITY_REFUSED` (S151: at run time, a capability call outside its targets, refused before the transport and audited), `PL6601 CROSS_SESSION_STATE` |
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

**The certificate (S126).** `poly admit` writes `.poly/certificate.json` in the polyflow certificate's shape (`v`, `subject`, `artefacts`, `guarantees`, `checks`, `domains`, `boundAccepted`, `toolchain`, `issuedAt`, `buildId`, `signatures`, `digest`), with poly's fields: the source and module digests, every artefact of every machine by path and SHA-256 (including `invariants.compose.mjs` and `liveness.mjs`), the instance of PT12.3a, the kernel assumptions, `decisions` (PD3.2b), and `handlers` (S142): the handler files `poly.json` names (`roots`) and every file they reach through relative imports, by path and SHA-256, the version and verdict of the lint that read them, the installed packages they import, and the lockfile's path and digest. It is signed, ed25519, with the admission key `poly.json` names by id and location (`keys.admission`); **no private key is ever committed**, and test keys are generated at test time. At load, the runtime reads only public keys. It reads each artefact once, checks its digest and the signature, writes the verified bytes to a directory named by the build id, and registers polyrun's machines from that copy, so the bytes polyrun loads are the bytes checked. Any difference (a changed, missing or extra artefact, an edited certificate, a bad signature or an unknown key) refuses the load, naming the artefact and both digests.

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

**Signing and verification.** Signed heads are `{ run, seq, hash, keyId, alg: "ed25519", sig }`, one per run. Verification runs the four Polyaxion checks: signature, chain, binding and replay. **Heads are signed off the step path (S123):** a signer loop signs the latest head of each run that moved since its last signature, every `ledger.headMs` and at closure, since a remote signer cannot sign inside a transaction. A live run verifies as `open-and-signed` through the `seq` its newest head covers, never as fully signed. `poly journal verify` also requires every run to carry a trusted signed head and the latest anchor to verify and cover each run's latest signed head; a missing head, a run absent from the anchor or a head signed after it is `PL9002`, and the command exits non-zero (review B1).

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
