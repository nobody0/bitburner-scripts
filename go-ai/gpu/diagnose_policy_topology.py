#!/usr/bin/env python3
"""Read-only exact-KataGo policy capacity assay for a small global token mixer."""

from __future__ import annotations

import argparse
import collections
import json
import os
import pathlib
import random
import subprocess
import time

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from device import auto_device
from train_v9 import (configure_accelerator, encode_state_planes,
                      encode_tactical_state_planes, file_sha256,
                      load_corpora, load_v9, read_block, save_model, verify_cpp,
                      CERTIFIED_ACTOR_SOURCE, V9Net, V9Shape)


class GlobalPolicyNet(nn.Module):
    def __init__(self, extent: int, behavior: int, width: int, layers: int,
                 heads: int, device: torch.device, seed: int):
        super().__init__()
        torch.manual_seed(seed)
        self.extent = extent
        self.input = nn.Linear(8, width, device=device)
        self.behavior = nn.Linear(behavior, width, device=device)
        self.row = nn.Parameter(torch.empty(extent, width, device=device))
        self.column = nn.Parameter(torch.empty(extent, width, device=device))
        block = nn.TransformerEncoderLayer(
            width, heads, 2 * width, dropout=0, activation="gelu",
            batch_first=True, norm_first=True, device=device)
        self.blocks = nn.TransformerEncoder(block, layers)
        self.policy = nn.Linear(width, 1, device=device)
        self.pass_policy = nn.Linear(width, 1, device=device)
        nn.init.normal_(self.row, std=width ** -0.5)
        nn.init.normal_(self.column, std=width ** -0.5)

    def forward(self, state: Tensor, behavior: Tensor) -> Tensor:
        batch = state.shape[0]
        token = state.permute(0, 2, 3, 1).reshape(batch, self.extent ** 2, 8)
        position = (self.row[:, None, :] + self.column[None, :, :]).reshape(
            self.extent ** 2, -1)
        token = self.input(token) + self.behavior(behavior)[:, None, :] + position[None, :, :]
        token = self.blocks(token)
        point = self.policy(token).squeeze(-1)
        passed = self.pass_policy(token.mean(dim=1))
        return torch.cat((point, passed), dim=1)


class HybridGlobalPolicyNet(nn.Module):
    """Small local trunk plus a low-rank whole-board correction per move."""
    def __init__(self, extent: int, behavior: int, width: int, layers: int,
                 rank: int, device: torch.device, seed: int, input_channels: int = 8,
                 conditional_rank: int = 0):
        super().__init__()
        torch.manual_seed(seed)
        self.extent = extent
        self.input_channels = input_channels
        self.stem = nn.Conv2d(input_channels, width, 3, padding=1, device=device)
        self.first = nn.ModuleList([
            nn.Conv2d(width, width, 3, padding=1, device=device) for _ in range(layers)])
        self.second = nn.ModuleList([
            nn.Conv2d(width, width, 3, padding=1, device=device) for _ in range(layers)])
        self.condition = nn.ModuleList([
            nn.Linear(behavior, width, device=device) for _ in range(layers)])
        self.local_policy = nn.Conv2d(width, 1, 1, device=device)
        pooled = width * 25
        self.global_rank = rank
        self.global_context = nn.Linear(pooled, rank, device=device) if rank else None
        self.global_policy = nn.Linear(rank, extent * extent, device=device) if rank else None
        self.pass_policy = nn.Linear(pooled, 1, device=device)
        self.conditional_rank = conditional_rank
        if conditional_rank:
            self.conditional_board = nn.Linear(
                pooled, conditional_rank, bias=False, device=device)
            self.conditional_behavior = nn.Linear(
                behavior, conditional_rank, bias=False, device=device)
            self.conditional_policy = nn.Linear(
                conditional_rank, extent * extent, bias=False, device=device)
            nn.init.zeros_(self.conditional_policy.weight)

    def forward(self, state: Tensor, behavior: Tensor) -> Tensor:
        spatial = torch.tanh(self.stem(state))
        for first, second, condition in zip(
                self.first, self.second, self.condition, strict=True):
            update = second(torch.tanh(first(spatial)))
            spatial = torch.tanh(spatial + update + condition(behavior)[:, :, None, None])
        pooled = F.adaptive_avg_pool2d(spatial, (5, 5)).flatten(1)
        local = self.local_policy(spatial).flatten(1)
        global_policy = self.global_policy(torch.tanh(self.global_context(pooled))) \
            if self.global_context is not None and self.global_policy is not None \
            else torch.zeros_like(local)
        if self.conditional_rank:
            interaction = torch.tanh(self.conditional_board(pooled)) \
                * torch.tanh(self.conditional_behavior(behavior))
            global_policy = global_policy + self.conditional_policy(interaction)
        return torch.cat((local + global_policy, self.pass_policy(pooled)), dim=1)


