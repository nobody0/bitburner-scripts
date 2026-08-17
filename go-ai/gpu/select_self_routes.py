#!/usr/bin/env python3
"""Filter self-action positives using matched exploratory route outcomes.

All exhaustive proposal records and all real terminal trajectories survive: a
failed exploration is still useful value evidence. Actor positives are the
dangerous part, because blindly blessing every random intervention teaches the
shortlist to repeat losing moves. This filter compares matched episode IDs
against a frozen-champion control and retains those positives only for a win
flip, or optionally for an equal-win Power/turn improvement.

A selected action is useful shortlist-exploration evidence, but one selected
rollout is not an unbiased post-reply value-order target: the value input does
not contain future RNG, and selecting only favorable rollouts conditions on
that hidden randomness. ``--emit-rankings`` is therefore an experimental
diagnostic unless repeated continuations establish the ordering. Unselected
real trajectories remain useful value data.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import json
import pathlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Outcome:
    won: float
    score: float
    rounds: float

    @property
    def power_per_turn(self) -> float:
        return self.score / max(self.rounds, 1)


def outcomes(path: pathlib.Path) -> tuple[dict[int, Outcome], dict[str, object]]:
    result: dict[int, Outcome] = {}
    identity: dict[str, object] | None = None
    with gzip.open(path, "rt") as source:
        for line_number, line in enumerate(source, 1):
            record = json.loads(line)
            current = {
                key: record.get(key)
                for key in ("schema", "profile", "teacherSha256", "opponentOracle")
            }
            if identity is None:
                identity = current
            elif current != identity:
                raise RuntimeError(f"{path}:{line_number}: mixed corpus identity")
            if record.get("kind") != "trajectory":
                continue
            values = record.get("values", [])
            if not values:
                raise RuntimeError(f"{path}:{line_number}: empty trajectory")
            first = values[0]
            episode = int(record["episode"])
            if episode in result:
                raise RuntimeError(f"{path}:{line_number}: duplicate episode {episode}")
            result[episode] = Outcome(
                float(first["won"]), float(first["score"]), float(first["remaining"]))
    if identity is None:
        raise RuntimeError(f"empty corpus: {path}")
    return result, identity


def improved(control: Outcome, exploration: Outcome, mode: str) -> bool:
    if exploration.won != control.won:
        return exploration.won > control.won
    if mode == "win-flip" or exploration.won < 0.5:
        return False
    if exploration.power_per_turn != control.power_per_turn:
        return exploration.power_per_turn > control.power_per_turn
    return exploration.rounds < control.rounds


def run(control_path: pathlib.Path, exploration_path: pathlib.Path,
        output_path: pathlib.Path, mode: str,
        emit_rankings: bool = False,
        exact_actors_per_episode: int | None = None,
        supervision_overlay: bool = False) -> dict[str, object]:
    if output_path.exists():
        raise RuntimeError(f"output already exists: {output_path}")
    control, control_identity = outcomes(control_path)
    exploration, exploration_identity = outcomes(exploration_path)
    if control_identity != exploration_identity:
        raise RuntimeError("control/exploration corpus identity mismatch")
    if control.keys() != exploration.keys():
        raise RuntimeError("control/exploration episode IDs differ")
    selected = {
        episode for episode in control
        if improved(control[episode], exploration[episode], mode)
    }
    win_flips = {
        episode for episode in control
        if exploration[episode].won > control[episode].won
    }
    selected_before_actor_filter = len(selected)
    selected_actors: dict[tuple[int, int, str], int] = {}
    actor_counts: dict[int, int] = collections.Counter()
    if emit_rankings or exact_actors_per_episode is not None:
        with gzip.open(exploration_path, "rt") as source:
            for line in source:
                record = json.loads(line)
                if record.get("kind") != "actor":
                    continue
                example = record["example"]
                episode = int(example["episode"])
                if episode not in selected:
                    continue
                actor_counts[episode] += 1
                key = (episode, int(example["elapsed"]), str(example["state"]))
                action = int(example["action"])
                if key in selected_actors and selected_actors[key] != action:
                    raise RuntimeError(f"conflicting self actions for {key[:2]}")
                selected_actors[key] = action
    if exact_actors_per_episode is not None:
        selected = {
            episode for episode in selected
            if actor_counts.get(episode, 0) == exact_actors_per_episode
        }

    def candidate_groups(values: list[dict[str, object]], count: int) \
            -> list[list[dict[str, object]]]:
        groups: list[list[dict[str, object]]] = []
        offset = 0
        for _ in range(count):
            group: list[dict[str, object]] = []
            probability = 0.0
            while offset < len(values) and probability < 1 - 1e-7:
                value = dict(values[offset])
                offset += 1
                group.append(value)
                probability += float(value["weight"])
            if abs(probability - 1) > 1e-5:
                raise RuntimeError(f"candidate reply mass is {probability}")
            groups.append(group)
        if offset != len(values):
            raise RuntimeError("candidate groups have trailing reply values")
        return groups

    records = actors_seen = actors_kept = ranking_records = 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(exploration_path, "rt") as source, gzip.open(output_path, "wt") as output:
        for line in source:
            record = json.loads(line)
            kind = record.get("kind")
            if kind == "actor":
                actors_seen += 1
                if int(record["example"]["episode"]) not in selected:
                    continue
                actors_kept += 1
            generation = dict(record.get("generation", {}))
            generation["selfSelection"] = {
                "mode": mode,
                "matchedControl": control_path.name,
            }
            record["generation"] = generation
            # A compact actor/ranking diagnostic does not need hundreds of
            # thousands of unrelated proposal and terminal rows copied around
            # it. Their immutable source corpus remains available for an
            # explicit absolute-value experiment. The overlay retains only
            # selected actor positives and the relative rankings derived below.
            if not supervision_overlay or kind == "actor":
                output.write(json.dumps(record, separators=(",", ":")) + "\n")
                records += 1
            if emit_rankings and kind == "proposal":
                example = record["example"]
                if int(example["episode"]) not in selected:
                    continue
                key = (int(example["episode"]), int(example["elapsed"]),
                       str(example["state"]))
                selected_action = selected_actors.get(key)
                teacher_action = int(example["best_move"])
                moves = [int(move) for move in example["moves"]]
                if selected_action is None or selected_action == teacher_action:
                    continue
                if selected_action not in moves or teacher_action not in moves:
                    raise RuntimeError(f"self ranking action is not legal for {key[:2]}")
                groups = candidate_groups(record["distill"], len(moves))
                ranked_moves = [selected_action, teacher_action]
                ranked_candidates: list[list[dict[str, object]]] = []
                for move in ranked_moves:
                    selected_group: list[dict[str, object]] = []
                    for value in groups[moves.index(move)]:
                        ranked = dict(value)
                        # Relative preference bookkeeping only. The trainer
                        # never inserts actor-ranking rows into absolute replay.
                        ranked["won"] = float(move == selected_action)
                        ranked["score"] = 0.0
                        ranked["remaining"] = 1.0
                        selected_group.append(ranked)
                    ranked_candidates.append(selected_group)
                ranking = {
                    "schema": record["schema"],
                    "kind": "actor-ranking",
                    "profile": record["profile"],
                    "teacherSha256": record["teacherSha256"],
                    "opponentOracle": record["opponentOracle"],
                    "split": record["split"],
                    "example": {
                        "episode": example["episode"],
                        "state": example["state"],
                        "behavior": example["behavior"],
                        "elapsed": example["elapsed"],
                        "moves": ranked_moves,
                        "bestMove": selected_action,
                        "candidates": ranked_candidates,
                        "source": "self",
                    },
                    "generation": generation,
                }
                output.write(json.dumps(ranking, separators=(",", ":")) + "\n")
                records += 1
                ranking_records += 1
    return {
        "mode": mode,
        "episodes": len(control),
        "selectedEpisodesBeforeActorFilter": selected_before_actor_filter,
        "selectedEpisodes": len(selected),
        "exactActorsPerEpisode": exact_actors_per_episode,
        "winFlipEpisodes": len(win_flips),
        "actorRecordsSeen": actors_seen,
        "actorRecordsKept": actors_kept,
        "rankingRecords": ranking_records,
        "supervisionOverlay": supervision_overlay,
        "records": records,
        "output": str(output_path),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--control", type=pathlib.Path, required=True)
    result.add_argument("--exploration", type=pathlib.Path, required=True)
    result.add_argument("--out", type=pathlib.Path, required=True)
    result.add_argument("--mode", choices=("win-flip", "win-or-power"),
                        default="win-flip")
    result.add_argument("--emit-rankings", action="store_true")
    result.add_argument("--exact-actors-per-episode", type=int)
    result.add_argument("--supervision-overlay", action="store_true")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    if arguments.exact_actors_per_episode is not None \
            and arguments.exact_actors_per_episode < 1:
        raise RuntimeError("--exact-actors-per-episode must be positive")
    print(json.dumps(run(
        arguments.control, arguments.exploration, arguments.out, arguments.mode,
        arguments.emit_rankings, arguments.exact_actors_per_episode,
        arguments.supervision_overlay)))
