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
import threading
import time

from train_v9 import PhaseTimings, read_block


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
    stderr_lines: list[str] = []
    assert process.stderr is not None
    stderr_thread = threading.Thread(
        target=lambda: stderr_lines.extend(process.stderr), daemon=True)
    stderr_thread.start()
    timings = PhaseTimings()
    protocol_digest = hashlib.sha256()
    positions = candidates = replies = completed_blocks = 0
    try:
        while completed_blocks < args.blocks:
            states, _, done = read_block(
                process, timings,
                lambda line: protocol_digest.update(line.encode()))
            if done:
                break
            completed_blocks += 1
            positions += len(states)
            candidates += sum(len(state.candidates) for state in states)
            replies += sum(len(candidate.replies) for state in states
                           for candidate in state.candidates)
            assert process.stdin is not None
            write_started = time.perf_counter()
            for state in states:
                process.stdin.write(
                    f"A\t{state.slot}\t{state.episode}\t{len(state.candidates) - 1}\n")
            process.stdin.write("GO\n")
            process.stdin.flush()
            timings.seconds["actionWriteFlush"] += time.perf_counter() - write_started
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait()
        stderr_thread.join()
    stderr = "".join(stderr_lines)
    native_totals = {
        "blocks": 0,
        "positions": 0,
        "candidateGenerationNanoseconds": 0,
        "opponentAnalysisNanoseconds": 0,
        "protocolSerializationNanoseconds": 0,
        "prepareWallNanoseconds": 0,
        "protocolOutputWallNanoseconds": 0,
        "candidates": 0,
        "replies": 0,
    }
    for line in stderr.splitlines():
        parts = line.split("\t")
        if parts[0] != "PROFILE" or len(parts) != 10:
            continue
        native_totals["blocks"] += 1
        native_totals["positions"] += int(parts[2])
        for key, value in zip((
                "candidateGenerationNanoseconds", "opponentAnalysisNanoseconds",
                "protocolSerializationNanoseconds", "prepareWallNanoseconds",
                "protocolOutputWallNanoseconds", "candidates", "replies",
        ), parts[3:], strict=True):
            native_totals[key] += int(value)
    if native_totals["blocks"] != completed_blocks:
        raise RuntimeError(
            f"sidecar emitted {native_totals['blocks']} profiles for "
            f"{completed_blocks} blocks: {stderr}")
    elapsed = time.perf_counter() - started
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_seconds = (after.ru_utime + after.ru_stime) - (before.ru_utime + before.ru_stime)
    summary = {
        "schema": "bitburner-go-v9-sidecar-benchmark-v2",
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
        "protocolSha256": protocol_digest.hexdigest(),
        "protocolTimings": timings.as_dict(),
        "protocolCounts": timings.counts_dict(),
        "nativeBreakdown": {
            "candidateGenerationCpuSeconds":
                native_totals["candidateGenerationNanoseconds"] / 1e9,
            "opponentAnalysisCpuSeconds":
                native_totals["opponentAnalysisNanoseconds"] / 1e9,
            "protocolSerializationCpuSeconds":
                native_totals["protocolSerializationNanoseconds"] / 1e9,
            "prepareWallSeconds": native_totals["prepareWallNanoseconds"] / 1e9,
            "protocolOutputWallSeconds":
                native_totals["protocolOutputWallNanoseconds"] / 1e9,
        },
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
