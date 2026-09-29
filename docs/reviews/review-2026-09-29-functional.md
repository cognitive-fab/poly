# Review: poly specification set, draft v0.3

*Peer review of `README.md` and `docs/01` to `docs/04`, draft v0.3. Written in the manner of a functional-programming language designer at the author's request: it looks for the algebra under the engineering, and for what the host language already gives you for free. 30 September 2026.*

## Verdict

**Accept the direction, revise the design.** The semantics document is the best thing that has happened to this project. Once you write down that a machine is a function from a state and an input to a verdict and a next state, the whole design starts to talk back to you. This review listens to what it says. It is saying five things:

1. You have one program and three interpreters. Make that the architecture.
2. Your state is a product type pretending to be a sum type. Give poly real sum types.
3. Your effects are labelled but not tracked. Labels that are claims are not an effect system.
4. You split the language by syntax where types would do.
5. Before you build a new syntax, try the embedded one. Agents already speak TypeScript.

## 1. One program, three interpreters

Look at what the stack actually does with a machine:

| Engine | What it does with the machine | How the environment chooses inputs |
|---|---|---|
| polygraph | explores every input | nondeterministic choice, over the check domains |
| Polytrion | samples inputs from distributions | probabilistic choice, over declared rates |
| the runtime | reacts to real inputs | whatever the world sends, and effects go to real handlers |

This is the same machine interpreted in three different **environment effects**. The machine is the same pure step function every time. Only the thing that feeds it and consumes its intents changes:

- a set of possibilities for checking;
- a probability distribution for simulation;
- IO for running.

This is the thesis of the whole Poly stack, and it is buried. 04-semantics says "the environment chooses each action" (PS4.1) and stops there.

**Recommendation.** Make the environment an explicit interface in the semantics, with three named interpretations:

```
interface Env {
  offer(): Action × Data          // what happens next
  complete(i: Intent): Completion // what the world does with an effect
}
check    : Env = all choices          (nondeterminism)
simulate : Env = sampled choices      (probability)
run      : Env = the network, the clock, the handlers   (IO)
```

Then three statements become precise:

- **Checking** is exploring the check interpretation exhaustively.
- **Simulation** is sampling the simulate interpretation.
- **Running** is the run interpretation.

The claim "the checked program is the running program" becomes a theorem: same machine, different `Env`. PS4.4's over-approximation also becomes a statement about interpretations, not an apology. The check interpretation offers a superset of what the run interpretation can offer.

It also tells you where Polytrion fits when worlds come back in v2. A world is just a definition of `simulate`. The machines inside it need no change, which is exactly what the Polytrion principle "responders draw, machines decide, the kernel schedules" already says in words.

## 2. The state wants to be a sum type

Here is `OutboxIntent`'s state:

```
status : IntentStatus
attempts : 0..3
decisions : 0..2
executed : bool
approved : bool
```

That is a product of five fields: 9 × 4 × 3 × 2 × 2 = 432 combinations, of which 33 are reachable. The other 399 are states that should not exist, and three invariants and two step properties are there to say so. For example, `approved` only means something in `Escalated` and after it. `attempts` only means something from `Allowed` on. `executed` can be derived from `attempts > 0`.

This is the classic smell of a sum type encoded as a product. What the machine wants to say is:

```poly
state IntentState =
  | Pending
  | Proposed   { decision: 1..2, approved: bool }
  | Escalated  { approved: bool }
  | Allowed    { attempts: 0..2, approved: bool }
  | Running    { attempt: 1..3 }
  | Settled    { attempt: 1..3 }
  | Done | Denied | Dead
```

Now most of the invariants are **types**. You cannot write `executed` without an attempt, because there is no such field outside `Running` and `Settled`. You cannot take a second gate decision after an execution, because `Allowed` carries no `decision` field to increment. The model checker explores fewer states. The agent writes fewer invariants. The ones it does write are about behaviour, not about ruling out nonsense. Invalid states become unrepresentable instead of unreachable.

**Recommendation.**