def tensors(examples: list, extent: int, tactical: bool = False) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor, Tensor]:
    encoder = encode_tactical_state_planes if tactical else encode_state_planes
    states = torch.stack([encoder(example.state, extent) for example in examples])
    elapsed = torch.tensor([example.elapsed for example in examples], dtype=torch.float32)
    behavior = torch.tensor([example.behavior for example in examples], dtype=torch.float32)
    valid = torch.zeros((len(examples), extent ** 2 + 1), dtype=torch.bool)
    target_set = torch.zeros_like(valid)
    best = torch.empty(len(examples), dtype=torch.long)
    for row, example in enumerate(examples):
        valid[row, example.moves] = True
        targets = [example.moves[index] for index, value in enumerate(example.targets) if value > 0.5]
        target_set[row, targets] = True
        best[row] = example.best_move
    return states, elapsed, behavior, valid, target_set, best


def inject_dynamic_state_planes(states: Tensor, elapsed: Tensor, extent: int) -> Tensor:
    """Convert cached exact state fields to the float planes seen by V9.

    Keep this profile-derived: the earlier Small5 backport accidentally used
    daemon19's 722-round denominator during training while evaluation used 50.
    """
    states[:, 4].mul_(0.5)
    states[:, 5] = elapsed[:, None, None] / (2 * extent * extent)
    return states


def update_checkpoint_path(path: pathlib.Path, update: int) -> pathlib.Path:
    return path.with_name(f"{path.stem}.u{update}{path.suffix}")


def freeze_except_policy_outputs(
    model: HybridGlobalPolicyNet, *, include_global: bool,
) -> None:
    """Freeze the representation while selecting the requested policy outputs."""
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    modules: list[nn.Module] = [model.local_policy, model.pass_policy]
    if include_global:
        if model.global_context is not None:
            modules.append(model.global_context)
        if model.global_policy is not None:
            modules.append(model.global_policy)
    for module in modules:
        for parameter in module.parameters():
            parameter.requires_grad_(True)


def balanced_batch_indices(
    groups: list[Tensor], count: int, generator: torch.Generator,
) -> Tensor:
    if not groups:
        raise RuntimeError("cannot sample an empty opponent-balanced batch")
    base, remainder = divmod(count, len(groups))
    selected = []
    for index, group in enumerate(groups):
        amount = base + int(index < remainder)
        if amount:
            selected.append(group.index_select(
                0, torch.randint(len(group), (amount,), generator=generator)))
    return torch.cat(selected)


@torch.no_grad()
def initialize_hybrid_from_v9(
    model: HybridGlobalPolicyNet, path: pathlib.Path, device: torch.device,
) -> str:
    source = load_v9(path, device)
    shape = source.shape
    expected = (
        model.extent, model.stem.out_channels, len(model.first),
        model.condition[0].in_features, model.global_rank,
        model.input_channels,
    )
    actual = (
        shape.extent, shape.channels, shape.blocks, shape.behavior,
        shape.policy_rank, shape.input_channels,
    )
    expanding_global_policy = shape.policy_rank == 0 and model.global_rank > 0
    if actual != expected and not (expanding_global_policy
            and actual[:4] == expected[:4] and actual[5] == expected[5]):
        raise RuntimeError(f"incompatible hybrid initialization: {actual} != {expected}")
    model.stem.weight.copy_(source.stem)
    model.stem.bias.copy_(source.stem_bias)
    for block, (first, second, condition) in enumerate(zip(
            model.first, model.second, model.condition, strict=True)):
        first.weight.copy_(source.residual[block, 0])
        first.bias.copy_(source.residual_bias[block, 0])
        second.weight.copy_(source.residual[block, 1])
        second.bias.copy_(source.residual_bias[block, 1])
        condition.weight.copy_(source.conditioning_w[block])
        condition.bias.copy_(source.conditioning_b[block])
    model.local_policy.weight[:, :, 0, 0].copy_(source.policy_w)
    model.local_policy.bias.copy_(source.policy_b)
    if expanding_global_policy:
        # A newly attached low-rank branch must be an exact no-op at update 0.
        # Its context can remain seeded-random; zero output weights preserve the
        # incumbent logits while still allowing gradients into the branch.
        assert model.global_policy is not None
        model.global_policy.weight.zero_()
        model.global_policy.bias.zero_()
    elif model.global_context is not None and model.global_policy is not None:
        model.global_context.weight.copy_(source.global_policy_w1)
        model.global_context.bias.copy_(source.global_policy_b1)
        model.global_policy.weight.copy_(source.global_policy_w2)
        model.global_policy.bias.copy_(source.global_policy_b2)
    model.pass_policy.weight.copy_(source.pass_w)
    model.pass_policy.bias.copy_(source.pass_b)
    return file_sha256(path)


