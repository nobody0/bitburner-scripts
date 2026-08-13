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
import json
import math
import os
import pathlib
import platform
import random
import resource
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Sequence

PROCESS_SELF_USAGE_STARTED = resource.getrusage(resource.RUSAGE_SELF)
PROCESS_CHILD_USAGE_STARTED = resource.getrusage(resource.RUSAGE_CHILDREN)

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from device import auto_device

GO_AI = pathlib.Path(__file__).resolve().parents[1]
BRANCHES = 13
BASE_BEHAVIOR = 30
CORPUS_SCHEMA = "bitburner-go-exhaustive-proposals-v9.4"
OPPONENT_ORACLE = "bitburner-go-ai-v3.0.1"
REPLAY_CACHE_SCHEMA = "bitburner-go-v9-packed-replay-v1"
ENCODING_VERSION = "v9-state-planes-u8-v1"


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

    def as_dict(self) -> dict[str, float]:
        return dict(sorted(self.seconds.items()))


@dataclasses.dataclass(frozen=True)
class V9Shape:
    extent: int
    channels: int
    blocks: int
    hidden: int = 256
    tower: int = 64
    behavior: int = BASE_BEHAVIOR


class V9Net(nn.Module):
    def __init__(self, shape: V9Shape, device: torch.device, seed: int = 0):
        super().__init__()
        self.shape = shape
        torch.manual_seed(seed)
        c, b, h, t = shape.channels, shape.blocks, shape.hidden, shape.tower
        pooled = c * 25
        self.stem = nn.Parameter(torch.empty(c, 8, 3, 3, device=device))
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


PARAMETERS = (
    "stem", "stem_bias", "residual", "residual_bias", "conditioning_w", "conditioning_b",
    "value_w1", "value_b1", "value_w2", "value_b2", "value_out_w", "value_out_b",
    "policy_w", "policy_b", "pass_w", "pass_b", "branch_w", "branch_b",
    "pass_branch_w", "pass_branch_b",
)


def save_model(model: V9Net, path: pathlib.Path) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    shape = model.shape
    with temporary.open("w") as output:
        output.write("bitburner-go-value-v9\n")
        output.write(
            f"{shape.extent} {shape.channels} {shape.blocks} {shape.hidden} "
            f"{shape.tower} {shape.behavior} {BRANCHES}\n")
        for name in PARAMETERS:
            values = getattr(model, name).detach().cpu().to(torch.float64).flatten().tolist()
            output.write(str(len(values)))
            for value in values:
                output.write(f" {value:.17g}")
            output.write("\n")
    os.replace(temporary, path)


def load_v9(path: pathlib.Path, device: torch.device) -> V9Net:
    tokens = path.read_text().split()
    if not tokens or tokens[0] != "bitburner-go-value-v9":
        raise ValueError("not a V9 checkpoint")
    extent, channels, blocks, hidden, tower, behavior, branches = map(int, tokens[1:8])
    if branches != BRANCHES:
        raise ValueError("unsupported response-branch count")
    model = V9Net(V9Shape(extent, channels, blocks, hidden, tower, behavior), device)
    offset = 8
    with torch.no_grad():
        for name in PARAMETERS:
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
    if magic != "bitburner-go-value-v9":
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


def decode_state_planes(values: Tensor, device: torch.device) -> Tensor:
    result = values.to(device=device, dtype=torch.float32)
    result[:, 4].mul_(0.5)
    return result


def encode_states(values: Sequence[str], extent: int, device: torch.device) -> Tensor:
    """Encode on CPU and perform one bulk host-to-device transfer per batch."""
    if not values:
        return torch.empty((0, 8, extent, extent), dtype=torch.float32, device=device)
    return decode_state_planes(
        torch.stack([encode_state_planes(encoded, extent) for encoded in values]), device)


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
    """Condition value only on information that remains true after the reply.

    Daemon19 has one fixed opponent, so its just-consumed WHRNG signature is
    pure label noise for the future position. Small5 spans several opponents;
    until V9 has a dedicated stable future-policy descriptor, retain its full
    signature rather than making different opponent policies indistinguishable.
    """
    if extent >= 19:
        return torch.zeros((len(values), features), dtype=torch.float32, device=device)
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


@dataclasses.dataclass
class ValueExample:
    state: str
    behavior: list[float]
    elapsed: int
    won: float
    score: float
    remaining: float
    weight: float


@dataclasses.dataclass
class DistillExample:
    state: str
    behavior: list[float]
    elapsed: int
    won: float
    score: float
    remaining: float
    weight: float


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
        self, examples: Sequence[ProposalExample], device: torch.device,
    ) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor]:
        rows = torch.tensor([value.prepared_proposal_row for value in examples])
        return (
            self.proposal_valid.index_select(0, rows).to(device),
            self.proposal_targets.index_select(0, rows).to(device),
            self.proposal_anchors.index_select(0, rows).to(device),
            self.proposal_branches.index_select(0, rows).to(device),
            self.proposal_behavior.index_select(0, rows).to(device),
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
    proposal_limit: int, distill_limit: int, ranking_limit: int, seed: int,
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
        "distillReplay": distill_limit,
        "rankingReplay": ranking_limit,
        "reservoirSeed": seed,
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
        state_planes = torch.stack([
            encode_state_planes(value, shape.extent) for value in state_keys]) \
            if state_keys else torch.empty((0, 8, shape.extent, shape.extent), dtype=torch.uint8)
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
                len(expected_states), 8, shape.extent, shape.extent) \
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
        "profile": profile,
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "split": "heldout" if example.episode % 10 == 0 else "train",
        "example": dataclasses.asdict(example),
        "distill": [dataclasses.asdict(value) for value in distill],
    }