- **Types.** Add tagged unions with payloads to the type language. Handlers pattern-match on the constructor, and the compiler checks that every match covers every case.
- **Lowering.** Lower a sum type to the SAM sealed shape as a tag field plus the union of payload fields. Generate one automatic invariant per constructor ("fields of other constructors are absent"). Nothing downstream changes: polygraph still sees flat fields.
- **Why this matters for agents.** Discriminated unions are the most idiomatic TypeScript there is. Coding agents write them all day. This is the cheapest feature on this list and the one agents will use most.

## 3. Labels are claims, not effects

An effect declares `labels { egress:external }` and `class irreversible`. The gate reasons about those labels. The host handler is then an arbitrary TypeScript function:

```ts
rt.handle('payment.charge', async (payload, ctx) => psp.charge(...))
```

Nothing stops that handler from reading a secret file, calling a second API, or writing to a disk. The label is the author's promise, and the gate trusts it. PS8.4 makes missing labels a refusal, which is good. But a **wrong** label is invisible, and a wrong label is what an attacker, or a confused agent, produces.

Every effect system worth the name ties the declaration to what the code is **able** to do. There are two ways to do that here, and the stack has both pieces already.

- **Capability passing.** A handler receives only the capabilities its labels grant:

  ```ts
  rt.handle('payment.charge', async (payload, { egress }) => egress.post(PSP_URL, ...))
  ```

  A handler for `egress:external` gets an `egress` object bound to the declared targets, and nothing else. It gets no `fs`, and no general `fetch` if the runtime can prevent it. In TypeScript this is a type-level discipline plus a lint rule that bans ambient imports in handler modules. It is not a proof, but it moves the label from "said" to "used".
- **Sandbox by construction.** Run each handler kind in an NVIDIA OpenShell sandbox whose policy is **generated from the effect's labels**. The stack already has the OpenShell integration. `egress:external` to `PSP_URL` becomes the only allowed egress for that sandbox. Now a wrong label fails closed at the network layer instead of silently widening what the gate believes.

Either way, the principle is the same: **an effect's type is what it can do, not what it says it does.** Section 7.2 of the architecture should say which of the two v1 uses. PT15 should show the handler signature with capabilities.

## 4. Types, not syntax, should separate the two logics

v0.2 moved policies into `.policy.poly` files, with `is` / `is not` instead of `==` / `!=`, so the two-valued and three-valued logics never meet. That fixes the symptom with syntax. The disease is that there are two types of truth value and the language does not have types for them.

Kleene's three-valued logic is just `Bool` lifted into an option type, with a particular choice of how `and` and `or` treat the missing case. Call the type `Tri`. Then:

- machine expressions have type `Bool`;
- policy expressions have type `Tri`;
- `unknown(x)` has type `Bool`;
- a `require` in a machine demands `Bool`;
- a `when` in a policy accepts `Tri` and must say what `U` means (PS8.2 already does).

The type checker then rejects a `Tri` where a `Bool` is expected. Policies can live wherever they are clearest, and one set of operators works everywhere, overloaded by type. That is how every language with an option type handles this, and agents already know the pattern from TypeScript's `boolean | undefined`.

This is a smaller change than it sounds: the rules of PS8.1 do not move, they get a type. Keep the separate file type if it helps people read policies. Just do not make it the thing that keeps the semantics apart.

## 5. Try the embedded language before the new one

The decision to write a new syntax is the biggest bet in the design. The documents give it one line (AD-1 is about text versus AST, not about whether to have a new syntax at all). History has a strong lesson here. Language-integrated query won because it lived inside the host language, with the host's types, tools and editors, and a small, analysable core underneath. The query language was an embedded interface over an expression tree, not a new file type.

poly has the same shape:

- a small, total, analysable core (04-semantics);
- a surface that agents must write.

An **embedded** surface would look like this:

