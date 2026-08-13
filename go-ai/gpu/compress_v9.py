#!/usr/bin/env python3
"""Distill a promoted 5x5 V9 champion into smaller, dense V9 students.

This is an export-preparation experiment, not candidate generation and not
promotion.  It removes complete channels/blocks/value neurons so the ordinary
dense WebGPU kernels perform less work.  Every resulting checkpoint remains a
V9 checkpoint and must still pass the independent WebGPU arena before use.
"""

from __future__ import annotations

import argparse
import dataclasses
import gzip
import hashlib
import json
import pathlib
import random
import shutil
import sys
import time

import torch
from torch import Tensor
import torch.nn.functional as F
from torch.nn.utils import parametrize

from device import auto_device
from train_v9 import (
    BRANCHES,
    CORPUS_SCHEMA,
    OPPONENT_ORACLE,
    DistillExample,
    ProposalExample,
    V9Net,
    V9Shape,
    configure_accelerator,
    encode_states,
    file_sha256,
    load_v9,
    save_model,
    set_elapsed,
    shortlist_metrics,
    verify_cpp,
)


GO_AI = pathlib.Path(__file__).resolve().parents[1]


def on_off(value: str) -> bool:
    if value not in ("on", "off"):
        raise argparse.ArgumentTypeError("expected on or off")
    return value == "on"


@dataclasses.dataclass(frozen=True)
class CompressionShape:
    channels: int
    blocks: int
    hidden: int
    tower: int

    @property
    def label(self) -> str:
        return f"c{self.channels}-b{self.blocks}-h{self.hidden}-t{self.tower}"


def parse_shape(value: str) -> CompressionShape:
    try:
        channels, blocks, hidden, tower = (int(part) for part in value.split("x"))
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            "shape must be CHANNELSxBLOCKSxHIDDENxTOWER") from error
    if min(channels, blocks, hidden, tower) <= 0 or channels % 4:
        raise argparse.ArgumentTypeError("shape dimensions must be positive and channels a multiple of four")
    return CompressionShape(channels, blocks, hidden, tower)


def parameter_counts(shape: V9Shape, value_rank: int = 0) -> tuple[int, int, int]:
    pooled = shape.channels * 25
    value_w1 = shape.hidden * pooled if value_rank == 0 \
        else shape.hidden * value_rank + value_rank * pooled
    deployed = (
        shape.channels * 8 * 9 + shape.channels
        + shape.blocks * 2 * shape.channels * shape.channels * 9
        + shape.blocks * 2 * shape.channels
        + shape.blocks * shape.channels * shape.behavior + shape.blocks * shape.channels
        + value_w1 + shape.hidden
        + shape.tower * shape.hidden + shape.tower
        + 3 * shape.tower + 3
        + shape.channels + 1 + pooled + 1
    )
    auxiliary = BRANCHES * shape.channels + BRANCHES \
        + BRANCHES * pooled + BRANCHES
    # Every deployed matrix uses one int8 per weight plus one f32 scale per
    # output row; every bias uses f16.  This exactly mirrors the TS exporter.
    matrices = [
        (shape.channels, 8 * 9, shape.channels),
        (shape.blocks * 2 * shape.channels, shape.channels * 9,
         shape.blocks * 2 * shape.channels),
        (shape.blocks * shape.channels, shape.behavior, shape.blocks * shape.channels),
        (shape.tower, shape.hidden, shape.tower),
        (3, shape.tower, 3),
        (1, shape.channels, 1),
        (1, pooled, 1),
    ]
    if value_rank == 0:
        matrices.insert(3, (shape.hidden, pooled, shape.hidden))
    else:
        matrices[3:3] = [
            (shape.hidden, value_rank, 0),
            (value_rank, pooled, shape.hidden),
        ]
    artifact_bytes = sum(rows * columns + rows * 4 + biases * 2
                         for rows, columns, biases in matrices)
    return deployed + auxiliary, deployed, artifact_bytes


