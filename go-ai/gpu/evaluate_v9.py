#!/usr/bin/env python3
"""Evaluate a frozen V9 actor with MPS/CUDA inference and exact native Go."""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import time

from device import auto_device
from train_v9 import (DEPLOYMENT_BASE_K, configure_accelerator, load_v9,
                      read_block, v9_actor_actions)


GO_AI = pathlib.Path(__file__).resolve().parents[1]


def run(args: argparse.Namespace) -> None:
    device = auto_device(args.device)
    configure_accelerator(device)
    model = load_v9(pathlib.Path(args.model), device)
    expected_extent = 5 if args.profile == "small5" else 19
    if model.shape.extent != expected_extent:
        raise RuntimeError("model extent does not match evaluation profile")
    top_k = args.top_k or DEPLOYMENT_BASE_K
    environment = subprocess.Popen([
        args.environment, str(args.games), str(args.seed), str(args.environments),
        args.profile, str(args.cpu_threads), "v9",
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
       text=True, bufsize=1)
    completed = wins = rounds = 0
    score = 0.0
    started = time.monotonic()
    try:
        done = False
        while not done:
            states, events, done = read_block(environment)
            for parts in events:
                if parts[0] != "R":
                    continue
                completed += 1
                wins += int(float(parts[3]))
                score += float(parts[4])
                rounds += int(parts[5])
            if done:
                break
            actions = v9_actor_actions(
                model, states, device, top_k, args.inference_batch,
                args.win_tolerance, args.proposal_only)
            assert environment.stdin is not None
            for state, action in zip(states, actions, strict=True):
                environment.stdin.write(
                    f"A\t{state.slot}\t{state.episode}\t{action}\n")
            environment.stdin.write("GO\n")
            environment.stdin.flush()
        if environment.wait() != 0:
            raise RuntimeError(
                environment.stderr.read() if environment.stderr else
                "V9 evaluation environment failed")
    finally:
        if environment.poll() is None:
            environment.terminate()
            environment.wait()
    elapsed = time.monotonic() - started
    print(json.dumps({
        "profile": args.profile,
        "model": args.model,
        "games": completed,
        "wins": wins,
        "winRate": wins / max(completed, 1),
        "averageRounds": rounds / max(completed, 1),
        "normalizedScorePerRound": score / max(rounds, 1),
        "baseK": top_k,
        "winTolerance": args.win_tolerance,
        "proposalOnly": args.proposal_only,
        "elapsedSeconds": elapsed,
        "gamesPerSecond": completed / max(elapsed, 1e-9),
    }))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19"), required=True)
    result.add_argument("--model", required=True)
    result.add_argument("--games", type=int, required=True)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    result.add_argument("--environment", default=str(
        GO_AI / "build/release/go_cpp_gpu_env"))
    result.add_argument("--environments", type=int, default=32)
    result.add_argument("--cpu-threads", type=int, default=12)
    result.add_argument("--top-k", type=int, default=0,
                        help="actor base K before adaptive boundary expansion (default: 8)")
    result.add_argument("--inference-batch", type=int, default=4096)
    result.add_argument("--win-tolerance", type=float, default=0,
                        help="score-rank finalists within this distance of best win probability")
    result.add_argument("--proposal-only", action="store_true",
                        help="diagnostic: play highest proposal without exact reranking")
    return result


if __name__ == "__main__":
    run(parser().parse_args())