```ts
export const Order = machine({
  state: { status: t.enum('Draft', 'Placed', 'Paid', 'Shipped', 'Cancelled'), items: t.range(0, 3) },
  on: {
    Place: (s) => [require(s.status === 'Draft', 'not-draft'), require(s.items > 0, 'empty-order'),
                   set({ status: 'Placed' })],
    Pay: (s, { amount }: { amount: t.OneOf<10 | 20> }) =>
      [require(s.status === 'Placed', 'not-placed'), emit(charge(amount))],
  },
})
```

It is written in TypeScript and is valid TypeScript. It is type-checked by `tsc`, edited in every editor, and completed by every model. A staging step (reflection over the handler's syntax tree, restricted to the PT2.2 subset and rejected otherwise) turns it into the same AST and lowers it the same way. The totality of the core is kept by a checker that refuses anything outside the subset, exactly as `poly-lang` would.

**What you give up:**
- a clean syntax for primes and properties;
- canonical formatting (the host formatter decides);
- a guarantee against the host language leaking in, which moves from the parser to a linter.

**What you get:**
- zero training-data gap;
- the host's type checker, language server and package manager;
- no parser, formatter or language server to build (a large part of the scope table in 02 §2a disappears).

I do not know which surface wins. Neither do you, and the experiment is exactly the place to find out. **Add a fourth arm to PT13: poly as an embedded TypeScript DSL.** It costs one front end on the same core. If it matches the standalone syntax on escaped defects at lower token cost, you have saved yourself a compiler front end and handed every coding agent a language it already speaks.

## 6. Small things

- **Replay is a fold.** A run's state is the left fold of the step function over its journal from `init`. Say that in PS11, because it makes the replay theorem one line long (determinism of the step, PS2.5). It also makes the kernel's job obvious: store the journal and the fold is free.
- **Rx duality.** Inputs are a stream into the machine, and intents are a stream out. The runtime is a stream transformer. That is a better mental model for agents writing host code than "outbox worker", and it suggests the host API: `rt.inputs.subscribe(…)`, `rt.intents.subscribe(…)`.
- **Hello, world is missing.** 14,000 words in, there is no ten-line program that runs. Put the turnstile, complete, at the top of the README, with `poly check` output and a three-line host program that dispatches `Coin` and `Push`. Agents learn from examples first and grammars second, and so do people.
- **Liveness under fairness is a game.** The environment is an adversary constrained by fairness. That is the right model. Say so, and the lasso witness becomes the adversary's winning strategy. That explanation lands with engineers.
- **PS2.3 (primes are write-only) is quietly beautiful.** It makes a handler a pure function from pre-state to a set of writes, order-free. Keep it, and mention it in the README, because it is the reason agents cannot get sequencing wrong inside a handler.

## 7. What is right

- **A deterministic, total step function** as the unit of everything. This is the correct foundation, and everything above can be built on it.
- **Translation validation per program (PS9.3).** Checking the compiler's output against the semantics every time, instead of proving the compiler once, is pragmatic and correct.
- **Rejection as a labelled stutter.** It is clean and it is the right answer.
- **The environment as unconstrained nondeterminism in checking.** It is the right interpretation, and section 1 only asks you to name it and give it two siblings.

## 8. Requested changes, in order

1. The environment as an explicit interface with three interpretations: check, simulate, run (section 1).
2. Sum types with payloads, exhaustive matching, and flattening to the sealed shape; rewrite `OutboxIntent` with them (section 2).
3. Capabilities or generated sandboxes for handlers, so labels constrain code (section 3).
4. A `Tri` type for three-valued expressions, with the logics separated by type, not syntax (section 4).
5. An embedded TypeScript surface as a fourth arm of the experiment (section 5).
6. Replay stated as a fold; a complete hello-world at the top of the README (section 6).

## Conclusion

v0.3 found the core: a total, deterministic step function with a clear semantics. The next step is to let that core shape the rest of the design. One program with three interpreters is the architecture. Sum types remove most invariants. Capabilities turn labels into a real effect system. A type separates the logics. Whether the surface is a new syntax or embedded TypeScript is an empirical question, and the experiment is already set up to answer it. Do these, and poly is not just a language for coding agents. It is a clear account of what the whole Poly stack has been doing all along.