def load_knowledge(paths: list[str], maximum: int, seed: int) -> tuple[
        list[ProposalExample], list[ProposalExample],
        list[DistillExample], list[DistillExample]]:
    training: list[ProposalExample] = []
    heldout: list[ProposalExample] = []
    training_values: list[DistillExample] = []
    heldout_values: list[DistillExample] = []
    for raw_path in paths:
        with gzip.open(raw_path, "rt") as source:
            for line_number, line in enumerate(source, 1):
                record = json.loads(line)
                if record.get("schema") != CORPUS_SCHEMA:
                    raise RuntimeError(f"{raw_path}:{line_number}: incompatible corpus schema")
                if record.get("profile") != "small5":
                    raise RuntimeError(f"{raw_path}:{line_number}: compression proof accepts small5 only")
                if record.get("opponentOracle") != OPPONENT_ORACLE:
                    raise RuntimeError(f"{raw_path}:{line_number}: opponent oracle mismatch")
                example = ProposalExample(**record["example"])
                values = [DistillExample(**value) for value in record.get("distill", ())]
                if record.get("split") == "heldout":
                    heldout.append(example)
                    heldout_values.extend(values)
                else:
                    training.append(example)
                    training_values.extend(values)
    if not training or not heldout or not training_values or not heldout_values:
        raise RuntimeError("compression needs both training and held-out corpus positions")
    randomizer = random.Random(seed ^ 0x510E527F)
    randomizer.shuffle(training)
    randomizer.shuffle(heldout)
    randomizer.shuffle(training_values)
    randomizer.shuffle(heldout_values)
    if maximum > 0:
        training = training[:maximum]
        heldout = heldout[:max(1, maximum // 5)]
        training_values = training_values[:maximum * 16]
        heldout_values = heldout_values[:max(1, maximum * 16 // 5)]
    return training, heldout, training_values, heldout_values


def top_indices(score: Tensor, count: int) -> Tensor:
    return torch.topk(score, count, largest=True, sorted=False).indices.sort().values


class FakeQ8Rows(torch.nn.Module):
    """Exporter-exact symmetric row q8 with a straight-through gradient."""

    def __init__(self, rows: int):
        super().__init__()
        self.rows = rows

    def forward(self, value: Tensor) -> Tensor:
        matrix = value.reshape(self.rows, -1)
        scale = matrix.detach().abs().amax(dim=1, keepdim=True).clamp_min(1e-30) / 127
        quantized = torch.round(matrix / scale).clamp(-127, 127) * scale
        return (matrix + (quantized - matrix).detach()).reshape_as(value)


class FakeF16(torch.nn.Module):
    """Exporter-exact f16 bias storage with a straight-through gradient."""

    def forward(self, value: Tensor) -> Tensor:
        quantized = value.to(torch.float16).to(value.dtype)
        return value + (quantized - value).detach()


class LowRankValueW1(torch.nn.Module):
    """Trainable U@V replacement for the first value matrix."""

    def __init__(self, matrix: Tensor, rank: int, quantization_aware: bool):
        super().__init__()
        if rank <= 0 or rank >= min(matrix.shape):
            raise ValueError("value rank must be positive and smaller than both matrix dimensions")
        u, singular, vh = torch.linalg.svd(matrix.detach(), full_matrices=False)
        root = singular[:rank].sqrt()
        self.left = torch.nn.Parameter(u[:, :rank] * root[None, :])
        self.right = torch.nn.Parameter(root[:, None] * vh[:rank])
        self.left_q8 = FakeQ8Rows(matrix.shape[0]) if quantization_aware else torch.nn.Identity()
        self.right_q8 = FakeQ8Rows(rank) if quantization_aware else torch.nn.Identity()

    def effective(self) -> tuple[Tensor, Tensor]:
        return self.left_q8(self.left), self.right_q8(self.right)

    def forward(self, _original: Tensor) -> Tensor:
        left, right = self.effective()
        return left @ right


def enable_low_rank_value(model: V9Net, rank: int,
                          quantization_aware: bool) -> LowRankValueW1:
    factor = LowRankValueW1(model.value_w1, rank, quantization_aware)
    parametrize.register_parametrization(model, "value_w1", factor, unsafe=True)
    model.parametrizations.value_w1.original.requires_grad_(False)
    return factor


def enable_export_quantization(model: V9Net, factorized_value: bool = False) -> None:
    shape = model.shape
    rows = {
        "stem": shape.channels,
        "residual": shape.blocks * 2 * shape.channels,
        "conditioning_w": shape.blocks * shape.channels,
        "value_w2": shape.tower,
        "value_out_w": 3,
        "policy_w": 1,
        "pass_w": 1,
        "branch_w": BRANCHES,
        "pass_branch_w": BRANCHES,
    }
    if not factorized_value:
        rows["value_w1"] = shape.hidden
    for name, count in rows.items():
        parametrize.register_parametrization(model, name, FakeQ8Rows(count), unsafe=True)
    for name in (
        "stem_bias", "residual_bias", "conditioning_b", "value_b1", "value_b2",
        "value_out_b", "policy_b", "pass_b", "branch_b", "pass_branch_b",
    ):
        parametrize.register_parametrization(model, name, FakeF16(), unsafe=True)


def save_value_factor(factor: LowRankValueW1, path: pathlib.Path) -> None:
    left, right = (value.detach().cpu().to(torch.float64) for value in factor.effective())
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as output:
        output.write("bitburner-go-value-factor-v1\n")
        output.write(f"{left.shape[0]} {right.shape[1]} {left.shape[1]}\n")
        for value in (left, right):
            flat = value.flatten().tolist()
            output.write(str(len(flat)))
            for item in flat:
                output.write(f" {item:.17g}")
            output.write("\n")
    temporary.replace(path)


@torch.no_grad()
def structured_initialize(student: V9Net, teacher: V9Net) -> None:
    """Slice high-influence dense units while preserving residual identities."""
    source, target = teacher.shape, student.shape
    if (target.extent != source.extent or target.behavior != source.behavior
            or target.channels > source.channels or target.blocks > source.blocks
            or target.hidden > source.hidden or target.tower > source.tower):
        raise RuntimeError("structured initialization only supports a smaller compatible V9 shape")

    residual = teacher.residual.abs()
    channel_score = teacher.stem.abs().mean((1, 2, 3)) \
        + teacher.policy_w.abs().flatten() \
        + teacher.branch_w.abs().mean(0)
    channel_score += residual.mean((0, 1, 3, 4, 5)) + residual.mean((0, 1, 2, 4, 5))
    channel_score += teacher.conditioning_w.abs().mean((0, 2))
    channel_score += teacher.pass_w.reshape(source.channels, 25).abs().mean(1)
    channel_score += teacher.value_w1.reshape(source.hidden, source.channels, 25).abs().mean((0, 2))
    channels = top_indices(channel_score, target.channels)

    block_score = teacher.residual.abs().mean((1, 2, 3, 4, 5)) \
        + teacher.conditioning_w.abs().mean((1, 2))
    blocks = top_indices(block_score, target.blocks)
    hidden_score = teacher.value_w1.abs().mean(1) \
        + teacher.value_w2.abs().mean(0)
    hidden = top_indices(hidden_score, target.hidden)
    tower_score = teacher.value_w2.abs().mean(1) \
        + teacher.value_out_w.abs().mean(0)
    tower = top_indices(tower_score, target.tower)

    student.stem.copy_(teacher.stem.index_select(0, channels))
    student.stem_bias.copy_(teacher.stem_bias.index_select(0, channels))
    selected_residual = teacher.residual.index_select(0, blocks)
    selected_residual = selected_residual.index_select(2, channels).index_select(3, channels)
    student.residual.copy_(selected_residual)
    student.residual_bias.copy_(teacher.residual_bias.index_select(0, blocks).index_select(2, channels))
    student.conditioning_w.copy_(
        teacher.conditioning_w.index_select(0, blocks).index_select(1, channels))
    student.conditioning_b.copy_(
        teacher.conditioning_b.index_select(0, blocks).index_select(1, channels))

    pooled = (channels[:, None] * 25 + torch.arange(25, device=channels.device)[None, :]).flatten()
    student.value_w1.copy_(
        teacher.value_w1.index_select(0, hidden).index_select(1, pooled))
    student.value_b1.copy_(teacher.value_b1.index_select(0, hidden))
    student.value_w2.copy_(
        teacher.value_w2.index_select(0, tower).index_select(1, hidden))
    student.value_b2.copy_(teacher.value_b2.index_select(0, tower))
    student.value_out_w.copy_(teacher.value_out_w.index_select(1, tower))
    student.value_out_b.copy_(teacher.value_out_b)
    student.policy_w.copy_(teacher.policy_w.index_select(1, channels))
    student.policy_b.copy_(teacher.policy_b)
    student.pass_w.copy_(teacher.pass_w.index_select(1, pooled))
    student.pass_b.copy_(teacher.pass_b)
    student.branch_w.copy_(teacher.branch_w.index_select(1, channels))
    student.branch_b.copy_(teacher.branch_b)
    student.pass_branch_w.copy_(teacher.pass_branch_w.index_select(1, pooled))
    student.pass_branch_b.copy_(teacher.pass_branch_b)


def encoded_batch(examples: list[ProposalExample], device: torch.device) -> tuple[Tensor, Tensor]:
    inputs = set_elapsed(
        encode_states([example.state for example in examples], 5, device),
        [example.elapsed for example in examples], 5)
    behavior = torch.tensor(
        [example.behavior for example in examples], dtype=torch.float32, device=device)
    return inputs, behavior


def encoded_value_batch(examples: list[DistillExample], device: torch.device) -> tuple[Tensor, Tensor]:
    inputs = set_elapsed(
        encode_states([example.state for example in examples], 5, device),
        [example.elapsed for example in examples], 5)
    behavior = torch.tensor(
        [example.behavior for example in examples], dtype=torch.float32, device=device)
    return inputs, behavior


def distillation_loss(
    student: V9Net,
    teacher: V9Net,
    examples: list[ProposalExample],
    value_examples: list[DistillExample],
    device: torch.device,
    args: argparse.Namespace,
) -> tuple[Tensor, dict[str, float]]:
    inputs, behavior = encoded_batch(examples, device)
    zero = torch.zeros((), device=device)
    if args.distill_policy or args.distill_branches or args.supervised_shortlist:
        with torch.no_grad():
            teacher_policy, teacher_branches = teacher.forward_proposal(inputs, behavior)
        student_policy, student_branches = student.forward_proposal(inputs, behavior)
    if args.distill_value:
        value_inputs, value_behavior = encoded_value_batch(value_examples, device)
        with torch.no_grad():
            teacher_value = teacher.forward_value(value_inputs, value_behavior)
        student_value = student.forward_value(value_inputs, value_behavior)
        value_loss = F.smooth_l1_loss(student_value, teacher_value)
    else:
        value_loss = zero
    policy_losses: list[Tensor] = []
    branch_losses: list[Tensor] = []
    supervised_losses: list[Tensor] = []
    temperature = args.temperature
    for row, example in enumerate(examples):
        moves = torch.tensor(example.moves, dtype=torch.long, device=device)
        if args.distill_policy:
            policy_losses.append(F.kl_div(
                F.log_softmax(student_policy[row, moves] / temperature, dim=0),
                F.softmax(teacher_policy[row, moves] / temperature, dim=0),
                reduction="sum") * temperature * temperature)
        if args.distill_branches:
            branch_losses.append(F.kl_div(
                F.log_softmax(student_branches[row, moves] / temperature, dim=1),
                F.softmax(teacher_branches[row, moves] / temperature, dim=1),
                reduction="batchmean") * temperature * temperature)
        if args.supervised_shortlist:
            targets = torch.tensor(example.targets, dtype=torch.float32, device=device)
            supervised_losses.append(F.binary_cross_entropy_with_logits(
                student_policy[row, moves], targets))
    policy_loss = torch.stack(policy_losses).mean() if policy_losses else zero
    branch_loss = torch.stack(branch_losses).mean() if branch_losses else zero
    supervised_loss = torch.stack(supervised_losses).mean() if supervised_losses else zero
    total = args.value_weight * value_loss + args.policy_weight * policy_loss \
        + args.branch_weight * branch_loss + args.supervised_weight * supervised_loss
    return total, {
        "value": float(value_loss.detach().cpu()),
        "policy": float(policy_loss.detach().cpu()),
        "branches": float(branch_loss.detach().cpu()),
        "supervised": float(supervised_loss.detach().cpu()),
    }


@torch.no_grad()
def agreement_metrics(student: V9Net, teacher: V9Net,
                      examples: list[ProposalExample],
                      value_examples: list[DistillExample], device: torch.device,
                      top_k: int) -> dict[str, float]:
    teacher_hits = total = 0
    win_errors: list[float] = []
    power_relative: list[float] = []
    remaining_relative: list[float] = []
    for offset in range(0, len(examples), 256):
        batch = examples[offset:offset + 256]
        inputs, behavior = encoded_batch(batch, device)
        tp = teacher.forward_policy(inputs, behavior)
        sp = student.forward_policy(inputs, behavior)
        for row, example in enumerate(batch):
            moves = torch.tensor(example.moves, dtype=torch.long, device=device)
            count = min(top_k, len(example.moves))
            teacher_set = set(torch.topk(tp[row, moves], count).indices.tolist())
            student_set = set(torch.topk(sp[row, moves], count).indices.tolist())
            teacher_hits += len(teacher_set & student_set)
            total += count
    for offset in range(0, len(value_examples), 256):
        batch = value_examples[offset:offset + 256]
        inputs, behavior = encoded_value_batch(batch, device)
        tv = teacher.forward_value(inputs, behavior)
        sv = student.forward_value(inputs, behavior)
        td = torch.cat((torch.sigmoid(tv[:, :1]),
                        torch.expm1(torch.clamp(F.softplus(tv[:, 1:]), max=40))), dim=1)
        sd = torch.cat((torch.sigmoid(sv[:, :1]),
                        torch.expm1(torch.clamp(F.softplus(sv[:, 1:]), max=40))), dim=1)
        win_errors.extend((sd[:, 0] - td[:, 0]).abs().cpu().tolist())
        power_relative.extend(((sd[:, 1] - td[:, 1]).abs()
                               / td[:, 1].abs().clamp_min(1)).cpu().tolist())
        remaining_relative.extend(((sd[:, 2] - td[:, 2]).abs()
                                   / td[:, 2].abs().clamp_min(1)).cpu().tolist())

    def percentile(values: list[float], fraction: float) -> float:
        ordered = sorted(values)
        return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]

    return {
        "positions": len(examples),
        "teacherTopKElementAgreement": teacher_hits / max(total, 1),
        "winAbsoluteP95": percentile(win_errors, 0.95),
        "winAbsoluteMax": max(win_errors),
        "powerRelativeP95": percentile(power_relative, 0.95),
        "remainingRelativeP95": percentile(remaining_relative, 0.95),
    }


def train_student(
    teacher: V9Net,
    requested: CompressionShape,
    training: list[ProposalExample],
    heldout: list[ProposalExample],
    training_values: list[DistillExample],
    heldout_values: list[DistillExample],
    output_dir: pathlib.Path,
    device: torch.device,
    deadline: float | None,
    args: argparse.Namespace,
) -> dict[str, object]:
    shape = V9Shape(5, requested.channels, requested.blocks,
                    requested.hidden, requested.tower, behavior=31)
    label = requested.label + (f"-r{args.value_rank}" if args.value_rank else "")
    student = load_v9(pathlib.Path(args.student_init), device) \
        if args.student_init else V9Net(shape, device, args.seed)
    if student.shape != shape:
        raise RuntimeError(f"--student-init shape {student.shape} does not match {shape}")
    if args.structured_init and not args.student_init:
        structured_initialize(student, teacher)
    if args.freeze_trunk:
        for name, parameter in student.named_parameters():
            parameter.requires_grad_(name.startswith((
                "value_w1", "value_b1", "value_w2", "value_b2",
                "value_out_w", "value_out_b")))
    value_factor = enable_low_rank_value(
        student, args.value_rank, args.quantization_aware) if args.value_rank else None
    if args.quantization_aware:
        enable_export_quantization(student, factorized_value=value_factor is not None)
    optimizer = torch.optim.AdamW(
        (parameter for parameter in student.parameters() if parameter.requires_grad),
        lr=args.learning_rate, weight_decay=args.weight_decay)
    shape_seed = int.from_bytes(hashlib.sha256(label.encode()).digest()[:8], "little")
    randomizer = random.Random(args.seed ^ shape_seed)
    started = time.monotonic()
    updates = 0
    latest: dict[str, float] = {}
    student.train()
    while not args.evaluate_only and (args.updates <= 0 or updates < args.updates):
        if deadline is not None and time.monotonic() >= deadline:
            break
        batch = randomizer.choices(training, k=min(args.batch_size, len(training)))
        value_batch = randomizer.choices(
            training_values, k=min(args.batch_size, len(training_values)))
        loss, latest = distillation_loss(
            student, teacher, batch, value_batch, device, args)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(student.parameters(), args.gradient_clip)
        optimizer.step()
        updates += 1
        if updates == 1 or updates % args.report_updates == 0:
            print(json.dumps({
                "shape": label, "updates": updates,
                "elapsedSeconds": time.monotonic() - started,
                "loss": float(loss.detach().cpu()), **latest,
            }), flush=True)

    model_path = output_dir / f"{label}.model"
    save_model(student, model_path)
    factor_path = output_dir / f"{label}.factor"
    if value_factor is not None:
        save_value_factor(value_factor, factor_path)
    agreement = agreement_metrics(
        student, teacher, heldout, heldout_values, device, args.top_k)
    shortlist = shortlist_metrics(student, heldout, device, args.top_k)
    trained, deployed, artifact_bytes = parameter_counts(shape, args.value_rank)
    teacher_trained, teacher_deployed, teacher_bytes = parameter_counts(teacher.shape)
    absolute_shortlist_allowed = (
        shortlist["positions"] >= args.min_gate_positions
        and shortlist["topKRecall"] >= args.min_top_k_recall
        and shortlist["setRecall"] >= args.min_set_recall
        and shortlist["passPositions"] >= args.min_gate_pass_positions
        and shortlist["passRecall"] >= args.min_pass_recall
    )
    distillation_allowed = (
        agreement["teacherTopKElementAgreement"] >= args.min_teacher_top_k_agreement
        and agreement["winAbsoluteP95"] <= args.max_win_p95
        and agreement["powerRelativeP95"] <= args.max_power_relative_p95
        and agreement["remainingRelativeP95"] <= args.max_remaining_relative_p95
    )
    cpp_error = verify_cpp(student, model_path, args.oracle, device)
    promoted_champion = GO_AI / "small5-champion.model"
    teacher_is_promoted_champion = args.teacher_sha256 == file_sha256(promoted_champion)
    inherited_shortlist_allowed = teacher_is_promoted_champion \
        and agreement["teacherTopKElementAgreement"] >= args.min_teacher_top_k_agreement
    shortlist_allowed = absolute_shortlist_allowed or inherited_shortlist_allowed
    result: dict[str, object] = {
        "profile": "small5",
        "stage": "post-training-structured-distillation-v1",
        "shape": dataclasses.asdict(requested),
        "valueRank": args.value_rank,
        "model": str(model_path),
        "modelSha256": file_sha256(model_path),
        "teacherSha256": args.teacher_sha256,
        "updates": updates,
        "elapsedSeconds": time.monotonic() - started,
        "flags": {
            "structuredInit": args.structured_init,
            "freezeTrunk": args.freeze_trunk,
            "quantizationAware": args.quantization_aware,
            "distillValue": args.distill_value,
            "distillPolicy": args.distill_policy,
            "distillBranches": args.distill_branches,
            "supervisedShortlist": args.supervised_shortlist,
        },
        "parameters": {
            "trained": trained, "deployed": deployed,
            "teacherTrained": teacher_trained, "teacherDeployed": teacher_deployed,
            "deployedReduction": 1 - deployed / teacher_deployed,
        },
        "estimatedArtifactBytes": artifact_bytes,
        "teacherArtifactBytes": teacher_bytes,
        "artifactReduction": 1 - artifact_bytes / teacher_bytes,
        "heldout": shortlist,
        "agreement": agreement,
        "cppParityRelativeError": cpp_error,
        "distillationGatePassed": distillation_allowed,
        "teacherIsPromotedChampion": teacher_is_promoted_champion,
        "absoluteShortlistGatePassed": absolute_shortlist_allowed,
        "inheritedShortlistGatePassed": inherited_shortlist_allowed,
        # go:promote can consume the summary, but remains the independent owner
        # of complete-game WebGPU strength and installation.
        "shortlistDataAllowed": shortlist_allowed,
        "shortlistGate": {
            "topK": shortlist["positions"] >= args.min_gate_positions
                and shortlist["topKRecall"] >= args.min_top_k_recall,
            "set": shortlist["positions"] >= args.min_gate_positions
                and shortlist["setRecall"] >= args.min_set_recall,
            "pass": shortlist["passPositions"] >= args.min_gate_pass_positions
                and shortlist["passRecall"] >= args.min_pass_recall,
            "bait": True,
            "inheritedFromPromotedTeacher": inherited_shortlist_allowed,
        },
        "exportCandidate": shortlist_allowed and distillation_allowed,
        "requiresWebGpuArena": True,
        **({
            "valueFactor": str(factor_path),
            "valueFactorSha256": file_sha256(factor_path),
        } if value_factor is not None else {}),
    }
    (output_dir / f"{label}.summary.json").write_text(
        json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    return result


def run(args: argparse.Namespace) -> None:
    if args.profile != "small5":
        raise RuntimeError("the structured-distillation proof currently supports small5 only")
    if not args.corpus_in:
        raise RuntimeError("at least one --corpus-in is required")
    if args.time_budget_minutes < 0 or args.updates < 0:
        raise RuntimeError("time budget and updates must be nonnegative")
    if args.evaluate_only and not args.student_init:
        raise RuntimeError("--evaluate-only=on requires --student-init")
    if not args.evaluate_only and args.time_budget_minutes == 0 and args.updates == 0:
        raise RuntimeError("set a positive --time-budget-minutes or --updates")
    if not any((args.distill_value, args.distill_policy,
                args.distill_branches, args.supervised_shortlist)):
        raise RuntimeError("at least one compression training objective must be enabled")
    device = auto_device(args.device)
    configure_accelerator(device)
    teacher_path = pathlib.Path(args.teacher)
    teacher = load_v9(teacher_path, device)
    expected = V9Shape(5, 32, 4, 256, 64, 31)
    if teacher.shape != expected:
        raise RuntimeError(f"small5 compression teacher must have promoted shape {expected}")
    teacher.eval()
    for parameter in teacher.parameters():
        parameter.requires_grad_(False)
    args.teacher_sha256 = file_sha256(teacher_path)
    for shape in args.shape:
        if (shape.channels > teacher.shape.channels or shape.blocks > teacher.shape.blocks
                or shape.hidden > teacher.shape.hidden or shape.tower > teacher.shape.tower):
            raise RuntimeError(f"{shape.label} is not smaller than the teacher")
        if args.value_rank < 0 or (args.value_rank
                and args.value_rank >= min(shape.hidden, shape.channels * 25)):
            raise RuntimeError("--value-rank must be zero or smaller than hidden and pooled dimensions")
    training, heldout, training_values, heldout_values = load_knowledge(
        args.corpus_in, args.max_positions, args.seed)
    output_dir = pathlib.Path(args.out_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError("output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    print(json.dumps({
        "device": str(device), "teacherSha256": args.teacher_sha256,
        "trainingPositions": len(training), "heldoutPositions": len(heldout),
        "trainingValuePositions": len(training_values),
        "heldoutValuePositions": len(heldout_values),
        "shapes": [shape.label for shape in args.shape],
    }), flush=True)
    overall_deadline = time.monotonic() + args.time_budget_minutes * 60 \
        if args.time_budget_minutes > 0 else None
    results: list[dict[str, object]] = []
    for index, shape in enumerate(args.shape):
        if overall_deadline is None:
            deadline = None
        else:
            remaining = max(0.0, overall_deadline - time.monotonic())
            deadline = time.monotonic() + remaining / (len(args.shape) - index)
        results.append(train_student(
            teacher, shape, training, heldout, training_values, heldout_values,
            output_dir, device, deadline, args))
    eligible = [result for result in results if result["exportCandidate"]]
    best = min(eligible, key=lambda value: int(value["estimatedArtifactBytes"])) \
        if eligible else None
    if best:
        shutil.copyfile(str(best["model"]), output_dir / "export-candidate.model")
        best["exportCandidateModel"] = str(output_dir / "export-candidate.model")
        if best.get("valueFactor"):
            shutil.copyfile(str(best["valueFactor"]), output_dir / "export-candidate.factor")
            best["exportCandidateFactor"] = str(output_dir / "export-candidate.factor")
    summary = {
        "profile": "small5",
        "stage": "post-training-structured-distillation-v1",
        "teacher": str(teacher_path),
        "teacherSha256": args.teacher_sha256,
        "results": results,
        "selected": best,
        "selectionRule": "smallest static-gate-passing student; WebGPU arena still required",
    }
    (output_dir / "compression-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19"), default="small5")
    result.add_argument("--teacher", default=str(GO_AI / "small5-champion.model"))
    result.add_argument("--student-init",
                        help="evaluate/resume an already compressed student of the requested shape")
    result.add_argument("--corpus-in", action="append", default=[])
    result.add_argument("--out-dir", required=True)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    result.add_argument("--oracle", default=str(GO_AI / "build/release/go_cpp_oracle"))
    result.add_argument("--shape", action="append", type=parse_shape,
                        default=[], metavar="CxBxHxT")
    result.add_argument("--time-budget-minutes", type=float, default=120)
    result.add_argument("--updates", type=int, default=0,
                        help="fixed updates per shape; zero trains to the time budget")
    result.add_argument("--evaluate-only", type=on_off, default=False, metavar="on|off",
                        help="gate --student-init without optimizer updates")
    result.add_argument("--batch-size", type=int, default=128)
    result.add_argument("--max-positions", type=int, default=0,
                        help="cap loaded training positions; zero loads all")
    result.add_argument("--learning-rate", type=float, default=2e-4)
    result.add_argument("--weight-decay", type=float, default=1e-6)
    result.add_argument("--gradient-clip", type=float, default=5.0)
    result.add_argument("--temperature", type=float, default=2.0)
    result.add_argument("--report-updates", type=int, default=100)
    result.add_argument("--structured-init", type=on_off, default=True, metavar="on|off")
    result.add_argument("--freeze-trunk", type=on_off, default=True, metavar="on|off",
                        help="train only the compressed value head; preserves proposal outputs exactly")
    result.add_argument("--quantization-aware", type=on_off, default=True, metavar="on|off",
                        help="recover against exporter-exact row-q8 weights and f16 biases")
    result.add_argument("--value-rank", type=int, default=0,
                        help="factor the first value matrix as hidden×rank and rank×pooled; zero disables")
    result.add_argument("--distill-value", type=on_off, default=True, metavar="on|off")
    result.add_argument("--distill-policy", type=on_off, default=False, metavar="on|off")
    result.add_argument("--distill-branches", type=on_off, default=False, metavar="on|off")
    result.add_argument("--supervised-shortlist", type=on_off, default=False, metavar="on|off")
    result.add_argument("--value-weight", type=float, default=1.0)
    result.add_argument("--policy-weight", type=float, default=1.0)
    result.add_argument("--branch-weight", type=float, default=0.25)
    result.add_argument("--supervised-weight", type=float, default=0.25)
    result.add_argument("--top-k", type=int, default=8)
    result.add_argument("--min-gate-positions", type=int, default=500)
    result.add_argument("--min-top-k-recall", type=float, default=0.995)
    result.add_argument("--min-set-recall", type=float, default=0.99)
    result.add_argument("--min-gate-pass-positions", type=int, default=25)
    result.add_argument("--min-pass-recall", type=float, default=0.995)
    result.add_argument("--min-teacher-top-k-agreement", type=float, default=0.99)
    result.add_argument("--max-win-p95", type=float, default=0.03)
    result.add_argument("--max-power-relative-p95", type=float, default=0.10)
    result.add_argument("--max-remaining-relative-p95", type=float, default=0.10)
    return result


if __name__ == "__main__":
    try:
        arguments = parser().parse_args()
        if not arguments.shape:
            arguments.shape = [
                CompressionShape(32, 4, 224, 56),
                CompressionShape(32, 4, 192, 48),
            ]
        run(arguments)
    except Exception as error:
        print(error, file=sys.stderr)
        raise
