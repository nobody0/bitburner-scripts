#!/usr/bin/env python3
"""Portable GPU pretrainer for the v7 board-value network.

The native sidecar owns every rules-sensitive operation. This process only
batches board evaluation and gradient updates on CUDA, MPS, or CPU.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import json
import math
import os
import pathlib
import random
import subprocess
import sys
import time
from typing import Iterable

import torch
from torch import Tensor, nn
import torch.nn.functional as F


GO_AI = pathlib.Path(__file__).resolve().parents[1]
REPO = GO_AI.parent


@dataclasses.dataclass
class ModelShape:
    extent: int
    hidden: int
    opponent_features: int

    @property
    def heads(self) -> int:
        return max(self.opponent_features, 1)

    @property
    def dense(self) -> int:
        return 8 * 5 * 5 + self.opponent_features


class V7ValueNet(nn.Module):
    def __init__(self, shape: ModelShape, vectors: list[list[float]], device: torch.device):
        super().__init__()
        self.shape = shape
        w1, b1, w2, b2, convolution, convolution_bias = vectors
        self.w1 = nn.Parameter(torch.tensor(w1, dtype=torch.float32, device=device).reshape(shape.hidden, shape.dense))
        self.b1 = nn.Parameter(torch.tensor(b1, dtype=torch.float32, device=device))
        self.w2 = nn.Parameter(torch.tensor(w2, dtype=torch.float32, device=device).reshape(shape.heads, 3, shape.hidden))
        self.b2 = nn.Parameter(torch.tensor(b2, dtype=torch.float32, device=device).reshape(shape.heads, 3))
        self.convolution = nn.Parameter(torch.tensor(convolution, dtype=torch.float32, device=device).reshape(8, 3, 3, 3))
        self.convolution_bias = nn.Parameter(torch.tensor(convolution_bias, dtype=torch.float32, device=device))
        pool = torch.zeros((25, shape.extent * shape.extent), dtype=torch.float32, device=device)
        counts = [0] * 25
        for x in range(shape.extent):
            for y in range(shape.extent):
                bin_index = (x * 5 // shape.extent) * 5 + y * 5 // shape.extent
                pool[bin_index, x * shape.extent + y] = 1.0
                counts[bin_index] += 1
        for index, count in enumerate(counts):
            if count:
                pool[index] /= count
        self.register_buffer("pool", pool)

    def forward_raw(self, boards: Tensor, opponents: Tensor) -> Tensor:
        spatial = torch.tanh(F.conv2d(
            boards, self.convolution, self.convolution_bias, padding=1))
        pooled = torch.einsum("bcn,pn->bcp", spatial.flatten(2), self.pool).flatten(1)
        if self.shape.opponent_features:
            one_hot = F.one_hot(opponents, self.shape.opponent_features).to(pooled.dtype)
            pooled = torch.cat((pooled, one_hot), dim=1)
        hidden = torch.tanh(F.linear(pooled, self.w1, self.b1))
        heads = opponents if self.shape.opponent_features else torch.zeros_like(opponents)
        selected_w2 = self.w2[heads]
        selected_b2 = self.b2[heads]
        return torch.bmm(selected_w2, hidden.unsqueeze(2)).squeeze(2) + selected_b2

    @staticmethod
    def decode(raw: Tensor) -> Tensor:
        result = torch.empty_like(raw)
        result[:, 0] = torch.sigmoid(raw[:, 0])
        result[:, 1:] = torch.expm1(torch.clamp(F.softplus(raw[:, 1:]), max=40.0))
        return result


def read_vector(tokens: list[str], offset: int) -> tuple[list[float], int]:
    count = int(tokens[offset])
    begin = offset + 1
    end = begin + count
    if end > len(tokens):
        raise ValueError("truncated model vector")
    return [float(value) for value in tokens[begin:end]], end


def load_model(path: pathlib.Path, device: torch.device) -> V7ValueNet:
    tokens = path.read_text().split()
    if not tokens or tokens[0] != "bitburner-go-value-v7":
        raise ValueError(f"{path} is not a v7 spatial value model")
    shape = ModelShape(int(tokens[1]), int(tokens[2]), int(tokens[3]))
    vectors: list[list[float]] = []
    offset = 4
    for _ in range(6):
        vector, offset = read_vector(tokens, offset)
        vectors.append(vector)
    if offset != len(tokens):
        raise ValueError(f"unexpected trailing data in {path}")
    expected = [
        shape.hidden * shape.dense,
        shape.hidden,
        shape.heads * 3 * shape.hidden,
        shape.heads * 3,
        8 * 3 * 3 * 3,
        8,
    ]
    if [len(vector) for vector in vectors] != expected:
        raise ValueError(f"unexpected tensor shapes in {path}")
    return V7ValueNet(shape, vectors, device)


def parameter_vectors(model: V7ValueNet) -> list[list[float]]:
    return [
        parameter.detach().cpu().to(torch.float64).flatten().tolist()
        for parameter in (
            model.w1, model.b1, model.w2, model.b2,
            model.convolution, model.convolution_bias,
        )
    ]


def save_model(model: V7ValueNet, path: pathlib.Path) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as output:
        shape = model.shape
        output.write(f"bitburner-go-value-v7\n{shape.extent} {shape.hidden} {shape.opponent_features}\n")
        for vector in parameter_vectors(model):
            output.write(str(len(vector)))
            for value in vector:
                output.write(f" {value:.17g}")
            output.write("\n")
    os.replace(temporary, path)


def encode_boards(hashes: list[str], extent: int, device: torch.device) -> Tensor:
    if not hashes:
        return torch.empty((0, 3, extent, extent), dtype=torch.float32, device=device)
    normalized: list[str] = []
    for board in hashes:
        size = math.isqrt(len(board))
        if size * size != len(board) or size > extent:
            raise ValueError("environment returned a board with the wrong extent")
        if size == extent:
            normalized.append(board)
            continue
        padded = ["#"] * (extent * extent)
        for x in range(size):
            for y in range(size):
                padded[x * extent + y] = board[x * size + y]
        normalized.append("".join(padded))
    raw = torch.frombuffer(bytearray("".join(normalized), "ascii"), dtype=torch.uint8)
    raw = raw.reshape(len(hashes), extent, extent)
    planes = torch.stack((raw == ord("X"), raw == ord("O"), raw == ord("#")), dim=1)
    return planes.to(device=device, dtype=torch.float32)


def auto_device(requested: str) -> torch.device:
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def fixture_cases(profile: str) -> list[dict[str, object]]:
    fixture = json.loads((REPO / "tests/fixtures/go-value.json").read_text())
    return [case for case in fixture if case["profile"] == profile]


@torch.no_grad()
def verify_against_cpp(
    model: V7ValueNet,
    model_path: pathlib.Path,
    profile: str,
    oracle: pathlib.Path,
    device: torch.device,
) -> float:
    maximum = 0.0
    for case in fixture_cases(profile):
        board = str(case["board"])
        opponent = int(case["opponentIndex"])
        output = subprocess.check_output([
            str(oracle), "value", str(model_path), str(case["size"]),
            str(opponent), board,
        ], text=True)
        expected = torch.tensor(
            [float(value) for value in output.strip().split("\t")], dtype=torch.float64)
        inputs = encode_boards([board], model.shape.extent, device)
        actual = model.decode(model.forward_raw(
            inputs, torch.tensor([opponent], dtype=torch.long, device=device)))[0]
        difference = torch.max(torch.abs(actual.detach().cpu().to(torch.float64) - expected)).item()
        scale = max(1.0, torch.max(torch.abs(expected)).item())
        maximum = max(maximum, difference / scale)
    if maximum > 2e-4:
        raise RuntimeError(f"GPU/C++ value parity exceeded tolerance: relative error {maximum}")
    return maximum


@dataclasses.dataclass
class State:
    slot: int
    episode: int
    opponent: int
    elapsed: int
    boards: list[str]


@dataclasses.dataclass
class Turn:
    turn: int
    opponent: int
    evaluated_board: str
    after_reply: str | None = None


@dataclasses.dataclass
class Example:
    board: str
    opponent: int
    won: float
    power: float
    remaining: float
    weight: float


@dataclasses.dataclass
class Learner:
    name: str
    model: V7ValueNet
    optimizer: torch.optim.Optimizer
    loss: float = 0.0


def rate_name(rate: float) -> str:
    return f"{rate:.8g}".replace("+", "").replace(".", "_")


def train_batches(
    model: V7ValueNet,
    optimizer: torch.optim.Optimizer,
    replay: collections.deque[Example],
    updates: int,
    batch_size: int,
    device: torch.device,
    randomizer: random.Random,
    replay_sampling: str,
    loss_weights: tuple[float, float, float],
) -> float:
    if not replay or updates <= 0:
        return 0.0
    values = list(replay)
    total = 0.0
    model.train()
    replay_buckets: dict[int, list[Example]] = {}
    if replay_sampling == "opponent":
        for example in values:
            replay_buckets.setdefault(example.opponent, []).append(example)
    elif replay_sampling == "outcome":
        for example in values:
            replay_buckets.setdefault(int(example.won >= 0.5), []).append(example)
    replay_keys = sorted(replay_buckets)
    for _ in range(updates):
        count = min(batch_size, len(values))
        if len(replay_keys) > 1:
            start = randomizer.randrange(len(replay_keys))
            batch = [
                randomizer.choice(replay_buckets[
                    replay_keys[(start + index) % len(replay_keys)]])
                for index in range(count)
            ]
            randomizer.shuffle(batch)
        else:
            batch = randomizer.choices(values, k=count)
        boards = encode_boards([example.board for example in batch], model.shape.extent, device)
        opponents = torch.tensor([example.opponent for example in batch], dtype=torch.long, device=device)
        raw = model.forward_raw(boards, opponents)
        win = torch.tensor([example.won for example in batch], dtype=torch.float32, device=device)
        log_power = torch.log1p(torch.tensor(
            [example.power for example in batch], dtype=torch.float32, device=device))
        log_remaining = torch.log1p(torch.tensor(
            [example.remaining for example in batch], dtype=torch.float32, device=device))
        weights = torch.tensor([example.weight for example in batch], dtype=torch.float32, device=device)
        per_example = (
            loss_weights[0] * F.binary_cross_entropy_with_logits(
                raw[:, 0], win, reduction="none")
            + loss_weights[1] * torch.square(F.softplus(raw[:, 1]) - log_power)
            + loss_weights[2] * torch.square(F.softplus(raw[:, 2]) - log_remaining)
        )
        loss = torch.sum(per_example * weights) / torch.clamp(torch.sum(weights), min=1e-9)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        optimizer.step()
        total += float(loss.detach().cpu())
    return total / updates


def read_environment_block(process: subprocess.Popen[str]) -> tuple[list[State], list[list[str]], bool]:
    states: list[State] = []
    events: list[list[str]] = []
    while True:
        line = process.stdout.readline() if process.stdout else ""
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"native GPU environment exited early: {stderr}")
        parts = line.rstrip("\n").split("\t")
        if parts[0] == "S":
            count = int(parts[5])
            boards = parts[6:]
            if len(boards) != count:
                raise RuntimeError("native GPU environment candidate count mismatch")
            states.append(State(int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]), boards))
        elif parts[0] in ("T", "R"):
            events.append(parts)
        elif parts[0] == "READY":
            return states, events, False
        elif parts[0] == "DONE":
            return states, events, True
        else:
            raise RuntimeError(f"unknown native GPU environment record: {line.rstrip()}")


@torch.no_grad()
def choose_actions(
    model: V7ValueNet,
    states: list[State],
    device: torch.device,
    epsilon: float,
    randomizer: random.Random,
) -> tuple[list[int], list[str]]:
    hashes = [board for state in states for board in state.boards]
    opponents = torch.tensor(
        [state.opponent for state in states for _ in state.boards],
        dtype=torch.long, device=device)
    model.eval()
    predictions = model.decode(model.forward_raw(
        encode_boards(hashes, model.shape.extent, device), opponents)).detach().cpu()
    actions: list[int] = []
    selected_boards: list[str] = []
    offset = 0
    for state in states:
        count = len(state.boards)
        values = predictions[offset:offset + count]
        if randomizer.random() < epsilon:
            selected = randomizer.randrange(count)
        else:
            best_win = torch.max(values[:, 0])
            tied = torch.nonzero(values[:, 0] == best_win).flatten()
            if len(tied) == 1:
                selected = int(tied[0])
            else:
                utility = values[tied, 1] / torch.clamp(
                    state.elapsed + values[tied, 2], min=1e-6)
                selected = int(tied[torch.argmax(utility)])
        actions.append(selected)
        selected_boards.append(state.boards[selected])
        offset += count
    return actions, selected_boards


@torch.no_grad()
def choose_population_actions(
    actors: list[V7ValueNet],
    states: list[State],
    device: torch.device,
    epsilon: float,
    randomizer: random.Random,
) -> tuple[list[int], list[str]]:
    if not actors:
        raise RuntimeError("at least one behavior actor is required")
    if len(actors) == 1:
        return choose_actions(actors[0], states, device, epsilon, randomizer)
    actions = [-1] * len(states)
    selected = [""] * len(states)
    groups: list[list[tuple[int, State]]] = [[] for _ in actors]
    for index, state in enumerate(states):
        groups[state.episode % len(actors)].append((index, state))
    for actor, group in zip(actors, groups, strict=True):
        if not group:
            continue
        group_actions, group_selected = choose_actions(
            actor, [state for _, state in group], device, epsilon, randomizer)
        for (index, _), action, board in zip(
            group, group_actions, group_selected, strict=True):
            actions[index] = action
            selected[index] = board
    if any(action < 0 for action in actions) or any(not board for board in selected):
        raise RuntimeError("population actor failed to select every state")
    return actions, selected


def run(args: argparse.Namespace) -> None:
    started = time.monotonic()
    device = auto_device(args.device)
    initial = pathlib.Path(args.init).resolve()
    retention_path = pathlib.Path(args.retention_model or args.init).resolve()
    output_dir = pathlib.Path(args.out_dir).resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"output directory must be new or empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    requested_rates = [args.learning_rate]
    if args.learning_rates:
        requested_rates = [float(value) for value in args.learning_rates.split(",")]
    if not requested_rates or any(rate <= 0 for rate in requested_rates):
        raise RuntimeError("learning rates must be positive")
    if len(set(requested_rates)) != len(requested_rates):
        raise RuntimeError("learning rates must be distinct")
    raw_loss_weights = (
        args.win_loss_weight, args.power_loss_weight, args.remaining_loss_weight)
    loss_weight_sum = sum(raw_loss_weights)
    if loss_weight_sum <= 0 or any(weight < 0 for weight in raw_loss_weights):
        raise RuntimeError("loss weights must be nonnegative with a positive sum")
    loss_weights = tuple(weight / loss_weight_sum for weight in raw_loss_weights)
    model = load_model(initial, device)
    expected = (5, 6) if args.profile == "small5" else (19, 0)
    if (model.shape.extent, model.shape.opponent_features) != expected:
        raise RuntimeError("initial model does not match the requested profile")
    oracle = pathlib.Path(args.oracle).resolve()
    parity = verify_against_cpp(model, initial, args.profile, oracle, device)
    print(f"device={device} profile={args.profile} initial_parity={parity:.3g}", flush=True)
    if args.parity_only:
        return

    learners: list[Learner] = []
    for index, rate in enumerate(requested_rates):
        learner_model = model if index == 0 else load_model(initial, device)
        name = "gpu" if len(requested_rates) == 1 else f"gpu-lr-{rate_name(rate)}"
        learners.append(Learner(
            name,
            learner_model,
            torch.optim.AdamW(
                learner_model.parameters(), lr=rate, weight_decay=args.weight_decay),
        ))
        save_model(learner_model, output_dir / f"{name}.0.model")
    retention_actor = load_model(retention_path, device) if args.actor_mode == "population-retention" else None
    if retention_actor is not None and retention_actor.shape != model.shape:
        raise RuntimeError("retention model does not match the requested profile")
    behavior_actors = (
        [learners[0].model]
        if args.actor_mode == "first"
        else [learner.model for learner in learners]
        + ([retention_actor] if retention_actor is not None else [])
    )
    replay: collections.deque[Example] = collections.deque(maxlen=args.replay)
    trajectories: dict[int, list[Turn]] = {}
    pending: dict[tuple[int, int, int], Turn] = {}
    randomizer = random.Random(args.seed ^ 0x6A09E667)
    completed = 0
    wins = 0
    total_power = 0.0
    total_rounds = 0
    next_checkpoint = args.checkpoint_games
    env = subprocess.Popen([
        str(pathlib.Path(args.environment).resolve()), str(args.games), str(args.seed),
        str(args.environments), args.profile, str(args.cpu_threads),
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1)
    try:
        done = False
        while not done:
            states, events, done = read_environment_block(env)
            new_results = 0
            for parts in events:
                if parts[0] == "T":
                    key = (int(parts[1]), int(parts[2]), int(parts[3]))
                    turn = pending.pop(key)
                    turn.after_reply = parts[5]
                    if turn.after_reply != turn.evaluated_board:
                        raise RuntimeError(
                            "environment selected a different board than the GPU evaluated")
                else:
                    slot, episode = int(parts[1]), int(parts[2])
                    won, power, rounds = float(parts[3]), float(parts[4]), int(parts[5])
                    trajectory = trajectories.pop(episode)
                    if any(turn.after_reply is None for turn in trajectory):
                        raise RuntimeError("terminal trajectory is missing an actual reply board")
                    for turn in trajectory:
                        remaining = float(rounds - turn.turn)
                        replay.append(Example(
                            turn.evaluated_board, turn.opponent, won, power, remaining, 1.0))
                    completed += 1
                    new_results += 1
                    wins += int(won)
                    total_power += power
                    total_rounds += rounds

            batch_random_state = randomizer.getstate()
            next_random_state = None
            for learner in learners:
                randomizer.setstate(batch_random_state)
                learner.loss = train_batches(
                    learner.model, learner.optimizer, replay,
                    new_results * args.updates_per_game,
                    args.batch_size, device, randomizer, args.replay_sampling,
                    loss_weights)
                if next_random_state is None:
                    next_random_state = randomizer.getstate()
            if next_random_state is not None:
                randomizer.setstate(next_random_state)
            while completed >= next_checkpoint:
                learner_metrics = []
                for learner in learners:
                    checkpoint = output_dir / f"{learner.name}.{completed}.model"
                    save_model(learner.model, checkpoint)
                    checkpoint_parity = verify_against_cpp(
                        learner.model, checkpoint, args.profile, oracle, device)
                    learner_metrics.append(
                        f"{learner.name}:loss={learner.loss:.8g},parity={checkpoint_parity:.3g}")
                elapsed = time.monotonic() - started
                print(
                    f"checkpoint={completed} win_rate={wins / completed:.8g} "
                    f"power_per_round={total_power / max(total_rounds, 1):.8g} "
                    f"replay={len(replay)} learners={'|'.join(learner_metrics)} "
                    f"elapsed_seconds={elapsed:.3f} "
                    f"games_per_second={completed / max(elapsed, 1e-9):.8g}",
                    flush=True,
                )
                next_checkpoint += args.checkpoint_games
            if done:
                break

            progress = completed / max(args.games, 1)
            epsilon = args.epsilon_start + (args.epsilon_end - args.epsilon_start) * progress
            actions, selected = choose_population_actions(
                behavior_actors, states, device, epsilon, randomizer)
            for state, action, board in zip(states, actions, selected, strict=True):
                turn = Turn(state.elapsed, state.opponent, board)
                trajectories.setdefault(state.episode, []).append(turn)
                pending[(state.slot, state.episode, state.elapsed)] = turn
                assert env.stdin is not None
                env.stdin.write(f"A\t{state.slot}\t{state.episode}\t{action}\n")
            assert env.stdin is not None
            env.stdin.write("GO\n")
            env.stdin.flush()
        return_code = env.wait()
        if return_code != 0:
            stderr = env.stderr.read() if env.stderr else ""
            raise RuntimeError(f"native GPU environment failed ({return_code}): {stderr}")
    finally:
        if env.poll() is None:
            env.terminate()
            env.wait()

    candidate_metadata = []
    for learner, rate in zip(learners, requested_rates, strict=True):
        final_path = output_dir / f"{learner.name}.model"
        save_model(learner.model, final_path)
        parity = verify_against_cpp(
            learner.model, final_path, args.profile, oracle, device)
        candidate_metadata.append({
            "name": learner.name,
            "learningRate": rate,
            "parityRelativeError": parity,
            "model": str(final_path),
        })
    elapsed = time.monotonic() - started
    metadata = {
        "command": [sys.executable, *sys.argv],
        "profile": args.profile,
        "games": completed,
        "seed": args.seed,
        "device": str(device),
        "wins": wins,
        "winRate": wins / completed,
        "powerPerRound": total_power / max(total_rounds, 1),
        "elapsedSeconds": elapsed,
        "gamesPerSecond": completed / max(elapsed, 1e-9),
        "actor": args.actor_mode,
        "model": candidate_metadata[0]["model"],
        "parityRelativeError": candidate_metadata[0]["parityRelativeError"],
        "candidates": candidate_metadata,
        "configuration": {
            "environments": args.environments,
            "cpuThreads": args.cpu_threads,
            "batchSize": args.batch_size,
            "updatesPerGame": args.updates_per_game,
            "replayCapacity": args.replay,
            "epsilonStart": args.epsilon_start,
            "epsilonEnd": args.epsilon_end,
            "weightDecay": args.weight_decay,
            "behaviorActors": len(behavior_actors),
            "retentionModel": str(retention_path),
            "replaySampling": args.replay_sampling,
            "lossWeights": loss_weights,
        },
    }
    (output_dir / "summary.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata), flush=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--profile", choices=("small5", "daemon19"), required=True)
    result.add_argument("--games", type=int, default=4096)
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--environments", type=int, default=128)
    result.add_argument("--init", required=True)
    result.add_argument(
        "--retention-model",
        help="immutable retention actor; defaults to --init")
    result.add_argument("--out-dir", required=True)
    result.add_argument("--device", default="auto")
    result.add_argument("--learning-rate", type=float, default=1e-4)
    result.add_argument(
        "--learning-rates",
        help="comma-separated AdamW rates; all share the first rate's trajectories")
    result.add_argument(
        "--actor-mode", choices=("first", "population", "population-retention"),
        default="population-retention",
        help="which models contribute complete behavior trajectories")
    result.add_argument("--weight-decay", type=float, default=1e-6)
    result.add_argument("--batch-size", type=int, default=2048)
    result.add_argument("--updates-per-game", type=int, default=2)
    result.add_argument("--win-loss-weight", type=float, default=1.0)
    result.add_argument("--power-loss-weight", type=float, default=1.0)
    result.add_argument("--remaining-loss-weight", type=float, default=1.0)
    result.add_argument("--replay", type=int, default=200_000)
    result.add_argument(
        "--replay-sampling", choices=("uniform", "opponent", "outcome"), default="uniform",
        help="sample uniformly, equally across small5 heads, or experimentally across wins/losses")
    result.add_argument("--epsilon-start", type=float, default=0.15)
    result.add_argument("--epsilon-end", type=float, default=0.02)
    result.add_argument("--cpu-threads", type=int, default=12)
    result.add_argument("--checkpoint-games", type=int, default=512)
    result.add_argument("--environment", default=str(GO_AI / "build/release/go_cpp_gpu_env"))
    result.add_argument("--oracle", default=str(GO_AI / "build/release/go_cpp_oracle"))
    result.add_argument("--parity-only", action="store_true")
    return result


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
