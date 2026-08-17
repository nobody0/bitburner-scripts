#!/usr/bin/env python3
"""Exhaustive V9 trainer.

The native sidecar enumerates every legal Black move plus pass and labels every
weighted exact White response branch. A frozen promoted value model supplies
the initial full-pipeline ordering. V9 proposal logits never prune their own
supervision corpus.
"""

from __future__ import annotations

import time

PROCESS_STARTED = time.perf_counter()

import argparse
import collections
import contextlib
import dataclasses
import gzip
import hashlib
import functools
import json
import math
import os
import pathlib
import platform
import random
import resource
import subprocess
import struct
import sys
import tempfile
from collections.abc import Callable, Iterator, Sequence

PROCESS_SELF_USAGE_STARTED = resource.getrusage(resource.RUSAGE_SELF)
PROCESS_CHILD_USAGE_STARTED = resource.getrusage(resource.RUSAGE_CHILDREN)

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from device import auto_device

GO_AI = pathlib.Path(__file__).resolve().parents[1]
BRANCHES = 13
BASE_BEHAVIOR = 30
DEPLOYMENT_BASE_K = 8
ADAPTIVE_BOUNDARY_GAP = 0.25
CORPUS_SCHEMA = "bitburner-go-exhaustive-proposals-v9.5"
OPPONENT_ORACLE = "bitburner-go-ai-v3.0.1"
REPLAY_CACHE_SCHEMA = "bitburner-go-v9-packed-replay-v7"
ENCODING_VERSION = "v9-state-planes-u8-v1"
CERTIFIED_ACTOR_SOURCE = "certified-playbook"
CERTIFIED_ACTOR_AUTHORITY = "replay-validated-and-or-certificate-v6"


def synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elif device.type == "mps":
        torch.mps.synchronize()


def configure_accelerator(device: torch.device) -> None:
    """Preserve portable FP32 semantics instead of CUDA's default TF32 convs."""
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False


class PhaseTimings:
    """Additive wall timings, with accelerator work completed at boundaries."""

    def __init__(self) -> None:
        self.seconds: collections.defaultdict[str, float] = collections.defaultdict(float)
        self.counts: collections.defaultdict[str, int] = collections.defaultdict(int)

    @contextlib.contextmanager
    def measure(self, name: str, device: torch.device | None = None) -> Iterator[None]:
        if device is not None:
            synchronize(device)
        started = time.perf_counter()
        try:
            yield
        finally:
            if device is not None:
                synchronize(device)
            self.seconds[name] += time.perf_counter() - started

    def start(self, device: torch.device | None = None) -> float:
        if device is not None:
            synchronize(device)
        return time.perf_counter()

    def finish(
        self, name: str, started: float, device: torch.device | None = None,
    ) -> None:
        if device is not None:
            synchronize(device)
        self.seconds[name] += time.perf_counter() - started

    def as_dict(self) -> dict[str, float]:
        return dict(sorted(self.seconds.items()))

    def counts_dict(self) -> dict[str, int]:
        return dict(sorted(self.counts.items()))


@dataclasses.dataclass(frozen=True)
class V9Shape:
    extent: int
    channels: int
    blocks: int
    hidden: int = 256
    tower: int = 64
    behavior: int = BASE_BEHAVIOR
    # Zero preserves the original pointwise policy head. A positive rank adds
    # a learned whole-board correction from the existing 5x5 pooled trunk.
    policy_rank: int = 0
    # The tactical-v1 input appends eight exact, rules-derived planes to the
    # original eight neural inputs. Checkpoint magic makes this explicit.
    input_channels: int = 8


