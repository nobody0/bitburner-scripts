#!/usr/bin/env python3
"""Separate V9 proposal recall from post-reply value-ranking fidelity."""

from __future__ import annotations

import argparse
import gzip
import json
import pathlib

import torch

from device import auto_device
from train_v9 import (BRANCHES, ProposalExample, DistillExample, encode_states, load_v9,
                      post_reply_behavior, set_elapsed)


def split_candidates(values: list[DistillExample], count: int) -> list[list[DistillExample]]:
    result: list[list[DistillExample]] = []
    offset = 0
    for _ in range(count):
        group: list[DistillExample] = []
        probability = 0.0
        while offset < len(values) and probability < 1 - 1e-7:
            value = values[offset]
            offset += 1
            group.append(value)
            probability += value.weight
        if abs(probability - 1) > 1e-5:
            raise RuntimeError(f"reply probabilities sum to {probability}")
        result.append(group)
    if offset != len(values):
        raise RuntimeError("trailing reply values")
    return result


def quality(group: list[DistillExample], predicted: list[tuple[float, float, float]],
            elapsed: int) -> tuple[float, float]:
    win = rate = 0.0
    for value, estimate in zip(group, predicted, strict=True):
        win += value.weight * estimate[0]
        rate += value.weight * estimate[1] / max(elapsed + estimate[2], 1e-6)
    return win, rate


