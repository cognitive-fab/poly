# Security

Report a vulnerability privately through GitHub: the repository's Security tab, "Report a vulnerability". Please do not open a public issue for it.

What is in scope: the checker and runtime guarantees in `docs/04-semantics.md` and the standing rules in `CLAUDE.md` (a check that reports clean when it should not, an effect that passes the gate undeclared, a ledger that does not replay). The demo's stand-in and fixtures contain no real credentials; the strings in `test/` that look like keys are canaries.

## Conclusion

A report that comes with a program, the command that checked or ran it and the verdict you expected is the fastest to act on.
