#!/usr/bin/env python3
"""Short, fixed-corpus V9 topology capacity and interference diagnostics.

This is deliberately read-only: it never writes a checkpoint, generates a game,
or promotes a model.  Route-separated probes preserve the champion's complete
per-route depth and width.  They therefore hold inference arithmetic constant;
only parameter sharing and resident weight bytes change.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import math
import pathlib
import random
from typing import Sequence

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from compress_v9 import parameter_counts
from device import auto_device
from train_v9 import (
    BRANCHES,
    DistillExample,
    ProposalExample,
    RankingExample,
    V9Net,
    V9Shape,
    actor_proposal_example,
    configure_accelerator,
    encode_states,
    file_sha256,
    load_corpora,
    load_v9,
    post_reply_behavior,
    proposal_objective,
    ranking_metrics,
    set_elapsed,
    shortlist_metrics,
    train_updates,
)


GO_AI = pathlib.Path(__file__).resolve().parents[1]


PROFILE = {
    "small5": {
        "champion": GO_AI / "small5-champion.model",
        "retention": GO_AI / "corpora/v9-small5-component-split-hard-finalists-future-v9.5-20260814-g64-c2048.jsonl.gz",
        "adviser": GO_AI / "corpora/v9-small5-component-split-hard-finalists-future-v9.5-20260814-g64-c2048.jsonl.gz",
        "top_k": 8,
        "separate_blocks": 1,
    },
    "daemon19": {
        "champion": GO_AI / "daemon19-champion.model",
        "retention": GO_AI / "corpora/v9-daemon19-component-split-paired-authority-future-v9.5-20260814-g256-c32.jsonl.gz",
        "adviser": GO_AI / "corpora/v9-daemon19-component-split-paired-authority-future-v9.5-20260814-g256-c32.jsonl.gz",
        "top_k": 16,
        "separate_blocks": 2,
    },
}


HEAD_PARAMETERS = (
    "value_w1", "value_b1", "value_w2", "value_b2", "value_out_w", "value_out_b",
    "policy_w", "policy_b", "pass_w", "pass_b", "branch_w", "branch_b",
    "pass_branch_w", "pass_branch_b",
)


class RoutedV9Net(nn.Module):
    """Champion-exact shared-prefix, route-specific-tail diagnostic network."""

    def __init__(self, champion: V9Net, separate_blocks: int):
        super().__init__()
        shape = champion.shape
        if not 0 <= separate_blocks <= shape.blocks:
            raise ValueError("separate block count exceeds topology")
        self.shape = shape
        self.separate_blocks = separate_blocks
        prefix = shape.blocks - separate_blocks
        self.stem_isolated = separate_blocks == shape.blocks
        if self.stem_isolated:
            self.proposal_stem = nn.Parameter(champion.stem.detach().clone())
            self.proposal_stem_bias = nn.Parameter(champion.stem_bias.detach().clone())
            self.value_stem = nn.Parameter(champion.stem.detach().clone())
            self.value_stem_bias = nn.Parameter(champion.stem_bias.detach().clone())
        else:
            self.stem = nn.Parameter(champion.stem.detach().clone())
            self.stem_bias = nn.Parameter(champion.stem_bias.detach().clone())
        self.shared_residual = nn.Parameter(champion.residual[:prefix].detach().clone())
        self.shared_residual_bias = nn.Parameter(champion.residual_bias[:prefix].detach().clone())
        self.shared_conditioning_w = nn.Parameter(champion.conditioning_w[:prefix].detach().clone())
        self.shared_conditioning_b = nn.Parameter(champion.conditioning_b[:prefix].detach().clone())
        tail = champion.residual[prefix:].detach()
        tail_bias = champion.residual_bias[prefix:].detach()
        tail_condition = champion.conditioning_w[prefix:].detach()
        tail_condition_bias = champion.conditioning_b[prefix:].detach()
        self.proposal_residual = nn.Parameter(tail.clone())
        self.proposal_residual_bias = nn.Parameter(tail_bias.clone())
        self.proposal_conditioning_w = nn.Parameter(tail_condition.clone())
        self.proposal_conditioning_b = nn.Parameter(tail_condition_bias.clone())
        self.value_residual = nn.Parameter(tail.clone())
        self.value_residual_bias = nn.Parameter(tail_bias.clone())
        self.value_conditioning_w = nn.Parameter(tail_condition.clone())
        self.value_conditioning_b = nn.Parameter(tail_condition_bias.clone())
        for name in HEAD_PARAMETERS:
            setattr(self, name, nn.Parameter(getattr(champion, name).detach().clone()))
        self.register_buffer("pool", champion.pool.detach().clone())

    @staticmethod
    def _block(spatial: Tensor, behavior: Tensor, residual: Tensor,
               residual_bias: Tensor, conditioning_w: Tensor,
               conditioning_b: Tensor, block: int) -> Tensor:
        update = torch.tanh(F.conv2d(
            spatial, residual[block, 0], residual_bias[block, 0], padding=1))
        update = F.conv2d(
            update, residual[block, 1], residual_bias[block, 1], padding=1)
        condition = F.linear(
            behavior, conditioning_w[block], conditioning_b[block])[:, :, None, None]
        return torch.tanh(spatial + update + condition)

    def trunk(self, inputs: Tensor, behavior: Tensor, route: str) -> tuple[Tensor, Tensor]:
        stem = getattr(self, f"{route}_stem") if self.stem_isolated else self.stem
        stem_bias = getattr(self, f"{route}_stem_bias") if self.stem_isolated else self.stem_bias
        spatial = torch.tanh(F.conv2d(inputs, stem, stem_bias, padding=1))
        for block in range(self.shared_residual.shape[0]):
            spatial = self._block(
                spatial, behavior, self.shared_residual, self.shared_residual_bias,
                self.shared_conditioning_w, self.shared_conditioning_b, block)
        residual = getattr(self, f"{route}_residual")
        residual_bias = getattr(self, f"{route}_residual_bias")
        conditioning_w = getattr(self, f"{route}_conditioning_w")
        conditioning_b = getattr(self, f"{route}_conditioning_b")
        for block in range(residual.shape[0]):
            spatial = self._block(
                spatial, behavior, residual, residual_bias,
                conditioning_w, conditioning_b, block)
        pooled = torch.einsum("bcn,pn->bcp", spatial.flatten(2), self.pool).flatten(1)
        return spatial, pooled

    def value_head(self, pooled: Tensor) -> Tensor:
        hidden = torch.tanh(F.linear(pooled, self.value_w1, self.value_b1))
        tower = torch.tanh(F.linear(hidden, self.value_w2, self.value_b2))
        return F.linear(tower, self.value_out_w, self.value_out_b)

    def policy_head(self, spatial: Tensor, pooled: Tensor) -> Tensor:
        point = F.conv2d(spatial, self.policy_w[:, :, None, None], self.policy_b).flatten(1)
        return torch.cat((point, F.linear(pooled, self.pass_w, self.pass_b)), dim=1)

    def branch_head(self, spatial: Tensor, pooled: Tensor) -> Tensor:
        point = F.conv2d(
            spatial, self.branch_w[:, :, None, None], self.branch_b).flatten(2).transpose(1, 2)
        passed = F.linear(pooled, self.pass_branch_w, self.pass_branch_b)[:, None, :]
        return torch.cat((point, passed), dim=1)

    def forward_value(self, inputs: Tensor, behavior: Tensor) -> Tensor:
        return self.value_head(self.trunk(inputs, behavior, "value")[1])

    def forward_policy(self, inputs: Tensor, behavior: Tensor) -> Tensor:
        spatial, pooled = self.trunk(inputs, behavior, "proposal")
        return self.policy_head(spatial, pooled)

    def forward_proposal(self, inputs: Tensor, behavior: Tensor) -> tuple[Tensor, Tensor]:
        spatial, pooled = self.trunk(inputs, behavior, "proposal")
        return self.policy_head(spatial, pooled), self.branch_head(spatial, pooled)

    def forward(self, inputs: Tensor, behavior: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        value = self.forward_value(inputs, behavior)
        policy, branch = self.forward_proposal(inputs, behavior)
        return value, policy, branch


def balanced(values: Sequence, per_source: int, seed: int,
             source=lambda value: value.source) -> list:
    buckets: dict[str, list] = collections.defaultdict(list)
    for value in values:
        buckets[source(value)].append(value)
    result: list = []
    for name, bucket in sorted(buckets.items()):
        random.Random(seed ^ sum(map(ord, name))).shuffle(bucket)
        result.extend(bucket[:per_source])
    random.Random(seed).shuffle(result)
    return result


def disjoint_adviser_split(path: pathlib.Path, profile: str, teacher_sha256: str) -> tuple[
        list[ProposalExample], list[ProposalExample],
        list[RankingExample], list[RankingExample]]:
    """Load fixed-adviser supervision from the retained component split."""
    proposal = {"train": [], "heldout": []}
    ranking = {"train": [], "heldout": []}

    with gzip.open(path, "rt") as source:
        for line_number, line in enumerate(source, 1):
            record = json.loads(line)
            if record.get("profile") != profile \
                    or record.get("teacherSha256") != teacher_sha256:
                raise RuntimeError(f"{path}:{line_number}: diagnostic corpus identity mismatch")
            kind = record.get("kind")
            if kind not in ("actor", "actor-ranking"):
                continue
            raw = record["example"]
            if raw.get("source") not in ("katago", "handcrafted"):
                continue
            side = record["split"]
            if kind == "actor":
                actions = raw.get("actions")
                action = [int(value) for value in actions] if isinstance(actions, list) \
                    else int(raw["action"])
                proposal[side].append(actor_proposal_example(
                    int(raw["episode"]), str(raw["state"]),
                    [float(value) for value in raw["behavior"]], int(raw["elapsed"]),
                    [int(value) for value in raw["moves"]], action, str(raw["source"])))
            else:
                moves = [int(value) for value in raw["moves"]]
                best = int(raw["bestMove"])
                example = ProposalExample(
                    int(raw["episode"]), str(raw["state"]),
                    [float(value) for value in raw["behavior"]], int(raw["elapsed"]),
                    moves, [1.0 if move == best else 0.0 for move in moves],
                    [0.0] * len(moves), [[0.0] * BRANCHES for _ in moves],
                    best, [best], [], [], str(raw["source"]))
                ranking[side].append(RankingExample(
                    example, [[DistillExample(**value) for value in candidate]
                              for candidate in raw["candidates"]]))
    return proposal["train"], proposal["heldout"], ranking["train"], ranking["heldout"]


def ranking_loss(model: nn.Module, examples: Sequence[RankingExample],
                 device: torch.device) -> Tensor:
    flat = [value for example in examples for candidate in example.candidates for value in candidate]
    inputs = set_elapsed(
        encode_states([value.state for value in flat], model.shape.extent, device),
        [value.elapsed for value in flat], model.shape.extent)
    behavior = post_reply_behavior(
        [value.behavior for value in flat], model.shape.extent, model.shape.behavior, device)
    raw = model.forward_value(inputs, behavior)
    decoded = torch.cat((
        torch.sigmoid(raw[:, :1]),
        torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
    ), dim=1)
    losses: list[Tensor] = []
    offset = 0
    for example in examples:
        wins: list[Tensor] = []
        rates: list[Tensor] = []
        teacher_wins: list[float] = []
        for candidate in example.candidates:
            rows = decoded[offset:offset + len(candidate)]
            offset += len(candidate)
            weights = torch.tensor([value.weight for value in candidate], device=device)
            wins.append((weights * rows[:, 0]).sum())
            rates.append((weights * rows[:, 1] / torch.clamp(
                example.proposal.elapsed + rows[:, 2], min=1e-6)).sum())
            teacher_wins.append(sum(value.weight * value.won for value in candidate))
        best = example.proposal.moves.index(example.proposal.best_move)
        loss = F.cross_entropy(
            (8 * torch.stack(wins).square())[None, :], torch.tensor([best], device=device))
        tied = [index for index, won in enumerate(teacher_wins)
                if abs(won - teacher_wins[best]) <= 1e-5]
        if len(tied) > 1:
            loss = loss + 0.25 * F.cross_entropy(
                (4 * torch.stack([rates[index] for index in tied]))[None, :],
                torch.tensor([tied.index(best)], device=device))
        losses.append(loss)
    return torch.stack(losses).mean()


def named_trunk_parameters(model: V9Net) -> dict[str, list[Tensor]]:
    midpoint = model.shape.blocks // 2
    return {
        "stem": [model.stem, model.stem_bias],
        "earlyResidual": [model.residual[:midpoint], model.residual_bias[:midpoint]],
        "lateResidual": [model.residual[midpoint:], model.residual_bias[midpoint:]],
        "conditioning": [model.conditioning_w, model.conditioning_b],
    }


def gradients(loss: Tensor, model: V9Net) -> dict[str, Tensor]:
    # Slices are not leaf parameters, so take gradients once and slice afterward.
    parameters = [model.stem, model.stem_bias, model.residual, model.residual_bias,
                  model.conditioning_w, model.conditioning_b]
    values = torch.autograd.grad(loss, parameters, retain_graph=True, allow_unused=True)
    midpoint = model.shape.blocks // 2
    packed = {
        "stem": values[:2],
        "earlyResidual": (values[2][:midpoint], values[3][:midpoint]),
        "lateResidual": (values[2][midpoint:], values[3][midpoint:]),
        "conditioning": values[4:],
    }
    return {name: torch.cat([value.flatten() for value in group if value is not None])
            for name, group in packed.items()}


def gradient_comparison(left: dict[str, Tensor], right: dict[str, Tensor]) -> dict[str, dict[str, float]]:
    result = {}
    for name in left:
        a, b = left[name], right[name]
        result[name] = {
            "cosine": float(F.cosine_similarity(a, b, dim=0)),
            "leftNorm": float(a.norm()),
            "rightNorm": float(b.norm()),
        }
    return result


def activation_diagnostics(model: V9Net, examples: Sequence[ProposalExample],
                           device: torch.device) -> dict[str, dict[str, float]]:
    batch = list(examples[:64])
    inputs = set_elapsed(encode_states(
        [example.state for example in batch], model.shape.extent, device),
        [example.elapsed for example in batch], model.shape.extent)
    behavior = torch.tensor([example.behavior for example in batch], device=device)
    stages: list[tuple[str, Tensor, Tensor | None, Tensor | None]] = []
    spatial = torch.tanh(F.conv2d(inputs, model.stem, model.stem_bias, padding=1))
    stages.append(("stem", spatial, None, None))
    for block in range(model.shape.blocks):
        update = torch.tanh(F.conv2d(
            spatial, model.residual[block, 0], model.residual_bias[block, 0], padding=1))
        update = F.conv2d(
            update, model.residual[block, 1], model.residual_bias[block, 1], padding=1)
        condition = F.linear(
            behavior, model.conditioning_w[block], model.conditioning_b[block])[:, :, None, None]
        previous = spatial
        spatial = torch.tanh(spatial + update + condition)
        stages.append((f"block{block + 1}", spatial, update, condition))
    result = {}
    for name, value, update, condition in stages:
        absolute = value.detach().abs().flatten()
        derivative = 1 - absolute.square()
        result[name] = {
            "absMean": float(absolute.mean()),
            "above0.9": float((absolute > 0.9).float().mean()),
            "above0.99": float((absolute > 0.99).float().mean()),
            "tanhDerivativeP05": float(torch.quantile(derivative, 0.05)),
            "tanhDerivativeMedian": float(derivative.median()),
        }
        if update is not None and condition is not None:
            result[name]["updateRms"] = float(update.detach().square().mean().sqrt())
            result[name]["conditionRms"] = float(condition.detach().square().mean().sqrt())
    return result


@torch.no_grad()
def value_activation_diagnostics(model: V9Net, rankings: Sequence[RankingExample],
                                 device: torch.device) -> dict[str, dict[str, float]]:
    flat = [value for example in rankings[:32]
            for candidate in example.candidates for value in candidate]
    inputs = set_elapsed(encode_states(
        [value.state for value in flat], model.shape.extent, device),
        [value.elapsed for value in flat], model.shape.extent)
    behavior = post_reply_behavior(
        [value.behavior for value in flat], model.shape.extent, model.shape.behavior, device)
    _, pooled = model.trunk(inputs, behavior)
    hidden = torch.tanh(F.linear(pooled, model.value_w1, model.value_b1))
    tower = torch.tanh(F.linear(hidden, model.value_w2, model.value_b2))
    raw = F.linear(tower, model.value_out_w, model.value_out_b)

    def tanh_stats(value: Tensor) -> dict[str, float]:
        absolute = value.abs().flatten()
        derivative = 1 - absolute.square()
        return {
            "above0.9": float((absolute > 0.9).float().mean()),
            "above0.99": float((absolute > 0.99).float().mean()),
            "tanhDerivativeP05": float(torch.quantile(derivative, 0.05)),
            "tanhDerivativeMedian": float(derivative.median()),
        }

    win = raw[:, 0].sigmoid()
    win_derivative = win * (1 - win)
    return {
        "hidden": tanh_stats(hidden),
        "tower": tanh_stats(tower),
        "winOutput": {
            "probabilityP05": float(torch.quantile(win, 0.05)),
            "probabilityMedian": float(win.median()),
            "probabilityP95": float(torch.quantile(win, 0.95)),
            "sigmoidDerivativeP05": float(torch.quantile(win_derivative, 0.05)),
            "sigmoidDerivativeMedian": float(win_derivative.median()),
        },
    }


@torch.no_grad()
def behavior_sensitivity(model: V9Net, proposals: Sequence[ProposalExample],
                         rankings: Sequence[RankingExample],
                         device: torch.device) -> dict[str, float]:
    proposal = list(proposals[:64])
    inputs = set_elapsed(encode_states(
        [value.state for value in proposal], model.shape.extent, device),
        [value.elapsed for value in proposal], model.shape.extent)
    behavior = torch.tensor([value.behavior for value in proposal], device=device)
    policy = model.forward_policy(inputs, behavior)
    zero_policy = model.forward_policy(inputs, torch.zeros_like(behavior))
    permuted_policy = model.forward_policy(inputs, behavior.roll(1, dims=0))
    flat = [value for example in rankings[:32]
            for candidate in example.candidates for value in candidate]
    value_inputs = set_elapsed(encode_states(
        [value.state for value in flat], model.shape.extent, device),
        [value.elapsed for value in flat], model.shape.extent)
    value_behavior = post_reply_behavior(
        [value.behavior for value in flat], model.shape.extent, model.shape.behavior, device)
    value = model.forward_value(value_inputs, value_behavior)
    zero_value = model.forward_value(value_inputs, torch.zeros_like(value_behavior))
    permuted_value = model.forward_value(value_inputs, value_behavior.roll(1, dims=0))

    def rms(left: Tensor, right: Tensor) -> float:
        return float((left - right).square().mean().sqrt())

    return {
        "proposalZeroBehaviorLogitRms": rms(policy, zero_policy),
        "proposalPermutedBehaviorLogitRms": rms(policy, permuted_policy),
        "valueZeroBehaviorRawRms": rms(value, zero_value),
        "valuePermutedBehaviorRawRms": rms(value, permuted_value),
    }


@torch.no_grad()
def branch_metrics(model: nn.Module, examples: Sequence[ProposalExample],
                   device: torch.device) -> dict[str, float]:
    examples = [example for example in examples
                if any(sum(branch) > 0 for branch in example.branches)]
    if not examples:
        return {"positions": 0, "candidateAccuracy": 0, "crossEntropy": 0}
    correct = candidates = 0
    cross_entropy = 0.0
    for start in range(0, len(examples), 128):
        batch = examples[start:start + 128]
        inputs = set_elapsed(encode_states(
            [value.state for value in batch], model.shape.extent, device),
            [value.elapsed for value in batch], model.shape.extent)
        behavior = torch.tensor([value.behavior for value in batch], device=device)
        _, logits = model.forward_proposal(inputs, behavior)
        for row, example in enumerate(batch):
            for move, target in zip(example.moves, example.branches, strict=True):
                if sum(target) <= 0:
                    continue
                target_tensor = torch.tensor(target, device=device)
                correct += int(int(logits[row, move].argmax()) == int(target_tensor.argmax()))
                cross_entropy += float(-(target_tensor * F.log_softmax(
                    logits[row, move], dim=0)).sum())
                candidates += 1
    return {
        "positions": len(examples),
        "candidates": candidates,
        "candidateAccuracy": correct / max(candidates, 1),
        "crossEntropy": cross_entropy / max(candidates, 1),
    }


def receptive_field_diagnostic(model: V9Net, example: ProposalExample,
                                device: torch.device) -> dict[str, object]:
    area = model.shape.extent ** 2
    legal_points = [move for move in example.moves if move < area]
    point = max(legal_points, key=lambda move: max(
        max(divmod(move, model.shape.extent)),
        max(model.shape.extent - 1 - value for value in divmod(move, model.shape.extent))))
    inputs = set_elapsed(encode_states(
        [example.state], model.shape.extent, device), [example.elapsed], model.shape.extent)
    inputs.requires_grad_(True)
    behavior = torch.tensor([example.behavior], device=device)
    logit = model.forward_policy(inputs, behavior)[0, point]
    gradient = torch.autograd.grad(logit, inputs)[0].abs().sum(dim=1)[0]
    x, y = divmod(point, model.shape.extent)
    distances = torch.tensor([
        max(abs(px - x), abs(py - y))
        for px in range(model.shape.extent) for py in range(model.shape.extent)
    ], device=device).reshape(model.shape.extent, model.shape.extent)
    total = gradient.sum().clamp_min(1e-30)
    radius = 1 + 2 * model.shape.blocks
    return {
        "point": point,
        "theoreticalRadius": radius,
        "theoreticalFieldWidth": 2 * radius + 1,
        "boardFullyCoveredFromEveryPoint": radius >= model.shape.extent - 1,
        "gradientMassBeyond4": float(gradient[distances > 4].sum() / total),
        "gradientMassBeyond8": float(gradient[distances > 8].sum() / total),
        "gradientMassAtMaximumDistance": float(gradient[distances == distances.max()].sum() / total),
        "maximumDistance": int(distances.max()),
    }


def deployed_cost(shape: V9Shape, separate_blocks: int) -> dict[str, int | float]:
    _, baseline_parameters, baseline_bytes = parameter_counts(shape)
    c = shape.channels
    extra_parameters = separate_blocks * (18 * c * c + c * (shape.behavior + 3))
    extra_bytes = separate_blocks * (2 * c * (9 * c + 6) + c * (shape.behavior + 6))
    if separate_blocks == shape.blocks:
        extra_parameters += c * 8 * 9 + c
        extra_bytes += c * (8 * 9 + 6)
    return {
        "separateBlocks": separate_blocks,
        "deployedParameters": baseline_parameters + extra_parameters,
        "q8PayloadBytes": baseline_bytes + extra_bytes,
        "q8IncreasePercent": 100 * extra_bytes / baseline_bytes,
        "inferenceConvolutionCountChange": 0,
    }


def model_metrics(model: nn.Module, proposals: list[ProposalExample],
                  rankings: list[RankingExample], device: torch.device,
                  top_k: int) -> dict[str, object]:
    return {
        "proposal": {
            source: shortlist_metrics(model, proposals, device, top_k, source)
            for source in sorted({value.source for value in proposals})
        },
        "ranking": {
            source: ranking_metrics(model, rankings, device, source)
            for source in sorted({value.proposal.source for value in rankings})
        },
    }


def verify_clone(champion: V9Net, clone: RoutedV9Net, examples: Sequence[ProposalExample],
                 rankings: Sequence[RankingExample], device: torch.device) -> None:
    proposal = list(examples[:4])
    states = set_elapsed(encode_states(
        [value.state for value in proposal], champion.shape.extent, device),
        [value.elapsed for value in proposal], champion.shape.extent)
    behavior = torch.tensor([value.behavior for value in proposal], device=device)
    torch.testing.assert_close(
        champion.forward_policy(states, behavior), clone.forward_policy(states, behavior),
        rtol=0, atol=0)
    flat = [value for item in rankings[:2] for candidate in item.candidates for value in candidate]
    value_states = set_elapsed(encode_states(
        [value.state for value in flat], champion.shape.extent, device),
        [value.elapsed for value in flat], champion.shape.extent)
    value_behavior = post_reply_behavior(
        [value.behavior for value in flat], champion.shape.extent,
        champion.shape.behavior, device)
    torch.testing.assert_close(
        champion.forward_value(value_states, value_behavior),
        clone.forward_value(value_states, value_behavior), rtol=0, atol=0)


def branch_auxiliary_ablation(champion_path: pathlib.Path, champion: V9Net,
                              training: Sequence[ProposalExample],
                              heldout: Sequence[ProposalExample],
                              args: argparse.Namespace, device: torch.device,
                              top_k: int) -> dict[str, object]:
    branch_training = [value for value in training
                       if value.source == "champion"
                       and any(sum(branch) > 0 for branch in value.branches)]
    branch_heldout = [value for value in heldout
                      if value.source == "champion"
                      and any(sum(branch) > 0 for branch in value.branches)]
    if not branch_training or not branch_heldout:
        return {
            "available": False,
            "reason": "retained fixed corpora contain no exhaustive branch labels for this profile",
        }
    branch_training = balanced(branch_training, min(512, len(branch_training)), args.seed + 20)
    branch_heldout = balanced(branch_heldout, min(256, len(branch_heldout)), args.seed + 21)
    batch = branch_training[:min(64, len(branch_training))]
    inputs = set_elapsed(encode_states(
        [value.state for value in batch], champion.shape.extent, device),
        [value.elapsed for value in batch], champion.shape.extent)
    behavior = torch.tensor([value.behavior for value in batch], device=device)
    policy, branches = champion.forward_proposal(inputs, behavior)
    policy_loss = proposal_objective(
        policy, branches, batch, device, shortlist_k=top_k, branch_weight=0)
    combined = proposal_objective(
        policy, branches, batch, device, shortlist_k=top_k, branch_weight=1)
    branch_loss = combined - policy_loss
    gradient = gradient_comparison(
        gradients(policy_loss, champion), gradients(branch_loss, champion))
    result: dict[str, object] = {
        "available": True,
        "fixedCorpusCounts": {
            "train": len(branch_training), "heldout": len(branch_heldout),
        },
        "policyVsBranchGradient": gradient,
        "before": branch_metrics(champion, branch_heldout, device),
        "shortAblation": {},
    }
    for label, weight in (("off", 0.0), ("on", 0.25)):
        model = load_v9(champion_path, device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0)
        train_updates(
            model, optimizer, collections.deque(branch_training), collections.deque(),
            collections.deque(), collections.deque(), args.branch_updates,
            args.batch_size, device, random.Random(args.seed + 22),
            distill_weight=0, value_sampling="uniform", proposal_weight=1,
            proposal_margin_weight=0.25, proposal_anchor_weight=0.5,
            proposal_shortlist_k=top_k, mc_value_weight=0,
            mc_value_loss_weights=(1, 1, 1), distill_value_loss_weights=(1, 1, 1),
            ranking_weight=0, ranking_batch_size=1,
            fixed_source_fraction=0, self_source_fraction=0,
            proposal_branch_weight=weight)
        result["shortAblation"][label] = {
            "proposal": shortlist_metrics(model, branch_heldout, device, top_k),
            "branch": branch_metrics(model, branch_heldout, device),
        }
    return result


def anchor_capacity_probe(champion_path: pathlib.Path, proposals: Sequence[ProposalExample],
                          args: argparse.Namespace, device: torch.device,
                          top_k: int) -> dict[str, object]:
    """Test point-policy fit with an unambiguous best-move CE, not V9's actor loss."""
    if args.anchor_capacity_updates <= 0:
        return {"enabled": False}
    examples = balanced(
        proposals, args.anchor_capacity_per_source, args.seed + 30)
    model = load_v9(champion_path, device)
    before = {
        source: shortlist_metrics(model, examples, device, top_k, source)
        for source in sorted({value.source for value in examples})
    }
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.anchor_capacity_learning_rate, weight_decay=0)
    randomizer = random.Random(args.seed + 31)
    final_loss = 0.0
    for _ in range(args.anchor_capacity_updates):
        batch = randomizer.choices(examples, k=min(args.batch_size, len(examples)))
        inputs = set_elapsed(encode_states(
            [value.state for value in batch], model.shape.extent, device),
            [value.elapsed for value in batch], model.shape.extent)
        behavior = torch.tensor([value.behavior for value in batch], device=device)
        logits = model.forward_policy(inputs, behavior)
        valid = torch.zeros_like(logits, dtype=torch.bool)
        for row, example in enumerate(batch):
            valid[row, torch.tensor(example.moves, device=device)] = True
        target = torch.tensor([value.best_move for value in batch], device=device)
        loss = F.cross_entropy(logits.masked_fill(~valid, -torch.inf), target)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5, error_if_nonfinite=True)
        optimizer.step()
        final_loss = float(loss.detach())
    return {
        "enabled": True,
        "contract": "diagnostic single-anchor cross entropy; not the maintained actor objective",
        "positions": len(examples),
        "updates": args.anchor_capacity_updates,
        "learningRate": args.anchor_capacity_learning_rate,
        "finalLoss": final_loss,
        "before": before,
        "after": {
            source: shortlist_metrics(model, examples, device, top_k, source)
            for source in sorted({value.source for value in examples})
        },
    }