def load_corpora(
    paths: list[str],
    profile: str,
    teacher_sha256: str,
    proposal_limit: int | None = None,
    distill_limit: int | None = None,
    ranking_limit: int | None = None,
    seed: int = 0,
    timings: PhaseTimings | None = None,
) -> tuple[collections.deque[ProposalExample], list[ProposalExample],
           collections.deque[DistillExample], collections.deque[RankingExample]]:
    training: collections.deque[ProposalExample] = collections.deque(
        maxlen=proposal_limit)
    heldout: list[ProposalExample] = []
    distill: collections.deque[DistillExample] = collections.deque(
        maxlen=distill_limit)
    rankings: collections.deque[RankingExample] = collections.deque(
        maxlen=ranking_limit)
    randomizer = random.Random(seed ^ 0xBB67AE85)
    seen_training = seen_distill = seen_rankings = 0

    def reservoir_append(target: collections.deque, value: object,
                         seen: int, limit: int | None) -> None:
        if limit is None or len(target) < limit:
            target.append(value)
            return
        replace = randomizer.randrange(seen)
        if replace < limit:
            target[replace] = value
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
                example = ProposalExample(**record["example"])
                if record.get("split") == "heldout":
                    heldout.append(example)
                else:
                    distilled = [DistillExample(**value) for value in record["distill"]]
                    seen_training += 1
                    reservoir_append(training, example, seen_training, proposal_limit)
                    seen_rankings += 1
                    reservoir_append(
                        rankings,
                        RankingExample(example, split_candidate_groups(
                            distilled, len(example.moves))),
                        seen_rankings, ranking_limit)
                    for value in distilled:
                        seen_distill += 1
                        reservoir_append(distill, value,
                                         seen_distill, distill_limit)
                if timings is not None:
                    timings.seconds["jsonObjectConstruction"] += time.perf_counter() - started
    return training, heldout, distill, rankings


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
    return (
        [example for example in examples
         if pass_move in example.safe_moves or pass_move in example.upside_moves],
        [example for example in examples
         if example.bait_moves and example.best_move != pass_move],
        [example for example in examples
         if not example.bait_moves and example.best_move != pass_move],
    )


def stratified_proposals(
    examples: list[ProposalExample],
    count: int,
    pass_move: int,
    randomizer: random.Random,
    strata: tuple[list[ProposalExample], list[ProposalExample],
                  list[ProposalExample]] | None = None,
) -> list[ProposalExample]:
    if strata is None:
        pass_best, bait, ordinary = proposal_strata(examples, pass_move)
    else:
        pass_best, bait, ordinary = strata
    selected: list[ProposalExample] = []
    for bucket in (pass_best, bait):
        if bucket:
            selected.extend(randomizer.choices(bucket, k=max(1, count // 4)))
    remainder = count - len(selected)
    selected.extend(randomizer.choices(ordinary or examples, k=max(remainder, 0)))
    randomizer.shuffle(selected)
    return selected[:count]


def stratified_values(
    examples: list[ValueExample],
    count: int,
    randomizer: random.Random,
    sampling: str,
    strata: tuple[list[ValueExample], list[ValueExample]] | None = None,
) -> list[ValueExample]:
    if sampling == "uniform":
        return randomizer.choices(examples, k=count)
    if strata is None:
        wins = [example for example in examples if example.won >= 0.5]
        losses = [example for example in examples if example.won < 0.5]
    else:
        wins, losses = strata
    if not wins or not losses:
        return randomizer.choices(examples, k=count)
    loss_count = 3 * count // 4 if sampling == "failure" else count // 2
    result = randomizer.choices(losses, k=loss_count)
    result.extend(randomizer.choices(wins, k=count - loss_count))
    randomizer.shuffle(result)
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


def read_block(process: subprocess.Popen[str]) -> tuple[list[State], list[list[str]], bool]:
    states: list[State] = []
    events: list[list[str]] = []
    while True:
        line = process.stdout.readline() if process.stdout else ""
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"V9 environment exited early: {stderr}")
        parts = line.rstrip("\n").split("\t")
        if parts[0] == "S9":
            count = int(parts[7])
            records = parts[8:]
            if len(records) != count:
                raise RuntimeError("V9 candidate count mismatch")
            states.append(State(
                int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]),
                [float(value) for value in parts[5].split(",")], parts[6],
                [parse_candidate(record) for record in records]))
        elif parts[0] in ("T", "R"):
            events.append(parts)
        elif parts[0] == "READY":
            return states, events, False
        elif parts[0] == "DONE":
            return states, events, True
        else:
            raise RuntimeError(f"unknown V9 environment record: {parts[0]}")


