"""Scores edgepii on the pii-guard samples (docs/examples/pii-guard.md, "Scores", PG13).

Run by a person, never by a test, with the adapter's venv:
    <venv python> examples/pii-guard/adapter/score.py --preset rules

Each sample is located with the scan's types and scored against samples/gold.json with edgepii's own
exact_span_f1, document by document; the counts are summed per language and per type. Only counts and
rates are printed, never a span's text.
"""

import json
import os
import sys
from types import SimpleNamespace

import edgepii
from edgepii.eval.score import exact_span_f1

SCAN_TYPES = ["SECRET", "GOV_ID", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS", "PERSON", "ORG"]
SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples")


def rates(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


def main():
    args = sys.argv[1:]
    if len(args) != 2 or args[0] != "--preset":
        sys.stderr.write("usage: score.py --preset <rules|multi-open>\n")
        sys.exit(64)
    preset = args[1]
    locator = edgepii.Locator.preset(preset)
    with open(os.path.join(SAMPLES, "gold.json"), encoding="utf-8") as handle:
        gold = json.load(handle)
    counts = {}
    revision = None
    for name in sorted(gold):
        with open(os.path.join(SAMPLES, name), encoding="utf-8", newline="") as handle:
            text = handle.read()
        result = locator.locate(text, types=SCAN_TYPES)
        revision = result.revision
        # exact_span_f1 reads .type, .start and .end, as of a Span.
        pred = [SimpleNamespace(type=s.type, start=s.start, end=s.end) for s in result.spans]
        report = exact_span_f1([SimpleNamespace(**g) for g in gold[name]["spans"]], pred)
        lang = gold[name]["lang"]
        for kind, row in report.per_type.items():
            key = (lang, kind)
            tp, fp, fn = counts.get(key, (0, 0, 0))
            counts[key] = (tp + row.tp, fp + row.fp, fn + row.fn)
    print(f"edgepii {edgepii.__version__}, preset {preset}, revision {revision}, {len(gold)} samples")
    print("| Language | Type | Gold | Found | Precision | Recall | F1 |")
    print("|---|---|---|---|---|---|---|")
    for lang in sorted({k[0] for k in counts}):
        total = [0, 0, 0]
        for kind in sorted(k[1] for k in counts if k[0] == lang):
            tp, fp, fn = counts[(lang, kind)]
            total = [total[0] + tp, total[1] + fp, total[2] + fn]
            p, r, f = rates(tp, fp, fn)
            print(f"| {lang} | {kind} | {tp + fn} | {tp + fp} | {p:.2f} | {r:.2f} | {f:.2f} |")
        p, r, f = rates(*total)
        print(f"| {lang} | all | {total[0] + total[2]} | {total[0] + total[1]} | {p:.2f} | {r:.2f} | {f:.2f} |")


if __name__ == "__main__":
    main()