def run_profile(profile: str, args: argparse.Namespace, device: torch.device) -> dict[str, object]:
    config = PROFILE[profile]
    champion_path = config["champion"]
    champion = load_v9(champion_path, device).eval()
    teacher_sha256 = file_sha256(champion_path)
    adviser_training, adviser_heldout, adviser_rankings, adviser_heldout_rankings = \
        disjoint_adviser_split(config["adviser"], profile, teacher_sha256)
    retention_training_all, retention_heldout_all, _, _, _, _ = load_corpora(
        [str(config["retention"])], profile, teacher_sha256,
        proposal_limit=None, value_limit=1, distill_limit=1,
        ranking_limit=args.ranking_limit, seed=args.seed)
    retention_training = collections.deque(balanced(
        [value for value in retention_training_all if value.source == "champion"],
        args.proposal_limit, args.seed))
    retention_heldout = [value for value in retention_heldout_all
                         if value.source == "champion"]
    # The architecture comparison intentionally uses external winning actors
    # and their real-oracle relative rankings, not champion self-distillation.
    train_proposals = balanced(
        adviser_training,
        args.train_proposals_per_source, args.seed)
    test_proposals = balanced(
        adviser_heldout,
        args.heldout_proposals_per_source, args.seed + 1)
    train_rankings = balanced(
        adviser_rankings,
        args.train_rankings_per_source, args.seed + 2,
        source=lambda value: value.proposal.source)
    test_rankings = balanced(
        adviser_heldout_rankings, args.heldout_rankings_per_source, args.seed + 3,
        source=lambda value: value.proposal.source)
    if not min(len(train_proposals), len(test_proposals), len(train_rankings), len(test_rankings)):
        raise RuntimeError(f"{profile} fixed corpus lacks a diagnostic split")

    proposal_batch = train_proposals[:min(64, len(train_proposals))]
    ranking_batch = train_rankings[:min(8, len(train_rankings))]
    inputs = set_elapsed(encode_states(
        [value.state for value in proposal_batch], champion.shape.extent, device),
        [value.elapsed for value in proposal_batch], champion.shape.extent)
    behavior = torch.tensor([value.behavior for value in proposal_batch], device=device)
    policy, branches = champion.forward_proposal(inputs, behavior)
    policy_loss = proposal_objective(
        policy, branches, proposal_batch, device,
        shortlist_k=config["top_k"], branch_weight=0)
    value_loss = ranking_loss(champion, ranking_batch, device)
    gradient_conflict = gradient_comparison(
        gradients(policy_loss, champion), gradients(value_loss, champion))

    branch_auxiliary = branch_auxiliary_ablation(
        champion_path, champion, list(retention_training), retention_heldout,
        args, device, config["top_k"])

    designs = {
        "shared": 0,
        "partial": args.partial_blocks or config["separate_blocks"],
        "headIsolated": champion.shape.blocks,
    }
    if designs["partial"] >= champion.shape.blocks:
        raise RuntimeError("--partial-blocks must leave at least one shared block")
    ablations = {}
    for name, separated in designs.items():
        model: nn.Module
        if separated == 0:
            model = load_v9(champion_path, device)
        else:
            model = RoutedV9Net(champion, separated).to(device)
            verify_clone(champion, model, test_proposals, test_rankings, device)
        before = model_metrics(model, test_proposals, test_rankings, device, config["top_k"])
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0)
        train_updates(
            model, optimizer, collections.deque(train_proposals), collections.deque(),
            collections.deque(), collections.deque(train_rankings),
            args.updates, args.batch_size, device, random.Random(args.seed),
            distill_weight=0, value_sampling="uniform", proposal_weight=1,
            proposal_margin_weight=0.25, proposal_anchor_weight=0,
            proposal_shortlist_k=config["top_k"], mc_value_weight=0,
            mc_value_loss_weights=(1, 1, 1), distill_value_loss_weights=(1, 1, 1),
            ranking_weight=args.ranking_weight,
            ranking_batch_size=args.ranking_batch_size,
            fixed_source_fraction=0.5, self_source_fraction=0,
            fixed_source_pass_fraction=0.05, proposal_branch_weight=0)
        ablations[name] = {
            "cost": deployed_cost(champion.shape, separated),
            "before": before,
            "afterTrain": model_metrics(
                model, train_proposals, train_rankings, device, config["top_k"]),
            "afterHeldout": model_metrics(
                model, test_proposals, test_rankings, device, config["top_k"]),
        }

    return {
        "profile": profile,
        "champion": str(champion_path),
        "fixedCorpus": list(dict.fromkeys((str(config["retention"]), str(config["adviser"])))),
        "splitContract": "joint connected components of shared f32 neural inputs; input-disjoint",
        "fixedCorpusCounts": {
            "trainProposals": len(train_proposals), "heldoutProposals": len(test_proposals),
            "trainRankings": len(train_rankings), "heldoutRankings": len(test_rankings),
        },
        "receptiveField": receptive_field_diagnostic(champion, test_proposals[0], device),
        "pooling": {
            "binsPerAxis": 5,
            "axisBinSizes": [sum(1 for point in range(champion.shape.extent)
                                 if point * 5 // champion.shape.extent == bucket)
                             for bucket in range(5)],
            "small5IsIdentity": champion.shape.extent == 5,
            "valueAndPassOnly": True,
            "pointPolicyUsesPooling": False,
        },
        "activation": {
            "proposalTrunk": activation_diagnostics(champion, test_proposals, device),
            "valueHead": value_activation_diagnostics(champion, test_rankings, device),
        },
        "behaviorSensitivity": behavior_sensitivity(
            champion, test_proposals, test_rankings, device),
        "proposalVsRankingGradient": gradient_conflict,
        "branchAuxiliary": branch_auxiliary,
        "anchorCapacity": anchor_capacity_probe(
            champion_path, adviser_training, args, device, config["top_k"]),
        "ablations": ablations,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19", "both"), default="both")
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    result.add_argument("--seed", type=int, default=2026081401)
    result.add_argument("--updates", type=int, default=96)
    result.add_argument("--learning-rate", type=float, default=3e-5)
    result.add_argument("--batch-size", type=int, default=64)
    result.add_argument("--ranking-batch-size", type=int, default=4)
    result.add_argument("--ranking-weight", type=float, default=0.1)
    result.add_argument("--branch-updates", type=int, default=64)
    result.add_argument("--partial-blocks", type=int, default=0,
                        help="route-specific tail depth; 0 uses the profile default")
    result.add_argument("--anchor-capacity-updates", type=int, default=0)
    result.add_argument("--anchor-capacity-per-source", type=int, default=64)
    result.add_argument("--anchor-capacity-learning-rate", type=float, default=1e-4)
    result.add_argument("--proposal-limit", type=int, default=8_000)
    result.add_argument("--ranking-limit", type=int, default=1_536)
    result.add_argument("--train-proposals-per-source", type=int, default=512)
    result.add_argument("--heldout-proposals-per-source", type=int, default=256)
    result.add_argument("--train-rankings-per-source", type=int, default=256)
    result.add_argument("--heldout-rankings-per-source", type=int, default=128)
    return result


def main() -> None:
    args = parser().parse_args()
    device = auto_device(args.device)
    configure_accelerator(device)
    profiles = PROFILE if args.profile == "both" else (args.profile,)
    result = {
        "contract": {
            "readOnly": True,
            "fixedCorpus": True,
            "perRouteDepthAndWidthPreserved": True,
            "inferenceArithmeticHeldConstant": True,
            "updates": args.updates,
            "seed": args.seed,
            "device": str(device),
        },
        "profiles": [run_profile(profile, args, device) for profile in profiles],
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
