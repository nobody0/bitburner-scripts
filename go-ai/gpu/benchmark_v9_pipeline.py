#!/usr/bin/env python3
"""Bounded, non-persisting profile of the V9 Python/accelerator pipeline."""

from __future__ import annotations

import argparse
import json
import pathlib
import platform
import random
import subprocess
import tempfile
import time

import torch

from device import auto_device
from train_v9 import (
    PhaseTimings,
    RankingExample,
    V9Net,
    V9Shape,
    checkpoint_metrics,
    configure_accelerator,
    configure_training_scope,
    file_sha256,
    load_corpora,
    load_teacher,
    load_v9,
    prepare_replay,
    ranking_metrics,
    read_block,
    replay_metadata,
    save_model,
    shortlist_metrics,
    synchronize,
    teacher_examples,
    train_updates,
    verify_cpp,
)


GO_AI = pathlib.Path(__file__).resolve().parents[1]


def measure(device: torch.device, action):
    synchronize(device)
    started = time.perf_counter()
    result = action()
    synchronize(device)
    return result, time.perf_counter() - started


def legacy_checkpoint_metrics(
    model: V9Net,
    heldout,
    heldout_rankings: list[RankingExample],
    device: torch.device,
    top_k: int,
):
    sources = ("katago", "handcrafted", "self")
    return (
        shortlist_metrics(model, heldout, device, top_k),
        {source: shortlist_metrics(model, heldout, device, top_k, source)
         for source in sources if any(value.source == source for value in heldout)},
        ranking_metrics(model, heldout_rankings, device),
        {source: ranking_metrics(model, heldout_rankings, device, source)
         for source in sources
         if any(value.proposal.source == source for value in heldout_rankings)},
    )


def profile_teacher(
    teacher: V9Net,
    args: argparse.Namespace,
    device: torch.device,
) -> tuple[dict[str, float], dict[str, int], int, int]:
    command = [
        str(pathlib.Path(args.environment).resolve()),
        str(max(args.environments, args.sidecar_blocks)), str(args.seed),
        str(args.environments), args.profile, str(args.cpu_threads), "v9",
        "deterministic-benchmark",
    ]
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, bufsize=1)
    timings = PhaseTimings()
    blocks = reply_boards = 0
    try:
        while blocks < args.sidecar_blocks:
            states, _, done = read_block(process, timings)
            if done:
                break
            actions, _, _, groups = teacher_examples(
                teacher, states, teacher.shape.extent, device,
                args.teacher_batch, 4, timings)
            reply_boards += sum(len(group) for group in groups)
            assert process.stdin is not None
            for state, action in zip(states, actions, strict=True):
                process.stdin.write(
                    f"A\t{state.slot}\t{state.episode}\t{action}\n")
            process.stdin.write("GO\n")
            process.stdin.flush()
            blocks += 1
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait()
    return timings.as_dict(), timings.counts_dict(), blocks, reply_boards