class V9Net(nn.Module):
    def __init__(self, shape: V9Shape, device: torch.device, seed: int = 0):
        super().__init__()
        self.shape = shape
        torch.manual_seed(seed)
        c, b, h, t = shape.channels, shape.blocks, shape.hidden, shape.tower
        pooled = c * 25
        if shape.input_channels not in (8, 16):
            raise ValueError("V9 input channels must be 8 or tactical-v1's 16")
        self.stem = nn.Parameter(torch.empty(c, shape.input_channels, 3, 3, device=device))
        self.stem_bias = nn.Parameter(torch.zeros(c, device=device))
        self.residual = nn.Parameter(torch.empty(b, 2, c, c, 3, 3, device=device))
        self.residual_bias = nn.Parameter(torch.zeros(b, 2, c, device=device))
        self.conditioning_w = nn.Parameter(torch.empty(b, c, shape.behavior, device=device))
        self.conditioning_b = nn.Parameter(torch.zeros(b, c, device=device))
        self.value_w1 = nn.Parameter(torch.empty(h, pooled, device=device))
        self.value_b1 = nn.Parameter(torch.zeros(h, device=device))
        self.value_w2 = nn.Parameter(torch.empty(t, h, device=device))
        self.value_b2 = nn.Parameter(torch.zeros(t, device=device))
        self.value_out_w = nn.Parameter(torch.empty(3, t, device=device))
        self.value_out_b = nn.Parameter(torch.zeros(3, device=device))
        self.policy_w = nn.Parameter(torch.empty(1, c, device=device))
        self.policy_b = nn.Parameter(torch.zeros(1, device=device))
        self.global_policy_w1 = nn.Parameter(torch.empty(shape.policy_rank, pooled, device=device))
        self.global_policy_b1 = nn.Parameter(torch.zeros(shape.policy_rank, device=device))
        self.global_policy_w2 = nn.Parameter(torch.empty(
            shape.extent * shape.extent, shape.policy_rank, device=device))
        self.global_policy_b2 = nn.Parameter(torch.zeros(
            shape.extent * shape.extent, device=device))
        self.pass_w = nn.Parameter(torch.empty(1, pooled, device=device))
        self.pass_b = nn.Parameter(torch.zeros(1, device=device))
        self.branch_w = nn.Parameter(torch.empty(BRANCHES, c, device=device))
        self.branch_b = nn.Parameter(torch.zeros(BRANCHES, device=device))
        self.pass_branch_w = nn.Parameter(torch.empty(BRANCHES, pooled, device=device))
        self.pass_branch_b = nn.Parameter(torch.zeros(BRANCHES, device=device))
        nn.init.kaiming_normal_(self.stem)
        # Not kaiming_normal_: the residual parameter stacks every block and
        # both convolutions into one 6-D tensor, so PyTorch reads fan_in from
        # tensor[0][0].numel() * size(1) = 2*c*c*9 instead of the real c*9 conv
        # fan-in and initializes ~10x too small for daemon19. Match
        # GoNetworkV9::create's sqrt(2 / (channels * 9)) explicitly.
        nn.init.normal_(self.residual, std=math.sqrt(2 / (c * 9)))
        nn.init.normal_(self.conditioning_w, std=1 / math.sqrt(shape.behavior))
        for parameter, fan in (
            (self.value_w1, pooled), (self.value_w2, h), (self.value_out_w, t),
            (self.policy_w, c), (self.pass_w, pooled), (self.branch_w, c),
            (self.pass_branch_w, pooled),
        ):
            nn.init.normal_(parameter, std=math.sqrt(2 / fan))
        if shape.policy_rank:
            nn.init.normal_(self.global_policy_w1, std=math.sqrt(2 / pooled))
            nn.init.normal_(self.global_policy_w2, std=math.sqrt(2 / shape.policy_rank))
        pool = torch.zeros((25, shape.extent * shape.extent), device=device)
        counts = torch.zeros(25, device=device)
        for x in range(shape.extent):
            for y in range(shape.extent):
                index = (x * 5 // shape.extent) * 5 + y * 5 // shape.extent
                pool[index, x * shape.extent + y] = 1
                counts[index] += 1
        pool /= counts[:, None]
        self.register_buffer("pool", pool)

    def trunk(self, inputs: Tensor, behavior: Tensor) -> tuple[Tensor, Tensor]:
        spatial = torch.tanh(F.conv2d(inputs, self.stem, self.stem_bias, padding=1))
        for block in range(self.shape.blocks):
            update = torch.tanh(F.conv2d(
                spatial, self.residual[block, 0], self.residual_bias[block, 0], padding=1))
            update = F.conv2d(
                update, self.residual[block, 1], self.residual_bias[block, 1], padding=1)
            condition = F.linear(
                behavior, self.conditioning_w[block], self.conditioning_b[block])[:, :, None, None]
            spatial = torch.tanh(spatial + update + condition)
        pooled = torch.einsum("bcn,pn->bcp", spatial.flatten(2), self.pool).flatten(1)
        return spatial, pooled

    def value_head(self, pooled: Tensor) -> Tensor:
        value_hidden = torch.tanh(F.linear(pooled, self.value_w1, self.value_b1))
        value_tower = torch.tanh(F.linear(value_hidden, self.value_w2, self.value_b2))
        return F.linear(value_tower, self.value_out_w, self.value_out_b)

    def policy_head(self, spatial: Tensor, pooled: Tensor) -> Tensor:
        policy = F.conv2d(spatial, self.policy_w[:, :, None, None], self.policy_b).flatten(1)
        if self.shape.policy_rank:
            context = torch.tanh(F.linear(
                pooled, self.global_policy_w1, self.global_policy_b1))
            policy = policy + F.linear(
                context, self.global_policy_w2, self.global_policy_b2)
        return torch.cat((policy, F.linear(pooled, self.pass_w, self.pass_b)), dim=1)

    def branch_head(self, spatial: Tensor, pooled: Tensor) -> Tensor:
        branches = F.conv2d(
            spatial, self.branch_w[:, :, None, None], self.branch_b).flatten(2).transpose(1, 2)
        pass_branches = F.linear(pooled, self.pass_branch_w, self.pass_branch_b)[:, None, :]
        return torch.cat((branches, pass_branches), dim=1)

    def forward_value(self, inputs: Tensor, behavior: Tensor) -> Tensor:
        _, pooled = self.trunk(inputs, behavior)
        return self.value_head(pooled)

    def forward_policy(self, inputs: Tensor, behavior: Tensor) -> Tensor:
        spatial, pooled = self.trunk(inputs, behavior)
        return self.policy_head(spatial, pooled)

    def forward_proposal(self, inputs: Tensor, behavior: Tensor) -> tuple[Tensor, Tensor]:
        spatial, pooled = self.trunk(inputs, behavior)
        return self.policy_head(spatial, pooled), self.branch_head(spatial, pooled)

    def forward(self, inputs: Tensor, behavior: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        """Compute every checkpoint output for serialization/parity checks."""
        spatial, pooled = self.trunk(inputs, behavior)
        return (self.value_head(pooled), self.policy_head(spatial, pooled),
                self.branch_head(spatial, pooled))


VALUE_HEAD_PARAMETERS = (
    "value_w1", "value_b1", "value_w2", "value_b2", "value_out_w", "value_out_b",
)


def value_head_is_zero(model: V9Net) -> bool:
    return all(torch.count_nonzero(getattr(model, name)).item() == 0
               for name in VALUE_HEAD_PARAMETERS)


@torch.no_grad()
def reinitialize_zero_value_head(model: V9Net, seed: int) -> None:
    """Activate a deliberately policy-only checkpoint's dead value MLP."""
    if not value_head_is_zero(model):
        raise RuntimeError("refusing to reinitialize a nonzero value head")
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed ^ 0x56A19EED)
    pooled = model.shape.channels * 25
    for name, fan in (("value_w1", pooled), ("value_w2", model.shape.hidden),
                     ("value_out_w", model.shape.tower)):
        parameter = getattr(model, name)
        initialized = torch.empty(parameter.shape, dtype=torch.float32, device="cpu")
        initialized.normal_(std=math.sqrt(2 / fan), generator=generator)
        parameter.copy_(initialized.to(parameter.device))
    for name in ("value_b1", "value_b2", "value_out_b"):
        getattr(model, name).zero_()


PARAMETERS = (
    "stem", "stem_bias", "residual", "residual_bias", "conditioning_w", "conditioning_b",
    "value_w1", "value_b1", "value_w2", "value_b2", "value_out_w", "value_out_b",
    "policy_w", "policy_b", "pass_w", "pass_b", "branch_w", "branch_b",
    "pass_branch_w", "pass_branch_b",
)

GLOBAL_POLICY_PARAMETERS = (
    "global_policy_w1", "global_policy_b1", "global_policy_w2", "global_policy_b2",
)


def checkpoint_parameters(model: V9Net) -> tuple[str, ...]:
    return PARAMETERS + (GLOBAL_POLICY_PARAMETERS if model.shape.policy_rank else ())


def save_model(model: V9Net, path: pathlib.Path) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    shape = model.shape
    with temporary.open("w") as output:
        if shape.input_channels == 16:
            if not shape.policy_rank:
                raise ValueError("tactical-v1 checkpoints require the global policy head")
            output.write("bitburner-go-value-v9-tactical-global-policy-v1\n")
        else:
            output.write("bitburner-go-value-v9-global-policy-v1\n"
                         if shape.policy_rank else "bitburner-go-value-v9\n")
        dimensions = (f"{shape.extent} {shape.channels} {shape.blocks} {shape.hidden} "
                      f"{shape.tower} {shape.behavior} {BRANCHES}")
        output.write(dimensions + (f" {shape.policy_rank}" if shape.policy_rank else "") + "\n")
        for name in checkpoint_parameters(model):
            values = getattr(model, name).detach().cpu().to(torch.float64).flatten().tolist()
            output.write(str(len(values)))
            for value in values:
                output.write(f" {value:.17g}")
            output.write("\n")
    os.replace(temporary, path)


def load_v9(path: pathlib.Path, device: torch.device) -> V9Net:
    tokens = path.read_text().split()
    if not tokens or tokens[0] not in (
            "bitburner-go-value-v9", "bitburner-go-value-v9-global-policy-v1",
            "bitburner-go-value-v9-tactical-global-policy-v1"):
        raise ValueError("not a V9 checkpoint")
    global_policy = tokens[0] != "bitburner-go-value-v9"
    input_channels = 16 if tokens[0] == \
        "bitburner-go-value-v9-tactical-global-policy-v1" else 8
    extent, channels, blocks, hidden, tower, behavior, branches = map(int, tokens[1:8])
    if branches != BRANCHES:
        raise ValueError("unsupported response-branch count")
    policy_rank = int(tokens[8]) if global_policy else 0
    model = V9Net(V9Shape(
        extent, channels, blocks, hidden, tower, behavior, policy_rank, input_channels), device)
    offset = 9 if global_policy else 8
    with torch.no_grad():
        for name in checkpoint_parameters(model):
            count = int(tokens[offset])
            offset += 1
            values = torch.tensor(
                [float(value) for value in tokens[offset:offset + count]],
                dtype=torch.float32, device=device)
            offset += count
            parameter = getattr(model, name)
            if values.numel() != parameter.numel():
                raise ValueError(f"invalid {name} tensor shape")
            parameter.copy_(values.reshape(parameter.shape))
    if offset != len(tokens):
        raise ValueError("trailing V9 checkpoint data")
    return model


def load_teacher(path: pathlib.Path, device: torch.device) -> V9Net:
    with path.open() as source:
        magic = source.read(64).split(maxsplit=1)[0]
    if magic not in ("bitburner-go-value-v9", "bitburner-go-value-v9-global-policy-v1",
                     "bitburner-go-value-v9-tactical-global-policy-v1"):
        raise ValueError(f"teacher topology {magic} is not V9")
    return load_v9(path, device)


def encode_state_planes(encoded: str, extent: int) -> Tensor:
    area = extent * extent
    parts = encoded.split("|")
    if len(parts) != 5 or len(parts[0]) != area or len(parts[1]) != area:
        raise ValueError("invalid V9 state input")
    result = torch.zeros((8, extent, extent), dtype=torch.uint8)
    board = torch.frombuffer(bytearray(parts[0], "ascii"), dtype=torch.uint8) \
        .reshape(extent, extent)
    result[0] = board == ord("X")
    result[1] = board == ord("O")
    result[2] = board == ord("#")
    legal = torch.frombuffer(bytearray(parts[1], "ascii"), dtype=torch.uint8) \
        .reshape(extent, extent)
    result[3] = legal == ord("1")
    # These exact inputs are binary except pass count, which is divided by two.
    # Store twice the value so the persistent cache remains compact and exact.
    result[4].fill_(int(parts[2]))
    result[6].fill_(int(parts[3]))
    result[7].fill_(int(parts[4]))
    return result


def encode_tactical_state_planes(encoded: str, extent: int) -> Tensor:
    """Exact, binary group/candidate facts appended to the eight V9 planes.

    These are rules-derived observations, not labels: group liberties plus
    capture, self-atari, and connection facts for every legal Black point.
    """
    base = encode_state_planes(encoded, extent)
    parts = encoded.split("|")
    board = list(parts[0])
    area = extent * extent
    result = torch.zeros((16, extent, extent), dtype=torch.uint8)
    result[:8] = base

    def neighbors(point: int) -> list[int]:
        x, y = divmod(point, extent)
        adjacent: list[int] = []
        if x: adjacent.append(point - extent)
        if x + 1 < extent: adjacent.append(point + extent)
        if y: adjacent.append(point - 1)
        if y + 1 < extent: adjacent.append(point + 1)
        return adjacent

    def group(position: list[str], start: int) -> tuple[set[int], set[int]]:
        color = position[start]
        stones = {start}
        liberties: set[int] = set()
        pending = [start]
        while pending:
            point = pending.pop()
            for other in neighbors(point):
                if position[other] == ".":
                    liberties.add(other)
                elif position[other] == color and other not in stones:
                    stones.add(other)
                    pending.append(other)
        return stones, liberties

    group_at = [-1] * area
    groups: list[tuple[str, set[int], set[int]]] = []
    seen: set[int] = set()
    for point, color in enumerate(board):
        if color not in ("X", "O") or point in seen:
            continue
        stones, liberties = group(board, point)
        seen.update(stones)
        group_id = len(groups)
        groups.append((color, stones, liberties))
        for stone in stones:
            group_at[stone] = group_id
        plane = 8 if color == "X" and len(liberties) == 1 \
            else 9 if color == "X" and len(liberties) == 2 \
            else 10 if color == "O" and len(liberties) == 1 \
            else 11 if color == "O" and len(liberties) == 2 else -1
        if plane >= 0:
            for stone in stones:
                result[plane, stone // extent, stone % extent] = 1

    for point, legal in enumerate(parts[1]):
        if legal != "1":
            continue
        adjacent_friendly: set[int] = set()
        captured_groups: set[int] = set()
        for other in neighbors(point):
            if board[other] == "X":
                adjacent_friendly.add(group_at[other])
            elif board[other] == "O":
                group_id = group_at[other]
                _, _, liberties = groups[group_id]
                if liberties == {point}:
                    captured_groups.add(group_id)
        captured = set().union(*(groups[group_id][1] for group_id in captured_groups)) \
            if captured_groups else set()
        merged = {point}
        for group_id in adjacent_friendly:
            merged.update(groups[group_id][1])
        liberties: set[int] = set()
        for stone in merged:
            for other in neighbors(stone):
                if other in captured or (board[other] == "." and other not in merged):
                    liberties.add(other)
        x, y = divmod(point, extent)
        result[12, x, y] = bool(captured)
        result[13, x, y] = len(captured) >= 2
        result[14, x, y] = len(liberties) == 1
        result[15, x, y] = len(adjacent_friendly) >= 2
    return result


def decode_state_planes(values: Tensor, device: torch.device) -> Tensor:
    result = values.to(device=device, dtype=torch.float32)
    result[:, 4].mul_(0.5)
    return result


def encode_states(
    values: Sequence[str], extent: int, device: torch.device, input_channels: int = 8,
) -> Tensor:
    """Encode on CPU and perform one bulk host-to-device transfer per batch."""
    if input_channels not in (8, 16):
        raise ValueError("unsupported V9 input channel count")
    if not values:
        return torch.empty(
            (0, input_channels, extent, extent), dtype=torch.float32, device=device)
    encoder = encode_tactical_state_planes if input_channels == 16 else encode_state_planes
    return decode_state_planes(
        torch.stack([encoder(encoded, extent) for encoded in values]), device)


def set_elapsed(inputs: Tensor, elapsed: list[int], extent: int) -> Tensor:
    inputs[:, 5] = torch.tensor(elapsed, dtype=torch.float32, device=inputs.device)[:, None, None] \
        / max(2 * extent * extent, 1)
    return inputs


def post_reply_behavior(
    values: list[list[float]],
    extent: int,
    features: int,
    device: torch.device,
) -> Tensor:
    """Materialize already-contextualized post-reply behavior vectors.

    Producers must supply the stable future-policy encoding: unknown rolls are
    -1 while opponent tendencies remain present. Silently zeroing or consuming
    an exact current-turn signature here would make training disagree with
    deployment.
    """
    del extent
    if any(len(value) != features for value in values):
        raise ValueError("post-reply behavior feature mismatch")
    return torch.tensor(values, dtype=torch.float32, device=device)


@dataclasses.dataclass
class Reply:
    probability: float
    branch: int
    state: str
    terminal_win: float | None
    terminal_score: float | None


@dataclasses.dataclass
class Candidate:
    move: int
    in_heuristic_shortlist: bool
    replies: list[Reply]


@dataclasses.dataclass
class State:
    slot: int
    episode: int
    opponent: int
    elapsed: int
    behavior: list[float]
    future_behavior: list[float]
    original: str
    candidates: list[Candidate]


@dataclasses.dataclass
class ProposalExample:
    episode: int
    state: str
    behavior: list[float]
    elapsed: int
    moves: list[int]
    targets: list[float]
    regrets: list[float]
    branches: list[list[float]]
    best_move: int
    safe_moves: list[int]
    upside_moves: list[int]
    bait_moves: list[int]
    source: str = "champion"
    opponent: str = ""


@dataclasses.dataclass
class ValueExample:
    state: str
    behavior: list[float]
    elapsed: int
    won: float
    score: float
    remaining: float
    weight: float
    source: str = "champion"
    author: str | None = None
    blackPower: float | None = None


@dataclasses.dataclass
class DistillExample:
    state: str
    behavior: list[float]
    elapsed: int
    won: float
    score: float
    remaining: float
    weight: float
    # Numeric exhaustive reply targets are authored by the frozen champion.
    # Keep this on each value rather than relying only on the enclosing record
    # so mixed corpora cannot silently obscure label authority.
    author: str | None = None


@dataclasses.dataclass
class RankingExample:
    proposal: ProposalExample
    candidates: list[list[DistillExample]]


@dataclasses.dataclass
class Turn:
    state: str
    behavior: list[float]
    elapsed: int


class PreparedReplay:
    """Packed CPU replay shared by updates and optionally persisted by hash.

    Corpus objects remain the sampling authority, so reservoir selection and
    stratification are unchanged. This layer only replaces repeated parsing,
    mask construction, target construction, and many tiny device transfers.
    """

    def __init__(
        self,
        extent: int,
        state_keys: list[str],
        state_planes: Tensor,
        proposal_examples: list[ProposalExample],
        proposal_valid: Tensor,
        proposal_targets: Tensor,
        proposal_anchors: Tensor,
        proposal_branches: Tensor,
        proposal_behavior: Tensor,
        value_examples: list[ValueExample | DistillExample],
        value_targets: Tensor,
        value_behavior: Tensor,
    ) -> None:
        self.extent = extent
        self.state_rows = {value: index for index, value in enumerate(state_keys)}
        self.state_planes = state_planes
        # Rows are stamped onto the example objects rather than kept in an
        # id()-keyed dict. The replay deques are bounded, so online training
        # evicts prepared examples; CPython then reuses the freed address for
        # the next example of the same size class, and an id() key would pair a
        # freshly generated position with the evicted occupant's targets. A
        # stamped attribute cannot be inherited by a new object, and it does not
        # retain the corpus the way a parallel list would.
        for index, value in enumerate(proposal_examples):
            value.prepared_proposal_row = index  # type: ignore[attr-defined]
        for index, value in enumerate(value_examples):
            value.prepared_value_row = index  # type: ignore[attr-defined]
        self.proposal_valid = proposal_valid
        self.proposal_targets = proposal_targets
        self.proposal_anchors = proposal_anchors
        self.proposal_branches = proposal_branches
        self.proposal_behavior = proposal_behavior
        self.value_targets = value_targets
        self.value_behavior = value_behavior

    def inputs(
        self,
        examples: Sequence[ProposalExample | ValueExample | DistillExample],
        device: torch.device,
    ) -> Tensor:
        rows = torch.tensor(
            [self.state_rows[example.state] for example in examples], dtype=torch.long)
        result = self.state_planes.index_select(0, rows).to(torch.float32)
        result[:, 4].mul_(0.5)
        result[:, 5] = torch.tensor(
            [example.elapsed for example in examples], dtype=torch.float32)[:, None, None] \
            / max(2 * self.extent * self.extent, 1)
        return result.to(device)

    @staticmethod
    def holds_proposals(examples: Sequence[ProposalExample]) -> bool:
        return all(getattr(value, "prepared_proposal_row", None) is not None
                   for value in examples)

    @staticmethod
    def holds_values(
        examples: Sequence[ValueExample | DistillExample],
    ) -> bool:
        return all(getattr(value, "prepared_value_row", None) is not None
                   for value in examples)

    def proposal_batch(
        self,
        examples: Sequence[ProposalExample],
        device: torch.device,
        timings: PhaseTimings | None = None,
    ) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor]:
        rows = torch.tensor([value.prepared_proposal_row for value in examples])
        valid = self.proposal_valid.index_select(0, rows).to(device)
        targets = self.proposal_targets.index_select(0, rows).to(device)
        anchors = self.proposal_anchors.index_select(0, rows).to(device)
        with timings.measure("branchTensorTransfer", device) \
                if timings is not None else contextlib.nullcontext():
            branches = self.proposal_branches.index_select(0, rows).to(device)
        behavior = self.proposal_behavior.index_select(0, rows).to(device)
        return (
            valid, targets, anchors, branches, behavior,
        )

    def value_batch(
        self, examples: Sequence[ValueExample | DistillExample], device: torch.device,
    ) -> tuple[Tensor, Tensor]:
        rows = torch.tensor([value.prepared_value_row for value in examples])
        return (
            self.value_targets.index_select(0, rows).to(device),
            self.value_behavior.index_select(0, rows).to(device),
        )


def replay_metadata(
    paths: list[str], profile: str, teacher_sha256: str, shape: V9Shape,
    proposal_limit: int, value_limit: int, distill_limit: int,
    ranking_limit: int, seed: int, exact_actor_source: str | None = None,
) -> dict[str, object]:
    return {
        "cacheSchema": REPLAY_CACHE_SCHEMA,
        "corpusSha256": [file_sha256(pathlib.Path(path)) for path in paths],
        "corpusSchema": CORPUS_SCHEMA,
        "profile": profile,
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "topology": dataclasses.asdict(shape),
        "encodingVersion": ENCODING_VERSION,
        "proposalReplay": proposal_limit,
        "valueReplay": value_limit,
        "distillReplay": distill_limit,
        "rankingReplay": ranking_limit,
        "reservoirSeed": seed,
        "exactActorSource": exact_actor_source,
    }


def prepare_replay(
    proposals: Sequence[ProposalExample],
    heldout: Sequence[ProposalExample],
    values: Sequence[ValueExample],
    distill: Sequence[DistillExample],
    rankings: Sequence[RankingExample],
    shape: V9Shape,
    metadata: dict[str, object],
    cache_dir: str | None,
) -> tuple[PreparedReplay, dict[str, object]]:
    proposal_examples = list(proposals) + list(heldout)
    value_examples: list[ValueExample | DistillExample] = list(values) + list(distill)
    known = {id(value) for value in value_examples}
    for ranking in rankings:
        for candidate in ranking.candidates:
            for value in candidate:
                if id(value) not in known:
                    known.add(id(value))
                    value_examples.append(value)

    canonical = json.dumps(metadata, sort_keys=True, separators=(",", ":"))
    cache_key = hashlib.sha256(canonical.encode()).hexdigest()
    cache_path = pathlib.Path(cache_dir) / f"{cache_key}.pt" if cache_dir else None
    payload: dict[str, object] | None = None
    cache_hit = False
    if cache_path and cache_path.exists():
        payload = torch.load(cache_path, map_location="cpu", weights_only=True)
        if payload.get("metadata") != canonical:
            raise RuntimeError(f"stale or incompatible replay cache: {cache_path}")
        cache_hit = True

    if payload is None:
        state_keys = list(dict.fromkeys(
            [value.state for value in proposal_examples]
            + [value.state for value in value_examples]))
        encoder = encode_tactical_state_planes \
            if shape.input_channels == 16 else encode_state_planes
        state_planes = torch.stack([
            encoder(value, shape.extent) for value in state_keys]) \
            if state_keys else torch.empty(
                (0, shape.input_channels, shape.extent, shape.extent), dtype=torch.uint8)
        move_count = shape.extent * shape.extent + 1
        valid = torch.zeros((len(proposal_examples), move_count), dtype=torch.bool)
        targets = torch.zeros((len(proposal_examples), move_count), dtype=torch.float32)
        anchors = torch.empty(len(proposal_examples), dtype=torch.long)
        branches = torch.zeros(
            (len(proposal_examples), move_count, BRANCHES), dtype=torch.float32)
        for row, example in enumerate(proposal_examples):
            moves = torch.tensor(example.moves, dtype=torch.long)
            valid[row, moves] = True
            targets[row, moves] = torch.tensor(example.targets, dtype=torch.float32)
            anchors[row] = example.best_move
            branches[row, moves] = torch.tensor(example.branches, dtype=torch.float32)
        value_targets = torch.tensor([
            [value.won, math.log1p(value.score), math.log1p(value.remaining), value.weight]
            for value in value_examples
        ], dtype=torch.float32) if value_examples else torch.empty((0, 4))
        proposal_behavior = torch.tensor(
            [value.behavior for value in proposal_examples], dtype=torch.float32,
        ) if proposal_examples else torch.empty((0, shape.behavior))
        value_behavior = torch.tensor(
            [value.behavior for value in value_examples], dtype=torch.float32,
        ) if value_examples else torch.empty((0, shape.behavior))
        payload = {
            "metadata": canonical,
            "stateKeys": state_keys,
            "statePlanes": state_planes,
            "proposalValid": valid,
            "proposalTargets": targets,
            "proposalAnchors": anchors,
            "proposalBranches": branches,
            "proposalBehavior": proposal_behavior,
            "valueTargets": value_targets,
            "valueBehavior": value_behavior,
        }
        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            # A per-process temporary name: the cache is content addressed, so
            # concurrent runs sharing --replay-cache-dir resolve to the same key
            # and a key-derived ".tmp" would let them interleave writes into one
            # file and unlink it out from under each other.
            handle, name = tempfile.mkstemp(dir=cache_path.parent, suffix=".tmp")
            os.close(handle)
            temporary = pathlib.Path(name)
            torch.save(payload, temporary)
            try:
                os.link(temporary, cache_path)
            except FileExistsError:
                existing = torch.load(cache_path, map_location="cpu", weights_only=True)
                if existing.get("metadata") != canonical:
                    raise RuntimeError(f"replay cache collision: {cache_path}")
            finally:
                temporary.unlink(missing_ok=True)

    state_keys = payload.get("stateKeys")
    state_planes = payload.get("statePlanes")
    expected_states = list(dict.fromkeys(
        [value.state for value in proposal_examples]
        + [value.state for value in value_examples]))
    tensors = (
        payload.get("proposalValid"), payload.get("proposalTargets"),
        payload.get("proposalAnchors"), payload.get("proposalBranches"),
        payload.get("proposalBehavior"), payload.get("valueTargets"),
        payload.get("valueBehavior"),
    )
    move_count = shape.extent * shape.extent + 1
    tensor_specs = (
        ((len(proposal_examples), move_count), torch.bool),
        ((len(proposal_examples), move_count), torch.float32),
        ((len(proposal_examples),), torch.long),
        ((len(proposal_examples), move_count, BRANCHES), torch.float32),
        ((len(proposal_examples), shape.behavior), torch.float32),
        ((len(value_examples), 4), torch.float32),
        ((len(value_examples), shape.behavior), torch.float32),
    )
    incompatible_tensors = any(
        not isinstance(value, Tensor)
        or tuple(value.shape) != expected_shape
        or value.dtype != expected_dtype
        for value, (expected_shape, expected_dtype) in zip(
            tensors, tensor_specs, strict=True)
    )
    if state_keys != expected_states or not isinstance(state_planes, Tensor) \
            or state_planes.dtype != torch.uint8 \
            or tuple(state_planes.shape) != (
                len(expected_states), shape.input_channels,
                shape.extent, shape.extent) \
            or incompatible_tensors:
        raise RuntimeError(f"stale or incompatible replay cache payload: {cache_path}")
    prepared = PreparedReplay(
        shape.extent, state_keys, state_planes, proposal_examples,
        tensors[0], tensors[1], tensors[2], tensors[3], tensors[4],
        value_examples, tensors[5], tensors[6])
    return prepared, {
        "schema": REPLAY_CACHE_SCHEMA,
        "key": cache_key,
        "path": str(cache_path) if cache_path else None,
        "hit": cache_hit,
        "states": len(state_keys),
        "proposalExamples": len(proposal_examples),
        "valueExamples": len(value_examples),
    }


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def corpus_record(
    profile: str,
    teacher_sha256: str,
    example: ProposalExample,
    distill: list[DistillExample],
) -> dict[str, object]:
    return {
        "schema": CORPUS_SCHEMA,
        "kind": "proposal",
        "profile": profile,
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "split": "heldout" if example.episode % 10 == 0 else "train",
        "example": dataclasses.asdict(example),
        "distill": [dataclasses.asdict(value) for value in distill],
    }


def trajectory_corpus_record(
    profile: str,
    teacher_sha256: str,
    episode: int,
    values: list[ValueExample],
    generation: dict[str, object] | None = None,
) -> dict[str, object]:
    record: dict[str, object] = {
        "schema": CORPUS_SCHEMA,
        "kind": "trajectory",
        "profile": profile,
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "split": "heldout" if episode % 10 == 0 else "train",
        "episode": episode,
        "values": [dataclasses.asdict(value) for value in values],
    }
    if generation is not None:
        record["generation"] = generation
    return record


def trajectory_outcome_source(action_sources: set[str]) -> str:
    """Attribute any intervened route to self rather than champion replay."""
    return "self" if "self" in action_sources else "champion"


def actor_corpus_record(
    profile: str,
    teacher_sha256: str,
    example: ProposalExample,
    action: int,
    source: str,
) -> dict[str, object]:
    if source not in ("katago", "handcrafted", "self"):
        raise RuntimeError("invalid actor corpus source")
    return {
        "schema": CORPUS_SCHEMA,
        "kind": "actor",
        "profile": profile,
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "split": "heldout" if example.episode % 10 == 0 else "train",
        "example": {
            "episode": example.episode,
            "state": example.state,
            "behavior": example.behavior,
            "elapsed": example.elapsed,
            "moves": example.moves,
            "action": action,
            "source": source,
        },
    }


def actor_proposal_example(
    episode: int,
    state: str,
    behavior: list[float],
    elapsed: int,
    moves: list[int],
    action: int | list[int],
    source: str,
    opponent: str = "",
) -> ProposalExample:
    if source not in (
            "champion", "katago", "handcrafted", "self", CERTIFIED_ACTOR_SOURCE):
        raise RuntimeError("invalid actor proposal source")
    actions = list(dict.fromkeys(action if isinstance(action, list) else [action]))
    if not moves or not actions or any(value not in moves for value in actions):
        raise RuntimeError("actor action is not legal")
    return ProposalExample(
        episode, state, behavior, elapsed, moves,
        [1.0 if move in actions else 0.0 for move in moves],
        [0.0] * len(moves), [[0.0] * BRANCHES for _ in moves],
        actions[0], actions, [], [], source, opponent)


@functools.lru_cache(maxsize=32)
def symmetry_permutation(extent: int, symmetry: int) -> tuple[int, ...]:
    if extent <= 0 or not 0 <= symmetry < 8:
        raise RuntimeError("invalid actor extent or symmetry")
    result: list[int] = []
    for value in range(extent * extent):
        x, y = divmod(value, extent)
        if symmetry >= 4:
            x = extent - 1 - x
        for _ in range(symmetry % 4):
            x, y = y, extent - 1 - x
        result.append(x * extent + y)
    return tuple(result)


def transform_actor_symmetry(example: ProposalExample, symmetry: int) -> ProposalExample:
    """Rotate/reflect a KataGo actor label without inventing an outcome.

    IPvGO boards and policy indices are column-major (x * extent + y). Pass is
    the area index and is invariant. Only actor supervision is transformed;
    RNG-sensitive opponent trajectories and their terminal values are not.
    """
    parts = example.state.split("|")
    if len(parts) != 5 or len(parts[0]) != len(parts[1]):
        raise RuntimeError("invalid actor state for symmetry augmentation")
    extent = math.isqrt(len(parts[0]))
    if extent * extent != len(parts[0]) or not 0 <= symmetry < 8:
        raise RuntimeError("invalid actor extent or symmetry")
    area = extent * extent
    permutation = symmetry_permutation(extent, symmetry)

    def point(value: int) -> int:
        return value if value == area else permutation[value]

    def plane(value: str) -> str:
        transformed = [""] * area
        for index, cell in enumerate(value):
            transformed[point(index)] = cell
        return "".join(transformed)

    return dataclasses.replace(
        example,
        state="|".join((plane(parts[0]), plane(parts[1]), *parts[2:])),
        moves=[point(value) for value in example.moves],
        best_move=point(example.best_move),
        safe_moves=[point(value) for value in example.safe_moves],
        upside_moves=[point(value) for value in example.upside_moves],
        bait_moves=[point(value) for value in example.bait_moves],
    )


@functools.lru_cache(maxsize=32)
def blocker_automorphisms(blockers: str) -> tuple[int, ...]:
    extent = math.isqrt(len(blockers))
    if extent * extent != len(blockers):
        raise RuntimeError("invalid blocker mask extent")
    result: list[int] = []
    for symmetry in range(8):
        permutation = symmetry_permutation(extent, symmetry)
        transformed = [""] * len(blockers)
        for index, cell in enumerate(blockers):
            transformed[permutation[index]] = cell
        if "".join(transformed) == blockers:
            result.append(symmetry)
    return tuple(result)


def valid_actor_symmetries(example: ProposalExample) -> list[ProposalExample]:
    """Augment only through automorphisms of this board's blocker geometry.

    Empty rectangular Go boards admit all eight D4 symmetries. The Daemon
    IPvGO board does not: rotating or reflecting its asymmetric blocker mask
    can manufacture positions that the game can never produce. Derive the
    valid subgroup from the encoded state instead of assuming a profile-wide
    symmetry contract.
    """
    parts = example.state.split("|")
    if len(parts) != 5:
        raise RuntimeError("invalid actor state for symmetry augmentation")
    blockers = "".join("#" if cell == "#" else "." for cell in parts[0])
    result = [transform_actor_symmetry(example, symmetry)
              for symmetry in blocker_automorphisms(blockers)]
    if not result:
        raise RuntimeError("actor state has no identity symmetry")
    return result


def load_corpora(
    paths: list[str],
    profile: str,
    teacher_sha256: str,
    proposal_limit: int | None = None,
    value_limit: int | None = None,
    distill_limit: int | None = None,
    ranking_limit: int | None = None,
    seed: int = 0,
    timings: PhaseTimings | None = None,
    exact_actor_source: str | None = None,
    heldout_proposal_limit: int | None = None,
    balance_actor_opponents: bool = False,
    exact_ranking_source: str | None = None,
) -> tuple[collections.deque[ProposalExample], list[ProposalExample],
           collections.deque[ValueExample],
           collections.deque[DistillExample], collections.deque[RankingExample],
           list[RankingExample]]:
    training: collections.deque[ProposalExample] = collections.deque(
        maxlen=proposal_limit)
    heldout: list[ProposalExample] = []
    if balance_actor_opponents and exact_actor_source is None:
        raise RuntimeError("opponent-balanced actor replay requires --exact-actor-source")
    if balance_actor_opponents and proposal_limit is None:
        raise RuntimeError("opponent-balanced actor replay requires a proposal limit")
    training_by_opponent: dict[str, collections.deque[ProposalExample]] = {}
    heldout_by_opponent: dict[str, collections.deque[ProposalExample]] = {}
    training_opponent_randomizers: dict[str, random.Random] = {}
    heldout_opponent_randomizers: dict[str, random.Random] = {}
    seen_training_opponents: collections.Counter[str] = collections.Counter()
    seen_heldout_opponents: collections.Counter[str] = collections.Counter()
    values: collections.deque[ValueExample] = collections.deque(maxlen=value_limit)
    distill: collections.deque[DistillExample] = collections.deque(
        maxlen=distill_limit)
    rankings: collections.deque[RankingExample] = collections.deque()
    heldout_rankings: list[RankingExample] = []
    # Relative value supervision has two qualitatively different sources:
    # exhaustive champion counterfactuals and sparse external/self actor
    # comparisons. A single reservoir lets tens of thousands of champion
    # positions silently evict nearly every adviser ranking. Reserve half the
    # configured replay for each group. Keep a full-size reservoir per group so
    # an absent source does not strand half the total capacity; final selection
    # reserves half for each source and lets the populated source borrow any
    # unused reservation.
    ranking_caps = {
        "champion": ranking_limit,
        "actor": ranking_limit,
        "counterfactual": ranking_limit,
    }
    ranking_groups: dict[str, collections.deque[RankingExample]] = {
        group: collections.deque(maxlen=cap) for group, cap in ranking_caps.items()
    }
    seen_ranking_groups = collections.Counter()
    randomizer = random.Random(seed ^ 0xBB67AE85)
    heldout_randomizer = random.Random(seed ^ 0xA54FF53A)
    value_randomizer = random.Random(seed ^ 0x3C6EF372)
    seen_training = seen_heldout = seen_values = seen_distill = seen_rankings = 0
    training_proposal_inputs: set[tuple[str, bytes, int]] = set()
    heldout_proposal_inputs: set[tuple[str, bytes, int]] = set()
    training_value_inputs: set[tuple[str, bytes, int]] = set()
    heldout_value_inputs: set[tuple[str, bytes, int]] = set()

    def input_key(value: ProposalExample | ValueExample | DistillExample) \
            -> tuple[str, bytes, int]:
        return value.state, b"".join(
            struct.pack(">f", item) for item in value.behavior), value.elapsed

    def append_ranking(value: RankingExample) -> None:
        nonlocal seen_rankings
        group = ("champion" if value.proposal.source == "champion" else
                 "counterfactual" if value.proposal.source == "counterfactual" else
                 "actor")
        seen_rankings += 1
        seen_ranking_groups[group] += 1
        reservoir_append(
            ranking_groups[group], value, seen_ranking_groups[group],
            ranking_caps[group])

    def reservoir_append(target: collections.deque, value: object,
                         seen: int, limit: int | None,
                         source: random.Random = randomizer) -> None:
        if limit is None or len(target) < limit:
            target.append(value)
            return
        replace = source.randrange(seen)
        if replace < limit:
            target[replace] = value

    def append_actor(
        value: ProposalExample,
        split: str,
    ) -> None:
        nonlocal seen_training, seen_heldout
        if split == "train":
            seen_training += 1
            if not balance_actor_opponents:
                reservoir_append(training, value, seen_training, proposal_limit)
                return
            key = value.opponent or "unknown"
            seen_training_opponents[key] += 1
            bucket = training_by_opponent.setdefault(
                key, collections.deque(maxlen=proposal_limit))
            source = training_opponent_randomizers.setdefault(
                key, random.Random(seed ^ 0x510E527F ^ sum(map(ord, key))))
            reservoir_append(
                bucket, value, seen_training_opponents[key], proposal_limit,
                source)
            return
        seen_heldout += 1
        if not balance_actor_opponents:
            reservoir_append(
                heldout, value, seen_heldout, heldout_proposal_limit,
                heldout_randomizer)
            return
        key = value.opponent or "unknown"
        seen_heldout_opponents[key] += 1
        cap = heldout_proposal_limit
        bucket = heldout_by_opponent.setdefault(key, collections.deque(maxlen=cap))
        source = heldout_opponent_randomizers.setdefault(
            key, random.Random(seed ^ 0x9B05688C ^ sum(map(ord, key))))
        reservoir_append(
            bucket, value, seen_heldout_opponents[key], cap,
            source)

    def balanced_rows(
        groups: dict[str, collections.deque[ProposalExample]],
        limit: int | None,
    ) -> list[ProposalExample]:
        values = {key: list(group) for key, group in sorted(groups.items())}
        if limit is None:
            return [value for group in values.values() for value in group]
        selected: list[ProposalExample] = []
        offset = 0
        while len(selected) < limit:
            added = False
            for group in values.values():
                if offset < len(group):
                    selected.append(group[offset])
                    added = True
                    if len(selected) == limit:
                        break
            if not added:
                break
            offset += 1
        return selected
    for raw_path in paths:
        with gzip.open(raw_path, "rt") as source:
            line_number = 0
            while True:
                started = time.perf_counter()
                line = source.readline()
                if timings is not None:
                    timings.seconds["corpusReadDecompression"] += time.perf_counter() - started
                if not line:
                    break
                line_number += 1
                started = time.perf_counter()
                record = json.loads(line)
                schema = record.get("schema")
                if schema != CORPUS_SCHEMA:
                    raise RuntimeError(f"{raw_path}:{line_number}: incompatible corpus schema")
                if record.get("profile") != profile:
                    raise RuntimeError(f"{raw_path}:{line_number}: profile mismatch")
                if record.get("teacherSha256") != teacher_sha256:
                    raise RuntimeError(f"{raw_path}:{line_number}: teacher checkpoint mismatch")
                if record.get("opponentOracle") != OPPONENT_ORACLE:
                    raise RuntimeError(f"{raw_path}:{line_number}: opponent oracle mismatch")
                kind = record.get("kind", "proposal")
                # A direct policy-distillation assay deliberately excludes
                # every other supervision path.  It answers the much smaller
                # question "can this topology clone this teacher's executed
                # action?" without champion values, handcrafted labels, or
                # candidate rankings changing the result.
                if exact_actor_source is not None and kind != "actor":
                    continue
                if kind == "actor-ranking":
                    raw = record.get("example", {})
                    ranking_source = raw.get("source")
                    if ranking_source not in ("katago", "handcrafted", "self", "counterfactual"):
                        raise RuntimeError(
                            f"{raw_path}:{line_number}: invalid actor-ranking source")
                    if exact_ranking_source is not None \
                            and ranking_source != exact_ranking_source:
                        continue
                    moves = [int(move) for move in raw.get("moves", [])]
                    best_move = int(raw.get("bestMove", -1))
                    raw_candidates = raw.get("candidates", [])
                    if not moves or best_move not in moves \
                            or len(raw_candidates) != len(moves):
                        raise RuntimeError(
                            f"{raw_path}:{line_number}: malformed actor ranking")
                    candidates = [
                        [DistillExample(**value) for value in candidate]
                        for candidate in raw_candidates
                    ]
                    if any(not candidate for candidate in candidates):
                        raise RuntimeError(
                            f"{raw_path}:{line_number}: empty actor-ranking candidate")
                    proposal = ProposalExample(
                        int(raw["episode"]), str(raw["state"]),
                        [float(value) for value in raw["behavior"]],
                        int(raw["elapsed"]), moves,
                        [1.0 if move == best_move else 0.0 for move in moves],
                        [0.0] * len(moves),
                        [[0.0] * BRANCHES for _ in moves],
                        best_move, [best_move], [], [], str(ranking_source))
                    ranking = RankingExample(proposal, candidates)
                    if record.get("split") == "train":
                        training_value_inputs.update(
                            input_key(value) for candidate in candidates for value in candidate)
                        append_ranking(ranking)
                    else:
                        heldout_value_inputs.update(
                            input_key(value) for candidate in candidates for value in candidate)
                        heldout_rankings.append(ranking)
                    if timings is not None:
                        timings.seconds["jsonObjectConstruction"] += \
                            time.perf_counter() - started
                    continue
                if kind == "trajectory":
                    if record.get("split") == "train":
                        trajectory_source = record.get("generation", {}).get(
                            "source", "champion")
                        for raw_value in record.get("values", []):
                            seen_values += 1
                            value_fields = dict(raw_value)
                            value_fields.setdefault("source", trajectory_source)
                            value_example = ValueExample(**value_fields)
                            training_value_inputs.add(input_key(value_example))
                            reservoir_append(
                                values, value_example, seen_values,
                                value_limit, value_randomizer)
                    if timings is not None:
                        timings.seconds["jsonObjectConstruction"] += \
                            time.perf_counter() - started
                    continue
                if kind == "actor":
                    raw = record.get("example", {})
                    actor_source = raw.get("source")
                    generation = record.get("generation", {})
                    if isinstance(generation, dict) \
                            and generation.get("source") == CERTIFIED_ACTOR_SOURCE:
                        if actor_source != "handcrafted" \
                                or generation.get("authority") != CERTIFIED_ACTOR_AUTHORITY \
                                or generation.get("certifiedAllWhiteOutcomesWin") is not True:
                            raise RuntimeError(
                                f"{raw_path}:{line_number}: malformed certified actor authority")
                        actor_source = CERTIFIED_ACTOR_SOURCE
                    actor_opponent = str(generation.get("opponent", "")) \
                        if isinstance(generation, dict) else ""
                    if exact_actor_source is not None \
                            and actor_source != exact_actor_source:
                        continue
                    moves = [int(move) for move in raw.get("moves", [])]
                    raw_actions = raw.get("actions")
                    action: int | list[int] = [int(value) for value in raw_actions] \
                        if isinstance(raw_actions, list) else int(raw.get("action", -1))
                    if actor_source not in (
                            "champion", "katago", "handcrafted", "self",
                            CERTIFIED_ACTOR_SOURCE):
                        raise RuntimeError(
                            f"{raw_path}:{line_number}: invalid actor source")
                    try:
                        example = actor_proposal_example(
                            int(raw["episode"]), str(raw["state"]),
                            [float(value) for value in raw["behavior"]],
                            int(raw["elapsed"]), moves, action,
                            str(actor_source), actor_opponent)
                    except RuntimeError as error:
                        raise RuntimeError(
                            f"{raw_path}:{line_number}: {error}") from error
                    if record.get("split") == "train":
                        actor_examples = valid_actor_symmetries(example) \
                            if actor_source == "katago" else [example]
                        for actor_example in actor_examples:
                            training_proposal_inputs.add(input_key(actor_example))
                            append_actor(actor_example, "train")
                    else:
                        heldout_proposal_inputs.add(input_key(example))
                        append_actor(example, "heldout")
                    if timings is not None:
                        timings.seconds["jsonObjectConstruction"] += \
                            time.perf_counter() - started
                    continue
                if kind != "proposal":
                    raise RuntimeError(f"{raw_path}:{line_number}: unknown corpus record kind")
                example = ProposalExample(**record["example"])
                if record.get("split") == "heldout":
                    heldout_proposal_inputs.add(input_key(example))
                    heldout.append(example)
                else:
                    distilled = [DistillExample(**value) for value in record["distill"]]
                    training_proposal_inputs.add(input_key(example))
                    training_value_inputs.update(input_key(value) for value in distilled)
                    seen_training += 1
                    reservoir_append(training, example, seen_training, proposal_limit)
                    if exact_ranking_source in (None, example.source):
                        append_ranking(RankingExample(
                            example, split_candidate_groups(
                                distilled, len(example.moves))))
                    for value in distilled:
                        seen_distill += 1
                        reservoir_append(distill, value,
                                         seen_distill, distill_limit)
                if timings is not None:
                    timings.seconds["jsonObjectConstruction"] += time.perf_counter() - started
    if balance_actor_opponents:
        training.extend(balanced_rows(training_by_opponent, proposal_limit))
        heldout.extend(balanced_rows(heldout_by_opponent, heldout_proposal_limit))
    if ranking_limit is None:
        rankings.extend(ranking_groups["champion"])
        rankings.extend(ranking_groups["actor"])
        rankings.extend(ranking_groups["counterfactual"])
    else:
        # Matched regret is scarce and normally appended after the large base
        # corpus. Reserve up to 10% before the champion/actor split so input
        # ordering cannot silently erase the authority we generated.
        counterfactual_count = min(
            len(ranking_groups["counterfactual"]),
            max(1, ranking_limit // 10) if ranking_groups["counterfactual"] else 0)
        remaining = ranking_limit - counterfactual_count
        champion_count = min(len(ranking_groups["champion"]), remaining // 2)
        actor_count = min(
            len(ranking_groups["actor"]), remaining - remaining // 2)
        spare = ranking_limit - champion_count - actor_count - counterfactual_count
        champion_count += min(
            spare, len(ranking_groups["champion"]) - champion_count)
        spare = ranking_limit - champion_count - actor_count - counterfactual_count
        actor_count += min(spare, len(ranking_groups["actor"]) - actor_count)
        spare = ranking_limit - champion_count - actor_count - counterfactual_count
        counterfactual_count += min(
            spare, len(ranking_groups["counterfactual"]) - counterfactual_count)
        rankings.extend(list(ranking_groups["champion"])[:champion_count])
        rankings.extend(list(ranking_groups["actor"])[:actor_count])
        rankings.extend(list(ranking_groups["counterfactual"])[:counterfactual_count])
    proposal_leakage = training_proposal_inputs & heldout_proposal_inputs
    value_leakage = training_value_inputs & heldout_value_inputs
    if proposal_leakage or value_leakage:
        raise RuntimeError(
            "corpus split leakage: "
            f"{len(proposal_leakage)} proposal inputs and "
            f"{len(value_leakage)} value inputs occur in both train and heldout")
    return training, heldout, values, distill, rankings, heldout_rankings


def split_candidate_groups(
    values: list[DistillExample], candidate_count: int,
) -> list[list[DistillExample]]:
    """Recover exhaustive per-move reply groups from their probability mass."""
    groups: list[list[DistillExample]] = []
    offset = 0
    for _ in range(candidate_count):
        group: list[DistillExample] = []
        probability = 0.0
        while offset < len(values) and probability < 1 - 1e-6:
            value = values[offset]
            offset += 1
            group.append(value)
            probability += value.weight
        if not group or abs(probability - 1) > 1e-4:
            raise RuntimeError("distillation replies do not sum to one candidate")
        groups.append(group)
    if offset != len(values):
        raise RuntimeError("distillation reply count exceeds candidate groups")
    return groups


def proposal_strata(
    examples: list[ProposalExample], pass_move: int,
) -> tuple[list[ProposalExample], list[ProposalExample], list[ProposalExample]]:
    def is_pass_target(example: ProposalExample) -> bool:
        return pass_move in example.safe_moves or pass_move in example.upside_moves

    return (
        [example for example in examples if is_pass_target(example)],
        [example for example in examples
         if not is_pass_target(example) and example.bait_moves],
        [example for example in examples
         if not is_pass_target(example) and not example.bait_moves],
    )


def stochastic_round(value: float, randomizer: random.Random) -> int:
    """Round a nonnegative quota without systematically inflating sparse strata."""
    whole = math.floor(value)
    fraction = value - whole
    return whole if fraction <= 0 else whole + int(randomizer.random() < fraction)


def reserved_source_quotas(
    count: int,
    buckets: Sequence[Sequence[object]],
    fractions: Sequence[float],
    randomizer: random.Random,
) -> list[int]:
    """Realize per-source fractions in expectation, including tiny batches.

    Giving every nonempty source at least one row made a two-position ranking
    batch 100% fixed-teacher data at the nominal 25% + 25% configuration. Use
    dependent stochastic rounding so the configured fractions remain the
    long-run proportions while every individual batch still has exactly the
    requested size.
    """
    raw = [count * fraction if bucket and fraction > 0 else 0.0
           for bucket, fraction in zip(buckets, fractions, strict=True)]
    # One random offset through the cumulative quotas is systematic dependent
    # rounding: every source retains E[quota] = count*fraction, their sum is
    # either floor or ceil of the requested reserved mass, and it never exceeds
    # the batch when the validated fractions sum to at most one.
    offset = randomizer.random()
    cumulative = 0.0
    quotas: list[int] = []
    for value in raw:
        before = math.floor(cumulative + offset)
        cumulative += value
        quotas.append(math.floor(cumulative + offset) - before)
    return quotas


def proposal_source_strata(
    examples: list[ProposalExample],
) -> tuple[list[ProposalExample], list[ProposalExample],
           list[ProposalExample], list[ProposalExample]]:
    return (
        [example for example in examples if example.source == "katago"],
        [example for example in examples
         if example.source in ("handcrafted", CERTIFIED_ACTOR_SOURCE)],
        [example for example in examples if example.source == "self"],
        [example for example in examples
         if example.source not in (
             "katago", "handcrafted", CERTIFIED_ACTOR_SOURCE, "self")],
    )


def proposal_source_pass_strata(
    source_strata: tuple[list[ProposalExample], list[ProposalExample],
                         list[ProposalExample], list[ProposalExample]],
    pass_move: int,
) -> tuple[tuple[list[ProposalExample], list[ProposalExample]], ...]:
    return tuple((
        [example for example in bucket
         if pass_move in example.safe_moves or pass_move in example.upside_moves],
        [example for example in bucket
         if pass_move not in example.safe_moves and pass_move not in example.upside_moves],
    ) for bucket in source_strata)


def proposal_source_opening_strata(
    source_pass_strata: tuple[
        tuple[list[ProposalExample], list[ProposalExample]], ...
    ],
) -> tuple[tuple[list[ProposalExample], list[ProposalExample]], ...]:
    """Split non-pass source rows into route entrances and later states."""
    return tuple((
        [example for example in nonpass if example.elapsed == 0],
        [example for example in nonpass if example.elapsed != 0],
    ) for _, nonpass in source_pass_strata)


def stratified_proposals(
    examples: list[ProposalExample],
    count: int,
    pass_move: int,
    randomizer: random.Random,
    strata: tuple[list[ProposalExample], list[ProposalExample],
                  list[ProposalExample]] | None = None,
    source_strata: tuple[list[ProposalExample], list[ProposalExample],
                         list[ProposalExample], list[ProposalExample]] | None = None,
    fixed_source_fraction: float = 0.25,
    self_source_fraction: float = 0.25,
    fixed_source_pass_fraction: float = 0.05,
    source_pass_strata: tuple[
        tuple[list[ProposalExample], list[ProposalExample]], ...
    ] | None = None,
    fixed_source_opening_fraction: float = 0,
    source_opening_strata: tuple[
        tuple[list[ProposalExample], list[ProposalExample]], ...
    ] | None = None,
) -> list[ProposalExample]:
    requested = count
    if source_strata is None:
        source_strata = proposal_source_strata(examples)
    if source_pass_strata is None:
        source_pass_strata = proposal_source_pass_strata(source_strata, pass_move)
    if source_opening_strata is None:
        source_opening_strata = proposal_source_opening_strata(source_pass_strata)
    katago, handcrafted, self_play, ordinary_sources = source_strata
    selected: list[ProposalExample] = []
    source_buckets = (katago, handcrafted, self_play)
    source_fractions = (
        fixed_source_fraction, fixed_source_fraction, self_source_fraction)
    quotas = reserved_source_quotas(
        requested, source_buckets, source_fractions, randomizer)
    for bucket, quota, (pass_positive, nonpass), (opening, nonopening) in zip(
            source_buckets, quotas, source_pass_strata[:3],
            source_opening_strata[:3], strict=True):
        if bucket and quota > 0 and len(selected) < requested:
            quota = min(quota, requested - len(selected))
            # Pass is a normal actor target but is sparse inside each fixed
            # teacher. Source balancing alone let thousands of non-pass rows
            # drive its global logit out of every shortlist: daemon fixed-source
            # pass recall collapsed to ~0 while total source recall improved.
            # Reserve a small, explicit share without changing the source's
            # total batch quota. A 25% hidden constant preserved pass at first,
            # but drove fixed-teacher pass recall toward 100% despite pass being
            # only about 3% of those held-out positions. Five percent supplies
            # reliable gradients without making pass the dominant teacher
            # action. The CLI exposes this as a calibration parameter.
            opening_count, pass_count = reserved_source_quotas(
                quota, (opening, pass_positive),
                (fixed_source_opening_fraction, fixed_source_pass_fraction),
                randomizer)
            selected.extend(randomizer.choices(opening, k=opening_count))
            selected.extend(randomizer.choices(pass_positive, k=pass_count))
            selected.extend(randomizer.choices(
                nonopening or nonpass or bucket,
                k=quota - opening_count - pass_count))
    remaining = requested - len(selected)
    if remaining <= 0:
        randomizer.shuffle(selected)
        return selected[:requested]
    examples = ordinary_sources or examples
    if strata is None:
        pass_best, bait, ordinary = proposal_strata(examples, pass_move)
    else:
        pass_best, bait, ordinary = tuple(
            [example for example in bucket
             if example.source not in ("katago", "handcrafted", "self")]
            for bucket in strata)
    for bucket in (pass_best, bait):
        if bucket and len(selected) < requested:
            selected.extend(randomizer.choices(
                bucket, k=min(max(1, remaining // 4), requested - len(selected))))
    selected.extend(randomizer.choices(
        ordinary or examples, k=max(requested - len(selected), 0)))
    randomizer.shuffle(selected)
    return selected[:requested]


def stratified_values(
    examples: list[ValueExample],
    count: int,
    randomizer: random.Random,
    sampling: str,
    strata: tuple[list[ValueExample], list[ValueExample]] | None = None,
    source_strata: tuple[list[ValueExample], list[ValueExample],
                         list[ValueExample], list[ValueExample]] | None = None,
    fixed_source_fraction: float = 0.25,
    self_source_fraction: float = 0.25,
) -> list[ValueExample]:
    requested = count
    if source_strata is None:
        source_strata = (
            [example for example in examples if example.source == "katago"],
            [example for example in examples if example.source == "handcrafted"],
            [example for example in examples if example.source == "self"],
            [example for example in examples
             if example.source not in ("katago", "handcrafted", "self")],
        )
    katago, handcrafted, self_play, champion = source_strata
    selected: list[ValueExample] = []
    source_buckets = (katago, handcrafted, self_play)
    quotas = reserved_source_quotas(
        requested, source_buckets,
        (fixed_source_fraction, fixed_source_fraction, self_source_fraction),
        randomizer)
    for bucket, quota in zip(source_buckets, quotas, strict=True):
        if bucket and quota > 0 and len(selected) < requested:
            selected.extend(randomizer.choices(
                bucket, k=min(quota, requested - len(selected))))
    count = requested - len(selected)
    if count <= 0:
        randomizer.shuffle(selected)
        return selected[:requested]
    examples = champion or examples
    if sampling == "uniform":
        selected.extend(randomizer.choices(examples, k=count))
        randomizer.shuffle(selected)
        return selected
    if strata is None:
        wins = [example for example in examples if example.won >= 0.5]
        losses = [example for example in examples if example.won < 0.5]
    else:
        wins, losses = (
            [example for example in bucket
             if example.source not in ("katago", "handcrafted", "self")]
            for bucket in strata)
    if not wins or not losses:
        selected.extend(randomizer.choices(examples, k=count))
        randomizer.shuffle(selected)
        return selected
    loss_count = 3 * count // 4 if sampling == "failure" else count // 2
    selected.extend(randomizer.choices(losses, k=loss_count))
    selected.extend(randomizer.choices(wins, k=count - loss_count))
    randomizer.shuffle(selected)
    return selected


def stratified_rankings(
    examples: list[RankingExample],
    count: int,
    randomizer: random.Random,
    source_strata: tuple[list[RankingExample], list[RankingExample],
                         list[RankingExample], list[RankingExample]] | None = None,
    fixed_source_fraction: float = 0.25,
    self_source_fraction: float = 0.25,
) -> list[RankingExample]:
    requested = count
    if source_strata is None:
        source_strata = (
            [example for example in examples if example.proposal.source == "katago"],
            [example for example in examples if example.proposal.source == "handcrafted"],
            [example for example in examples if example.proposal.source == "self"],
            [example for example in examples
             if example.proposal.source not in ("katago", "handcrafted", "self")],
        )
    katago, handcrafted, self_play, champion = source_strata
    selected: list[RankingExample] = []
    source_buckets = (katago, handcrafted, self_play)
    quotas = reserved_source_quotas(
        requested, source_buckets,
        (fixed_source_fraction, fixed_source_fraction, self_source_fraction),
        randomizer)
    for bucket, quota in zip(source_buckets, quotas, strict=True):
        if bucket and quota > 0 and len(selected) < requested:
            selected.extend(randomizer.choices(
                bucket, k=min(quota, requested - len(selected))))
    fallback = champion or examples
    selected.extend(randomizer.choices(
        fallback, k=max(requested - len(selected), 0)))
    randomizer.shuffle(selected)
    return selected[:requested]


def target_exploration_actions(
    actions: list[int],
    examples: list[ProposalExample],
    fraction: float,
    randomizer: random.Random,
    broad_fraction: float = 0,
    broad_pool: int = 0,
) -> list[int]:
    """Explore exhaustive candidates without consulting the learned shortlist.

    Ordinary exploration stays inside the four safe/upside targets. A small
    broad fraction instead samples a non-target from the teacher's lowest-
    regret exhaustive pool. This expands outcome coverage without turning the
    policy into uniform-random Go or letting a proposal label its own misses.
    """
    result = list(actions)
    for row, example in enumerate(examples):
        draw = randomizer.random()
        if draw < broad_fraction:
            ordered = sorted(range(len(example.moves)), key=lambda index: (
                example.regrets[index], example.moves[index]))
            pool = ordered[:min(broad_pool, len(ordered))]
            outside_targets = [index for index in pool if example.targets[index] <= 0.5]
            if outside_targets:
                result[row] = randomizer.choice(outside_targets)
            continue
        if draw >= broad_fraction + fraction:
            continue
        targets = [index for index, target in enumerate(example.targets) if target > 0.5]
        if targets:
            result[row] = randomizer.choice(targets)
    return result


def parse_candidate(text: str) -> Candidate:
    move_text, shortlist_text, replies_text = text.split("~", 2)
    replies: list[Reply] = []
    for encoded in replies_text.split("^"):
        probability, branch, state, terminal_win, terminal_score = encoded.split(",", 4)
        replies.append(Reply(
            float(probability), int(branch), state,
            None if terminal_win == "-" else float(terminal_win),
            None if terminal_score == "-" else float(terminal_score)))
    return Candidate(int(move_text), shortlist_text == "1", replies)


def read_block(
    process: subprocess.Popen[str],
    timings: PhaseTimings | None = None,
    line_callback: Callable[[str], None] | None = None,
) -> tuple[list[State], list[list[str]], bool]:
    states: list[State] = []
    events: list[list[str]] = []
    while True:
        started = time.perf_counter()
        line = process.stdout.readline() if process.stdout else ""
        if timings is not None:
            timings.seconds["sidecarReadWait"] += time.perf_counter() - started
            timings.counts["sidecarProtocolBytes"] += len(line.encode())
            timings.counts["sidecarProtocolLines"] += 1
        if line_callback is not None:
            line_callback(line)
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"V9 environment exited early: {stderr}")
        started = time.perf_counter()
        try:
            parts = line.rstrip("\n").split("\t")
            if parts[0] == "S9":
                count = int(parts[8])
                records = parts[9:]
                if len(records) != count:
                    raise RuntimeError("V9 candidate count mismatch")
                states.append(State(
                    int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]),
                    [float(value) for value in parts[5].split(",")],
                    [float(value) for value in parts[6].split(",")], parts[7],
                    [parse_candidate(record) for record in records]))
            elif parts[0] in ("T", "R"):
                events.append(parts)
            elif parts[0] == "READY":
                return states, events, False
            elif parts[0] == "DONE":
                return states, events, True
            else:
                raise RuntimeError(f"unknown V9 environment record: {parts[0]}")
        finally:
            if timings is not None:
                timings.seconds["sidecarResponseParsing"] += time.perf_counter() - started


@torch.no_grad()
def teacher_examples(
    teacher: nn.Module,
    states: list[State],
    extent: int,
    device: torch.device,
    teacher_batch: int,
    proposal_target_size: int,
    timings: PhaseTimings | None = None,
) -> tuple[list[int], list[ProposalExample], list[Turn], list[list[DistillExample]]]:
    with timings.measure("teacherWorklistPreparation") \
            if timings is not None else contextlib.nullcontext():
        reply_states = [
            reply.state for state in states
            for candidate in state.candidates for reply in candidate.replies]
        behavior_values = [
            state.future_behavior
            for state in states for candidate in state.candidates for _ in candidate.replies
        ]
        elapsed = [
            state.elapsed + 1 for state in states
            for candidate in state.candidates for _ in candidate.replies]
        if timings is not None:
            timings.counts["teacherReplyBoards"] += len(reply_states)
    decoded_chunks: list[Tensor] = []
    for start in range(0, len(reply_states), teacher_batch):
        stop = min(start + teacher_batch, len(reply_states))
        with timings.measure("teacherInputPreparation", device) \
                if timings is not None else contextlib.nullcontext():
            inputs = set_elapsed(
                encode_states(reply_states[start:stop], extent, device,
                              teacher.shape.input_channels),
                elapsed[start:stop], extent)
            behavior = post_reply_behavior(
                behavior_values[start:stop], extent, teacher.shape.behavior, device)
        with timings.measure("gpuTeacherEvaluation", device) \
                if timings is not None else contextlib.nullcontext():
            raw = teacher.forward_value(inputs, behavior)
            decoded = torch.cat((
                torch.sigmoid(raw[:, :1]),
                torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
            ), dim=1)
        with timings.measure("teacherDeviceToHost", device) \
                if timings is not None else contextlib.nullcontext():
            decoded_chunks.append(decoded.detach().cpu())
    with timings.measure("teacherLabelPreparation") \
            if timings is not None else contextlib.nullcontext():
        decoded = torch.cat(decoded_chunks)
        result = build_teacher_labels(
            states, decoded, proposal_target_size)
    return result


def build_teacher_labels(
    states: list[State],
    decoded: Tensor,
    proposal_target_size: int,
) -> tuple[list[int], list[ProposalExample], list[Turn], list[list[DistillExample]]]:
    """Build deterministic exhaustive targets from frozen teacher outputs."""
    actions: list[int] = []
    examples: list[ProposalExample] = []
    turns: list[Turn] = []
    distill_groups: list[list[DistillExample]] = []
    offset = 0
    for state in states:
        qualities: list[tuple[float, float]] = []
        reply_utilities: list[list[tuple[float, float, int]]] = []
        branch_targets: list[list[float]] = []
        distill: list[DistillExample] = []
        for candidate in state.candidates:
            win = 0.0
            score_rate = 0.0
            branches = [0.0] * BRANCHES
            candidate_replies: list[tuple[float, float, int]] = []
            for reply in candidate.replies:
                value = decoded[offset]
                offset += 1
                reply_win = float(value[0]) if reply.terminal_win is None else reply.terminal_win
                reply_score = float(value[1]) if reply.terminal_score is None \
                    else reply.terminal_score
                remaining = float(value[2]) if reply.terminal_score is None else 1.0
                reply_rate = reply_score / max(state.elapsed + remaining, 1e-6)
                win += reply.probability * reply_win
                score_rate += reply.probability * reply_rate
                # Win remains the primary objective. The score-rate term only
                # separates replies with comparable win prospects.
                candidate_replies.append((reply.probability, 8 * reply_win ** 2 + reply_rate,
                                          reply.branch))
                branches[reply.branch] += reply.probability
                distill.append(DistillExample(
                    reply.state, state.future_behavior, state.elapsed + 1,
                    reply_win, reply_score, remaining, reply.probability,
                    "champion"))
            qualities.append((win, score_rate))
            reply_utilities.append(candidate_replies)
            branch_targets.append(branches)
        order = sorted(range(len(qualities)), key=lambda index: (
            -qualities[index][0], -qualities[index][1], state.candidates[index].move))
        best = order[0]
        best_win, best_score = qualities[best]
        regrets = [max(0.0, best_win ** 2 - win ** 2) * 8
                   + max(0.0, best_score - score)
                   for win, score in qualities]
        best_move = state.candidates[best].move
        # The proposal is a *set* predictor, not a cheaper value function.
        # Reserve one safe anchor, then cover high-upside replies from distinct
        # enemy branches. Do not order or penalize positives against each other:
        # exact opponent prediction and the value head will rank the finalists.
        selected = [best]
        upside_rows: list[tuple[float, int, int]] = []
        for candidate_index, replies in enumerate(reply_utilities):
            if candidate_index == best:
                continue
            eligible = [reply for reply in replies if reply[0] >= 0.05]
            probability, utility, branch = max(eligible or replies,
                                               key=lambda reply: (reply[1], reply[0], -reply[2]))
            expected = 8 * qualities[candidate_index][0] ** 2 \
                + qualities[candidate_index][1]
            # A little expected utility breaks ties without erasing a genuine
            # 5-10% jackpot. Probability is deliberately not multiplied into
            # the upside term: that would recreate four conservative choices.
            upside_rows.append((utility + 0.25 * expected, branch, candidate_index))
        upside_rows.sort(key=lambda row: (-row[0], row[1], state.candidates[row[2]].move))
        seen_branches: set[int] = set()
        for _, branch, candidate_index in upside_rows:
            if len(selected) >= min(proposal_target_size, len(state.candidates)):
                break
            if branch in seen_branches:
                continue
            selected.append(candidate_index)
            seen_branches.add(branch)
        for _, _, candidate_index in upside_rows:
            if len(selected) >= min(proposal_target_size, len(state.candidates)):
                break
            if candidate_index not in selected:
                selected.append(candidate_index)
        selected_set = set(selected)
        targets = [1.0 if index in selected_set else 0.0
                   for index in range(len(state.candidates))]
        safe_moves = [best_move]
        upside_moves = [state.candidates[index].move for index in selected[1:]]
        bait_moves = [state.candidates[index].move for index in selected
                      if not state.candidates[index].in_heuristic_shortlist]
        examples.append(ProposalExample(
            state.episode, state.original, state.behavior, state.elapsed,
            [candidate.move for candidate in state.candidates], targets, regrets,
            branch_targets, best_move, safe_moves, upside_moves, bait_moves))
        actions.append(best)
        selected = state.candidates[best]
        # The sidecar samples one of these replies. T later identifies it; keep
        # all options temporarily by encoding them in the pending lookup.
        turns.append(Turn("^".join(reply.state for reply in selected.replies),
                          state.future_behavior, state.elapsed))
        distill_groups.append(distill)
    return actions, examples, turns, distill_groups


@torch.no_grad()
def v9_shortlist(
    logits: Tensor,
    moves: list[int],
    base_k: int,
) -> list[int]:
    """Return deployment-order candidate indices for one exact seed.

    Production starts at K=8 and doubles once when the proposal boundary is
    flatter than 0.25.  Sorting by candidate index on exact logit ties matches
    the C++/TypeScript scan order; ``torch.topk`` does not promise that tie
    behavior.
    """
    if base_k <= 0:
        raise ValueError("V9 base K must be positive")
    ranked = sorted(
        range(len(moves)),
        key=lambda candidate: (-float(logits[moves[candidate]]), candidate),
    )
    limit = min(base_k, len(ranked))
    # K=1 is an explicit policy-only request and must not reintroduce value
    # arbitration by silently adding a second finalist.
    if limit > 1 and limit < len(ranked):
        boundary = float(logits[moves[ranked[limit - 1]]]) \
            - float(logits[moves[ranked[limit]]])
        if boundary < ADAPTIVE_BOUNDARY_GAP:
            limit = min(len(ranked), limit * 2)
    return ranked[:limit]


@torch.no_grad()
def v9_actor_actions(
    model: V9Net,
    states: list[State],
    device: torch.device,
    top_k: int,
    inference_batch: int,
    win_tolerance: float = 0.0,
    proposal_only: bool = False,
    exhaustive: bool = False,
    audit: list[dict[str, object]] | None = None,
) -> list[int]:
    """Choose through exact-reply value evaluation.

    Normally only replies under the learned top K enter the value pass, which
    requires callers to validate a prior unseen recall gate. Exhaustive mode
    deliberately bypasses the policy head and values every legal candidate;
    it is slower, but can safely generate outcome trajectories from a research
    value model without letting an unqualified shortlist hide moves.
    """
    model.eval()
    policy = None
    if not exhaustive:
        original = set_elapsed(
            encode_states([state.original for state in states], model.shape.extent, device,
                          model.shape.input_channels),
            [state.elapsed for state in states], model.shape.extent)
        behavior = torch.tensor(
            [state.behavior for state in states], dtype=torch.float32, device=device)
        policy = model.forward_policy(original, behavior)
    finalists: list[list[int]] = []
    reply_records: list[tuple[int, int, Reply]] = []
    for row, state in enumerate(states):
        if exhaustive:
            local = list(range(len(state.candidates)))
        else:
            assert policy is not None
            local = v9_shortlist(
                policy[row], [candidate.move for candidate in state.candidates], top_k)
        finalists.append(local)
        for candidate_index in local:
            for reply in state.candidates[candidate_index].replies:
                if reply.terminal_win is None or reply.terminal_score is None:
                    reply_records.append((row, candidate_index, reply))

    if proposal_only:
        return [candidates[0] for candidates in finalists]

    decoded_chunks: list[Tensor] = []
    for start in range(0, len(reply_records), inference_batch):
        chunk = reply_records[start:start + inference_batch]
        inputs = set_elapsed(
            encode_states([record[2].state for record in chunk], model.shape.extent, device,
                          model.shape.input_channels),
            [states[record[0]].elapsed + 1 for record in chunk], model.shape.extent)
        chunk_behavior = post_reply_behavior(
            [states[record[0]].future_behavior for record in chunk],
            model.shape.extent, model.shape.behavior, device)
        raw = model.forward_value(inputs, chunk_behavior)
        decoded_chunks.append(torch.cat((
            torch.sigmoid(raw[:, :1]),
            torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
        ), dim=1).cpu())
    decoded = torch.cat(decoded_chunks) if decoded_chunks else torch.empty((0, 3))
    qualities: list[dict[int, tuple[float, float]]] = [dict() for _ in states]
    for row, candidates in enumerate(finalists):
        for candidate_index in candidates:
            win = score_rate = 0.0
            for reply in states[row].candidates[candidate_index].replies:
                if reply.terminal_win is None or reply.terminal_score is None:
                    continue
                win += reply.probability * reply.terminal_win
                score_rate += reply.probability * reply.terminal_score \
                    / max(states[row].elapsed + 1.0, 1e-6)
            qualities[row][candidate_index] = (win, score_rate)
    for index, (row, candidate_index, reply) in enumerate(reply_records):
        value = decoded[index]
        decoded_win, decoded_score, decoded_remaining = map(float, value)
        win = decoded_win
        score = decoded_score
        remaining = decoded_remaining
        old_win, old_rate = qualities[row].get(candidate_index, (0.0, 0.0))
        qualities[row][candidate_index] = (
            old_win + reply.probability * win,
            old_rate + reply.probability * score
                / max(states[row].elapsed + remaining, 1e-6),
        )
    actions: list[int] = []
    for row, candidates in enumerate(finalists):
        best_win = max(qualities[row][candidate][0] for candidate in candidates)
        plausible = [candidate for candidate in candidates
                     if qualities[row][candidate][0] >= best_win - win_tolerance]
        action = max(plausible, key=lambda candidate: (
            qualities[row][candidate][1], qualities[row][candidate][0], -candidate))
        actions.append(action)
        if audit is not None:
            audit.append({
                "action": states[row].candidates[action].move,
                "finalists": [states[row].candidates[candidate].move for candidate in candidates],
                "winProbability": qualities[row][action][0],
                "powerPerRound": qualities[row][action][1],
            })
    return actions


def validate_self_actor_gate(
    summary_path: str | None,
    init_path: str | None,
    profile: str,
) -> None:
    if not summary_path:
        raise RuntimeError("--self-actor-fraction requires --self-actor-summary")
    if not init_path:
        raise RuntimeError("--self-actor-fraction requires --init")
    summary = json.loads(pathlib.Path(summary_path).read_text())
    if not summary.get("shortlistDataAllowed"):
        raise RuntimeError("self actor summary did not pass the exhaustive shortlist gate")
    if summary.get("profile") != profile:
        raise RuntimeError("self actor summary profile mismatch")
    if summary.get("modelSha256") != file_sha256(pathlib.Path(init_path)):
        raise RuntimeError("self actor summary does not identify --init")


def validate_exhaustive_actor(
    summary_path: str | None,
    model_path: str | None,
    profile: str,
) -> None:
    """Require checkpoint identity/parity, deliberately not shortlist recall."""
    if not summary_path:
        raise RuntimeError(
            "--exhaustive-actor-fraction requires --exhaustive-actor-summary")
    if not model_path:
        raise RuntimeError(
            "--exhaustive-actor-fraction requires --exhaustive-actor-model")
    summary = json.loads(pathlib.Path(summary_path).read_text())
    if summary.get("profile") != profile:
        raise RuntimeError("exhaustive actor summary profile mismatch")
    if summary.get("modelSha256") != file_sha256(pathlib.Path(model_path)):
        raise RuntimeError("exhaustive actor summary does not identify its checkpoint")
    parity = summary.get("cppParityRelativeError")
    if not isinstance(parity, (int, float)) or not math.isfinite(parity) \
            or parity > 2e-4:
        raise RuntimeError("exhaustive actor summary does not prove C++ parity")


def proposal_objective(
    policy: Tensor,
    branch_logits: Tensor,
    batch: list[ProposalExample],
    device: torch.device,
    prepared: PreparedReplay | None = None,
    prepared_batch: tuple[Tensor, Tensor, Tensor, Tensor, Tensor] | None = None,
    margin_weight: float = 0.25,
    shortlist_k: int | None = None,
    anchor_weight: float = 0.5,
    branch_weight: float = 0.25,
    actor_pass_negative_weight: float = 0.05,
    actor_boundary_gradient_weight: float = 1.0,
    exact_actor_source: str | None = None,
    timings: PhaseTimings | None = None,
) -> Tensor:
    """Vectorized set-separation and branch loss without per-row MPS syncs."""
    move_count = policy.shape[1]
    if prepared_batch is not None:
        valid, targets, anchors, branch_targets, _ = prepared_batch
    elif prepared is not None and prepared.holds_proposals(batch):
        valid, targets, anchors, branch_targets, _ = prepared.proposal_batch(batch, device)
    else:
        valid_cpu = torch.zeros((len(batch), move_count), dtype=torch.bool)
        targets_cpu = torch.zeros((len(batch), move_count), dtype=torch.float32)
        anchors_cpu = torch.empty(len(batch), dtype=torch.long)
        branches_cpu = torch.zeros((len(batch), move_count, BRANCHES), dtype=torch.float32)
        for row, example in enumerate(batch):
            moves = torch.tensor(example.moves, dtype=torch.long)
            valid_cpu[row, moves] = True
            targets_cpu[row, moves] = torch.tensor(example.targets, dtype=torch.float32)
            anchors_cpu[row] = example.best_move
            branches_cpu[row, moves] = torch.tensor(example.branches, dtype=torch.float32)
        valid = valid_cpu.to(device)
        targets = targets_cpu.to(device)
        anchors = anchors_cpu.to(device)
        branch_targets = branches_cpu.to(device)
    positives = targets > 0.5
    negatives = valid & ~positives
    actor_rows = torch.tensor(
        [example.source != "champion" for example in batch],
        dtype=torch.bool, device=device)
    exact_actor_rows = torch.tensor(
        [exact_actor_source is not None and example.source == exact_actor_source
         for example in batch], dtype=torch.bool, device=device)
    champion_rows = ~actor_rows
    positive_count = positives.sum(dim=1).clamp_min(1)
    negative_count = negatives.sum(dim=1).clamp_min(1)
    positive_loss = (F.softplus(-policy) * positives).sum(dim=1) / positive_count
    negative_loss = (F.softplus(policy) * negatives).sum(dim=1) / negative_count
    # An adviser action is evidence that the move belongs in the exploration
    # shortlist, not evidence that every other teacher's move is bad. Only the
    # exhaustive champion set supplies negative board labels. Pass is the one
    # exception: it has a separate global head, so without explicit non-pass
    # adviser negatives its sparse positive examples can only push that logit
    # upward until it displaces every board move.
    pass_move = move_count - 1
    actor_nonpass = actor_rows & valid[:, pass_move] & ~positives[:, pass_move]
    actor_pass_loss = torch.where(
        actor_nonpass,
        actor_pass_negative_weight * F.softplus(policy[:, pass_move]),
        torch.zeros_like(negative_loss))
    negative_loss = torch.where(actor_rows, actor_pass_loss, negative_loss)
    # A shortlist needs one dependable anchor as well as diverse speculative
    # moves. The set loss deliberately does not order its four positives, so
    # supervise the exhaustive teacher-best move separately.
    per_row_anchor = F.cross_entropy(
        policy.masked_fill(~valid, -torch.inf), anchors, reduction="none")
    anchor_loss = (per_row_anchor * champion_rows).sum() \
        / champion_rows.sum().clamp_min(1)
    minimum_positive = policy.masked_fill(~positives, torch.inf).min(dim=1).values
    if shortlist_k is None:
        boundary_negative = policy.masked_fill(~negatives, -torch.inf).max(dim=1).values
        has_boundary = negatives.any(dim=1)
        # Sparse adviser rows can contain no negative at all. Masking a later
        # loss does not make `-inf - -inf` safe: torch.where still constructs
        # that NaN and autograd can propagate it. Replace absent boundaries
        # before applying the tunable stop-gradient interpolation.
        safe_boundary = torch.where(
            has_boundary, boundary_negative, torch.zeros_like(boundary_negative))
        actor_boundary = safe_boundary.detach() \
            + actor_boundary_gradient_weight * (
                safe_boundary - safe_boundary.detach())
        comparison_boundary = torch.where(
            actor_rows, actor_boundary, safe_boundary)
        pairwise = torch.where(
            has_boundary,
            F.softplus(0.5 - minimum_positive + comparison_boundary),
            torch.zeros_like(minimum_positive))
    else:
        # With P desired moves in a K-sized shortlist, K-P outsiders may rank
        # above the worst desired move without evicting it. Compare against the
        # next outsider, not the maximum outsider; the latter over-optimizes a
        # stricter ordering than deployment needs and fights the safe anchor.
        allowed_above = (shortlist_k - positive_count).clamp_min(0).long()
        ordered_negatives = policy.masked_fill(~negatives, -torch.inf) \
            .sort(dim=1, descending=True).values
        boundary_index = allowed_above.clamp_max(policy.shape[1] - 1)
        boundary_negative = ordered_negatives.gather(1, boundary_index[:, None])[:, 0]
        has_boundary = negative_count > allowed_above
        safe_boundary = torch.where(
            has_boundary, boundary_negative, torch.zeros_like(boundary_negative))
        actor_boundary = safe_boundary.detach() \
            + actor_boundary_gradient_weight * (
                safe_boundary - safe_boundary.detach())
        comparison_boundary = torch.where(
            actor_rows, actor_boundary, safe_boundary)
        # Set recall scores every desired move, so give every positive a
        # boundary gradient. Updating only the current minimum rotates slowly
        # between positives and plateaued well below the four-move gate.
        per_positive_margin = F.softplus(
            0.5 - policy + comparison_boundary[:, None]) * positives
        pairwise = torch.where(
            has_boundary,
            per_positive_margin.sum(dim=1) / positive_count,
            torch.zeros_like(minimum_positive))

    with timings.measure("branchLoss", device) \
            if timings is not None else contextlib.nullcontext():
        branch_labels = branch_targets.argmax(dim=2)
        branch_labels = torch.where(valid, branch_labels, torch.zeros_like(branch_labels)) \
            .clamp(0, BRANCHES - 1)
        branch_counts = torch.zeros(
            (len(batch), BRANCHES), dtype=torch.float32, device=device)
        branch_counts.scatter_add_(1, branch_labels, valid.float())
        branch_weights = branch_counts.gather(1, branch_labels).clamp_min(1).reciprocal() \
            * valid
        branch_weights /= (
            branch_weights.sum(dim=1, keepdim=True)
            / valid.sum(dim=1, keepdim=True).clamp_min(1)).clamp_min(1e-9)
        branch_cross_entropy = -(
            branch_targets * F.log_softmax(branch_logits, dim=2)).sum(dim=2)
        branch_loss = (branch_cross_entropy * branch_weights).sum(dim=1) \
            / valid.sum(dim=1).clamp_min(1)
        branch_supervised = branch_targets.sum(dim=(1, 2)) > 0
        mean_branch_loss = (branch_loss * branch_supervised).sum() \
            / branch_supervised.sum().clamp_min(1)
    per_row = positive_loss + negative_loss + margin_weight * pairwise
    # Shortlist supervision intentionally leaves non-teacher moves unknown.
    # That is not policy distillation: it cannot establish which move the
    # teacher would actually execute.  The bounded exact-actor assay replaces
    # the set objective with legal-move cross entropy for only the explicitly
    # selected source, preserving the default mixed-authority behavior.
    exact_actor_loss = F.cross_entropy(
        policy.masked_fill(~valid, -torch.inf), anchors, reduction="none")
    per_row = torch.where(exact_actor_rows, exact_actor_loss, per_row)
    return per_row.mean() \
        + anchor_weight * anchor_loss + branch_weight * mean_branch_loss


def candidate_ranking_objective(
    decoded: Tensor,
    batch: Sequence[RankingExample],
    device: torch.device,
    packed_targets: Tensor | None = None,
) -> Tensor:
    """Apply lexicographic win, then Power/turn, candidate supervision."""
    position_losses: list[Tensor] = []
    offset = 0
    for example in batch:
        candidate_wins: list[Tensor] = []
        candidate_rates: list[Tensor] = []
        teacher_wins: list[float] = []
        for candidate in example.candidates:
            rows = decoded[offset:offset + len(candidate)]
            probabilities = packed_targets[
                offset:offset + len(candidate), 3] if packed_targets is not None else torch.tensor(
                    [value.weight for value in candidate], device=device)
            offset += len(candidate)
            candidate_wins.append((probabilities * rows[:, 0]).sum())
            candidate_rates.append((
                probabilities * rows[:, 1]
                / torch.clamp(example.proposal.elapsed + rows[:, 2], min=1e-6)
            ).sum())
            teacher_wins.append(sum(value.weight * value.won for value in candidate))
        best = example.proposal.moves.index(example.proposal.best_move)
        tied = [index for index, won in enumerate(teacher_wins)
                if abs(won - teacher_wins[best]) <= 1e-5]

        # Quadratic win utility is primary, but a teacher-equal win group is a
        # genuine tie. The former one-hot loss fabricated a win difference for
        # the Power/turn winner and directly fought calibrated MC/distill values.
        win_logits = 8 * torch.stack(candidate_wins).square()
        tied_index = torch.tensor(tied, dtype=torch.long, device=device)
        primary = torch.logsumexp(win_logits, dim=0) \
            - torch.logsumexp(win_logits.index_select(0, tied_index), dim=0)
        if len(tied) > 1:
            tied_best = tied.index(best)
            efficiency = F.cross_entropy(
                (4 * torch.stack([candidate_rates[index]
                                  for index in tied]))[None, :],
                torch.tensor([tied_best], device=device))
            primary = primary + 0.25 * efficiency
        position_losses.append(primary)
    if offset != decoded.shape[0]:
        raise RuntimeError("ranking rows do not match candidate groups")
    return torch.stack(position_losses).mean()


def train_updates(
    model: V9Net,
    optimizer: torch.optim.Optimizer,
    proposals: collections.deque[ProposalExample],
    values: collections.deque[ValueExample],
    distill: collections.deque[DistillExample],
    rankings: collections.deque[RankingExample],
    updates: int,
    batch_size: int,
    device: torch.device,
    randomizer: random.Random,
    distill_weight: float,
    value_sampling: str,
    proposal_weight: float,
    proposal_margin_weight: float,
    proposal_anchor_weight: float,
    proposal_shortlist_k: int,
    mc_value_weight: float,
    mc_value_loss_weights: tuple[float, float, float],
    distill_value_loss_weights: tuple[float, float, float],
    ranking_weight: float,
    ranking_batch_size: int,
    prepared: PreparedReplay | None = None,
    fixed_source_fraction: float = 0.25,
    self_source_fraction: float = 0.25,
    fixed_source_pass_fraction: float = 0.05,
    proposal_branch_weight: float = 0.25,
    actor_pass_negative_weight: float = 0.05,
    actor_boundary_gradient_weight: float = 1.0,
    exact_actor_source: str | None = None,
    timings: PhaseTimings | None = None,
    fixed_source_opening_fraction: float = 0,
) -> tuple[float, float, float, float]:
    if updates <= 0 or (not proposals and not values and not distill and not rankings):
        return 0.0, 0.0, 0.0, 0.0
    # MPS does not implement float64 tensors. Accumulating a few thousand
    # scalar losses in float32 is ample precision and keeps this off the
    # per-update CPU synchronization path.
    loss_totals = torch.zeros(4, dtype=torch.float32, device=device)
    model.train()
    strata_started = timings.start() if timings is not None else 0.0
    proposal_values = list(proposals)
    value_values = list(values)
    distill_values = list(distill)
    ranking_values = list(rankings)
    # Replay is immutable for this update group. Building these strata inside
    # every optimizer step rescanned up to 100k/200k Python objects and starved
    # CUDA between otherwise fast kernels.
    pass_move = model.shape.extent * model.shape.extent
    cached_proposal_strata = proposal_strata(proposal_values, pass_move)
    cached_source_strata = proposal_source_strata(proposal_values)
    cached_source_pass_strata = proposal_source_pass_strata(
        cached_source_strata, pass_move)
    cached_source_opening_strata = proposal_source_opening_strata(
        cached_source_pass_strata)
    value_strata = None if value_sampling == "uniform" else (
        [example for example in value_values if example.won >= 0.5],
        [example for example in value_values if example.won < 0.5],
    )
    value_source_strata = (
        [example for example in value_values if example.source == "katago"],
        [example for example in value_values if example.source == "handcrafted"],
        [example for example in value_values if example.source == "self"],
        [example for example in value_values
         if example.source not in ("katago", "handcrafted", "self")],
    )
    ranking_source_strata = (
        [example for example in ranking_values if example.proposal.source == "katago"],
        [example for example in ranking_values if example.proposal.source == "handcrafted"],
        [example for example in ranking_values if example.proposal.source == "self"],
        [example for example in ranking_values
         if example.proposal.source not in ("katago", "handcrafted", "self")],
    )
    if timings is not None:
        timings.finish("replayStrataPreparation", strata_started)
    for _ in range(updates):
        # Each head uses an independent forward graph. Accumulate their
        # weighted gradients into one optimizer step as soon as each loss is
        # available, so CUDA need not retain four production-sized graphs at
        # once. This is the same summed objective and preserves one shared
        # clipping/step boundary.
        optimizer.zero_grad(set_to_none=True)
        proposal_loss = torch.tensor(0.0, device=device)
        if proposal_values and proposal_weight > 0:
            preparation_started = timings.start(device) if timings is not None else 0.0
            count = min(batch_size, len(proposal_values))
            batch = stratified_proposals(
                proposal_values, count, pass_move, randomizer,
                cached_proposal_strata, cached_source_strata,
                fixed_source_fraction, self_source_fraction,
                fixed_source_pass_fraction, cached_source_pass_strata,
                fixed_source_opening_fraction, cached_source_opening_strata)
            states = prepared.inputs(batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in batch) else set_elapsed(
                    encode_states([example.state for example in batch], model.shape.extent, device,
                                  model.shape.input_channels),
                    [example.elapsed for example in batch], model.shape.extent)
            prepared_proposal = prepared.proposal_batch(batch, device, timings) \
                if prepared is not None and prepared.holds_proposals(batch) else None
            behavior = prepared_proposal[4] if prepared_proposal is not None else torch.tensor(
                [example.behavior for example in batch], dtype=torch.float32, device=device)
            if timings is not None:
                timings.finish("replayBatchPreparation", preparation_started, device)
                forward_started = timings.start(device)
                spatial, pooled = model.trunk(states, behavior)
                policy = model.policy_head(spatial, pooled)
                timings.finish("proposalTrunkPolicyForward", forward_started, device)
                branch_started = timings.start(device)
                branch_logits = model.branch_head(spatial, pooled)
                timings.finish("branchHeadForward", branch_started, device)
                timings.counts["branchTargetBytes"] += (
                    prepared_proposal[3].numel() * prepared_proposal[3].element_size()
                    if prepared_proposal is not None else
                    len(batch) * policy.shape[1] * BRANCHES * 4)
                timings.counts["branchLogitBytes"] += \
                    branch_logits.numel() * branch_logits.element_size()
            else:
                policy, branch_logits = model.forward_proposal(states, behavior)
            loss_started = timings.start(device) if timings is not None else 0.0
            proposal_loss = proposal_objective(
                policy, branch_logits, batch, device, prepared, prepared_proposal,
                proposal_margin_weight, proposal_shortlist_k,
                proposal_anchor_weight, proposal_branch_weight,
                actor_pass_negative_weight, actor_boundary_gradient_weight,
                exact_actor_source, timings)
            if timings is not None:
                timings.finish("proposalLoss", loss_started, device)
            backward_started = timings.start(device) if timings is not None else 0.0
            (proposal_weight * proposal_loss).backward()
            if timings is not None:
                timings.finish("backpropagation", backward_started, device)
        value_loss = torch.tensor(0.0, device=device)
        if value_values and mc_value_weight > 0:
            preparation_started = timings.start(device) if timings is not None else 0.0
            value_batch = stratified_values(
                value_values, min(batch_size, len(value_values)), randomizer,
                value_sampling, value_strata, value_source_strata,
                fixed_source_fraction, self_source_fraction)
            value_inputs = prepared.inputs(value_batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in value_batch) else set_elapsed(
                    encode_states([example.state for example in value_batch], model.shape.extent,
                                  device, model.shape.input_channels),
                    [example.elapsed for example in value_batch], model.shape.extent)
            packed_values = prepared is not None \
                and prepared.holds_values(value_batch)
            if packed_values:
                value_target, value_behavior = prepared.value_batch(value_batch, device)
            else:
                value_target = None
                value_behavior = post_reply_behavior(
                    [example.behavior for example in value_batch],
                    model.shape.extent, model.shape.behavior, device)
            if timings is not None:
                timings.finish("replayBatchPreparation", preparation_started, device)
            forward_started = timings.start(device) if timings is not None else 0.0
            raw = model.forward_value(value_inputs, value_behavior)
            won = value_target[:, 0] if value_target is not None else torch.tensor(
                [example.won for example in value_batch], device=device)
            log_score = value_target[:, 1] if value_target is not None else torch.log1p(
                torch.tensor([example.score for example in value_batch], device=device))
            log_remaining = value_target[:, 2] if value_target is not None else torch.log1p(
                torch.tensor([example.remaining for example in value_batch], device=device))
            weights = value_target[:, 3] if value_target is not None else torch.tensor(
                [example.weight for example in value_batch], device=device)
            per_example = mc_value_loss_weights[0] * F.binary_cross_entropy_with_logits(
                raw[:, 0], won, reduction="none") \
                + mc_value_loss_weights[1] * torch.square(
                    F.softplus(raw[:, 1]) - log_score) \
                + mc_value_loss_weights[2] * torch.square(
                    F.softplus(raw[:, 2]) - log_remaining)
            value_loss = (per_example * weights).sum() / weights.sum().clamp_min(1e-9)
            if timings is not None:
                timings.finish("valueForwardLoss", forward_started, device)
            backward_started = timings.start(device) if timings is not None else 0.0
            (mc_value_weight * value_loss).backward()
            if timings is not None:
                timings.finish("backpropagation", backward_started, device)
        distill_loss = torch.tensor(0.0, device=device)
        if distill_values and distill_weight > 0:
            preparation_started = timings.start(device) if timings is not None else 0.0
            distill_batch = randomizer.choices(
                distill_values, k=min(batch_size, len(distill_values)))
            distill_inputs = prepared.inputs(distill_batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in distill_batch) else set_elapsed(
                    encode_states([example.state for example in distill_batch], model.shape.extent,
                                  device, model.shape.input_channels),
                    [example.elapsed for example in distill_batch], model.shape.extent)
            packed_distill = prepared is not None \
                and prepared.holds_values(distill_batch)
            if packed_distill:
                distill_target, distill_behavior = prepared.value_batch(distill_batch, device)
            else:
                distill_target = None
                distill_behavior = post_reply_behavior(
                    [example.behavior for example in distill_batch],
                    model.shape.extent, model.shape.behavior, device)
            if timings is not None:
                timings.finish("replayBatchPreparation", preparation_started, device)
            forward_started = timings.start(device) if timings is not None else 0.0
            distill_raw = model.forward_value(distill_inputs, distill_behavior)
            distill_won = distill_target[:, 0] if distill_target is not None else torch.tensor(
                [example.won for example in distill_batch], device=device)
            distill_score = distill_target[:, 1] if distill_target is not None else torch.log1p(
                torch.tensor([example.score for example in distill_batch], device=device))
            distill_remaining = distill_target[:, 2] if distill_target is not None else torch.log1p(
                torch.tensor([example.remaining for example in distill_batch], device=device))
            distill_weights = distill_target[:, 3] if distill_target is not None else torch.tensor(
                [example.weight for example in distill_batch], device=device)
            distill_per_example = distill_value_loss_weights[0] * F.binary_cross_entropy_with_logits(
                distill_raw[:, 0], distill_won, reduction="none") \
                + distill_value_loss_weights[1] * torch.square(
                    F.softplus(distill_raw[:, 1]) - distill_score) \
                + distill_value_loss_weights[2] * torch.square(
                    F.softplus(distill_raw[:, 2]) - distill_remaining)
            distill_loss = (distill_per_example * distill_weights).sum() \
                / distill_weights.sum().clamp_min(1e-9)
            if timings is not None:
                timings.finish("distillForwardLoss", forward_started, device)
            backward_started = timings.start(device) if timings is not None else 0.0
            (distill_weight * distill_loss).backward()
            if timings is not None:
                timings.finish("backpropagation", backward_started, device)
        ranking_loss = torch.tensor(0.0, device=device)
        if ranking_values and ranking_weight > 0:
            preparation_started = timings.start(device) if timings is not None else 0.0
            ranking_batch = stratified_rankings(
                ranking_values, min(ranking_batch_size, len(ranking_values)),
                randomizer, ranking_source_strata,
                fixed_source_fraction, self_source_fraction)
            flat = [value for example in ranking_batch
                    for candidate in example.candidates for value in candidate]
            ranking_inputs = prepared.inputs(flat, device) if prepared is not None \
                and all(value.state in prepared.state_rows for value in flat) else set_elapsed(
                    encode_states([value.state for value in flat], model.shape.extent, device,
                                  model.shape.input_channels),
                    [value.elapsed for value in flat], model.shape.extent)
            packed_ranking = prepared is not None \
                and prepared.holds_values(flat)
            if packed_ranking:
                ranking_targets, ranking_behavior = prepared.value_batch(flat, device)
            else:
                ranking_targets = None
                ranking_behavior = post_reply_behavior(
                    [value.behavior for value in flat], model.shape.extent,
                    model.shape.behavior, device)
            if timings is not None:
                timings.finish("replayBatchPreparation", preparation_started, device)
            forward_started = timings.start(device) if timings is not None else 0.0
            ranking_raw = model.forward_value(ranking_inputs, ranking_behavior)
            ranking_decoded = torch.cat((
                torch.sigmoid(ranking_raw[:, :1]),
                torch.expm1(torch.clamp(F.softplus(ranking_raw[:, 1:]), max=40)),
            ), dim=1)
            ranking_loss = candidate_ranking_objective(
                ranking_decoded, ranking_batch, device, ranking_targets)
            if timings is not None:
                timings.finish("rankingForwardLoss", forward_started, device)
            backward_started = timings.start(device) if timings is not None else 0.0
            (ranking_weight * ranking_loss).backward()
            if timings is not None:
                timings.finish("backpropagation", backward_started, device)
        # Never let a single numerical failure silently poison a checkpoint and
        # consume hours of accelerator time before the next evaluation gate.
        optimizer_started = timings.start(device) if timings is not None else 0.0
        torch.nn.utils.clip_grad_norm_(
            model.parameters(), 5, error_if_nonfinite=True)
        optimizer.step()
        if timings is not None:
            timings.finish("optimizerStep", optimizer_started, device)
        loss_totals += torch.stack((proposal_loss, value_loss, distill_loss, ranking_loss)) \
            .detach().to(torch.float32)
    # One scalar synchronization per train_updates call instead of four per
    # optimizer update. The values are reporting-only and never affect steps.
    totals = loss_totals.cpu().tolist()
    return tuple(value / updates for value in totals)


def configure_training_scope(
    model: V9Net,
    learning_rate: float,
    weight_decay: float,
    value_head_only: bool = False,
    proposal_head_only: bool = False,
    pass_head_only: bool = False,
    train_tail_blocks: int = 0,
    conditioning_only: bool = False,
) -> torch.optim.Optimizer:
    """Freeze the requested scope and build an optimizer that cannot drift it.

    Residual and conditioning tensors stack all blocks in one Parameter. A
    gradient mask freezes their prefix. Their optimizer group deliberately has
    no decoupled weight decay, because AdamW would otherwise change the frozen
    prefix even when its gradient is exactly zero.
    """
    if sum((value_head_only, proposal_head_only, pass_head_only,
            train_tail_blocks > 0, conditioning_only)) > 1:
        raise RuntimeError("training-scope options are mutually exclusive")
    if not 0 <= train_tail_blocks <= model.shape.blocks:
        raise RuntimeError("tail block count exceeds topology")
    sliced_names = {"residual", "residual_bias", "conditioning_w", "conditioning_b"}
    if value_head_only:
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name.startswith("value_"))
    elif proposal_head_only:
        proposal_prefixes = ("policy_", "pass_", "branch_", "pass_branch_")
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name.startswith(proposal_prefixes))
    elif pass_head_only:
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name in ("pass_w", "pass_b"))
    elif conditioning_only:
        # Opponent-exploit authority. The behaviour vector reaches the network
        # only through the per-block conditioning linears, so restricting the
        # update to them means an exploit label can shift a decision *only*
        # when the enemy-behaviour input matches. Everything spatial stays
        # bit-exact, which is what keeps a seeded bait move from being learned
        # as a board pattern and fired against the wrong faction.
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name in ("conditioning_w", "conditioning_b"))
    elif train_tail_blocks:
        head_prefixes = ("value_", "policy_", "pass_", "branch_", "pass_branch_")
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name in sliced_names or name.startswith(head_prefixes))
        frozen_blocks = model.shape.blocks - train_tail_blocks
        if frozen_blocks:
            def freeze_prefix(gradient: Tensor) -> Tensor:
                gradient[:frozen_blocks].zero_()
                return gradient
            for name in sliced_names:
                getattr(model, name).register_hook(freeze_prefix)

    named = [(name, parameter) for name, parameter in model.named_parameters()
             if parameter.requires_grad]
    ordinary = [parameter for name, parameter in named if name not in sliced_names]
    sliced = [parameter for name, parameter in named if name in sliced_names]
    groups: list[dict[str, object]] = []
    if ordinary:
        groups.append({"params": ordinary, "weight_decay": weight_decay})
    if sliced:
        groups.append({"params": sliced, "weight_decay": 0.0})
    return torch.optim.AdamW(groups, lr=learning_rate)


@torch.no_grad()
def evaluate_shortlist_policy(
    model: V9Net,
    examples: list[ProposalExample],
    device: torch.device,
) -> dict[int, Tensor]:
    """Evaluate each held-out position once for global and per-source metrics."""
    model.eval()
    result: dict[int, Tensor] = {}
    for offset in range(0, len(examples), 256):
        batch = examples[offset:offset + 256]
        states = set_elapsed(
            encode_states([example.state for example in batch], model.shape.extent, device,
                          model.shape.input_channels),
            [example.elapsed for example in batch], model.shape.extent)
        behavior = torch.tensor(
            [example.behavior for example in batch], dtype=torch.float32, device=device)
        logits = model.forward_policy(states, behavior).cpu()
        result.update((id(example), logits[row]) for row, example in enumerate(batch))
    return result


def shortlist_metrics(
    model: V9Net,
    examples: list[ProposalExample],
    device: torch.device,
    k: int,
    source: str = "champion",
    evaluated: dict[int, Tensor] | None = None,
    adaptive: bool = False,
) -> dict[str, float]:
    examples = [example for example in examples if example.source == source]
    if not examples:
        return {"positions": 0, "topKRecall": 0, "meanRegret": 0,
                "passPositions": 0, "passRecall": 0,
                "nonPassPositions": 0, "passFalseInclusionRate": 0,
                "setTargets": 0, "setRecall": 0,
                "upsideTargets": 0, "upsideRecall": 0,
                "baitPositions": 0, "baitRecall": 0}
    hits = pass_total = pass_hits = pass_false_total = pass_false_hits = 0
    bait_total = bait_hits = 0
    set_total = set_hits = upside_total = upside_hits = 0
    regret = 0.0
    evaluated = evaluated if evaluated is not None \
        else evaluate_shortlist_policy(model, examples, device)
    for example in examples:
        logits = evaluated[id(example)]
        if adaptive:
            selected = v9_shortlist(logits, example.moves, k)
        else:
            moves = torch.tensor(example.moves, dtype=torch.long)
            selected = torch.topk(
                logits[moves], min(k, len(example.moves))).indices.tolist()
        best = example.moves.index(example.best_move)
        hit = best in selected
        hits += int(hit)
        regret += 0 if hit else min(example.regrets[index] for index in selected)
        selected_moves = {example.moves[index] for index in selected}
        target_moves = {example.moves[index] for index, target in enumerate(example.targets)
                        if target > 0.5}
        set_total += len(target_moves)
        set_hits += len(target_moves & selected_moves)
        upside = set(example.upside_moves)
        upside_total += len(upside)
        upside_hits += len(upside & selected_moves)
        pass_move = model.shape.extent * model.shape.extent
        is_pass = pass_move in target_moves
        pass_total += int(is_pass)
        pass_hits += int(is_pass and pass_move in selected_moves)
        pass_false_total += int(not is_pass)
        pass_false_hits += int(not is_pass and pass_move in selected_moves)
        bait = set(example.bait_moves)
        bait_total += len(bait)
        bait_hits += len(bait & selected_moves)
    return {
        "positions": len(examples), "topKRecall": hits / len(examples),
        "meanRegret": regret / len(examples),
        "passPositions": pass_total,
        "passRecall": pass_hits / max(pass_total, 1),
        "nonPassPositions": pass_false_total,
        "passFalseInclusionRate": pass_false_hits / max(pass_false_total, 1),
        "setTargets": set_total,
        "setRecall": set_hits / max(set_total, 1),
        "upsideTargets": upside_total,
        "upsideRecall": upside_hits / max(upside_total, 1),
        "baitPositions": bait_total,
        "baitRecall": bait_hits / max(bait_total, 1),
    }


def source_shortlist_metrics(
    model: V9Net,
    examples: list[ProposalExample],
    device: torch.device,
    k: int,
    evaluated: dict[int, Tensor] | None = None,
) -> dict[str, dict[str, float]]:
    evaluated = evaluated if evaluated is not None \
        else evaluate_shortlist_policy(model, examples, device)
    return {
        source: shortlist_metrics(model, examples, device, k, source, evaluated)
        for source in ("katago", "handcrafted", CERTIFIED_ACTOR_SOURCE, "self")
        if any(example.source == source for example in examples)
    }


RankingEvaluation = tuple[Tensor, dict[int, tuple[int, list[int]]]]


@torch.no_grad()
def evaluate_ranking_values(
    model: V9Net,
    examples: list[RankingExample],
    device: torch.device,
    inference_batch: int = 4096,
) -> RankingEvaluation:
    """Evaluate each reply board once for global and per-source ranking metrics."""
    flat = [value for example in examples
            for candidate in example.candidates for value in candidate]
    decoded_chunks: list[Tensor] = []
    model.eval()
    for start in range(0, len(flat), inference_batch):
        chunk = flat[start:start + inference_batch]
        inputs = set_elapsed(
            encode_states([value.state for value in chunk], model.shape.extent, device,
                          model.shape.input_channels),
            [value.elapsed for value in chunk], model.shape.extent)
        behavior = post_reply_behavior(
            [value.behavior for value in chunk], model.shape.extent,
            model.shape.behavior, device)
        raw = model.forward_value(inputs, behavior)
        decoded_chunks.append(torch.cat((
            torch.sigmoid(raw[:, :1]),
            torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
        ), dim=1).cpu())
    decoded = torch.cat(decoded_chunks) if decoded_chunks else torch.empty((0, 3))
    offsets: dict[int, tuple[int, list[int]]] = {}
    offset = 0
    for example in examples:
        lengths = [len(candidate) for candidate in example.candidates]
        offsets[id(example)] = (offset, lengths)
        offset += sum(lengths)
    return decoded, offsets


def ranking_metrics(
    model: V9Net,
    examples: list[RankingExample],
    device: torch.device,
    source: str | None = None,
    inference_batch: int = 4096,
    evaluated: RankingEvaluation | None = None,
) -> dict[str, float]:
    """Measure unseen teacher-choice ordering through the deployment value rule."""
    if source is not None:
        examples = [example for example in examples
                    if example.proposal.source == source]
    if not examples:
        return {"positions": 0, "top1Agreement": 0,
                "meanBestRank": 0, "meanWinMargin": 0}
    decoded, offsets = evaluated if evaluated is not None \
        else evaluate_ranking_values(model, examples, device, inference_batch)
    hits = 0
    best_rank_total = 0
    win_margin_total = 0.0
    for example in examples:
        offset, lengths = offsets[id(example)]
        qualities: list[tuple[float, float]] = []
        for candidate, length in zip(example.candidates, lengths, strict=True):
            rows = decoded[offset:offset + length]
            offset += length
            probabilities = torch.tensor(
                [value.weight for value in candidate], dtype=torch.float32)
            win = float((probabilities * rows[:, 0]).sum())
            rate = float((probabilities * rows[:, 1]
                          / torch.clamp(example.proposal.elapsed + rows[:, 2],
                                        min=1e-6)).sum())
            qualities.append((win, rate))
        teacher = example.proposal.moves.index(example.proposal.best_move)
        order = sorted(range(len(qualities)), key=lambda index: (
            -qualities[index][0], -qualities[index][1], index))
        hits += int(order[0] == teacher)
        best_rank_total += order.index(teacher) + 1
        alternatives = [quality[0] for index, quality in enumerate(qualities)
                        if index != teacher]
        win_margin_total += qualities[teacher][0] - max(alternatives, default=0)
    return {
        "positions": len(examples),
        "top1Agreement": hits / len(examples),
        "meanBestRank": best_rank_total / len(examples),
        "meanWinMargin": win_margin_total / len(examples),
    }


def source_ranking_metrics(
    model: V9Net,
    examples: list[RankingExample],
    device: torch.device,
    evaluated: RankingEvaluation | None = None,
) -> dict[str, dict[str, float]]:
    evaluated = evaluated if evaluated is not None \
        else evaluate_ranking_values(model, examples, device)
    return {
        source: ranking_metrics(model, examples, device, source, evaluated=evaluated)
        for source in ("katago", "handcrafted", "self", "counterfactual")
        if any(example.proposal.source == source for example in examples)
    }


def checkpoint_metrics(
    model: V9Net,
    heldout: list[ProposalExample],
    heldout_rankings: list[RankingExample],
    device: torch.device,
    k: int,
) -> tuple[dict[str, float], dict[str, dict[str, float]],
           dict[str, float], dict[str, dict[str, float]]]:
    """Reuse frozen outputs across global and source-specific checkpoint metrics."""
    policy = evaluate_shortlist_policy(model, heldout, device)
    ranking = evaluate_ranking_values(model, heldout_rankings, device)
    return (
        shortlist_metrics(model, heldout, device, k, evaluated=policy),
        source_shortlist_metrics(model, heldout, device, k, policy),
        ranking_metrics(model, heldout_rankings, device, evaluated=ranking),
        source_ranking_metrics(model, heldout_rankings, device, ranking),
    )


@dataclasses.dataclass(frozen=True)
class ParityProbe:
    """One PyTorch/C++ comparison point.

    `size` is the played board; the encoded string is always extent-sized
    because the padded points are part of what is being compared.
    """
    name: str
    size: int
    board: str
    padded: str
    legal: str
    passes: int
    elapsed: int
    response_pass: int
    response_no_op: int


def parity_probes(extent: int) -> list[ParityProbe]:
    """Deterministic states that pin every axis of the V9 input encoder.

    A uniform empty board leaves channels 0-2 and 4-7 identically zero and
    every remaining plane spatially constant, so a permuted plane, a dropped
    pass scaling, or a transposed board all score exactly zero error against
    it. Each probe below breaks one of those degeneracies: mixed cells
    separate the three board planes, coprime strides make the pattern
    transpose-sensitive, a legal mask uncorrelated with the board separates
    channel 3, nonzero pass counts exercise the halving, the response flags
    are set one at a time, and a sub-extent board pins the '#' padding
    convention the deployed 7x7-through-13x13 boards rely on.
    """
    def pad(size: int, board: str) -> str:
        return "".join(
            board[x * size + y] if x < size and y < size else "#"
            for x in range(extent) for y in range(extent))

    def mask(size: int, phase: int) -> str:
        return "".join(
            "1" if x < size and y < size and (x * 2 + y + phase) % 3 else "0"
            for x in range(extent) for y in range(extent))

    area = extent * extent
    cells = "XO.#"
    mixed = "".join(cells[(x * 5 + y * 2) % 4] for x in range(extent) for y in range(extent))
    corners = "X" + "." * (area - 2) + "O"
    probes = [
        # Retained so a regression here still reports against the historical
        # baseline, not because it discriminates on its own.
        ParityProbe("empty", extent, "." * area, "." * area, "1" * area, 0, 3, 0, 0),
        ParityProbe("mixed cells", extent, mixed, mixed, mask(extent, 0), 1, 7, 1, 0),
        ParityProbe("mixed cells, second reply flag", extent, mixed, mixed,
                    mask(extent, 1), 2, area // 3, 0, 1),
        # Two opposite corners: any transposition or board-plane swap moves a
        # lone stone across the whole board.
        ParityProbe("opposite corners", extent, corners, corners,
                    "0" * (area - 1) + "1", 1, 1, 1, 1),
    ]
    for size in (7, 13):
        if size >= extent:
            continue
        board = "".join(cells[(x * 3 + y * 5) % 4] for x in range(size) for y in range(size))
        probes.append(ParityProbe(
            f"padded {size}x{size}", size, board, pad(size, board), mask(size, 2),
            1, 2 * size, 0, 1))
    return probes


@torch.no_grad()
def verify_cpp(model: V9Net, checkpoint: pathlib.Path, oracle: str, device: torch.device) -> float:
    extent = model.shape.extent
    area = extent * extent
    behavior = [((index * 17) % 31) / 31 for index in range(model.shape.behavior)]
    behavior_text = ",".join(map(str, behavior))
    probes = parity_probes(extent)
    inputs = set_elapsed(
        encode_states([
            f"{probe.padded}|{probe.legal}|{probe.passes}|{probe.response_pass}"
            f"|{probe.response_no_op}" for probe in probes], extent, device,
            model.shape.input_channels),
        [probe.elapsed for probe in probes], extent)
    tensor_behavior = torch.tensor([behavior] * len(probes), dtype=torch.float32, device=device)
    value, moves, branches = model(inputs, tensor_behavior)
    decoded_value = torch.cat((torch.sigmoid(value[:, :1]),
                               torch.expm1(torch.clamp(F.softplus(value[:, 1:]), max=40))), dim=1)
    maximum = 0.0
    for row, probe in enumerate(probes):
        output = subprocess.check_output([
            oracle, "value-v9", str(checkpoint), str(probe.size), probe.board, probe.legal,
            str(probe.passes / 2), str(probe.elapsed / max(2 * area, 1)),
            str(probe.response_pass), str(probe.response_no_op), behavior_text,
        ], text=True).splitlines()
        expected = [float(value) for value in output[0].split("\t")]
        expected_rows = [[float(value) for value in line.split("\t")[1:]] for line in output[1:]]
        actual = [*decoded_value[row].cpu().tolist()]
        for candidate, _ in enumerate(expected_rows):
            actual.append(float(moves[row, candidate].cpu()))
            actual.extend(branches[row, candidate].cpu().tolist())
        for line in expected_rows:
            expected.extend(line)
        error = max(abs(left - right) / max(1, abs(right))
                    for left, right in zip(actual, expected, strict=True))
        if error > 2e-4:
            raise RuntimeError(
                f"V9 PyTorch/C++ parity exceeded tolerance on probe '{probe.name}': {error}")
        maximum = max(maximum, error)
    return maximum


def run(args: argparse.Namespace) -> None:
    run_entered = time.perf_counter()
    end_to_end_started = PROCESS_STARTED
    timings = PhaseTimings()
    timings.seconds["moduleImport"] = run_entered - PROCESS_STARTED
    if args.top_k <= 0:
        args.top_k = 8 if args.profile == "small5" else 16
    if args.actor_base_k <= 0:
        args.actor_base_k = DEPLOYMENT_BASE_K
    if args.teacher_batch <= 0 or args.batch_size <= 0 or args.pretrain_updates < 0 \
            or args.pretrain_checkpoint_updates < 0:
        raise RuntimeError("batch sizes must be positive and pretrain updates nonnegative")
    if args.games <= 0 or args.environments <= 0 or args.cpu_threads <= 0:
        raise RuntimeError("games, environments, and CPU threads must be positive")
    if any(value < 0 for value in (
            args.channels, args.blocks, args.hidden, args.tower)):
        raise RuntimeError("topology overrides must be positive or 0 for the profile default")
    if args.proposal_target_size <= 0 or args.proposal_target_size > args.top_k:
        raise RuntimeError("proposal target size must be positive and no larger than top K")
    if not 0 <= args.fixed_source_batch_fraction <= 0.5 \
            or not 0 <= args.self_source_batch_fraction <= 1 \
            or not 0 <= args.fixed_source_pass_fraction <= 1 \
            or not 0 <= args.fixed_source_opening_fraction <= 1:
        raise RuntimeError("source batch fractions must be nonnegative and leave room for champion replay")
    if 2 * args.fixed_source_batch_fraction \
            + args.self_source_batch_fraction > 1:
        raise RuntimeError("fixed/self source batch fractions may not exceed the complete batch")
    if args.fixed_source_pass_fraction + args.fixed_source_opening_fraction > 1:
        raise RuntimeError(
            "fixed-source pass/opening fractions may not exceed each source quota")
    if args.distill_replay <= 0 or args.ranking_replay <= 0 or args.distill_weight < 0:
        raise RuntimeError("distill/ranking replay must be positive and distill weight nonnegative")
    distill_value_loss_weights = (
        args.win_loss_weight, args.score_loss_weight, args.remaining_loss_weight)
    mc_value_loss_weights = tuple(
        fallback if override is None else override
        for override, fallback in zip((
            args.mc_win_loss_weight,
            args.mc_score_loss_weight,
            args.mc_remaining_loss_weight,
        ), distill_value_loss_weights, strict=True))
    if any(weight < 0 for weight in distill_value_loss_weights) \
            or not any(distill_value_loss_weights):
        raise RuntimeError("distillation value loss weights must be nonnegative with a positive sum")
    if any(weight < 0 for weight in mc_value_loss_weights) \
            or (args.mc_value_weight > 0 and not any(mc_value_loss_weights)):
        raise RuntimeError(
            "Monte Carlo value loss weights must be nonnegative with a positive sum when enabled")
    if args.proposal_loss_weight < 0 or args.proposal_margin_weight < 0 \
            or args.proposal_anchor_weight < 0 \
            or args.proposal_branch_weight < 0 \
            or args.actor_pass_negative_weight < 0 \
            or not 0 <= args.actor_boundary_gradient_weight <= 1 \
            or args.mc_value_weight < 0:
        raise RuntimeError("task loss weights must be nonnegative")
    if args.ranking_loss_weight < 0 or args.ranking_batch_size <= 0:
        raise RuntimeError("ranking weight must be nonnegative and its batch size positive")
    if args.exact_actor_source is not None and (
            args.mc_value_weight != 0 or args.distill_weight != 0
            or args.ranking_loss_weight != 0):
        raise RuntimeError(
            "--exact-actor-source is a policy-only assay; MC/distill/ranking weights must be 0")
    if args.value_head_only and args.proposal_loss_weight != 0:
        raise RuntimeError("--value-head-only requires --proposal-loss-weight 0")
    if args.proposal_head_only and (args.value_head_only or args.pass_head_only
                                    or args.mc_value_weight != 0
                                    or args.distill_weight != 0
                                    or args.ranking_loss_weight != 0):
        raise RuntimeError(
            "--proposal-head-only requires MC/distill weights 0 and is mutually exclusive")
    if args.pass_head_only and (args.value_head_only or args.proposal_head_only
                                or args.mc_value_weight != 0
                                or args.distill_weight != 0
                                or args.ranking_loss_weight != 0):
        raise RuntimeError(
            "--pass-head-only requires MC/distill/ranking weights 0 and is mutually exclusive")
    if args.train_tail_blocks and (args.value_head_only or args.proposal_head_only
                                   or args.pass_head_only):
        raise RuntimeError("--train-tail-blocks is mutually exclusive with head-only modes")
    if args.conditioning_only and (args.value_head_only or args.proposal_head_only
                                   or args.pass_head_only or args.train_tail_blocks
                                   or args.mc_value_weight != 0
                                   or args.distill_weight != 0
                                   or args.ranking_loss_weight != 0):
        raise RuntimeError(
            "--conditioning-only requires MC/distill/ranking weights 0 and is "
            "mutually exclusive with the other training-scope options")
    if not 0 <= args.self_actor_fraction <= 1 \
            or not 0 <= args.exhaustive_actor_fraction <= 1 \
            or not 0 <= args.teacher_target_exploration_fraction <= 1 \
            or not 0 <= args.teacher_broad_exploration_fraction <= 1 \
            or args.teacher_target_exploration_fraction \
            + args.teacher_broad_exploration_fraction > 1:
        raise RuntimeError("actor/exploration fractions must be in [0,1]")
    if args.teacher_broad_exploration_fraction and args.teacher_broad_exploration_pool <= 0:
        raise RuntimeError("broad exploration requires a positive candidate pool")
    if args.self_actor_fraction:
        validate_self_actor_gate(args.self_actor_summary, args.init, args.profile)
    if args.self_actor_fraction and args.exhaustive_actor_fraction:
        raise RuntimeError("shortlist and exhaustive actors are mutually exclusive")
    if args.exhaustive_actor_fraction and not args.exhaustive_actor_model:
        raise RuntimeError(
            "--exhaustive-actor-fraction requires --exhaustive-actor-model")
    if args.exhaustive_actor_fraction:
        validate_exhaustive_actor(
            args.exhaustive_actor_summary, args.exhaustive_actor_model,
            args.profile)
    device = auto_device(args.device)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device cuda requested but CUDA is unavailable")
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("--device mps requested but MPS is unavailable")
    configure_accelerator(device)
    default_shape = V9Shape(5, 32, 4, behavior=31) if args.profile == "small5" \
        else V9Shape(19, 48, 8, behavior=30)
    shape = V9Shape(
        default_shape.extent,
        args.channels or default_shape.channels,
        args.blocks or default_shape.blocks,
        args.hidden or default_shape.hidden,
        args.tower or default_shape.tower,
        default_shape.behavior,
        args.global_policy_rank,
        16 if args.tactical_features else 8,
    )
    if shape.policy_rank < 0 or shape.policy_rank > 256:
        raise RuntimeError("--global-policy-rank must be in [0, 256]")
    if args.tactical_features and not shape.policy_rank:
        raise RuntimeError("--tactical-features requires --global-policy-rank")
    with timings.measure("initialization", device):
        model = load_v9(pathlib.Path(args.init), device) if args.init \
            else V9Net(shape, device, args.seed)
        # A continuation actor is the exact hash-gated checkpoint and remains
        # immutable while the learner changes. A later learner must pass a fresh
        # recall gate before it may generate another stage's trajectories.
        self_actor = load_v9(pathlib.Path(args.init), device) \
            if args.self_actor_fraction else None
        exhaustive_actor_path = pathlib.Path(args.exhaustive_actor_model) \
            if args.exhaustive_actor_model else None
        exhaustive_actor = load_v9(exhaustive_actor_path, device) \
            if args.exhaustive_actor_fraction and exhaustive_actor_path else None
        exhaustive_actor_sha256 = file_sha256(exhaustive_actor_path) \
            if exhaustive_actor_path else None
        teacher_path = pathlib.Path(args.teacher)
        teacher_sha256 = file_sha256(teacher_path)
        teacher = load_teacher(teacher_path, device)
    if model.shape != shape:
        raise RuntimeError("V9 checkpoint does not match profile")
    dead_value_head = value_head_is_zero(model)
    value_training_enabled = args.mc_value_weight > 0 or args.distill_weight > 0 \
        or args.ranking_loss_weight > 0
    if dead_value_head and value_training_enabled:
        if not args.reinitialize_zero_value_head:
            raise RuntimeError(
                "value supervision cannot train an all-zero multi-layer value head; "
                "pass --reinitialize-zero-value-head for a policy-only checkpoint")
        reinitialize_zero_value_head(model, args.seed)
    elif args.reinitialize_zero_value_head:
        raise RuntimeError("--reinitialize-zero-value-head requires an all-zero value head")
    if exhaustive_actor is not None and exhaustive_actor.shape != shape:
        raise RuntimeError("exhaustive actor checkpoint does not match profile")
    if isinstance(teacher, V9Net) and (
            teacher.shape.extent != shape.extent
            or teacher.shape.behavior != shape.behavior):
        raise RuntimeError("V9 exhaustive value teacher has incompatible inputs")
    teacher.eval()
    trajectory_generation: dict[str, object] = {
        "teacherTargetExplorationFraction": args.teacher_target_exploration_fraction,
        "teacherBroadExplorationFraction": args.teacher_broad_exploration_fraction,
        "teacherBroadExplorationPool": args.teacher_broad_exploration_pool,
        "selfActorFraction": args.self_actor_fraction,
        "selfActorSha256": file_sha256(pathlib.Path(args.init))
            if args.self_actor_fraction and args.init else None,
        "exhaustiveActorFraction": args.exhaustive_actor_fraction,
        "exhaustiveActorSha256": exhaustive_actor_sha256,
    }
    output_dir = pathlib.Path(args.out_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError("output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    initial_checkpoint = output_dir / "v9.initial.model"
    with timings.measure("checkpointSerialization", device):
        save_model(model, initial_checkpoint)
    with timings.measure("evaluation", device):
        initial_parity = verify_cpp(model, initial_checkpoint, args.oracle, device)
    optimizer = configure_training_scope(
        model, args.learning_rate, args.weight_decay,
        args.value_head_only, args.proposal_head_only, args.pass_head_only,
        args.train_tail_blocks, args.conditioning_only)
    proposals: collections.deque[ProposalExample] = collections.deque(maxlen=args.proposal_replay)
    values: collections.deque[ValueExample] = collections.deque(maxlen=args.value_replay)
    distill: collections.deque[DistillExample] = collections.deque(maxlen=args.distill_replay)
    rankings: collections.deque[RankingExample] = collections.deque(maxlen=args.ranking_replay)
    heldout: list[ProposalExample] = []
    heldout_rankings: list[RankingExample] = []
    if args.corpus_in:
        loaded_training, loaded_heldout, loaded_values, loaded_distill, \
            loaded_rankings, loaded_heldout_rankings = load_corpora(
            args.corpus_in, args.profile, teacher_sha256,
            args.proposal_replay, args.value_replay, args.distill_replay,
            args.ranking_replay, args.seed, timings, args.exact_actor_source,
            exact_ranking_source=args.exact_ranking_source)
        proposals.extend(loaded_training)
        heldout.extend(loaded_heldout)
        values.extend(loaded_values)
        distill.extend(loaded_distill)
        rankings.extend(loaded_rankings)
        heldout_rankings.extend(loaded_heldout_rankings)
        print(json.dumps({
            "loadedProposalTraining": len(loaded_training),
            "loadedProposalHeldout": len(loaded_heldout),
            "loadedMonteCarloValues": len(loaded_values),
            "loadedValueDistill": len(loaded_distill),
            "loadedCandidateRankings": len(loaded_rankings),
            "loadedCandidateRankingHeldout": len(loaded_heldout_rankings),
            "loadedProposalSources": dict(sorted(collections.Counter(
                example.source for example in loaded_training).items())),
            "loadedHeldoutSources": dict(sorted(collections.Counter(
                example.source for example in loaded_heldout).items())),
            "loadedMonteCarloSources": dict(sorted(collections.Counter(
                example.source for example in loaded_values).items())),
            "loadedRankingSources": dict(sorted(collections.Counter(
                example.proposal.source for example in loaded_rankings).items())),
            "loadedRankingHeldoutSources": dict(sorted(collections.Counter(
                example.proposal.source for example in loaded_heldout_rankings).items())),
        }), flush=True)
        value_sources = collections.Counter(
            example.source for example in loaded_values)
        if args.mc_value_weight > 0 \
                and (value_sources["katago"] or value_sources["handcrafted"]) \
                and not value_sources["champion"]:
            print(json.dumps({
                "warning": "fixed-teacher Monte Carlo replay has no champion routes",
                "effect": "KataGo/handcrafted own the complete MC batch; add a frozen-champion trajectory corpus or disable/down-weight MC replay",
                "loadedMonteCarloSources": dict(sorted(value_sources.items())),
            }), flush=True)
        # The bounded deques own the retained replay now. Daemon corpora can
        # contain millions of reply boards, so do not keep duplicate lists for
        # the duration of training.
        del loaded_training, loaded_heldout, loaded_values, loaded_distill, \
            loaded_rankings, loaded_heldout_rankings
    with timings.measure("corpusHashing"):
        cache_metadata = replay_metadata(
            args.corpus_in, args.profile, teacher_sha256, shape,
            args.proposal_replay, args.value_replay, args.distill_replay,
            args.ranking_replay, args.seed, args.exact_actor_source)
    with timings.measure("replayPreparation"):
        prepared, replay_cache = prepare_replay(
            proposals, heldout, values, distill, rankings, shape,
            cache_metadata, args.replay_cache_dir)
    with timings.measure("initialHeldoutEvaluation", device):
        initial_heldout, initial_source_heldout, initial_ranking_heldout, \
            initial_source_ranking_heldout = checkpoint_metrics(
                model, heldout, heldout_rankings, device, args.top_k)
    print(json.dumps({
        "initialCppParityRelativeError": initial_parity,
        "initialHeldout": initial_heldout,
        "initialSourceHeldout": initial_source_heldout,
        "initialRankingHeldout": initial_ranking_heldout,
        "initialSourceRankingHeldout": initial_source_ranking_heldout,
        "replayCache": replay_cache,
    }), flush=True)
    trajectories: dict[int, list[Turn]] = {}
    trajectory_sources: dict[int, set[str]] = {}
    pending: dict[tuple[int, int, int], Turn] = {}
    randomizer = random.Random(args.seed ^ 0x6A09E667)
    if args.corpus_out:
        output_corpus = pathlib.Path(args.corpus_out)
        output_corpus.parent.mkdir(parents=True, exist_ok=True)
        if any(output_corpus.resolve() == pathlib.Path(value).resolve() for value in args.corpus_in):
            raise RuntimeError("--corpus-out must not overwrite a --corpus-in file")
    corpus = gzip.open(args.corpus_out, "wt") if args.corpus_out else None
    if args.pretrain_updates:
        interval = args.pretrain_checkpoint_updates or args.pretrain_updates
        completed_pretrain = 0
        while completed_pretrain < args.pretrain_updates:
            chunk = min(interval, args.pretrain_updates - completed_pretrain)
            with timings.measure("pretraining", device):
                pretrain_proposal_loss, pretrain_value_loss, \
                    pretrain_distill_loss, pretrain_ranking_loss = train_updates(
                    model, optimizer, proposals, values, distill, rankings, chunk,
                    args.batch_size, device, randomizer, args.distill_weight,
                    args.value_sampling, args.proposal_loss_weight,
                    args.proposal_margin_weight, args.proposal_anchor_weight,
                    args.top_k,
                    args.mc_value_weight, mc_value_loss_weights,
                    distill_value_loss_weights, args.ranking_loss_weight,
                    args.ranking_batch_size, prepared,
                    args.fixed_source_batch_fraction,
                    args.self_source_batch_fraction,
                    args.fixed_source_pass_fraction,
                    args.proposal_branch_weight,
                    args.actor_pass_negative_weight,
                    args.actor_boundary_gradient_weight,
                    args.exact_actor_source,
                    timings if args.profile_detail else None,
                    args.fixed_source_opening_fraction)
            completed_pretrain += chunk
            report = {
                "pretrainUpdates": completed_pretrain,
                "proposalLoss": pretrain_proposal_loss,
                "valueLoss": pretrain_value_loss,
                "distillLoss": pretrain_distill_loss,
                "rankingLoss": pretrain_ranking_loss,
            }
            if args.pretrain_checkpoint_updates and completed_pretrain < args.pretrain_updates:
                checkpoint = output_dir / f"v9.pretrain.{completed_pretrain}.model"
                with timings.measure("checkpointSerialization", device):
                    save_model(model, checkpoint)
                with timings.measure("evaluation", device):
                    report["heldout"], report["sourceHeldout"], \
                        report["rankingHeldout"], report["sourceRankingHeldout"] = \
                        checkpoint_metrics(
                            model, heldout, heldout_rankings, device, args.top_k)
                report["checkpoint"] = str(checkpoint)
            print(json.dumps(report), flush=True)
    environment = subprocess.Popen([
        args.environment, str(args.games), str(args.seed), str(args.environments),
        args.profile, str(args.cpu_threads), "v9",
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    completed = wins = total_rounds = 0
    last_checkpoint_games = 0
    total_score = 0.0
    online_started = time.monotonic()
    try:
        done = False
        while not done:
            with timings.measure("environmentGeneration"):
                states, events, done = read_block(
                    environment, timings if args.profile_detail else None)
            new_results = 0
            for parts in events:
                if parts[0] == "T":
                    key = (int(parts[1]), int(parts[2]), int(parts[3]))
                    turn = pending.pop(key)
                    options = turn.state.split("^")
                    # The environment reports which reply it sampled. The board
                    # alone cannot say: a pass and a superko-rejected move both
                    # leave it untouched and differ only in the pass count and
                    # the two response flags.
                    index = int(parts[6])
                    if index >= len(options):
                        raise RuntimeError("environment reply index is outside the V9 labels")
                    if options[index].split("|", 1)[0] != parts[5]:
                        raise RuntimeError("environment reply index disagrees with the played board")
                    turn.state = options[index]
                else:
                    episode = int(parts[2])
                    won, score, rounds = float(parts[3]), float(parts[4]), int(parts[5])
                    trajectory = trajectories.pop(episode)
                    episode_sources = trajectory_sources.pop(episode)
                    # A single non-champion intervention changes the complete
                    # return distribution. Keep mixed self/champion routes in
                    # the self stratum instead of silently diluting them into
                    # ordinary champion replay.
                    trajectory_source = trajectory_outcome_source(episode_sources)
                    weight = 1 / max(len(trajectory), 1)
                    # The recall split is by complete episode. Keeping its
                    # value labels out too prevents the shared trunk from
                    # indirectly training on held-out proposal positions.
                    trajectory_values = [ValueExample(
                        turn.state, turn.behavior, turn.elapsed + 1, won, score,
                        rounds - turn.elapsed, weight, trajectory_source)
                        for turn in trajectory]
                    if episode % 10 != 0:
                        values.extend(trajectory_values)
                    if corpus:
                        with timings.measure("corpusSerialization"):
                            corpus.write(json.dumps(trajectory_corpus_record(
                                args.profile, teacher_sha256, episode,
                                trajectory_values,
                                {**trajectory_generation,
                                 "source": trajectory_source}),
                                separators=(",", ":")) + "\n")
                    completed += 1
                    new_results += 1
                    wins += int(won)
                    total_score += score
                    total_rounds += rounds
            if done:
                with timings.measure("trainingUpdates", device):
                    proposal_loss, value_loss, distill_loss, ranking_loss = train_updates(
                        model, optimizer, proposals, values, distill, rankings,
                        new_results * args.updates_per_game,
                        args.batch_size, device, randomizer, args.distill_weight,
                        args.value_sampling, args.proposal_loss_weight,
                        args.proposal_margin_weight, args.proposal_anchor_weight,
                        args.top_k,
                        args.mc_value_weight, mc_value_loss_weights,
                        distill_value_loss_weights,
                        args.ranking_loss_weight, args.ranking_batch_size, prepared,
                        args.fixed_source_batch_fraction,
                        args.self_source_batch_fraction,
                        args.fixed_source_pass_fraction,
                        args.proposal_branch_weight,
                        args.actor_pass_negative_weight,
                        args.actor_boundary_gradient_weight,
                        args.exact_actor_source,
                        timings if args.profile_detail else None,
                        args.fixed_source_opening_fraction)
                break
            with timings.measure("evaluation", device):
                actions, generated, _, distill_groups = teacher_examples(
                    teacher, states, shape.extent, device, args.teacher_batch,
                    args.proposal_target_size,
                    timings if args.profile_detail else None)
            greedy_teacher_actions = list(actions)
            actions = target_exploration_actions(
                actions, generated, args.teacher_target_exploration_fraction,
                randomizer, args.teacher_broad_exploration_fraction,
                args.teacher_broad_exploration_pool)
            # The exhaustive targets are champion-derived, but an actually
            # sampled non-greedy action is self-generated exploration. Persist
            # that action as a positive proposal label and keep its terminal
            # return in the self route stratum.
            action_sources = [
                "self" if action != greedy else "champion"
                for action, greedy in zip(
                    actions, greedy_teacher_actions, strict=True)
            ]
            if args.self_actor_fraction:
                assert self_actor is not None
                self_actions = v9_actor_actions(
                    self_actor, states, device, args.actor_base_k, args.teacher_batch)
                for row, self_action in enumerate(self_actions):
                    if randomizer.random() < args.self_actor_fraction:
                        actions[row] = self_action
                        action_sources[row] = "self"
            elif args.exhaustive_actor_fraction:
                assert exhaustive_actor is not None
                selected_rows = [row for row in range(len(states))
                                 if randomizer.random()
                                 < args.exhaustive_actor_fraction]
                if selected_rows:
                    exhaustive_actions = v9_actor_actions(
                        exhaustive_actor, [states[row] for row in selected_rows],
                        device, args.top_k, args.teacher_batch, exhaustive=True)
                    for row, actor_action in zip(
                            selected_rows, exhaustive_actions, strict=True):
                        actions[row] = actor_action
                        action_sources[row] = "self"
            turns = [Turn(
                "^".join(reply.state for reply in state.candidates[action].replies),
                state.future_behavior,
                state.elapsed,
            ) for state, action in zip(states, actions, strict=True)]
            for state, example, turn, distilled, action, action_source in zip(
                    states, generated, turns, distill_groups, actions,
                    action_sources, strict=True):
                if state.episode % 10 == 0:
                    heldout.append(example)
                else:
                    proposals.append(example)
                    distill.extend(distilled)
                    rankings.append(RankingExample(
                        example, split_candidate_groups(distilled, len(example.moves))))
                if action_source == "self":
                    self_example = actor_proposal_example(
                        example.episode, example.state, example.behavior,
                        example.elapsed, example.moves, example.moves[action], "self")
                    if state.episode % 10 == 0:
                        heldout.append(self_example)
                    else:
                        proposals.append(self_example)
                if corpus:
                    with timings.measure("corpusSerialization"):
                        corpus.write(json.dumps(
                            corpus_record(args.profile, teacher_sha256, example, distilled),
                            separators=(",", ":")) + "\n")
                        if action_source == "self":
                            corpus.write(json.dumps(actor_corpus_record(
                                args.profile, teacher_sha256, example,
                                example.moves[action], "self"),
                                separators=(",", ":")) + "\n")
                trajectories.setdefault(state.episode, []).append(turn)
                trajectory_sources.setdefault(state.episode, set()).add(action_source)
                pending[(state.slot, state.episode, state.elapsed)] = turn
            with timings.measure("trainingUpdates", device):
                proposal_loss, value_loss, distill_loss, ranking_loss = train_updates(
                    model, optimizer, proposals, values, distill, rankings,
                    new_results * args.updates_per_game,
                    args.batch_size, device, randomizer, args.distill_weight,
                    args.value_sampling, args.proposal_loss_weight,
                    args.proposal_margin_weight, args.proposal_anchor_weight,
                    args.top_k,
                    args.mc_value_weight, mc_value_loss_weights,
                    distill_value_loss_weights,
                    args.ranking_loss_weight, args.ranking_batch_size, prepared,
                    args.fixed_source_batch_fraction,
                    args.self_source_batch_fraction,
                    args.fixed_source_pass_fraction,
                    args.proposal_branch_weight,
                    args.actor_pass_negative_weight,
                    args.actor_boundary_gradient_weight,
                    args.exact_actor_source,
                    timings if args.profile_detail else None,
                    args.fixed_source_opening_fraction)
            for state, action in zip(states, actions, strict=True):
                assert environment.stdin is not None
                environment.stdin.write(f"A\t{state.slot}\t{state.episode}\t{action}\n")
            assert environment.stdin is not None
            environment.stdin.write("GO\n")
            environment.stdin.flush()
            if new_results and completed // args.checkpoint_games \
                    > last_checkpoint_games // args.checkpoint_games:
                checkpoint = output_dir / f"v9.{completed}.model"
                with timings.measure("checkpointSerialization", device):
                    save_model(model, checkpoint)
                last_checkpoint_games = completed
                with timings.measure("evaluation", device):
                    metrics, source_metrics, ranking_heldout_metrics, \
                        source_ranking_heldout_metrics = checkpoint_metrics(
                            model, heldout, heldout_rankings, device, args.top_k)
                print(json.dumps({
                    "games": completed, "winRate": wins / completed,
                    "averageRounds": total_rounds / completed,
                    "normalizedScorePerRound": total_score / max(total_rounds, 1),
                    "proposalLoss": proposal_loss, "valueLoss": value_loss,
                    "distillLoss": distill_loss, "rankingLoss": ranking_loss,
                    "heldout": metrics, "sourceHeldout": source_metrics,
                    "rankingHeldout": ranking_heldout_metrics,
                    "sourceRankingHeldout": source_ranking_heldout_metrics,
                    "checkpoint": str(checkpoint),
                }), flush=True)
        if environment.wait() != 0:
            raise RuntimeError(environment.stderr.read() if environment.stderr else "V9 environment failed")
    finally:
        if corpus:
            corpus.close()
        if environment.poll() is None:
            environment.terminate()
            environment.wait()
    final = output_dir / "v9.model"
    with timings.measure("checkpointSerialization", device):
        save_model(model, final)
    with timings.measure("evaluation", device):
        metrics, source_metrics, ranking_heldout_metrics, \
            source_ranking_heldout_metrics = checkpoint_metrics(
                model, heldout, heldout_rankings, device, args.top_k)
        deployment_policy = evaluate_shortlist_policy(model, heldout, device)
        deployment_metrics = shortlist_metrics(
            model, heldout, device, args.actor_base_k,
            evaluated=deployment_policy, adaptive=True)
        deployment_source_metrics = {
            source: shortlist_metrics(
                model, heldout, device, args.actor_base_k, source,
                deployment_policy, adaptive=True)
            for source in (
                "katago", "handcrafted", CERTIFIED_ACTOR_SOURCE, "self")
            if any(example.source == source for example in heldout)
        }
    pass_gate = deployment_metrics["passPositions"] >= args.min_gate_pass_positions \
        and deployment_metrics["passRecall"] >= args.min_pass_recall
    bait_gate = args.profile == "small5" or (
        deployment_metrics["baitPositions"] >= args.min_gate_bait_positions
        and deployment_metrics["baitRecall"] >= args.min_bait_recall)
    shortlist_data_allowed = deployment_metrics["positions"] >= args.min_gate_positions \
        and deployment_metrics["topKRecall"] >= args.min_top_k_recall \
        and deployment_metrics["setRecall"] >= args.min_set_recall \
        and pass_gate and bait_gate
    with timings.measure("evaluation", device):
        final_parity = verify_cpp(model, final, args.oracle, device)
    end_to_end_seconds = time.perf_counter() - end_to_end_started
    self_usage = resource.getrusage(resource.RUSAGE_SELF)
    child_usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    self_cpu_seconds = (self_usage.ru_utime + self_usage.ru_stime) \
        - (PROCESS_SELF_USAGE_STARTED.ru_utime + PROCESS_SELF_USAGE_STARTED.ru_stime)
    child_cpu_seconds = (child_usage.ru_utime + child_usage.ru_stime) \
        - (PROCESS_CHILD_USAGE_STARTED.ru_utime + PROCESS_CHILD_USAGE_STARTED.ru_stime)
    accelerator_memory: dict[str, int] = {}
    if device.type == "cuda":
        accelerator_memory = {
            "allocatedBytes": torch.cuda.memory_allocated(device),
            "reservedBytes": torch.cuda.memory_reserved(device),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(device),
            "peakReservedBytes": torch.cuda.max_memory_reserved(device),
        }
    elif device.type == "mps":
        accelerator_memory = {
            "allocatedBytes": torch.mps.current_allocated_memory(),
            "driverAllocatedBytes": torch.mps.driver_allocated_memory(),
        }
    summary = {
        "profile": args.profile, "games": completed, "wins": wins,
        "topology": dataclasses.asdict(shape),
        "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
        "winRate": wins / max(completed, 1),
        "averageRounds": total_rounds / max(completed, 1),
        "normalizedScorePerRound": total_score / max(total_rounds, 1),
        "heldout": metrics, "sourceHeldout": source_metrics,
        "deploymentHeldout": deployment_metrics,
        "sourceDeploymentHeldout": deployment_source_metrics,
        "rankingHeldout": ranking_heldout_metrics,
        "sourceRankingHeldout": source_ranking_heldout_metrics,
        "model": str(final),
        "modelSha256": file_sha256(final),
        "elapsedSeconds": end_to_end_seconds,
        "endToEndSeconds": end_to_end_seconds,
        "onlineTrainingSeconds": time.monotonic() - online_started,
        "phaseTimings": timings.as_dict(),
        "phaseCounts": timings.counts_dict(),
        "detailedProfiling": args.profile_detail,
        "cppParityRelativeError": final_parity,
        "initialCppParityRelativeError": initial_parity,
        "shortlistDataAllowed": shortlist_data_allowed,
        "shortlistGate": {
            "topK": deployment_metrics["positions"] >= args.min_gate_positions
                and deployment_metrics["topKRecall"] >= args.min_top_k_recall,
            "set": deployment_metrics["positions"] >= args.min_gate_positions
                and deployment_metrics["setRecall"] >= args.min_set_recall,
            "pass": pass_gate,
            "bait": bait_gate,
        },
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "selfActorFraction": args.self_actor_fraction,
        "actorBaseK": args.actor_base_k,
        "exactActorSource": args.exact_actor_source,
        "exhaustiveActorFraction": args.exhaustive_actor_fraction,
        "exhaustiveActorSha256": exhaustive_actor_sha256,
        "teacherTargetExplorationFraction": args.teacher_target_exploration_fraction,
        "teacherBroadExplorationFraction": args.teacher_broad_exploration_fraction,
        "teacherBroadExplorationPool": args.teacher_broad_exploration_pool,
        "device": str(device),
        "torchVersion": torch.__version__,
        "cudaVersion": torch.version.cuda,
        "cudaTf32Enabled": device.type == "cuda" and (
            torch.backends.cuda.matmul.allow_tf32 or torch.backends.cudnn.allow_tf32),
        "pythonVersion": platform.python_version(),
        "platform": platform.platform(),
        "batchSize": args.batch_size,
        "teacherBatch": args.teacher_batch,
        "pretrainUpdates": args.pretrain_updates,
        "pretrainUpdatesPerSecond": args.pretrain_updates
            / max(timings.seconds["pretraining"], 1e-9),
        "acceleratorMemory": accelerator_memory,
        "acceleratorName": torch.cuda.get_device_name(device) if device.type == "cuda"
            else "Apple Metal Performance Shaders" if device.type == "mps" else None,
        "processCpuSeconds": self_cpu_seconds,
        "sidecarCpuSeconds": child_cpu_seconds,
        "aggregateCpuUtilizationPercent": 100 * (self_cpu_seconds + child_cpu_seconds)
            / max(end_to_end_seconds, 1e-9),
        "replayCache": replay_cache,
        "corpusSha256": cache_metadata["corpusSha256"],
        "trainingConfig": {
            "learningRate": args.learning_rate,
            "weightDecay": args.weight_decay,
            "valueHeadOnly": args.value_head_only,
            "proposalHeadOnly": args.proposal_head_only,
            "passHeadOnly": args.pass_head_only,
            "trainTailBlocks": args.train_tail_blocks,
            "conditioningOnly": args.conditioning_only,
            "proposalLossWeight": args.proposal_loss_weight,
            "proposalMarginWeight": args.proposal_margin_weight,
            "proposalAnchorWeight": args.proposal_anchor_weight,
            "proposalBranchWeight": args.proposal_branch_weight,
            "actorPassNegativeWeight": args.actor_pass_negative_weight,
            "actorBoundaryGradientWeight": args.actor_boundary_gradient_weight,
            "trainingTopK": args.top_k,
            "actorBaseK": args.actor_base_k,
            "mcValueWeight": args.mc_value_weight,
            "mcWinLossWeight": mc_value_loss_weights[0],
            "mcScoreLossWeight": mc_value_loss_weights[1],
            "mcRemainingLossWeight": mc_value_loss_weights[2],
            "distillWeight": args.distill_weight,
            "rankingLossWeight": args.ranking_loss_weight,
            "rankingBatchSize": args.ranking_batch_size,
        "exactRankingSource": args.exact_ranking_source,
        "reinitializedZeroValueHead": args.reinitialize_zero_value_head,
            "valueSampling": args.value_sampling,
            "winLossWeight": args.win_loss_weight,
            "scoreLossWeight": args.score_loss_weight,
            "remainingLossWeight": args.remaining_loss_weight,
            "fixedSourceBatchFraction": args.fixed_source_batch_fraction,
            "selfSourceBatchFraction": args.self_source_batch_fraction,
            "fixedSourcePassFraction": args.fixed_source_pass_fraction,
            "fixedSourceOpeningFraction": args.fixed_source_opening_fraction,
        },
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19"), required=True)
    result.add_argument("--teacher", required=True, help="frozen promoted V9 exhaustive value teacher")
    result.add_argument("--init", help="optional V9 checkpoint; otherwise initialize cleanly")
    result.add_argument("--out-dir", required=True)
    result.add_argument("--channels", type=int, default=0,
                        help="student trunk width; 0 uses the profile default")
    result.add_argument("--blocks", type=int, default=0,
                        help="student residual block count; 0 uses the profile default")
    result.add_argument("--hidden", type=int, default=0,
                        help="student value hidden width; 0 uses the profile default")
    result.add_argument("--tower", type=int, default=0,
                        help="student value tower width; 0 uses the profile default")
    result.add_argument("--global-policy-rank", type=int, default=0,
                        help="low-rank whole-board policy correction; 0 disables")
    result.add_argument("--tactical-features", action="store_true",
                        help="append exact liberty/capture/self-atari/connection planes")
    result.add_argument("--games", type=int, default=4096)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    result.add_argument("--profile-detail", action="store_true",
                        help="synchronize phase boundaries for accelerator/IPC profiling")
    result.add_argument("--environment", default=str(GO_AI / "build/release/go_cpp_gpu_env"))
    result.add_argument("--oracle", default=str(GO_AI / "build/release/go_cpp_oracle"))
    result.add_argument("--environments", type=int, default=64)
    result.add_argument("--cpu-threads", type=int, default=12)
    result.add_argument("--learning-rate", type=float, default=1e-4)
    result.add_argument("--weight-decay", type=float, default=1e-6)
    result.add_argument("--batch-size", type=int, default=128)
    result.add_argument("--teacher-batch", type=int, default=4096,
                        help="maximum exhaustive reply boards per frozen-teacher dispatch")
    result.add_argument("--updates-per-game", type=int, default=2)
    result.add_argument("--proposal-replay", type=int, default=100_000)
    result.add_argument("--value-replay", type=int, default=200_000)
    result.add_argument("--distill-replay", type=int, default=200_000)
    result.add_argument("--ranking-replay", type=int, default=2_000,
                        help="complete exhaustive candidate groups retained for value ordering")
    result.add_argument("--distill-weight", type=float, default=1.0,
                        help="weight of exhaustive frozen-teacher value imitation")
    result.add_argument("--proposal-loss-weight", type=float, default=1.0)
    result.add_argument("--proposal-margin-weight", type=float, default=0.25,
                        help="weight for keeping every desired set move above the deployment top-K boundary")
    result.add_argument("--proposal-anchor-weight", type=float, default=0.5,
                        help="weight for ordering the safe anchor above the other desired moves")
    result.add_argument("--proposal-branch-weight", type=float, default=0.25,
                        help="weight of exact per-candidate enemy-response branch supervision")
    result.add_argument("--actor-pass-negative-weight", type=float, default=0.05,
                        help="relative non-pass adviser evidence against the global pass logit")
    result.add_argument("--actor-boundary-gradient-weight", type=float, default=1.0,
                        help="adviser top-K margin gradient applied to the occupying boundary outsider")
    result.add_argument(
        "--exact-actor-source",
        choices=("katago", "handcrafted", "self", CERTIFIED_ACTOR_SOURCE),
        help="load only this actor source and clone its executed action with legal-move cross "
             "entropy. `self` covers actions the deployed player should make that no fixed "
             "teacher proposes, such as lookahead-derived opponent exploits")
    result.add_argument("--mc-value-weight", type=float, default=1.0)
    result.add_argument("--fixed-source-batch-fraction", type=float, default=0.25,
                        help="batch share reserved for each of KataGo and handcrafted replay")
    result.add_argument("--self-source-batch-fraction", type=float, default=0.25,
                        help="batch share reserved for self-route replay when present")
    result.add_argument("--fixed-source-pass-fraction", type=float, default=0.05,
                        help="pass-positive share inside each fixed-teacher proposal quota")
    result.add_argument(
        "--fixed-source-opening-fraction", type=float, default=0,
        help="elapsed-zero non-pass share inside each fixed-teacher proposal quota")
    result.add_argument("--mc-win-loss-weight", type=float,
                        help="Monte Carlo win loss weight; defaults to --win-loss-weight")
    result.add_argument("--mc-score-loss-weight", type=float,
                        help="Monte Carlo score loss weight; defaults to --score-loss-weight")
    result.add_argument("--mc-remaining-loss-weight", type=float,
                        help="Monte Carlo remaining-turn loss weight; defaults to --remaining-loss-weight")
    result.add_argument("--win-loss-weight", type=float, default=1.0)
    result.add_argument("--score-loss-weight", type=float, default=1.0)
    result.add_argument("--remaining-loss-weight", type=float, default=1.0)
    result.add_argument("--ranking-loss-weight", type=float, default=0.0,
                        help="weight of exhaustive post-reply candidate-order loss")
    result.add_argument("--ranking-batch-size", type=int, default=2,
                        help="complete positions per ranking update (each includes every candidate)")
    result.add_argument("--exact-ranking-source",
                        choices=("champion", "katago", "handcrafted", "counterfactual"),
                        help="load only this ranking authority for a bounded ablation")
    result.add_argument("--value-head-only", action="store_true",
                        help="freeze shared trunk and proposal/branch heads")
    result.add_argument(
        "--reinitialize-zero-value-head", action="store_true",
        help="deterministically initialize a policy-only checkpoint's all-zero value MLP")
    result.add_argument("--proposal-head-only", action="store_true",
                        help="freeze shared trunk and value head")
    result.add_argument("--pass-head-only", action="store_true",
                        help="freeze every parameter except the global pass policy head")
    result.add_argument("--conditioning-only", action="store_true",
                        help="train only the per-block enemy-behaviour conditioning "
                             "linears; every spatial tensor and head stays bit-exact")
    result.add_argument("--train-tail-blocks", type=int, default=0,
                        help="train all heads plus only the last N residual/conditioning blocks")
    result.add_argument("--value-sampling", choices=("uniform", "outcome", "failure"),
                        default="uniform",
                        help="terminal replay distribution; uniform preserves the corpus")
    result.add_argument("--checkpoint-games", type=int, default=512)
    result.add_argument("--corpus-in", action="append", default=[],
                        help="versioned gzip JSONL exhaustive corpus to preload; repeatable")
    result.add_argument("--replay-cache-dir",
                        help="content-addressed packed tensor cache (never trusts mismatched metadata)")
    result.add_argument("--corpus-out", help="gzip JSONL exhaustive proposal corpus")
    result.add_argument("--pretrain-updates", type=int, default=0,
                        help="optimizer updates from --corpus-in before new games; active loss weights decide which heads train")
    result.add_argument("--pretrain-checkpoint-updates", type=int, default=0,
                        help="emit replay checkpoint and held-out metrics every N updates; 0 only reports the endpoint")
    result.add_argument("--self-actor-fraction", type=float, default=0,
                        help="fraction of trajectories chosen by gated V9 shortlist/value actor")
    result.add_argument("--exhaustive-actor-fraction", type=float, default=0,
                        help="fraction chosen by a fixed actor that values every legal candidate")
    result.add_argument("--exhaustive-actor-model",
                        help="fixed V9 value actor; exhaustive use bypasses the shortlist gate")
    result.add_argument("--exhaustive-actor-summary",
                        help="hash/parity summary for --exhaustive-actor-model (recall may fail)")
    result.add_argument("--teacher-target-exploration-fraction", type=float, default=0,
                        help="fraction of online turns sampled uniformly from the exhaustive teacher's safe/upside target set")
    result.add_argument("--teacher-broad-exploration-fraction", type=float, default=0,
                        help="fraction sampled from non-targets in the best exhaustive candidate pool")
    result.add_argument("--teacher-broad-exploration-pool", type=int, default=16,
                        help="lowest-regret exhaustive candidates eligible for broad exploration")
    result.add_argument("--self-actor-summary",
                        help="prior unseen summary proving --init may generate shortlist trajectories")
    result.add_argument("--top-k", type=int, default=0,
                        help="training loss/recall K (default: 8 small5, 16 daemon19)")
    result.add_argument("--actor-base-k", type=int, default=DEPLOYMENT_BASE_K,
                        help="learned actor base K before deployment's adaptive expansion (default: 8)")
    result.add_argument("--proposal-target-size", type=int, default=4,
                        help="one safe anchor plus diverse high-upside candidates")
    result.add_argument("--min-gate-positions", type=int, default=10_000)
    result.add_argument("--min-top-k-recall", type=float, default=0.995)
    result.add_argument("--min-set-recall", type=float, default=0.99)
    result.add_argument("--min-gate-pass-positions", type=int, default=25)
    result.add_argument("--min-pass-recall", type=float, default=0.995)
    result.add_argument("--min-gate-bait-positions", type=int, default=100)
    result.add_argument("--min-bait-recall", type=float, default=0.995)
    return result


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except Exception as error:
        print(error, file=sys.stderr)
        raise