@torch.no_grad()
def evaluate(model: GlobalPolicyNet, data: tuple[Tensor, ...], device: torch.device,
             batch_size: int) -> dict[str, float]:
    states, elapsed, behavior, valid, target_set, best = data
    exact = good = total = 0
    model.eval()
    for start in range(0, len(states), batch_size):
        stop = min(start + batch_size, len(states))
        batch = states[start:stop].to(device=device, dtype=torch.float32)
        inject_dynamic_state_planes(
            batch, elapsed[start:stop].to(device), model.extent)
        logits = model(batch, behavior[start:stop].to(device))
        logits.masked_fill_(~valid[start:stop].to(device), -torch.inf)
        selected = logits.argmax(dim=1).cpu()
        exact += int((selected == best[start:stop]).sum())
        good += int(target_set[start:stop].gather(1, selected[:, None]).sum())
        total += stop - start
    return {"positions": total, "exactTop1": exact / total, "goodSetTop1": good / total}


def evaluate_by_opponent(
    model: nn.Module,
    data: tuple[Tensor, ...],
    examples: list,
    device: torch.device,
    batch_size: int,
) -> dict[str, dict[str, float]]:
    groups: dict[str, list[int]] = collections.defaultdict(list)
    for index, example in enumerate(examples):
        groups[example.opponent or "unknown"].append(index)
    result: dict[str, dict[str, float]] = {}
    for opponent, indices in sorted(groups.items()):
        selected = torch.tensor(indices, dtype=torch.long)
        subset = tuple(value.index_select(0, selected) for value in data)
        result[opponent] = evaluate(model, subset, device, batch_size)
    return result


@torch.no_grad()
def frozen_policy_targets(
    model: nn.Module, data: tuple[Tensor, ...], device: torch.device, batch_size: int,
) -> tuple[Tensor, ...]:
    """Relabel a retention set with the exact frozen warm-start decision."""
    states, elapsed, behavior, valid, target_set, best = data
    frozen_best = torch.empty_like(best)
    model.eval()
    for start in range(0, len(states), batch_size):
        stop = min(start + batch_size, len(states))
        batch = states[start:stop].to(device=device, dtype=torch.float32)
        inject_dynamic_state_planes(batch, elapsed[start:stop].to(device), model.extent)
        logits = model(batch, behavior[start:stop].to(device))
        logits.masked_fill_(~valid[start:stop].to(device), -torch.inf)
        frozen_best[start:stop] = logits.argmax(dim=1).cpu()
    frozen_set = torch.zeros_like(target_set)
    frozen_set.scatter_(1, frozen_best[:, None], True)
    return states, elapsed, behavior, valid, frozen_set, frozen_best