@torch.no_grad()
def teacher_examples(
    teacher: nn.Module,
    states: list[State],
    extent: int,
    device: torch.device,
    teacher_batch: int,
    proposal_target_size: int,
) -> tuple[list[int], list[ProposalExample], list[Turn], list[list[DistillExample]]]:
    reply_states = [reply.state for state in states for candidate in state.candidates for reply in candidate.replies]
    opponent_values = [
        state.opponent for state in states for candidate in state.candidates for _ in candidate.replies
    ]
    behavior_values = [
        state.behavior for state in states for candidate in state.candidates for _ in candidate.replies
    ]
    elapsed = [state.elapsed + 1 for state in states for candidate in state.candidates for _ in candidate.replies]
    decoded_chunks: list[Tensor] = []
    for start in range(0, len(reply_states), teacher_batch):
        stop = min(start + teacher_batch, len(reply_states))
        inputs = set_elapsed(
            encode_states(reply_states[start:stop], extent, device),
            elapsed[start:stop], extent)
        behavior = post_reply_behavior(
            behavior_values[start:stop], extent, teacher.shape.behavior, device)
        raw = teacher.forward_value(inputs, behavior)
        decoded_chunks.append(torch.cat((
            torch.sigmoid(raw[:, :1]),
            torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
        ), dim=1).detach().cpu())
    decoded = torch.cat(decoded_chunks)
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
                    reply.state, state.behavior, state.elapsed + 1,
                    reply_win, reply_score, remaining, reply.probability))
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
                          state.behavior, state.elapsed))
        distill_groups.append(distill)
    return actions, examples, turns, distill_groups


