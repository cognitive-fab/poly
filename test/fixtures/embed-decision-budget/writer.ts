// S454 (PS18.4a, PT10r): the writer of test/fixtures/decision-budget/writer.poly, written by hand in the embedded
// surface. The decision's clause `prices "prices/flash.json" max input tokens 2000 max tokens 4000 budget monthly`
// is the decision item budget("monthly", { prices, maxInputTokens, maxTokens }), after provider("flash") as the
// clause is after `provider`. The budget("monthly", { caps }) in the declaration list is the budget itself.
import { action, budget, count, decide, decision, enumType, failed, field, isIn, labels, machine, module, okWith, on, pathProperty, provider, require, set, t, terminal, timeout } from '@cognitive-fab/poly/embed';

export default module("writer", [
  enumType("Tone", ["Plain", "Warm", "Other"]),
  enumType("DraftStatus", ["New", "Writing", "Written", "Unwritten"]),
  machine("Draft", {
    state: {
      status: field(t.named("DraftStatus"), ($) => $.New),
    },
    items: [
      terminal(($) => isIn($.status, [$.Written, $.Unwritten])),
      action("Requested", { text: t.string.check(["draft a reply"]) }),
      action("Wrote", { tone: t.named("Tone"), conf: t.conf, margin: t.conf }),
      action("NotWritten", {}),
      on("Requested", ($) => [
        require($.status === $.New, "not-new"),
        set("status", $.Writing),
        decide("draft", [$.text]),
      ], ["text"]),
      on("Wrote", ($) => [
        require($.status === $.Writing, "not-writing"),
        set("status", $.Written),
      ], ["tone", "conf", "margin"]),
      on("NotWritten", ($) => [
        require($.status === $.Writing, "not-writing"),
        set("status", $.Unwritten),
      ]),
      decision("draft", { text: t.string }, t.named("Tone"), [
        provider("flash"),
        budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: 4000 }),
        labels(["egress:external", "read:private"]),
        timeout("800ms"),
        okWith("r", "Wrote", ($) => ({ tone: $.r.answer, conf: $.r.conf, margin: $.r.margin })),
        failed("NotWritten", []),
      ]),
      pathProperty("one-draft", ($) => count("decision.draft") <= 1),
    ],
  }),
  budget("monthly", { caps: [
    { currency: "usd", amount: 0.004, per: "month" },
  ] }),
]);