@torch.no_grad()
def run(args: argparse.Namespace) -> None:
    device = auto_device(args.device)
    model = load_v9(pathlib.Path(args.model), device).eval()
    records: list[tuple[ProposalExample, list[DistillExample], bool]] = []
    with gzip.open(args.corpus, "rt") as source:
        for line in source:
            record = json.loads(line)
            if record.get("split") != args.split:
                continue
            kind = record.get("kind", "proposal")
            if kind == "proposal":
                records.append((
                    ProposalExample(**record["example"]),
                    [DistillExample(**value) for value in record["distill"]],
                    False,
                ))
            elif kind == "actor-ranking":
                raw = record["example"]
                moves = [int(move) for move in raw["moves"]]
                best = int(raw["bestMove"])
                records.append((
                    ProposalExample(
                        int(raw["episode"]), str(raw["state"]),
                        [float(value) for value in raw["behavior"]],
                        int(raw["elapsed"]), moves,
                        [1.0 if move == best else 0.0 for move in moves],
                        [0.0] * len(moves), [[0.0] * BRANCHES for _ in moves],
                        best, [best], [], [], str(raw["source"])),
                    [DistillExample(**value)
                     for candidate in raw["candidates"] for value in candidate],
                    True,
                ))
            else:
                continue
            if len(records) >= args.positions:
                break
    reply_values = [value for _, values, _ in records for value in values]
    predictions: list[tuple[float, float, float]] = []
    for start in range(0, len(reply_values), args.batch_size):
        batch = reply_values[start:start + args.batch_size]
        inputs = set_elapsed(
            encode_states([value.state for value in batch], model.shape.extent, device,
                          model.shape.input_channels),
            [value.elapsed for value in batch], model.shape.extent)
        behavior = post_reply_behavior(
            [value.behavior for value in batch], model.shape.extent,
            model.shape.behavior, device)
        raw = model.forward_value(inputs, behavior)
        decoded = torch.cat((
            torch.sigmoid(raw[:, :1]),
            torch.expm1(torch.clamp(torch.nn.functional.softplus(raw[:, 1:]), max=40)),
        ), dim=1).cpu().tolist()
        predictions.extend(tuple(row) for row in decoded)

    safe_retained = value_exact = pipeline_exact = 0
    target_win_regret = target_rate_regret = reply_win_error = 0.0
    reply_weight = 0.0
    reply_offset = 0
    actor_records = actor_value_exact = actor_pipeline_exact = actor_safe_retained = 0
    for example, values, actor_ranking in records:
        groups = split_candidates(values, len(example.moves))
        predicted_groups: list[list[tuple[float, float, float]]] = []
        for group in groups:
            predicted_groups.append(predictions[reply_offset:reply_offset + len(group)])
            reply_offset += len(group)
        target_quality = [quality(
            group, [(value.won, value.score, value.remaining) for value in group],
            example.elapsed) for group in groups]
        predicted_quality = [quality(group, estimate, example.elapsed)
                             for group, estimate in zip(groups, predicted_groups, strict=True)]
        target_best = max(range(len(groups)), key=lambda index: (
            target_quality[index][0], target_quality[index][1], -example.moves[index]))
        if example.moves[target_best] != example.best_move:
            raise RuntimeError("stored proposal best disagrees with reply labels")
        predicted_best = max(range(len(groups)), key=lambda index: (
            predicted_quality[index][0], predicted_quality[index][1], -example.moves[index]))
        value_exact += int(predicted_best == target_best)

        original = set_elapsed(
            encode_states([example.state], model.shape.extent, device,
                          model.shape.input_channels),
            [example.elapsed], model.shape.extent)
        behavior = torch.tensor([example.behavior], dtype=torch.float32, device=device)
        logits = model.forward_policy(original, behavior)[0]
        moves = torch.tensor(example.moves, dtype=torch.long, device=device)
        finalists = torch.topk(logits[moves], min(args.top_k, len(example.moves))).indices.tolist()
        safe_retained += int(target_best in finalists)
        pipeline_best = max(finalists, key=lambda index: (
            predicted_quality[index][0], predicted_quality[index][1], -example.moves[index]))
        pipeline_exact += int(pipeline_best == target_best)
        if actor_ranking:
            actor_records += 1
            actor_value_exact += int(predicted_best == target_best)
            actor_pipeline_exact += int(pipeline_best == target_best)
            legal_plane = example.state.split("|")[1]
            legal_moves = [index for index, legal in enumerate(legal_plane) if legal == "1"]
            legal_moves.append(model.shape.extent * model.shape.extent)
            legal = torch.tensor(legal_moves, dtype=torch.long, device=device)
            full_finalists = torch.topk(
                logits[legal], min(args.top_k, len(legal_moves))).indices.tolist()
            selected_move = example.moves[target_best]
            actor_safe_retained += int(
                selected_move in [legal_moves[position] for position in full_finalists])
        target_win_regret += target_quality[target_best][0] - target_quality[pipeline_best][0]
        target_rate_regret += max(0.0, target_quality[target_best][1] - target_quality[pipeline_best][1])
        if not actor_ranking:
            for group, estimate in zip(groups, predicted_groups, strict=True):
                for value, prediction in zip(group, estimate, strict=True):
                    reply_win_error += value.weight * abs(value.won - prediction[0])
                    reply_weight += value.weight

    count = max(len(records), 1)
    print(json.dumps({
        "model": args.model,
        "split": args.split,
        "positions": len(records),
        "replies": len(reply_values),
        "topK": args.top_k,
        "proposalSafeRecall": safe_retained / count,
        "valueExhaustiveTop1Agreement": value_exact / count,
        "pipelineTop1Agreement": pipeline_exact / count,
        "meanTeacherWinRegret": target_win_regret / count,
        "meanTeacherRateRegret": target_rate_regret / count,
        "weightedReplyWinMae": reply_win_error / reply_weight if reply_weight else None,
        "actorRankings": actor_records,
        "actorProposalRecall": actor_safe_retained / max(actor_records, 1),
        "actorValueTop1Agreement": actor_value_exact / max(actor_records, 1),
        "actorSampledPipelineTop1Agreement": actor_pipeline_exact / max(actor_records, 1),
    }, indent=2))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--model", required=True)
    result.add_argument("--corpus", required=True)
    result.add_argument("--positions", type=int, default=100)
    result.add_argument("--split", choices=("train", "heldout"), default="heldout")
    result.add_argument("--top-k", type=int, default=16)
    result.add_argument("--batch-size", type=int, default=4096)
    result.add_argument("--device", default="auto")
    return result


if __name__ == "__main__":
    run(parser().parse_args())