@torch.no_grad()
def v9_actor_actions(
    model: V9Net,
    states: list[State],
    device: torch.device,
    top_k: int,
    inference_batch: int,
    win_tolerance: float = 0.0,
    proposal_only: bool = False,
) -> list[int]:
    """Choose through the deployed proposal->exact-reply-value pipeline.

    The sidecar has already emitted exhaustive replies, but only replies under
    the learned top K enter the actor value pass. Callers must validate a prior
    unseen recall gate before invoking this function.
    """
    model.eval()
    original = set_elapsed(
        encode_states([state.original for state in states], model.shape.extent, device),
        [state.elapsed for state in states], model.shape.extent)
    behavior = torch.tensor(
        [state.behavior for state in states], dtype=torch.float32, device=device)
    policy = model.forward_policy(original, behavior)
    finalists: list[list[int]] = []
    reply_records: list[tuple[int, int, Reply]] = []
    for row, state in enumerate(states):
        move_ids = torch.tensor(
            [candidate.move for candidate in state.candidates], dtype=torch.long, device=device)
        local = torch.topk(policy[row, move_ids], min(top_k, len(state.candidates))).indices.tolist()
        finalists.append(local)
        for candidate_index in local:
            for reply in state.candidates[candidate_index].replies:
                reply_records.append((row, candidate_index, reply))

    if proposal_only:
        return [candidates[0] for candidates in finalists]

    decoded_chunks: list[Tensor] = []
    for start in range(0, len(reply_records), inference_batch):
        chunk = reply_records[start:start + inference_batch]
        inputs = set_elapsed(
            encode_states([record[2].state for record in chunk], model.shape.extent, device),
            [states[record[0]].elapsed + 1 for record in chunk], model.shape.extent)
        chunk_behavior = post_reply_behavior(
            [states[record[0]].behavior for record in chunk],
            model.shape.extent, model.shape.behavior, device)
        raw = model.forward_value(inputs, chunk_behavior)
        decoded_chunks.append(torch.cat((
            torch.sigmoid(raw[:, :1]),
            torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40)),
        ), dim=1).cpu())
    decoded = torch.cat(decoded_chunks)
    qualities: list[dict[int, tuple[float, float]]] = [dict() for _ in states]
    for index, (row, candidate_index, reply) in enumerate(reply_records):
        value = decoded[index]
        reply = reply_records[index][2]
        decoded_win, decoded_score, decoded_remaining = map(float, value)
        win = decoded_win if reply.terminal_win is None else reply.terminal_win
        score = decoded_score if reply.terminal_score is None else reply.terminal_score
        remaining = decoded_remaining if reply.terminal_score is None else 1.0
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
        actions.append(max(plausible, key=lambda candidate: (
            qualities[row][candidate][1], qualities[row][candidate][0], -candidate)))
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
    positive_count = positives.sum(dim=1).clamp_min(1)
    negative_count = negatives.sum(dim=1).clamp_min(1)
    positive_loss = (F.softplus(-policy) * positives).sum(dim=1) / positive_count
    negative_loss = (F.softplus(policy) * negatives).sum(dim=1) / negative_count
    # A shortlist needs one dependable anchor as well as diverse speculative
    # moves. The set loss deliberately does not order its four positives, so
    # supervise the exhaustive teacher-best move separately.
    anchor_loss = F.cross_entropy(policy.masked_fill(~valid, -torch.inf), anchors)
    minimum_positive = policy.masked_fill(~positives, torch.inf).min(dim=1).values
    if shortlist_k is None:
        boundary_negative = policy.masked_fill(~negatives, -torch.inf).max(dim=1).values
        has_boundary = negatives.any(dim=1)
        pairwise = torch.where(
            has_boundary,
            F.softplus(0.5 - minimum_positive + boundary_negative),
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
        # Set recall scores every desired move, so give every positive a
        # boundary gradient. Updating only the current minimum rotates slowly
        # between positives and plateaued well below the four-move gate.
        per_positive_margin = F.softplus(
            0.5 - policy + boundary_negative[:, None]) * positives
        pairwise = torch.where(
            has_boundary,
            per_positive_margin.sum(dim=1) / positive_count,
            torch.zeros_like(minimum_positive))

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
    return (positive_loss + negative_loss + margin_weight * pairwise).mean() \
        + anchor_weight * anchor_loss + 0.25 * branch_loss.mean()


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
    value_loss_weights: tuple[float, float, float],
    ranking_weight: float,
    ranking_batch_size: int,
    prepared: PreparedReplay | None = None,
) -> tuple[float, float, float, float]:
    if updates <= 0 or (not proposals and not values and not distill and not rankings):
        return 0.0, 0.0, 0.0, 0.0
    # MPS does not implement float64 tensors. Accumulating a few thousand
    # scalar losses in float32 is ample precision and keeps this off the
    # per-update CPU synchronization path.
    loss_totals = torch.zeros(4, dtype=torch.float32, device=device)
    model.train()
    proposal_values = list(proposals)
    value_values = list(values)
    distill_values = list(distill)
    ranking_values = list(rankings)
    # Replay is immutable for this update group. Building these strata inside
    # every optimizer step rescanned up to 100k/200k Python objects and starved
    # CUDA between otherwise fast kernels.
    pass_move = model.shape.extent * model.shape.extent
    cached_proposal_strata = proposal_strata(proposal_values, pass_move)
    value_strata = None if value_sampling == "uniform" else (
        [example for example in value_values if example.won >= 0.5],
        [example for example in value_values if example.won < 0.5],
    )
    for _ in range(updates):
        proposal_loss = torch.tensor(0.0, device=device)
        if proposal_values and proposal_weight > 0:
            count = min(batch_size, len(proposal_values))
            batch = stratified_proposals(
                proposal_values, count, pass_move, randomizer, cached_proposal_strata)
            states = prepared.inputs(batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in batch) else set_elapsed(
                    encode_states([example.state for example in batch], model.shape.extent, device),
                    [example.elapsed for example in batch], model.shape.extent)
            prepared_proposal = prepared.proposal_batch(batch, device) \
                if prepared is not None and prepared.holds_proposals(batch) else None
            behavior = prepared_proposal[4] if prepared_proposal is not None else torch.tensor(
                [example.behavior for example in batch], dtype=torch.float32, device=device)
            policy, branch_logits = model.forward_proposal(states, behavior)
            proposal_loss = proposal_objective(
                policy, branch_logits, batch, device, prepared, prepared_proposal,
                proposal_margin_weight, proposal_shortlist_k,
                proposal_anchor_weight)
        value_loss = torch.tensor(0.0, device=device)
        if value_values and mc_value_weight > 0:
            value_batch = stratified_values(
                value_values, min(batch_size, len(value_values)), randomizer,
                value_sampling, value_strata)
            value_inputs = prepared.inputs(value_batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in value_batch) else set_elapsed(
                    encode_states([example.state for example in value_batch], model.shape.extent, device),
                    [example.elapsed for example in value_batch], model.shape.extent)
            packed_values = prepared is not None \
                and prepared.holds_values(value_batch)
            if packed_values:
                value_target, value_behavior = prepared.value_batch(value_batch, device)
                if model.shape.extent >= 19:
                    value_behavior = torch.zeros_like(value_behavior)
            else:
                value_target = None
                value_behavior = post_reply_behavior(
                    [example.behavior for example in value_batch],
                    model.shape.extent, model.shape.behavior, device)
            raw = model.forward_value(value_inputs, value_behavior)
            won = value_target[:, 0] if value_target is not None else torch.tensor(
                [example.won for example in value_batch], device=device)
            log_score = value_target[:, 1] if value_target is not None else torch.log1p(
                torch.tensor([example.score for example in value_batch], device=device))
            log_remaining = value_target[:, 2] if value_target is not None else torch.log1p(
                torch.tensor([example.remaining for example in value_batch], device=device))
            weights = value_target[:, 3] if value_target is not None else torch.tensor(
                [example.weight for example in value_batch], device=device)
            per_example = value_loss_weights[0] * F.binary_cross_entropy_with_logits(
                raw[:, 0], won, reduction="none") \
                + value_loss_weights[1] * torch.square(
                    F.softplus(raw[:, 1]) - log_score) \
                + value_loss_weights[2] * torch.square(
                    F.softplus(raw[:, 2]) - log_remaining)
            value_loss = (per_example * weights).sum() / weights.sum().clamp_min(1e-9)
        distill_loss = torch.tensor(0.0, device=device)
        if distill_values and distill_weight > 0:
            distill_batch = randomizer.choices(
                distill_values, k=min(batch_size, len(distill_values)))
            distill_inputs = prepared.inputs(distill_batch, device) if prepared is not None \
                and all(example.state in prepared.state_rows for example in distill_batch) else set_elapsed(
                    encode_states([example.state for example in distill_batch], model.shape.extent, device),
                    [example.elapsed for example in distill_batch], model.shape.extent)
            packed_distill = prepared is not None \
                and prepared.holds_values(distill_batch)
            if packed_distill:
                distill_target, distill_behavior = prepared.value_batch(distill_batch, device)
                if model.shape.extent >= 19:
                    distill_behavior = torch.zeros_like(distill_behavior)
            else:
                distill_target = None
                distill_behavior = post_reply_behavior(
                    [example.behavior for example in distill_batch],
                    model.shape.extent, model.shape.behavior, device)
            distill_raw = model.forward_value(distill_inputs, distill_behavior)
            distill_won = distill_target[:, 0] if distill_target is not None else torch.tensor(
                [example.won for example in distill_batch], device=device)
            distill_score = distill_target[:, 1] if distill_target is not None else torch.log1p(
                torch.tensor([example.score for example in distill_batch], device=device))
            distill_remaining = distill_target[:, 2] if distill_target is not None else torch.log1p(
                torch.tensor([example.remaining for example in distill_batch], device=device))
            distill_weights = distill_target[:, 3] if distill_target is not None else torch.tensor(
                [example.weight for example in distill_batch], device=device)
            distill_per_example = value_loss_weights[0] * F.binary_cross_entropy_with_logits(
                distill_raw[:, 0], distill_won, reduction="none") \
                + value_loss_weights[1] * torch.square(
                    F.softplus(distill_raw[:, 1]) - distill_score) \
                + value_loss_weights[2] * torch.square(
                    F.softplus(distill_raw[:, 2]) - distill_remaining)
            distill_loss = (distill_per_example * distill_weights).sum() \
                / distill_weights.sum().clamp_min(1e-9)
        ranking_loss = torch.tensor(0.0, device=device)
        if ranking_values and ranking_weight > 0:
            ranking_batch = randomizer.choices(
                ranking_values, k=min(ranking_batch_size, len(ranking_values)))
            flat = [value for example in ranking_batch
                    for candidate in example.candidates for value in candidate]
            ranking_inputs = prepared.inputs(flat, device) if prepared is not None \
                and all(value.state in prepared.state_rows for value in flat) else set_elapsed(
                    encode_states([value.state for value in flat], model.shape.extent, device),
                    [value.elapsed for value in flat], model.shape.extent)
            packed_ranking = prepared is not None \
                and prepared.holds_values(flat)
            if packed_ranking:
                ranking_targets, ranking_behavior = prepared.value_batch(flat, device)
                if model.shape.extent >= 19:
                    ranking_behavior = torch.zeros_like(ranking_behavior)
            else:
                ranking_targets = None
                ranking_behavior = post_reply_behavior(
                    [value.behavior for value in flat], model.shape.extent,
                    model.shape.behavior, device)
            ranking_raw = model.forward_value(ranking_inputs, ranking_behavior)
            ranking_decoded = torch.cat((
                torch.sigmoid(ranking_raw[:, :1]),
                torch.expm1(torch.clamp(F.softplus(ranking_raw[:, 1:]), max=40)),
            ), dim=1)
            position_losses: list[Tensor] = []
            offset = 0
            for example in ranking_batch:
                candidate_wins: list[Tensor] = []
                candidate_rates: list[Tensor] = []
                teacher_wins: list[float] = []
                for candidate in example.candidates:
                    rows = ranking_decoded[offset:offset + len(candidate)]
                    offset += len(candidate)
                    probabilities = ranking_targets[
                        offset - len(candidate):offset, 3] if ranking_targets is not None else torch.tensor(
                            [value.weight for value in candidate], device=device)
                    win = (probabilities * rows[:, 0]).sum()
                    rate = (probabilities * rows[:, 1]
                            / torch.clamp(example.proposal.elapsed + rows[:, 2], min=1e-6)).sum()
                    candidate_wins.append(win)
                    candidate_rates.append(rate)
                    teacher_wins.append(sum(value.weight * value.won for value in candidate))
                best = example.proposal.moves.index(example.proposal.best_move)
                # Deployment is lexicographic: win first, then Power/turn.
                # The quadratic win score gives improvements near an already
                # high win rate more leverage, matching streak value without
                # allowing faster losses to trade against wins.
                primary = F.cross_entropy(
                    (8 * torch.stack(candidate_wins).square())[None, :],
                    torch.tensor([best], device=device))
                tied = [index for index, won in enumerate(teacher_wins)
                        if abs(won - teacher_wins[best]) <= 1e-5]
                if len(tied) > 1:
                    tied_best = tied.index(best)
                    efficiency = F.cross_entropy(
                        (4 * torch.stack([candidate_rates[index]
                                          for index in tied]))[None, :],
                        torch.tensor([tied_best], device=device))
                    primary = primary + 0.25 * efficiency
                position_losses.append(primary)
            ranking_loss = torch.stack(position_losses).mean()
        loss = proposal_weight * proposal_loss + mc_value_weight * value_loss \
            + distill_weight * distill_loss + ranking_weight * ranking_loss
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
        optimizer.step()
        loss_totals += torch.stack((proposal_loss, value_loss, distill_loss, ranking_loss)) \
            .detach().to(torch.float32)
    # One scalar synchronization per train_updates call instead of four per
    # optimizer update. The values are reporting-only and never affect steps.
    totals = loss_totals.cpu().tolist()
    return tuple(value / updates for value in totals)


