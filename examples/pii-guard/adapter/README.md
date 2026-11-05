# edgepii adapter

A small Python process that runs edgepii, a local detector of personal data, for the pii-guard example (`examples/pii-guard`, spec `docs/examples/pii-guard.md`, S587). It is host code: the example's host starts it, asks it for spans, and reads its answers into facts. Only types, counts and offsets come out of it, except the masked text of a redaction.

## The protocol

`python adapter.py --preset rules` reads one JSON request per line on stdin and writes one JSON answer per line on stdout, UTF-8 with `\n` line ends. Stderr is its log and carries no value.

- `{"v":1,"id":1,"op":"hello"}` answers edgepii's version, the digest of its installed source, the taxonomy, the preset, its revision and its detectors.
- `{"v":1,"id":2,"op":"locate","text":"...","types":[...]}` answers `dropped` and the spans, each with exactly `type`, `start`, `end`, `detector` and `detectorId`.
- `{"v":1,"id":3,"op":"redact","text":"...","types":[...]}` masks the spans, throws the vault away, locates again on the masked text, and answers `masked`, `redacted` (counts by type) and `recheck` (the second pass's `dropped` and its counts by type).
- A line that is not JSON, a request without its fields or a type the taxonomy does not hold answers `malformed-request`; an unknown op `unknown-op`; an exception from edgepii `edgepii-error` with the exception's class name, never its message.

The adapter refuses to start (status 2) when `EDGEPII_LOG_TEXT` is set, since edgepii would then log values, and it sets edgepii's logger to `WARNING`.

## Setup

```sh
node examples/pii-guard/adapter/setup.mjs
```

It finds Python 3.11 or later (`py -3.12`, `py -3.11`, then `python3`), creates the venv `%LOCALAPPDATA%\poly\venvs\edgepii-0.3.1\` on Windows (`$HOME/.local/share/poly/venvs/edgepii-0.3.1/` elsewhere), and installs `requirements.txt` with `--require-hashes --no-deps`. `POLY_EDGEPII_PYTHON` points the example at another python. `--model` is for the `multi-open` lane, which is not packaged yet and says so.

`PIN.json` fixes what the client accepts: edgepii's version, the wheel's hash, the installed source's digest, the taxonomy, `adapter.py`'s own digest, and each preset's revision and detectors. A change to `adapter.py` changes its digest, so the pin is rewritten in the same change.

`score.py --preset rules`, run with the venv's python, scores the example's samples with edgepii's `exact_span_f1`.

## Conclusion

The adapter is the one place where personal data meets code outside poly, and it is kept small, pinned and quiet: it answers in types and offsets, checks its own redaction, and logs no value.

## Glossary

- **Preset:** a pinned set of edgepii detectors; `rules` is rules and checksums only.
- **Span:** a type and a half-open range of code points on the text.
- **Dropped span:** a span whose offsets failed edgepii's slice check; counted, never repaired.
- **Vault:** the map from placeholders to original values that `edgepii.redact` returns; the adapter discards it.
- **Source digest:** the SHA-256 over the installed package's files and their hashes, which `hello` reports.
