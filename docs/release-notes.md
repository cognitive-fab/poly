# Release notes

What a user of poly needs to know when a milestone changes a format, a command or what a guarantee covers. Each entry names the milestone and the requirement ids it rests on. The specifications stay the source of truth.

## M10: Memory

- **Forgetting a whole source** (`poly forget --source <s>`, PS17.7, PT10l) erases poly's copies: every body a decision read from the source, the item sets that came from it, and its memory items. The source's own data is the source owner's to erase: no adapter call takes a source, so poly asks none. Forgetting a subject (`poly forget --subject <principal>`) erases every body whose taint names the subject among its owners, derived ones included, removes the item sets and memory items that name the subject, and asks each connected source adapter to forget that subject.
- **The journal format changed.** A decision event now records the item set its answer cites, `cites: { ref, count }`, for a decision with `cites` (PS17.6, PT10l). Journals written before v1 are pre-release, and no reader is kept for decision events without it.
- **Two new owner's commands**, `poly memory-verify` and `poly forget`, sign a person's record from a key file outside the repository. Neither is served over MCP.
- **Stated limit: a decision with a finite answer** (S323, PS17.2). A decision whose answer is a `bool`, an enum or a range carries no taint, so it can pass up to log2 of the number of its answers in bits per call about what it read to whoever its answer reaches. The certificate lists every such decision that reads tainted data, with the class it reads and the number of its answers, and a policy can deny it by `effect.taint.class`.
- **Stated limit: a count** (S325, PS1.4b). `x.count` of an `Items` carries no taint, so whether another principal has any items, and how many, reaches whoever the count is sent to. The certificate lists each count read of an item set whose owner predicate is not the requester's principal.
- **Records bound to the project** (S321). `poly memory-verify` and `poly forget` sign over the project's anchor id; a record signed for another project is refused `wrong-project`.
- **Stated limit: the runtime may refuse what the checker passes** (S326, S327, PS17.4). A retrieval with no owner predicate is owned by every principal at run time, and a body received on a channel is owned by its sender; both exist only at run time and only narrow an audience. So a send `poly check` finds clean can still be denied `audience` when it runs, never the reverse.
- **Stated limit: freshness is judged when an intent is proposed** (S307, PS17.6). A decision whose first attempt fails and is retried reads its items again without a new freshness check, so a retry may read items that have since gone stale.
- **Stated limit: recorded traffic only** (S308, K14). The source adapters are tested against documented Postgres statements and OpenSearch responses; a live database or index is not gated.
- **Stated limit: the canary scan** finds an item body plain, in base64, base64url or URL-encoded; another encoding is not found.

## Conclusion

Each entry here is a change a user acts on: a command to run, a format a reader must expect, or a limit to know. M10's entries are the scope of a forget, the decision event's `cites`, the records' binding to a project, and the limits M10 closes with.