@torch.no_grad()
def arena(model: nn.Module, device: torch.device, environment_path: str,
          games: int, seed: int, environments: int, cpu_threads: int,
          batch_size: int, profile: str, tactical: bool = False) -> dict[str, float]:
    process = subprocess.Popen([
        environment_path, str(games), str(seed), str(environments),
        profile, str(cpu_threads), "v9",
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
       text=True, bufsize=1)
    completed = wins = rounds = 0
    score = 0.0
    episode_opponents: dict[int, int] = {}
    opponent_results: dict[int, dict[str, float]] = collections.defaultdict(
        lambda: {"games": 0, "wins": 0, "score": 0, "rounds": 0})
    started = time.perf_counter()
    model.eval()
    try:
        done = False
        while not done:
            states, events, done = read_block(process)
            for parts in events:
                if parts[0] == "R":
                    completed += 1
                    wins += int(float(parts[3]))
                    score += float(parts[4])
                    rounds += int(parts[5])
                    opponent = episode_opponents[int(parts[2])]
                    group = opponent_results[opponent]
                    group["games"] += 1
                    group["wins"] += int(float(parts[3]))
                    group["score"] += float(parts[4])
                    group["rounds"] += int(parts[5])
            if done:
                break
            actions: list[int] = []
            for state in states:
                episode_opponents[state.episode] = state.opponent
            for start in range(0, len(states), batch_size):
                group = states[start:start + batch_size]
                encoder = encode_tactical_state_planes if tactical else encode_state_planes
                inputs = torch.stack([
                    encoder(state.original, model.extent) for state in group]) \
                    .to(device=device, dtype=torch.float32)
                inject_dynamic_state_planes(inputs, torch.tensor(
                    [state.elapsed for state in group], device=device,
                    dtype=torch.float32), model.extent)
                behavior = torch.tensor(
                    [state.behavior for state in group], device=device,
                    dtype=torch.float32)
                logits = model(inputs, behavior)
                for row, state in enumerate(group):
                    actions.append(max(range(len(state.candidates)), key=lambda index:
                        (float(logits[row, state.candidates[index].move]), -index)))
            assert process.stdin is not None
            for state, action in zip(states, actions, strict=True):
                process.stdin.write(f"A\t{state.slot}\t{state.episode}\t{action}\n")
            process.stdin.write("GO\n")
            process.stdin.flush()
        if process.wait() != 0:
            raise RuntimeError(process.stderr.read() if process.stderr else "arena failed")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
    elapsed = time.perf_counter() - started
    names = ("Netburners", "Slum Snakes", "The Black Hand", "Tetrads",
             "Daedalus", "Illuminati", "World Daemon")
    per_opponent = {}
    for opponent, values in sorted(opponent_results.items()):
        games_for_opponent = values["games"]
        per_opponent[names[opponent]] = {
            "games": games_for_opponent,
            "wins": values["wins"],
            "winRate": values["wins"] / max(games_for_opponent, 1),
            "averageRounds": values["rounds"] / max(games_for_opponent, 1),
            "normalizedScorePerRound": values["score"] / max(values["rounds"], 1),
        }
    return {"games": completed, "wins": wins, "winRate": wins / max(completed, 1),
            "averageRounds": rounds / max(completed, 1),
            "normalizedScorePerRound": score / max(rounds, 1),
            "byOpponent": per_opponent,
            "elapsedSeconds": elapsed}


@torch.no_grad()
def export_hybrid(model: HybridGlobalPolicyNet, path: pathlib.Path,
                  behavior_features: int, seed: int,
                  auxiliary_source: pathlib.Path | None = None) -> None:
    """Embed the proven policy exactly in a full V9-global checkpoint."""
    if model.conditional_rank:
        raise RuntimeError("conditional policy experiments require a deployed format decision")
    source = load_v9(auxiliary_source, next(model.parameters()).device) \
        if auxiliary_source is not None else None
    target = V9Net(V9Shape(
        model.extent, model.stem.out_channels, len(model.first),
        source.shape.hidden if source is not None else 32,
        source.shape.tower if source is not None else 8,
        behavior_features, model.global_rank, model.input_channels),
        next(model.parameters()).device, seed)
    # This is an exact K=1 policy candidate. Untrained value and auxiliary
    # branch outputs must be neutral rather than arbitrary random functions.
    for parameter in (
            target.value_w1, target.value_b1, target.value_w2, target.value_b2,
            target.value_out_w, target.value_out_b, target.branch_w,
            target.branch_b, target.pass_branch_w, target.pass_branch_b):
        parameter.zero_()
    if source is not None:
        for name in (
                "value_w1", "value_b1", "value_w2", "value_b2",
                "value_out_w", "value_out_b", "branch_w", "branch_b",
                "pass_branch_w", "pass_branch_b"):
            getattr(target, name).copy_(getattr(source, name))
    target.stem.copy_(model.stem.weight)
    target.stem_bias.copy_(model.stem.bias)
    for block, (first, second, condition) in enumerate(zip(
            model.first, model.second, model.condition, strict=True)):
        target.residual[block, 0].copy_(first.weight)
        target.residual_bias[block, 0].copy_(first.bias)
        target.residual[block, 1].copy_(second.weight)
        target.residual_bias[block, 1].copy_(second.bias)
        target.conditioning_w[block].copy_(condition.weight)
        target.conditioning_b[block].copy_(condition.bias)
    target.policy_w.copy_(model.local_policy.weight[:, :, 0, 0])
    target.policy_b.copy_(model.local_policy.bias)
    if model.global_context is not None and model.global_policy is not None:
        target.global_policy_w1.copy_(model.global_context.weight)
        target.global_policy_b1.copy_(model.global_context.bias)
        target.global_policy_w2.copy_(model.global_policy.weight)
        target.global_policy_b2.copy_(model.global_policy.bias)
    target.pass_w.copy_(model.pass_policy.weight)
    target.pass_b.copy_(model.pass_policy.bias)
    save_model(target, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("small5", "daemon19"), default="daemon19")
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--teacher", required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--updates", type=int, default=2000)
    parser.add_argument("--learning-rate", type=float, default=3e-4,
                        help="AdamW step for the trained parameters; the historical "
                             "default is 3e-4, which is deliberately large for a "
                             "from-scratch capacity assay and too large for a gentle "
                             "correction of an already promoted champion")
    parser.add_argument("--proposal-limit", type=int, default=0,
                        help="bounded training reservoir; 0 retains every selected actor")
    parser.add_argument("--heldout-limit", type=int, default=0,
                        help="bounded held-out reservoir; 0 retains every selected actor")
    parser.add_argument("--balance-opponents", action="store_true",
                        help="allocate bounded exact-actor replay evenly across opponents")
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--width", type=int, default=32)
    parser.add_argument("--layers", type=int, default=3)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--global-rank", type=int, default=16)
    parser.add_argument("--conditional-rank", type=int, default=0,
                        help="experimental board x enemy-behavior policy interaction")
    parser.add_argument("--conditional-only", action="store_true",
                        help="freeze the warm-start policy and train only the interaction")
    parser.add_argument("--policy-head-only", action="store_true",
                        help="freeze the warm-start trunk and train only placement/pass policy heads")
    parser.add_argument("--policy-output-heads-only", action="store_true",
                        help="also train the pooled-global policy outputs while freezing the trunk")
    parser.add_argument("--global-only", action="store_true",
                        help="freeze a rank-zero warm start and train only a newly added global branch")
    parser.add_argument("--topology", choices=("token", "hybrid"), default="token")
    parser.add_argument("--seed", type=int, default=2026081606)
    parser.add_argument("--arena-environment")
    parser.add_argument("--arena-games", type=int, default=0)
    parser.add_argument("--arena-seed", type=int, default=2026082001)
    parser.add_argument("--arena-environments", type=int, default=32)
    parser.add_argument("--arena-cpu-threads", type=int, default=8)
    parser.add_argument("--out", help="write a full V9-global checkpoint (hybrid only)")
    parser.add_argument("--summary-out", help="write the final assay result as JSON")
    parser.add_argument("--init", help="warm-start a shape-identical V9-global policy")
    parser.add_argument("--preserve-aux-from-init", action="store_true",
                        help="copy value and branch heads unchanged into exported checkpoint")
    parser.add_argument("--checkpoint-updates", type=int, default=0,
                        help="also save immutable checkpoints every N updates; 0 disables")
    parser.add_argument("--oracle", help="C++ oracle used to verify an exported checkpoint")
    parser.add_argument("--tactical-features", action="store_true",
                        help="append exact group-liberty and candidate tactical planes")
    parser.add_argument("--target-mode", choices=("exact", "good-set", "blended"), default="exact",
                        help="imitate one KataGo root move or its full authority-valid shortlist")
    parser.add_argument("--exact-actor-source",
                        choices=("katago", "handcrafted", "self", CERTIFIED_ACTOR_SOURCE),
                        default="katago",
                        help="authority whose executed actor action is cloned")
    parser.add_argument("--ranking-as-actor-source",
                        choices=("katago", "handcrafted", "self", "counterfactual"),
                        help="train the policy on proven bestMove labels from rankings")
    parser.add_argument("--retention-actor-source",
                        choices=("katago", "handcrafted", CERTIFIED_ACTOR_SOURCE),
                        help="second exact actor authority interleaved to prevent forgetting")
    parser.add_argument("--retention-fraction", type=float, default=0.0,
                        help="fraction of every batch drawn from the retention authority")
    parser.add_argument("--retention-proposal-limit", type=int, default=0,
                        help="bounded retention reservoir; 0 retains every selected actor")
    parser.add_argument("--retention-corpus",
                        help="corpus containing retention authority; defaults to --corpus")
    parser.add_argument("--retention-target-mode", choices=("authority", "frozen-init"),
                        default="authority",
                        help="preserve the warm-start action instead of cloning retention authority")
    parser.add_argument("--good-set-mass", type=float, default=0.25,
                        help="probability mass assigned uniformly to approved moves in blended mode")
    parser.add_argument("--tensor-cache",
                        help="optional content-checked CPU tensor cache for repeated shape assays")
    args = parser.parse_args()
    if args.tactical_features and args.topology != "hybrid":
        parser.error("--tactical-features requires --topology hybrid")
    if args.checkpoint_updates < 0:
        parser.error("--checkpoint-updates must be nonnegative")
    if args.proposal_limit < 0 or args.heldout_limit < 0:
        parser.error("--proposal-limit and --heldout-limit must be nonnegative")
    if args.retention_proposal_limit < 0:
        parser.error("--retention-proposal-limit must be nonnegative")
    if not 0 <= args.retention_fraction < 1:
        parser.error("--retention-fraction must be in [0, 1)")
    if bool(args.retention_actor_source) != bool(args.retention_fraction):
        parser.error("--retention-actor-source and a positive --retention-fraction require each other")
    if args.checkpoint_updates and (not args.out or args.topology != "hybrid"):
        parser.error("--checkpoint-updates requires --out and --topology hybrid")
    if args.init and args.topology != "hybrid":
        parser.error("--init requires --topology hybrid")
    if args.conditional_rank < 0:
        parser.error("--conditional-rank must be nonnegative")
    if args.conditional_only and (not args.init or not args.conditional_rank):
        parser.error("--conditional-only requires --init and --conditional-rank")
    if args.policy_head_only and (not args.init or args.topology != "hybrid"):
        parser.error("--policy-head-only requires --init and --topology hybrid")
    if args.policy_output_heads_only and (not args.init or args.topology != "hybrid"):
        parser.error("--policy-output-heads-only requires --init and --topology hybrid")
    if args.global_only and (not args.init or args.topology != "hybrid" or not args.global_rank):
        parser.error("--global-only requires --init, --topology hybrid, and positive --global-rank")
    if sum((args.policy_head_only, args.policy_output_heads_only,
            args.conditional_only, args.global_only)) > 1:
        parser.error("policy-head and conditional-only modes are mutually exclusive")
    if args.preserve_aux_from_init and (not args.init or not args.out):
        parser.error("--preserve-aux-from-init requires --init and --out")
    if args.retention_target_mode == "frozen-init" and not args.init:
        parser.error("--retention-target-mode frozen-init requires --init")
    if args.conditional_rank and args.out:
        parser.error("conditional experiments cannot yet export a production V9 checkpoint")
    extent = 5 if args.profile == "small5" else 19
    device = auto_device(args.device)
    configure_accelerator(device)
    teacher_sha = file_sha256(pathlib.Path(args.teacher))
    training, heldout, _, _, ranking_training, ranking_heldout = load_corpora(
        [args.corpus], args.profile, teacher_sha, seed=args.seed,
        proposal_limit=args.proposal_limit or None,
        exact_actor_source=None if args.ranking_as_actor_source else args.exact_actor_source,
        heldout_proposal_limit=args.heldout_limit or None,
        balance_actor_opponents=args.balance_opponents and not args.ranking_as_actor_source,
        exact_ranking_source=args.ranking_as_actor_source)
    if args.ranking_as_actor_source:
        training = collections.deque(value.proposal for value in ranking_training)
        heldout = [value.proposal for value in ranking_heldout]
        if not training or not heldout:
            raise RuntimeError("ranking-as-actor authority has no train or held-out examples")
    retention_training = collections.deque()
    retention_heldout: list = []
    if args.retention_actor_source:
        retention_training, retention_heldout, *_ = load_corpora(
            [args.retention_corpus or args.corpus], args.profile, teacher_sha, seed=args.seed,
            proposal_limit=args.retention_proposal_limit or None,
            exact_actor_source=args.retention_actor_source)
        if not retention_training or not retention_heldout:
            raise RuntimeError("retention authority has no train or held-out examples")
    behavior_features = len(training[0].behavior)
    cache_metadata = json.dumps({
        "corpusSha256": file_sha256(pathlib.Path(args.corpus)),
        "retentionCorpusSha256": file_sha256(pathlib.Path(args.retention_corpus))
            if args.retention_corpus else None,
        "teacherSha256": teacher_sha,
        "seed": args.seed,
        "profile": args.profile,
        "exactActorSource": args.exact_actor_source,
        "rankingAsActorSource": args.ranking_as_actor_source,
        "proposalLimit": args.proposal_limit,
        "heldoutLimit": args.heldout_limit,
        "balanceOpponents": args.balance_opponents,
        "retentionActorSource": args.retention_actor_source,
        "retentionFraction": args.retention_fraction,
        "retentionProposalLimit": args.retention_proposal_limit,
        "retentionTargetMode": args.retention_target_mode,
        "conditionalRank": args.conditional_rank,
        "conditionalOnly": args.conditional_only,
        "policyHeadOnly": args.policy_head_only,
        "tacticalFeatures": args.tactical_features,
        "schema": "diagnose-policy-tensors-v1",
    }, sort_keys=True)
    cache_path = pathlib.Path(args.tensor_cache) if args.tensor_cache else None
    cached = torch.load(cache_path, map_location="cpu", weights_only=True) \
        if cache_path and cache_path.exists() else None
    if cached is not None:
        if cached.get("metadata") != cache_metadata:
            raise RuntimeError(f"stale or incompatible tensor cache: {cache_path}")
        train_data = tuple(cached[f"train{index}"] for index in range(6))
        heldout_data = tuple(cached[f"heldout{index}"] for index in range(6))
        retention_train_data = tuple(
            cached[f"retentionTrain{index}"] for index in range(6)) \
            if args.retention_actor_source else None
        retention_heldout_data = tuple(
            cached[f"retentionHeldout{index}"] for index in range(6)) \
            if args.retention_actor_source else None
    else:
        train_data = tensors(list(training), extent, args.tactical_features)
        heldout_data = tensors(heldout, extent, args.tactical_features)
        retention_train_data = tensors(
            list(retention_training), extent, args.tactical_features) \
            if args.retention_actor_source else None
        retention_heldout_data = tensors(
            retention_heldout, extent, args.tactical_features) \
            if args.retention_actor_source else None
        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"metadata": cache_metadata}
            payload.update({f"train{index}": value for index, value in enumerate(train_data)})
            payload.update({f"heldout{index}": value for index, value in enumerate(heldout_data)})
            if retention_train_data is not None and retention_heldout_data is not None:
                payload.update({f"retentionTrain{index}": value
                                for index, value in enumerate(retention_train_data)})
                payload.update({f"retentionHeldout{index}": value
                                for index, value in enumerate(retention_heldout_data)})
            temporary = cache_path.with_suffix(cache_path.suffix + f".{os.getpid()}.tmp")
            torch.save(payload, temporary)
            os.replace(temporary, cache_path)
    model = (GlobalPolicyNet(
            extent, behavior_features, args.width, args.layers, args.heads, device, args.seed)
        if args.topology == "token" else HybridGlobalPolicyNet(
            extent, behavior_features, args.width, args.layers, args.global_rank, device, args.seed,
            16 if args.tactical_features else 8, args.conditional_rank))
    init_sha256 = initialize_hybrid_from_v9(
        model, pathlib.Path(args.init), device) if args.init else None
    if args.retention_target_mode == "frozen-init":
        assert retention_train_data is not None and retention_heldout_data is not None
        retention_train_data = frozen_policy_targets(
            model, retention_train_data, device, args.batch_size)
        retention_heldout_data = frozen_policy_targets(
            model, retention_heldout_data, device, args.batch_size)
    if args.conditional_only:
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        for module in (model.conditional_board, model.conditional_behavior,
                       model.conditional_policy):
            for parameter in module.parameters():
                parameter.requires_grad_(True)
    elif args.global_only:
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        assert model.global_context is not None and model.global_policy is not None
        for module in (model.global_context, model.global_policy):
            for parameter in module.parameters():
                parameter.requires_grad_(True)
    elif args.policy_head_only:
        freeze_except_policy_outputs(model, include_global=False)
    elif args.policy_output_heads_only:
        freeze_except_policy_outputs(model, include_global=True)
    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate, weight_decay=0)
    generator = torch.Generator().manual_seed(args.seed)
    primary_opponent_groups = None
    if args.balance_opponents:
        grouped: dict[str, list[int]] = collections.defaultdict(list)
        for index, example in enumerate(training):
            grouped[example.opponent or "unknown"].append(index)
        primary_opponent_groups = [torch.tensor(indices, dtype=torch.long)
                                   for _, indices in sorted(grouped.items())]
    started = time.perf_counter()
    model.train()
    for update in range(1, args.updates + 1):
        retention_count = round(args.batch_size * args.retention_fraction)
        primary_count = args.batch_size - retention_count
        groups: list[tuple[tuple[Tensor, ...], int]] = [(train_data, primary_count)]
        if retention_count:
            assert retention_train_data is not None
            groups.append((retention_train_data, retention_count))
        selected_groups: list[tuple[tuple[Tensor, ...], Tensor]] = []
        for group_index, (data, count) in enumerate(groups):
            count = min(count, len(data[0]))
            indices = balanced_batch_indices(
                primary_opponent_groups, count, generator) \
                if group_index == 0 and primary_opponent_groups is not None \
                else torch.randint(len(data[0]), (count,), generator=generator)
            selected_groups.append((data, indices))
        selected = lambda field: torch.cat([
            data[field].index_select(0, indices)
            for data, indices in selected_groups], dim=0)
        batch = selected(0).to(device=device, dtype=torch.float32)
        inject_dynamic_state_planes(batch, selected(1).to(device), model.extent)
        behavior = selected(2).to(device)
        valid = selected(3).to(device)
        best = selected(5).to(device)
        logits = model(batch, behavior).masked_fill(~valid, -torch.inf)
        if args.target_mode != "exact":
            positives = selected(4).to(device, dtype=torch.float32)
            positives /= positives.sum(dim=1, keepdim=True).clamp_min(1)
            if args.target_mode == "blended":
                if not 0 <= args.good_set_mass <= 1:
                    raise RuntimeError("--good-set-mass must be in [0, 1]")
                positives *= args.good_set_mass
                positives.scatter_add_(
                    1, best[:, None], torch.full(
                        (len(best), 1), 1 - args.good_set_mass, device=device))
            log_probabilities = F.log_softmax(logits, dim=1)
            loss = -torch.where(positives > 0, positives * log_probabilities, 0).sum(dim=1).mean()
        else:
            loss = F.cross_entropy(logits, best)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        if update % 250 == 0 or update == args.updates:
            progress: dict[str, object] = {
                "update": update, "loss": float(loss.detach()),
                "heldout": evaluate(model, heldout_data, device, args.batch_size),
            }
            if retention_heldout_data is not None:
                progress["retentionHeldout"] = evaluate(
                    model, retention_heldout_data, device, args.batch_size)
            if args.checkpoint_updates and update % args.checkpoint_updates == 0:
                assert args.out is not None
                checkpoint = update_checkpoint_path(pathlib.Path(args.out), update)
                checkpoint.parent.mkdir(parents=True, exist_ok=True)
                assert isinstance(model, HybridGlobalPolicyNet)
                export_hybrid(model, checkpoint, behavior_features, args.seed,
                              pathlib.Path(args.init) if args.preserve_aux_from_init else None)
                progress["checkpoint"] = str(checkpoint)
                progress["checkpointSha256"] = file_sha256(checkpoint)
            print(json.dumps(progress), flush=True)
            model.train()
    result = {
        "profile": args.profile,
        "exactActorSource": args.exact_actor_source,
        "initSha256": init_sha256,
        "balanceOpponents": args.balance_opponents,
        "retentionActorSource": args.retention_actor_source,
        "retentionFraction": args.retention_fraction,
        "retentionTargetMode": args.retention_target_mode,
        "conditionalRank": args.conditional_rank, "globalOnly": args.global_only,
        "conditionalOnly": args.conditional_only,
        "policyHeadOnly": args.policy_head_only,
        "policyOutputHeadsOnly": args.policy_output_heads_only,
        "preserveAuxFromInit": args.preserve_aux_from_init,
        "topology": ("global-token-mixer-v1" if args.topology == "token"
                     else "hybrid-global-policy-v1"),
        "width": args.width, "layers": args.layers, "globalRank": args.global_rank,
        "heads": args.heads, "parameters": sum(value.numel() for value in model.parameters()),
        "tacticalFeatures": args.tactical_features,
        "targetMode": args.target_mode,
        "goodSetMass": args.good_set_mass if args.target_mode == "blended" else None,
        "updates": args.updates, "learningRate": args.learning_rate,
        "trainExamples": len(train_data[0]),
        "heldoutExamples": len(heldout_data[0]), "elapsedSeconds": time.perf_counter() - started,
        "heldout": evaluate(model, heldout_data, device, args.batch_size),
        "heldoutByOpponent": evaluate_by_opponent(
            model, heldout_data, heldout, device, args.batch_size),
        "trainOpponents": dict(collections.Counter(value.opponent for value in training)),
        "heldoutOpponents": dict(collections.Counter(value.opponent for value in heldout)),
    }
    if retention_heldout_data is not None:
        result["retentionTrainExamples"] = len(retention_training)
        result["retentionHeldoutExamples"] = len(retention_heldout)
        result["retentionHeldout"] = evaluate(
            model, retention_heldout_data, device, args.batch_size)
    if args.out:
        if not isinstance(model, HybridGlobalPolicyNet):
            raise RuntimeError("--out requires --topology hybrid")
        output = pathlib.Path(args.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        export_hybrid(model, output, behavior_features, args.seed,
                      pathlib.Path(args.init) if args.preserve_aux_from_init else None)
        result["model"] = str(output)
        result["modelSha256"] = file_sha256(output)
        if args.oracle:
            result["cppParityRelativeError"] = verify_cpp(
                load_v9(output, device), output, args.oracle, device)
    if args.arena_games:
        if not args.arena_environment:
            raise RuntimeError("--arena-games requires --arena-environment")
        result["arena"] = arena(
            model, device, args.arena_environment, args.arena_games,
            args.arena_seed, args.arena_environments, args.arena_cpu_threads,
            args.batch_size, args.profile, args.tactical_features)
    serialized = json.dumps(result, sort_keys=True)
    if args.summary_out:
        summary = pathlib.Path(args.summary_out)
        if summary.exists():
            raise RuntimeError(f"refusing to overwrite {summary}")
        summary.parent.mkdir(parents=True, exist_ok=True)
        summary.write_text(serialized + "\n")
    print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
