# poly · Signed rules: a person signs what must always hold (proposed for v2.0)

*Cognitive Fab · November 2026 · on branch `rules-index`, after S589 (`poly rules`) · from PT12.5 (signed policies, the anchor, no rollback), PT14 (`poly rules` as built), PT15 (the certificate), the refund-twice example (S588) and the owner's question of 2026-11-08 on one file for the rules*

Status: a plan for v2.0. The owner answered its four questions on 2026-11-08 (section 6): opt-in, no domains, no policy items, no signed examples. Nothing here is specified, tested or built, and it numbers nothing yet: the ruling, the spec sections and the codes are taken from the free ones when v2.0 starts.

## 1. The gap

A person signs every policy (PT12.5, S194). An agent may draft one and the check proves it, but admission and load refuse a policy scope that no key of the `people` ring signed, and the anchor refuses a rollback to an older signature. So an agent cannot weaken a policy to let its own effects through.

The rules inside a machine have no such protection. Invariants, `never` statements, path properties, liveness properties and a configuration's properties are part of the module's source. An agent that deletes `never no-reissue` from the refund-twice desk (`examples/refund-twice`) gets a program that checks `CLEAN`, and `poly_admit` is open to it over MCP, so the program is admitted and certified without the rule. The certificate changes, and nothing refuses it.

`poly rules` (S589) makes that removal visible: a committed `RULES.md` shows it in a diff, and `poly rules --check` fails in review or CI. It does not stop it. A reviewer who does not look, or a pipeline with no such step, lets it through. Bend's landing page leaves the same question open for its `LAWS.bend`.

## 2. The proposal

The owner signs the set of a project's rules, as the owner signs a policy scope. Admission refuses a build that drops or changes a signed rule. A rule added without a signature is accepted, since adding a rule only makes the program stricter.

- **What is signed.** The machine and configuration rules of `poly rules --format json` (S589): each rule's `id`, `kind` and `text`, as `poly fmt` prints it. Policy items are left out, since their scope's signature already covers them. The subject of the record is the digest of `{ project, sequence, rules: [ { id, kind, text } … ] }`, the rules in the index's order.
- **Where it lives.** `rules.sig.json` in the project, committed with the sources, `{ v: 1, sequence, record }`, the record of a new kind `rules`, by a key of the certified `people` ring.
- **The command.** `poly sign rules --by <keyId> --key <file> [--project <dir>]`: the owner's command, never served over MCP, as `poly sign policy` is. It prints the rules it signs, so the owner sees what they put their name to, and signs the next sequence after both the file's and the anchor's.
- **Admission.** A project with `rules.sig.json` is admitted only when the record verifies against the certified `people` ring, its sequence is not below the anchor's, and every signed rule is present in the current index with the same `kind` and `text`. A signed rule that is missing or changed is refused with a new code, proposed `PL6413 RULE_NOT_SIGNED`, naming the rule and whether it was removed or changed. Rules present and not signed are listed as a warning (`unsigned: <id>`), never in the verdict. Admission writes the sequence to the anchor.
- **Opting in is one way.** Once the anchor holds a rules sequence for the project, admission refuses the project without a `rules.sig.json` (`PL6413`, the file removed), so an agent cannot leave the check by deleting the file. Only the owner opts out: `poly sign rules --none` signs a record of kind `rules` over an empty rule list at the next sequence, which admission accepts and which leaves every rule unsigned. The anchor lives outside the project (PT12.5, S210), where an agent confined to it cannot reset it.
- **The certificate.** `poly.rules`: `{ sequence, record, digest }`. Load verifies the record again against the people ring and the rules the build was admitted with.
- **Translation validation and poly-ref.** poly-ref reads `poly.rules` back and recomputes the signed subject from the sources, sharing no code with the compiler: a new artefact enters the build only with its round-trip check and broken variants in `test/toolchain-faults.mjs` (proposed `rules-signature-dropped`, `rule-dropped-from-subject`, `rule-text-changed-in-subject`).

## 3. What counts as a change

The simplest rule, and the one proposed: **any change to a signed rule's text is a change**, and needs a new signature. Deciding that a new property is at least as strong as the old one (that it implies it over every reachable state) is a model-checking question in general, not a textual one. A later version could let poly-ref prove that the new rule implies the old one over the checked instance, and accept a rewrite without a signature. That is left out of the first version: it would let a check bound decide what a person signed.

**Check domains.** Narrowing a domain (a field's `check` clause, an action parameter's range) weakens what a rule covers without touching the rule. The owner ruled that domains are not signed (question 2): the check prints its instance with every verdict (PT12.3a), so a narrowed domain shows there, and in a diff of the source.

## 4. What it would change for an agent

- The guide (`poly guide`, S588) already says never to weaken a property. With signed rules, the program refuses it as well: an agent that deletes or edits a signed rule gets `PL6413` at admission, with the rule named, and must ask the owner.
- An agent may still add rules. The owner signs them when they review the change, and until then they are listed as unsigned.
- `poly rules` gains a column: signed (with the sequence) or unsigned.

## 5. Tests and order of work (rule 7a)

1. The owner's answers of section 6, recorded as one S ruling when v2.0 starts.
2. Spec: PT12.5 (the `rules` record, the file, the anchor's sequence), PT14 (`poly sign rules`), PT15 (`poly.rules`), PT12.2 (the new code), and the toolchain faults, committed alone.
3. Tests by a separate writer, failing first. Among them:
   - deleting `never no-reissue` from a signed refund-twice desk is refused `PL6413`, removed;
   - editing its `while` is refused, changed;
   - adding a rule is admitted with an `unsigned:` warning;
   - an agent key's record is refused;
   - a lower sequence than the anchor's is refused;
   - deleting `rules.sig.json` of a project the anchor records as signed is refused, and `poly sign rules --none` by the owner is the only way out;
   - each new toolchain fault is caught;
   - `poly sign rules` is not an MCP tool.
4. Code, then the affected files and the suite on the AMD box at the owner's word.

## 6. The owner's answers (2026-11-08)

1. **Opt-in.** Only a project with a `rules.sig.json` has its rules checked at admission. A project that never signed is admitted as today, and `poly rules` lists its rules as unsigned. Once a project has signed, the anchor remembers it, and the file's removal is refused (section 2), so opting in cannot be undone by an agent.
2. **Domains: not signed.** The signed subject holds the rules alone.
3. **Policy items: not in the rules record.** Their scope's signature covers them, as today.
4. **Examples: not signed.** Only the tests sign rules; the refund-twice README stays as it is.

## Conclusion

Policies are already the owner's; the rules in a machine are not yet. Signing them the same way, with the same keys, anchor and no-rollback rule, closes the gap that `poly rules` can only show: an agent could still drop the rule that made its mistake visible. The first version treats any change to a signed rule as a change, and leaves proving that a rewrite is no weaker to a later version.
