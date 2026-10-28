# Example spec: appointment-booker

Batch 1, example 1. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

A small clinic books appointments from free text. A typed decision reads a request such as "Tuesday at nine" and answers a day and an hour. The program books that slot on the calendar, once, through an irreversible write attempted once, and refuses a slot that is already taken. The point of the example is the property: **no slot is ever booked twice**.

## Files

All paths are under `examples/appointment-booker/`. The names below are fixed.

| File | Content |
|---|---|
| `appointment-booker.poly` | module `booker`, first line `// expected: CLEAN` |
| `appointment-booker.policy.poly` | module `booker_policy`, policy `calendar`, scope `"booker"` |
| `appointment-booker-defect.poly` | the program with the overlap check removed, first line `// expected: FINDING PL3002` |
| `host/handlers.ts` | the certified handler file; exports `write` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/appointment-booker` |
| `host/recorded.mjs` | the recorded provider; exports `loadAnswers(file)`, `recordedBooker(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded answers of the decision |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

The tests are `test/ex-appointment-booker.test.mjs` (light) and `test/after/ex-appointment-booker-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`.

## Machine

One `service machine Calendar` in module `booker`. It works on one request at a time.

Types: `type When = { day: 0..1, hour: 0..1 }`. A slot is `day * 2 + hour`, so there are four slots, 0 to 3.

State: `phase` (enum `Phase`: `Idle`, `Parsing`, `Booking`, `Booked`, `Conflict`, `Unclear`, `Failed`, `Uncertain`; initial `Idle`), `taken : map<0..3, bool>` (all false), `slot : 0..3` (0).

Actions and handlers:

- `Ask(text: Content)`: rejects `"busy"` unless `Idle`. Goes to `Parsing` and issues `decide parse(text: text)`.
- `Parsed(day, hour, dconf: Conf, hconf: Conf)`: rejects `"not-parsing"` unless `Parsing`. If both confidences are at least 0.8: when `taken[day * 2 + hour]`, goes to `Conflict` (the refusal); otherwise goes to `Booking`, records `slot`, sets `taken` for that slot and emits `write(slot: ...)`. If either confidence is below 0.8, goes to `Unclear`.
- `Unparsed()`: the decision failed. Rejects `"not-parsing"` unless `Parsing`. Goes to `Unclear`.
- `Written()`: rejects `"not-booking"` unless `Booking`. Goes to `Booked`.
- `WriteFailed()`: rejects `"not-booking"` unless `Booking`. Goes to `Failed` and frees the slot.
- `WriteUncertain()`: the one attempt of the write ended with no answer the program can trust (a timeout, or a status that is not a refusal). Rejects `"not-booking"` unless `Booking`. Goes to `Uncertain`. The slot **stays taken**, because the write may have happened.
- `Resolve(found: bool)`: rejects `"not-uncertain"` unless `Uncertain`. When the owner found the event, goes to `Booked`; otherwise goes to `Failed` and frees the slot.
- `Reset()`: rejects `"not-settled"` unless the phase is `Booked`, `Conflict`, `Unclear` or `Failed`. Goes to `Idle`.

## Decision

`decision parse(text: Content) -> When`, provider `"small"`, labels `egress:external` and `read:private`, timeout 2s. Its `ok` outcome dispatches `Parsed` with the answer's `day` and `hour` and the per-field confidences `r.conf.day` and `r.conf.hour`. Its `failed` outcome dispatches `Unparsed`.

## Effect

`effect write(slot: 0..3)`: kind `"calendar.write"`, labels `egress:external`, target `egress` the exact URL `https://calendar.example/v1/events`, class `irreversible`, retry `attempts 1, base 200ms, timeout 10s`. Outcomes: `ok` to `Written`, `failed` to `WriteFailed`, `exhausted` to `WriteUncertain`.

**Attempted once (G1, PS23.4; finding 31).** The calendar service documents no idempotency key, so the write is not retried: a retry whose first answer was lost could book the slot twice, and the check reports such a write as `PL4003 UNGUARDED_RETRY` (PS23.5). With one attempt, `failed` is a refusal the service made (the slot was not booked) and `exhausted` is an end the program cannot read (the slot may be booked), which goes to a person through `Uncertain` and `Resolve`. The handler still sends the intent's idempotency key (`ctx.idempotencyKey`) as the header `idempotency-key`; nothing documents that the service honours it, so the program does not rely on it.

## Host handler

`host/handlers.ts` exports `write(payload, caps, ctx)`. It imports its types with a type-only import from `../.poly/build/booker.Calendar/types.js`. It posts, through `caps.egress.post`, to `https://calendar.example/v1/events` the body `{ day, hour }` (the slot as `Math.floor(slot / 2)` and `slot % 2`) with the header `idempotency-key`. Status 200 or 201 returns `{ ok: true }`. A status from 400 to 499 other than 429 throws an error with `permanent: true`, so the effect fails at once. Any other status, or a thrown transport error, throws an ordinary error; the effect has one attempt, so it ends `exhausted` and is not sent again.

## Recorded provider

`recorded/answers.json` holds `{ "models": { "small": "<model id>" }, "requests": [ { "id", "text", "answer": { "day", "hour" }, "distribution": [ [ { "day", "hour" }, p ], ... ], "usage" } ] }`. `recordedBooker(fixture)` returns `{ asked, decisions: { parse: { provider, model } } }`. The provider finds the request whose `text` is among the bodies the decision was given, records `{ decision, request: id }` in `asked`, and returns `{ answer, distribution, reported, latencyMs: 0 }`. A text the fixture does not hold throws. No test calls a model or the network.

The fixture holds these requests (each text is made up):

| id | text | answer | distribution | meaning |
|---|---|---|---|---|
| `tue-nine` | "Can I get Tuesday at nine?" | day 0, hour 0 | (0,0) 0.95, (0,1) 0.05 | a clear request |
| `tue-nine-again` | "Tuesday at nine please, for my sister." | day 0, hour 0 | the same | the same slot, a second request |
| `wed-ten` | "Wednesday at ten works." | day 1, hour 1 | (1,1) 0.92, (1,0) 0.08 | a second clear request |
| `vague` | "Sometime next week?" | day 1, hour 0 | (1,0) 0.5, (0,1) 0.5 | unclear |

## Policy

Policy `calendar`, scope `"booker"`: one obligation `write-while-booking`, a rule that, for `proposal.kind == "effect" && effect.kind == "calendar.write"`, requires `machine("booker.Calendar").phase == Booking`, otherwise `deny`, with `on unknown deny`. The policy is signed as a person signs it (`signPolicies`).

## Properties

1. **Step property `free-slot-only`** (the double-booking property): `(action == Parsed && post.phase == Booking) implies !pre.taken[post.slot]`.
2. **Invariant `booking-holds-slot`**: `phase == Booking implies taken[slot]`.
3. **Invariant `booked-holds-slot`**: `phase == Booked implies taken[slot]`.

The program and its policy together check `CLEAN`. The program has no deadlock check (a service machine is exempt, PS1.7).

## Seeded defect

`appointment-booker-defect.poly` is the program with the conflict branch of `Parsed` removed: a confident parse always goes to `Booking`, whether or not the slot is taken. The check rejects it with exactly one code, `PL3002 STEP_PROPERTY`, naming `free-slot-only`. The shortest witness has **6 steps**: `Ask`, `Parsed(0, 0, 800, 800)`, `Written`, `Reset`, `Ask`, `Parsed(0, 0, 800, 800)`. The check of the defect copy beside the same policy gives the same finding.

## What the tests must show

Light test (`test/ex-appointment-booker.test.mjs`):

- the program, checked with its policy, is `CLEAN`, and the report prints the instance (slot range, content representatives, state count);
- the defect is `FINDINGS` with exactly `PL3002`, the property named, a witness of 6 steps whose last step is `Parsed` into `Booking` on a slot a step before had taken;
- `poly check --host` over `host/tsconfig.json` with `--root examples/appointment-booker` is `CLEAN`, and a handler with a wrong payload field is `PL6836`;
- the handler: 201 returns ok; 409 throws with `permanent: true`; 503 throws without it; the header `idempotency-key` is the context's key and the body is the slot's day and hour;
- the recorded provider: each request of the table gives its answer; an unknown text throws; `asked` records ids and never text.

End-to-end test (`test/after/ex-appointment-booker-e2e.test.mjs`), over recorded traffic, nothing on the network:

- main path: `Ask` with `tue-nine` ends `Booked`, with exactly one POST carrying a key; `Reset` returns to `Idle`;
- refusal: `tue-nine-again` ends `Conflict` with no second POST; `vague` ends `Unclear` with no POST;
- one attempt: a write answered 503 is sent exactly once (a later 201 in the script is never asked for), and the booking ends `Uncertain` with the slot still taken;
- failure and uncertainty: a 409 ends `Failed` and frees the slot (the same request books afterwards); after a 503, `Resolve(found: true)` ends `Booked`, and on another calendar `Resolve(found: false)` ends `Failed` and frees the slot;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

The example has no escalation to a person.

## Amendments made when the code existed

- The program declares `audience { public < patient }`. Without an audience the runtime keeps no taint record for a body the host stores, and a decision over it fails closed as `Unparsed` (S302).
- The policy holds a second obligation, `parse-while-parsing`, a rule that denies `decision.parse` unless the calendar is `Parsing`. Without a rule that names the decision, polycheck reports `PL7001` (a private-text egress region with no gate crossed).
- The recorded answers are read from `examples/appointment-booker/recorded/answers.json`, as the file table says. The test writer's first version read a fixture elsewhere and used `rt.state`; the implementer corrected those, the refusal test (which asked for a taken slot on a fresh calendar) and two over-strict assertions after the code existed.

## Amendment on v1.3.1 (finding 31)

v1.4 is built on v1.3.1, whose retry-safety rule (PS23.5) reports an irreversible effect that may be attempted more than once with no documented key as `PL4003`. The write was `attempts 3`, with a key the handler sent and no service documentation behind it, so the program and its defect copy were `FINDINGS` with `PL4003` beside their expected lines. The owner ruled: a target that documents an idempotency key is declared with its window; otherwise the effect is attempted once and an uncertain outcome goes to a person. The calendar service documents no key, so the write is `attempts 1`. The program already sent an unanswered write to a person (`Uncertain`, `Resolve`), so no state or action changes. The tests change where they asserted a retry. The expected lines, the defect's witness (6 steps) and the properties do not change.

## Conclusion

The property is small and exact: one comparison in `Parsed` is all that stands between the calendar and a double booking, and the check finds its absence in six steps. A write attempted once, and the held slot on an unanswered write, are outside that property, so the retry-safety rule and the end-to-end test cover them.

## Glossary

- **Slot:** one of four times, `day * 2 + hour`.
- **Attempted once:** an irreversible effect with `retry { attempts 1 }`: an end the program cannot read is never followed by a second request (G1, PS23.4).
- **Uncertain:** the one attempt of the write ended with no answer the program can trust; the slot stays taken until a person resolves it.
