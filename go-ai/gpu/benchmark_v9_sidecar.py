#!/usr/bin/env python3
"""Measure identical bounded V9 C++ environment work on macOS and WSL."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import platform
import resource
import subprocess
import time

from train_v9 import read_block


GO_AI = pathlib.Path(__file__).resolve().parents[1]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run(args: argparse.Namespace) -> None:
    binary = pathlib.Path(args.environment).resolve()
    command = [
        str(binary), str(max(args.environments, args.blocks)), str(args.seed),
        str(args.environments), args.profile, str(args.cpu_threads), "v9",
        "deterministic-benchmark",
    ]
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter()
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, bufsize=1)
    positions = candidates = replies = completed_blocks = 0
    try:
        while completed_blocks < args.blocks:
            states, _, done = read_block(process)
            if done:
                break
            completed_blocks += 1
            positions += len(states)
            candidates += sum(len(state.candidates) for state in states)
            replies += sum(len(candidate.replies) for state in states
                           for candidate in state.candidates)
            assert process.stdin is not None
            for state in states:
                process.stdin.write(
                    f"A\t{state.slot}\t{state.episode}\t{len(state.candidates) - 1}\n")
            process.stdin.write("GO\n")
            process.stdin.flush()
    finally:
        process.terminate()
        process.wait()
    elapsed = time.perf_counter() - started
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_seconds = (after.ru_utime + after.ru_stime) - (before.ru_utime + before.ru_stime)
    summary = {
        "schema": "bitburner-go-v9-sidecar-benchmark-v1",
        "profile": args.profile,
        "command": command,
        "binarySha256": sha256(binary),
        "platform": platform.platform(),
        "cpuThreads": args.cpu_threads,
        "environments": args.environments,
        "blocks": completed_blocks,
        "positions": positions,
        "candidates": candidates,
        "replies": replies,
        "elapsedSeconds": elapsed,
        "childCpuSeconds": cpu_seconds,
        "aggregateCpuUtilizationPercent": 100 * cpu_seconds / max(elapsed, 1e-9),
        "positionsPerSecond": positions / max(elapsed, 1e-9),
        "candidatesPerSecond": candidates / max(elapsed, 1e-9),
    }
    encoded = json.dumps(summary, indent=2) + "\n"
    if args.out:
        output = pathlib.Path(args.out)
        if output.exists():
            raise RuntimeError(f"refusing to overwrite {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded)
    print(encoded, end="")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19"), required=True)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--blocks", type=int, default=4)
    result.add_argument("--environments", type=int, default=8)
    result.add_argument("--cpu-threads", type=int, default=12)
    result.add_argument("--environment", default=str(GO_AI / "build/release/go_cpp_gpu_env"))
    result.add_argument("--out")
    return result


if __name__ == "__main__":
    run(parser().parse_args())
