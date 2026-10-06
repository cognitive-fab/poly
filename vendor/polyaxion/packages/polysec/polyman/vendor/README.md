# vendored

`sam-pattern.cjs` is a vendored build of **@cognitive-fab/sam-pattern** (SAM
**2.1.2**, explicit next-state / prime semantics, #25), the strict-profile
state-machine library polyman drives at runtime. It is byte-identical to the
bundle the PolySec design-time checker uses
(`../../scripts/vendor/sam-pattern.cjs` in the polygraph repo), so the policy
polyman *enforces* is stepped by the same engine that *proved* it (the
golden-parity test asserts this).

Vendored (rather than an npm dependency) for two reasons: (1) a standalone
install must not depend on a specific published version drifting from the proven
one; (2) it keeps runtime SAM byte-identical to design-time SAM. License:
Apache-2.0, © Cognitive Fab LLC — same as this package.