@torch.no_grad()
def shortlist_metrics(model: V9Net, examples: list[ProposalExample], device: torch.device, k: int) -> dict[str, float]:
    if not examples:
        return {"positions": 0, "topKRecall": 0, "meanRegret": 0,
                "passPositions": 0, "passRecall": 0,
                "setTargets": 0, "setRecall": 0,
                "upsideTargets": 0, "upsideRecall": 0,
                "baitPositions": 0, "baitRecall": 0}
    hits = pass_total = pass_hits = bait_total = bait_hits = 0
    set_total = set_hits = upside_total = upside_hits = 0
    regret = 0.0
    model.eval()
    for offset in range(0, len(examples), 256):
        batch = examples[offset:offset + 256]
        states = set_elapsed(encode_states([example.state for example in batch], model.shape.extent, device),
                             [example.elapsed for example in batch], model.shape.extent)
        behavior = torch.tensor([example.behavior for example in batch], dtype=torch.float32, device=device)
        logits = model.forward_policy(states, behavior)
        for row, example in enumerate(batch):
            moves = torch.tensor(example.moves, dtype=torch.long, device=device)
            selected = torch.topk(logits[row, moves], min(k, len(example.moves))).indices.tolist()
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
            bait = set(example.bait_moves)
            bait_total += len(bait)
            bait_hits += len(bait & selected_moves)
    return {
        "positions": len(examples), "topKRecall": hits / len(examples),
        "meanRegret": regret / len(examples),
        "passPositions": pass_total,
        "passRecall": pass_hits / max(pass_total, 1),
        "setTargets": set_total,
        "setRecall": set_hits / max(set_total, 1),
        "upsideTargets": upside_total,
        "upsideRecall": upside_hits / max(upside_total, 1),
        "baitPositions": bait_total,
        "baitRecall": bait_hits / max(bait_total, 1),
    }


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
            f"|{probe.response_no_op}" for probe in probes], extent, device),
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
    if args.teacher_batch <= 0 or args.batch_size <= 0 or args.pretrain_updates < 0 \
            or args.pretrain_checkpoint_updates < 0:
        raise RuntimeError("batch sizes must be positive and pretrain updates nonnegative")
    if args.proposal_target_size <= 0 or args.proposal_target_size > args.top_k:
        raise RuntimeError("proposal target size must be positive and no larger than top K")
    if args.distill_replay <= 0 or args.ranking_replay <= 0 or args.distill_weight < 0:
        raise RuntimeError("distill/ranking replay must be positive and distill weight nonnegative")
    value_loss_weights = (
        args.win_loss_weight, args.score_loss_weight, args.remaining_loss_weight)
    if any(weight < 0 for weight in value_loss_weights) or not any(value_loss_weights):
        raise RuntimeError("value loss weights must be nonnegative with a positive sum")
    if args.proposal_loss_weight < 0 or args.proposal_margin_weight < 0 \
            or args.proposal_anchor_weight < 0 \
            or args.mc_value_weight < 0:
        raise RuntimeError("task loss weights must be nonnegative")
    if args.ranking_loss_weight < 0 or args.ranking_batch_size <= 0:
        raise RuntimeError("ranking weight must be nonnegative and its batch size positive")
    if args.value_head_only and args.proposal_loss_weight != 0:
        raise RuntimeError("--value-head-only requires --proposal-loss-weight 0")
    if args.proposal_head_only and (args.value_head_only
                                    or args.mc_value_weight != 0
                                    or args.distill_weight != 0
                                    or args.ranking_loss_weight != 0):
        raise RuntimeError(
            "--proposal-head-only requires MC/distill weights 0 and is mutually exclusive")
    if not 0 <= args.self_actor_fraction <= 1:
        raise RuntimeError("--self-actor-fraction must be in [0,1]")
    if args.self_actor_fraction:
        validate_self_actor_gate(args.self_actor_summary, args.init, args.profile)
    device = auto_device(args.device)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device cuda requested but CUDA is unavailable")
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("--device mps requested but MPS is unavailable")
    configure_accelerator(device)
    shape = V9Shape(5, 32, 4, behavior=31) if args.profile == "small5" \
        else V9Shape(19, 48, 8, behavior=30)
    with timings.measure("initialization", device):
        model = load_v9(pathlib.Path(args.init), device) if args.init \
            else V9Net(shape, device, args.seed)
        # A continuation actor is the exact hash-gated checkpoint and remains
        # immutable while the learner changes. A later learner must pass a fresh
        # recall gate before it may generate another stage's trajectories.
        self_actor = load_v9(pathlib.Path(args.init), device) \
            if args.self_actor_fraction else None
        teacher_path = pathlib.Path(args.teacher)
        teacher_sha256 = file_sha256(teacher_path)
        teacher = load_teacher(teacher_path, device)
    if model.shape != shape:
        raise RuntimeError("V9 checkpoint does not match profile")
    if isinstance(teacher, V9Net) and teacher.shape != shape:
        raise RuntimeError("V9 exhaustive value teacher does not match profile")
    teacher.eval()
    output_dir = pathlib.Path(args.out_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError("output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    initial_checkpoint = output_dir / "v9.initial.model"
    with timings.measure("checkpointSerialization", device):
        save_model(model, initial_checkpoint)
    with timings.measure("evaluation", device):
        initial_parity = verify_cpp(model, initial_checkpoint, args.oracle, device)
    if args.value_head_only:
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name.startswith("value_"))
    elif args.proposal_head_only:
        proposal_prefixes = ("policy_", "pass_", "branch_", "pass_branch_")
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name.startswith(proposal_prefixes))
    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate, weight_decay=args.weight_decay)
    proposals: collections.deque[ProposalExample] = collections.deque(maxlen=args.proposal_replay)
    values: collections.deque[ValueExample] = collections.deque(maxlen=args.value_replay)
    distill: collections.deque[DistillExample] = collections.deque(maxlen=args.distill_replay)
    rankings: collections.deque[RankingExample] = collections.deque(maxlen=args.ranking_replay)
    heldout: list[ProposalExample] = []
    if args.corpus_in:
        loaded_training, loaded_heldout, loaded_distill, loaded_rankings = load_corpora(
            args.corpus_in, args.profile, teacher_sha256,
            args.proposal_replay, args.distill_replay, args.ranking_replay, args.seed,
            timings)
        proposals.extend(loaded_training)
        heldout.extend(loaded_heldout)
        distill.extend(loaded_distill)
        rankings.extend(loaded_rankings)
        print(json.dumps({
            "loadedProposalTraining": len(loaded_training),
            "loadedProposalHeldout": len(loaded_heldout),
            "loadedValueDistill": len(loaded_distill),
            "loadedCandidateRankings": len(loaded_rankings),
        }), flush=True)
        # The bounded deques own the retained replay now. Daemon corpora can
        # contain millions of reply boards, so do not keep duplicate lists for
        # the duration of training.
        del loaded_training, loaded_heldout, loaded_distill, loaded_rankings
    with timings.measure("corpusHashing"):
        cache_metadata = replay_metadata(
            args.corpus_in, args.profile, teacher_sha256, shape,
            args.proposal_replay, args.distill_replay, args.ranking_replay, args.seed)
    with timings.measure("replayPreparation"):
        prepared, replay_cache = prepare_replay(
            proposals, heldout, values, distill, rankings, shape,
            cache_metadata, args.replay_cache_dir)
    with timings.measure("initialHeldoutEvaluation", device):
        initial_heldout = shortlist_metrics(model, heldout, device, args.top_k)
    print(json.dumps({
        "initialCppParityRelativeError": initial_parity,
        "initialHeldout": initial_heldout,
        "replayCache": replay_cache,
    }), flush=True)
    trajectories: dict[int, list[Turn]] = {}
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
                pretrain_proposal_loss, _, pretrain_distill_loss, pretrain_ranking_loss = train_updates(
                    model, optimizer, proposals, values, distill, rankings, chunk,
                    args.batch_size, device, randomizer, args.distill_weight,
                    args.value_sampling, args.proposal_loss_weight,
                    args.proposal_margin_weight, args.proposal_anchor_weight,
                    args.top_k,
                    args.mc_value_weight, value_loss_weights, args.ranking_loss_weight,
                    args.ranking_batch_size, prepared)
            completed_pretrain += chunk
            report = {
                "pretrainUpdates": completed_pretrain,
                "proposalLoss": pretrain_proposal_loss,
                "distillLoss": pretrain_distill_loss,
                "rankingLoss": pretrain_ranking_loss,
            }
            if args.pretrain_checkpoint_updates and completed_pretrain < args.pretrain_updates:
                checkpoint = output_dir / f"v9.pretrain.{completed_pretrain}.model"
                with timings.measure("checkpointSerialization", device):
                    save_model(model, checkpoint)
                with timings.measure("evaluation", device):
                    report["heldout"] = shortlist_metrics(
                        model, heldout, device, args.top_k)
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
                states, events, done = read_block(environment)
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
                    weight = 1 / max(len(trajectory), 1)
                    # The recall split is by complete episode. Keeping its
                    # value labels out too prevents the shared trunk from
                    # indirectly training on held-out proposal positions.
                    if episode % 10 != 0:
                        for turn in trajectory:
                            values.append(ValueExample(
                                turn.state, turn.behavior, turn.elapsed + 1, won, score,
                                rounds - turn.elapsed, weight))
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
                        args.mc_value_weight, value_loss_weights,
                        args.ranking_loss_weight, args.ranking_batch_size, prepared)
                break
            with timings.measure("evaluation", device):
                actions, generated, _, distill_groups = teacher_examples(
                    teacher, states, shape.extent, device, args.teacher_batch,
                    args.proposal_target_size)
            if args.self_actor_fraction:
                assert self_actor is not None
                self_actions = v9_actor_actions(
                    self_actor, states, device, args.top_k, args.teacher_batch)
                actions = [self_action if randomizer.random() < args.self_actor_fraction
                           else teacher_action
                           for self_action, teacher_action in zip(
                               self_actions, actions, strict=True)]
            turns = [Turn(
                "^".join(reply.state for reply in state.candidates[action].replies),
                state.behavior,
                state.elapsed,
            ) for state, action in zip(states, actions, strict=True)]
            for state, example, turn, distilled in zip(
                    states, generated, turns, distill_groups, strict=True):
                if state.episode % 10 == 0:
                    heldout.append(example)
                else:
                    proposals.append(example)
                    distill.extend(distilled)
                    rankings.append(RankingExample(
                        example, split_candidate_groups(distilled, len(example.moves))))
                if corpus:
                    with timings.measure("corpusSerialization"):
                        corpus.write(json.dumps(
                            corpus_record(args.profile, teacher_sha256, example, distilled),
                            separators=(",", ":")) + "\n")
                trajectories.setdefault(state.episode, []).append(turn)
                pending[(state.slot, state.episode, state.elapsed)] = turn
            with timings.measure("trainingUpdates", device):
                proposal_loss, value_loss, distill_loss, ranking_loss = train_updates(
                    model, optimizer, proposals, values, distill, rankings,
                    new_results * args.updates_per_game,
                    args.batch_size, device, randomizer, args.distill_weight,
                    args.value_sampling, args.proposal_loss_weight,
                    args.proposal_margin_weight, args.proposal_anchor_weight,
                    args.top_k,
                    args.mc_value_weight, value_loss_weights,
                    args.ranking_loss_weight, args.ranking_batch_size, prepared)
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
                    metrics = shortlist_metrics(model, heldout, device, args.top_k)
                print(json.dumps({
                    "games": completed, "winRate": wins / completed,
                    "averageRounds": total_rounds / completed,
                    "normalizedScorePerRound": total_score / max(total_rounds, 1),
                    "proposalLoss": proposal_loss, "valueLoss": value_loss,
                    "distillLoss": distill_loss, "rankingLoss": ranking_loss,
                    "heldout": metrics, "checkpoint": str(checkpoint),
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
        metrics = shortlist_metrics(model, heldout, device, args.top_k)
    pass_gate = metrics["passPositions"] >= args.min_gate_pass_positions \
        and metrics["passRecall"] >= args.min_pass_recall
    bait_gate = args.profile == "small5" or (
        metrics["baitPositions"] >= args.min_gate_bait_positions
        and metrics["baitRecall"] >= args.min_bait_recall)
    shortlist_data_allowed = metrics["positions"] >= args.min_gate_positions \
        and metrics["topKRecall"] >= args.min_top_k_recall \
        and metrics["setRecall"] >= args.min_set_recall \
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
        "heldout": metrics, "model": str(final),
        "modelSha256": file_sha256(final),
        "elapsedSeconds": end_to_end_seconds,
        "endToEndSeconds": end_to_end_seconds,
        "onlineTrainingSeconds": time.monotonic() - online_started,
        "phaseTimings": timings.as_dict(),
        "cppParityRelativeError": final_parity,
        "initialCppParityRelativeError": initial_parity,
        "shortlistDataAllowed": shortlist_data_allowed,
        "shortlistGate": {
            "topK": metrics["positions"] >= args.min_gate_positions
                and metrics["topKRecall"] >= args.min_top_k_recall,
            "set": metrics["positions"] >= args.min_gate_positions
                and metrics["setRecall"] >= args.min_set_recall,
            "pass": pass_gate,
            "bait": bait_gate,
        },
        "teacherSha256": teacher_sha256,
        "opponentOracle": OPPONENT_ORACLE,
        "selfActorFraction": args.self_actor_fraction,
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
            "proposalLossWeight": args.proposal_loss_weight,
            "proposalMarginWeight": args.proposal_margin_weight,
            "proposalAnchorWeight": args.proposal_anchor_weight,
            "mcValueWeight": args.mc_value_weight,
            "distillWeight": args.distill_weight,
            "rankingLossWeight": args.ranking_loss_weight,
            "rankingBatchSize": args.ranking_batch_size,
            "valueSampling": args.value_sampling,
            "winLossWeight": args.win_loss_weight,
            "scoreLossWeight": args.score_loss_weight,
            "remainingLossWeight": args.remaining_loss_weight,
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
    result.add_argument("--games", type=int, default=4096)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
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
    result.add_argument("--mc-value-weight", type=float, default=1.0)
    result.add_argument("--win-loss-weight", type=float, default=1.0)
    result.add_argument("--score-loss-weight", type=float, default=1.0)
    result.add_argument("--remaining-loss-weight", type=float, default=1.0)
    result.add_argument("--ranking-loss-weight", type=float, default=0.0,
                        help="weight of exhaustive post-reply candidate-order loss")
    result.add_argument("--ranking-batch-size", type=int, default=2,
                        help="complete positions per ranking update (each includes every candidate)")
    result.add_argument("--value-head-only", action="store_true",
                        help="freeze shared trunk and proposal/branch heads")
    result.add_argument("--proposal-head-only", action="store_true",
                        help="freeze shared trunk and value head")
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
    result.add_argument("--self-actor-summary",
                        help="prior unseen summary proving --init may generate shortlist trajectories")
    result.add_argument("--top-k", type=int, default=0,
                        help="recall/deployment K (default: 8 small5, 16 daemon19)")
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
