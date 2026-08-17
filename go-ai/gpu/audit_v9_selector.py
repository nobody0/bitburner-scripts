#!/usr/bin/env python3
"""Run the maintained Python V9 actor on one explicit native selector state."""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

import torch

from train_v9 import (State, encode_states, load_v9, parse_candidate, set_elapsed,
                      v9_actor_actions, v9_shortlist)


GO_AI = pathlib.Path(__file__).resolve().parents[1]


def parse_state(line: str) -> State:
    parts = line.rstrip("\n").split("\t")
    if parts[0] != "S9":
        raise RuntimeError("native selector fixture did not return an S9 state")
    count = int(parts[8])
    if len(parts[9:]) != count:
        raise RuntimeError("native selector fixture candidate count mismatch")
    return State(
        int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]),
        [float(value) for value in parts[5].split(",")],
        [float(value) for value in parts[6].split(",")],
        parts[7], [parse_candidate(record) for record in parts[9:]],
    )


def run(args: argparse.Namespace) -> None:
    output = subprocess.check_output([
        args.oracle, "state-v9", str(args.size), args.opponent, str(args.seed),
        str(args.elapsed), str(args.passes), args.board, args.history,
    ], text=True)
    state = parse_state(output)
    device = torch.device("cpu")
    model = load_v9(pathlib.Path(args.model), device)
    with torch.no_grad():
        original = set_elapsed(
            encode_states([state.original], model.shape.extent, device,
                          model.shape.input_channels),
            [state.elapsed], model.shape.extent)
        behavior = torch.tensor([state.behavior], dtype=torch.float32, device=device)
        logits = model.forward_policy(original, behavior)[0]
        finalist_indices = v9_shortlist(
            logits, [candidate.move for candidate in state.candidates], args.base_k)
        audit: list[dict[str, object]] = []
        [action] = v9_actor_actions(
            model, [state], device, args.base_k, args.inference_batch, audit=audit)
    print(json.dumps({
        "move": state.candidates[action].move,
        "candidateIndex": action,
        "finalists": [state.candidates[index].move for index in finalist_indices],
        "baseK": args.base_k,
        "behavior": state.behavior,
        "futureBehavior": state.future_behavior,
        "winProbability": audit[0]["winProbability"],
        "powerPerRound": audit[0]["powerPerRound"],
    }, separators=(",", ":")))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--model", required=True)
    result.add_argument("--size", type=int, required=True)
    result.add_argument("--opponent", required=True)
    result.add_argument("--seed", type=float, required=True)
    result.add_argument("--elapsed", type=int, required=True)
    result.add_argument("--passes", type=int, required=True)
    result.add_argument("--board", required=True)
    result.add_argument("--history", default="-")
    result.add_argument("--base-k", type=int, default=8)
    result.add_argument("--inference-batch", type=int, default=4096)
    result.add_argument("--oracle", default=str(GO_AI / "build/release/go_cpp_oracle"))
    return result


if __name__ == "__main__":
    run(parser().parse_args())
