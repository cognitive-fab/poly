"""The edgepii adapter of the pii-guard example (S587, docs/examples/pii-guard.md, "The adapter").

One JSON request per line on stdin, one JSON answer per line on stdout. Only types, counts and
offsets cross: no answer carries a span's text, raw label, score, a vault or a quasi row (PG2).
A redaction's masked text is the one exception, and it crosses only into the decision's Content.
"""

import hashlib
import json
import logging
import os
import sys

# PG2: refuse to start when edgepii would log values, before edgepii is imported.
if "EDGEPII_LOG_TEXT" in os.environ:
    sys.stderr.write("EDGEPII_LOG_TEXT is set; the adapter does not log values\n")
    sys.stderr.flush()
    sys.exit(2)

import edgepii  # noqa: E402
from edgepii.presets import PRESETS  # noqa: E402

logging.getLogger("edgepii").setLevel(logging.WARNING)


class Malformed(Exception):
    pass


def source_digest():
    """The digest of edgepii's installed source, since the venv keeps no wheel (PIN.json `source`)."""

    package = os.path.dirname(os.path.abspath(edgepii.__file__))
    root = os.path.dirname(package)
    lines = []
    for folder, dirs, files in os.walk(package):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as handle:
                lines.append((rel, hashlib.sha256(handle.read()).hexdigest()))
    lines.sort(key=lambda row: row[0])
    joined = "".join(f"{rel}\0{digest}\n" for rel, digest in lines)
    return "sha256:" + hashlib.sha256(joined.encode("utf-8")).hexdigest()


def types_of(request, locator):
    types = request.get("types")
    if not isinstance(types, list) or not types or not all(isinstance(t, str) for t in types):
        raise Malformed()
    for name in types:
        if name not in locator.taxonomy.types:
            raise Malformed()
    return types


def text_of(request):
    text = request.get("text")
    if not isinstance(text, str):
        raise Malformed()
    return text


def counts(spans):
    out = {}
    for span in spans:
        out[span.type] = out.get(span.type, 0) + 1
    return out


def span_out(span):
    return {
        "type": span.type,
        "start": span.start,
        "end": span.end,
        "detector": "rule" if span.detector_id.startswith("rules.") else "model",
        "detectorId": span.detector_id,
    }


def hello(locator, preset):
    probe = locator.locate("", types=["EMAIL"])
    return {
        "ok": True,
        "edgepii": edgepii.__version__,
        "source": source_digest(),
        "taxonomy": probe.taxonomy_version,
        "preset": probe.preset,
        "revision": probe.revision,
        "detectors": list(PRESETS[preset].detectors),
    }


def locate(locator, request):
    result = locator.locate(text_of(request), types=types_of(request, locator))
    spans = sorted(result.spans, key=lambda s: (s.start, s.end, s.type))
    return {"ok": True, "dropped": result.dropped, "spans": [span_out(s) for s in spans]}


def redact(locator, request):
    text = text_of(request)
    types = types_of(request, locator)
    first = locator.locate(text, types=types)
    if first.dropped > 0:
        return {"ok": False, "error": "dropped"}
    masked, vault = edgepii.redact(text, first.spans)
    vault.clear()
    del vault
    # PG9: a placeholder or a value the mask missed is found again on the masked text.
    second = locator.locate(masked, types=types)
    return {
        "ok": True,
        "masked": masked,
        "redacted": counts(first.spans),
        "recheck": {"dropped": second.dropped, "found": counts(second.spans)},
    }


def answer(locator, preset, line):
    try:
        request = json.loads(line)
    except ValueError:
        return {"v": 1, "id": None, "ok": False, "error": "malformed-request"}
    if not isinstance(request, dict) or request.get("v") != 1 or type(request.get("id")) is not int:
        rid = request.get("id") if isinstance(request, dict) and type(request.get("id")) is int else None
        return {"v": 1, "id": rid, "ok": False, "error": "malformed-request"}
    rid = request["id"]
    op = request.get("op")
    handlers = {"hello": lambda: hello(locator, preset), "locate": lambda: locate(locator, request), "redact": lambda: redact(locator, request)}
    if not isinstance(op, str):
        return {"v": 1, "id": rid, "ok": False, "error": "malformed-request"}
    if op not in handlers:
        return {"v": 1, "id": rid, "ok": False, "error": "unknown-op"}
    try:
        body = handlers[op]()
    except Malformed:
        return {"v": 1, "id": rid, "ok": False, "error": "malformed-request"}
    except Exception as error:  # the class name only, never the message, which may hold a value
        return {"v": 1, "id": rid, "ok": False, "error": "edgepii-error", "kind": type(error).__name__}
    return {"v": 1, "id": rid, **body}


def main():
    args = sys.argv[1:]
    if len(args) != 2 or args[0] != "--preset" or args[1] not in PRESETS:
        sys.stderr.write("usage: adapter.py --preset <rules|multi-open>\n")
        sys.exit(64)
    preset = args[1]
    sys.stdin.reconfigure(encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    locator = edgepii.Locator.preset(preset)
    for line in sys.stdin:
        if not line.strip():
            continue
        sys.stdout.write(json.dumps(answer(locator, preset, line), ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