def run(args: argparse.Namespace) -> None:
    device = auto_device(args.device)
    configure_accelerator(device)
    shape = V9Shape(5, 32, 4, behavior=31) if args.profile == "small5" \
        else V9Shape(19, 48, 8, behavior=30)
    teacher_path = pathlib.Path(args.teacher)
    teacher_sha256 = file_sha256(teacher_path)
    model = load_v9(teacher_path, device)
    teacher = load_teacher(teacher_path, device)
    if model.shape != shape or not isinstance(teacher, V9Net) or teacher.shape != shape:
        raise RuntimeError("teacher topology does not match profile")
    teacher.eval()

    load_timings = PhaseTimings()
    proposals, heldout, values, distill, rankings, heldout_rankings = load_corpora(
        args.corpus_in, args.profile, teacher_sha256,
        args.proposal_replay, args.value_replay, args.distill_replay,
        args.ranking_replay, args.seed, load_timings)
    metadata = replay_metadata(
        args.corpus_in, args.profile, teacher_sha256, shape,
        args.proposal_replay, args.value_replay, args.distill_replay,
        args.ranking_replay, args.seed)

    with tempfile.TemporaryDirectory(prefix="go-v9-profile-cache-") as cache_dir:
        started = time.perf_counter()
        prepared, cold_cache = prepare_replay(
            proposals, heldout, values, distill, rankings, shape, metadata, cache_dir)
        cold_seconds = time.perf_counter() - started
        started = time.perf_counter()
        prepared, warm_cache = prepare_replay(
            proposals, heldout, values, distill, rankings, shape, metadata, cache_dir)
        warm_seconds = time.perf_counter() - started
        cache_bytes = pathlib.Path(warm_cache["path"]).stat().st_size

    legacy, legacy_seconds = measure(
        device, lambda: legacy_checkpoint_metrics(
            model, heldout, heldout_rankings, device, args.top_k))
    reused, reused_seconds = measure(
        device, lambda: checkpoint_metrics(
            model, heldout, heldout_rankings, device, args.top_k))
    if legacy != reused:
        raise RuntimeError("single-pass checkpoint metrics changed a reported value")

    with tempfile.TemporaryDirectory(prefix="go-v9-profile-checkpoint-") as directory:
        checkpoint = pathlib.Path(directory) / "profile.model"
        _, serialization_seconds = measure(
            device, lambda: save_model(model, checkpoint))
        checkpoint_bytes = checkpoint.stat().st_size
        parity, parity_seconds = measure(
            device, lambda: verify_cpp(model, checkpoint, args.oracle, device))

    training_timings = PhaseTimings()
    optimizer = configure_training_scope(model, 0.0, 0.0)
    losses, training_seconds = measure(device, lambda: train_updates(
        model, optimizer, proposals, values, distill, rankings,
        args.updates, args.batch_size, device, random.Random(args.seed),
        1.0, "uniform", 1.0, 0.25, 0.5, args.top_k,
        1.0, (1.0, 1.0, 1.0), (1.0, 1.0, 1.0), 0.1,
        args.ranking_batch_size, prepared, 0.25, 0.25, 0.05,
        0.25, 0.05, 1.0, training_timings))

    teacher_timings, teacher_counts, sidecar_blocks, reply_boards = profile_teacher(
        teacher, args, device)
    summary = {
        "schema": "bitburner-go-v9-pipeline-benchmark-v1",
        "profile": args.profile,
        "platform": platform.platform(),
        "device": str(device),
        "torchVersion": torch.__version__,
        "teacherSha256": teacher_sha256,
        "corpusSha256": [file_sha256(pathlib.Path(path)) for path in args.corpus_in],
        "replay": {
            "proposals": len(proposals), "heldout": len(heldout),
            "monteCarloValues": len(values), "distillValues": len(distill),
            "rankings": len(rankings), "heldoutRankings": len(heldout_rankings),
            "readTimings": load_timings.as_dict(),
            "coldPreparationSeconds": cold_seconds,
            "warmLoadSeconds": warm_seconds,
            "cacheBytes": cache_bytes,
            "coldCache": cold_cache, "warmCache": warm_cache,
        },
        "teacher": {
            "blocks": sidecar_blocks, "replyBoards": reply_boards,
            "timings": teacher_timings, "counts": teacher_counts,
        },
        "training": {
            "updates": args.updates, "batchSize": args.batch_size,
            "elapsedSeconds": training_seconds,
            "updatesPerSecond": args.updates / max(training_seconds, 1e-9),
            "losses": losses,
            "timings": training_timings.as_dict(),
            "counts": training_timings.counts_dict(),
        },
        "checkpoint": {
            "legacyEvaluationSeconds": legacy_seconds,
            "singlePassEvaluationSeconds": reused_seconds,
            "speedup": legacy_seconds / max(reused_seconds, 1e-9),
            "metricsBitExact": legacy == reused,
            "serializationSeconds": serialization_seconds,
            "bytes": checkpoint_bytes,
            "cppParitySeconds": parity_seconds,
            "cppParityRelativeError": parity,
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
    result.add_argument("--teacher", required=True)
    result.add_argument("--corpus-in", action="append", required=True)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    result.add_argument("--environment", default=str(GO_AI / "build/release/go_cpp_gpu_env"))
    result.add_argument("--oracle", default=str(GO_AI / "build/release/go_cpp_oracle"))
    result.add_argument("--cpu-threads", type=int, default=12)
    result.add_argument("--environments", type=int, default=4)
    result.add_argument("--sidecar-blocks", type=int, default=2)
    result.add_argument("--teacher-batch", type=int, default=4096)
    result.add_argument("--batch-size", type=int, default=512)
    result.add_argument("--ranking-batch-size", type=int, default=2)
    result.add_argument("--updates", type=int, default=3)
    result.add_argument("--top-k", type=int, default=0)
    result.add_argument("--proposal-replay", type=int, default=8192)
    result.add_argument("--value-replay", type=int, default=16384)
    result.add_argument("--distill-replay", type=int, default=16384)
    result.add_argument("--ranking-replay", type=int, default=256)
    result.add_argument("--out")
    return result


if __name__ == "__main__":
    parsed = parser().parse_args()
    if parsed.top_k <= 0:
        parsed.top_k = 8 if parsed.profile == "small5" else 16
    run(parsed)
