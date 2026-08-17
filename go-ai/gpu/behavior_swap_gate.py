"""Behaviour-swap gate: is the enemy-behaviour input used causally?

A certified action is valid only jointly with the exact seeded opponent
behaviour. A model that memorised those actions as board patterns answers
identically no matter which opponent is about to move; a model that learned the
conditioning changes its action when *only* the behaviour vector changes.

The corpus contains rows sharing an identical encoded state (board plus legal
mask plus pass/elapsed fields) and elapsed turn while carrying different
behaviour vectors and different certified actions. For each such pair:

  switchRate  - top-1 differs across the two behaviour vectors;
  bothCorrect - BOTH certified actions are produced, the only outcome that
                demonstrates conditioning rather than a lucky flip.

Read-only. Spends no arena games, which is the point: it decides whether a
candidate deserves a 12,288-game gate at all.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import pathlib

import torch

from train_v9 import decode_state_planes, encode_states, load_v9


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--models", required=True, help="comma-separated checkpoints")
    parser.add_argument("--split", default="heldout")
    parser.add_argument("--limit", type=int, default=4000)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--summary-out")
    args = parser.parse_args()

    grouped: dict[tuple[str, int], list[dict]] = collections.defaultdict(list)
    with gzip.open(args.corpus, "rt") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("kind") != "actor" or record.get("split") != args.split:
                continue
            example = record["example"]
            grouped[(example["state"], int(example["elapsed"]))].append(example)

    pairs: list[tuple[dict, dict]] = []
    for rows in grouped.values():
        for index in range(len(rows)):
            for other in range(index + 1, len(rows)):
                left, right = rows[index], rows[other]
                if left["action"] != right["action"] and left["behavior"] != right["behavior"]:
                    pairs.append((left, right))
                    if len(pairs) >= args.limit:
                        break
            if len(pairs) >= args.limit:
                break
        if len(pairs) >= args.limit:
            break
    if not pairs:
        raise SystemExit("corpus contains no behaviour-contrast pairs")

    device = torch.device(args.device)
    flat = [row for pair in pairs for row in pair]
    results = []
    for path in args.models.split(","):
        if not path:
            continue
        model = load_v9(pathlib.Path(path), device)
        model.eval()
        extent = model.shape.extent
        channels = model.stem.shape[1]
        chosen: list[int] = []
        with torch.no_grad():
            for start in range(0, len(flat), args.batch_size):
                chunk = flat[start:start + args.batch_size]
                states = decode_state_planes(
                    encode_states([row["state"] for row in chunk], extent, device, channels),
                    device)
                behavior = torch.tensor([row["behavior"] for row in chunk],
                                        dtype=torch.float32, device=device)
                logits, _ = model.forward_proposal(states, behavior)
                mask = torch.full_like(logits, float("-inf"))
                for offset, row in enumerate(chunk):
                    for move in row["moves"]:
                        mask[offset, move] = 0.0
                chosen.extend((logits + mask).argmax(dim=1).tolist())
        switched = both = either = 0
        for index, (left, right) in enumerate(pairs):
            a, b = chosen[2 * index], chosen[2 * index + 1]
            switched += int(a != b)
            left_ok, right_ok = a == int(left["action"]), b == int(right["action"])
            both += int(left_ok and right_ok)
            either += int(left_ok or right_ok)
        digest = hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
        results.append({
            "model": path, "sha256": digest, "pairs": len(pairs),
            "switchRate": switched / len(pairs),
            "bothCorrect": both / len(pairs),
            "eitherCorrect": either / len(pairs),
        })
        print(json.dumps(results[-1]))

    summary = {"corpus": args.corpus, "split": args.split,
               "pairs": len(pairs), "results": results}
    if args.summary_out:
        pathlib.Path(args.summary_out).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
