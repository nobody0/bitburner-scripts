#!/usr/bin/env python3
"""Audit what each V9 teacher actually contributes to a retained corpus.

This is deliberately read-only.  It does not train, rewrite a corpus, or treat
the marker values in ``actor-ranking`` records as counterfactual outcomes.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import gzip
import hashlib
import json
import math
import pathlib
import struct
from collections.abc import Sequence

import torch

from device import auto_device
from train_v9 import (CORPUS_SCHEMA, OPPONENT_ORACLE, configure_accelerator,
                      encode_states, load_v9, post_reply_behavior, set_elapsed)


SOURCES = ("champion", "katago", "handcrafted", "self")


@dataclasses.dataclass(frozen=True)
class ValueRow:
    state: str
    behavior: list[float]
    elapsed: int
    won: float
    score: float
    remaining: float
    weight: float
    black_power: float | None = None


@dataclasses.dataclass(frozen=True)
class ActorRow:
    split: str
    source: str
    episode: int
    state: str
    behavior: list[float]
    elapsed: int
    moves: list[int]
    actions: list[int]
    executed: int | None


@dataclasses.dataclass(frozen=True)
class RankingRow:
    split: str
    source: str
    episode: int
    state: str
    behavior: list[float]
    elapsed: int
    moves: list[int]
    best_move: int
    candidates: list[list[ValueRow]]


@dataclasses.dataclass(frozen=True)
class Trajectory:
    split: str
    source: str
    episode: int
    values: list[ValueRow]
    counterfactual_group: str | None = None
    candidate_index: int | None = None
    candidate_count: int | None = None
    forced_action: int | None = None
    chosen_action: int | None = None
    origin_elapsed: int | None = None
    split_component: str | None = None
    selection_kind: str | None = None
    student_action: int | None = None
    handcrafted_action: int | None = None
    katago_action: int | None = None
    student_top_k: bool | None = None
    student_finalist: bool | None = None


@dataclasses.dataclass
class Corpus:
    actors: list[ActorRow] = dataclasses.field(default_factory=list)
    rankings: list[RankingRow] = dataclasses.field(default_factory=list)
    trajectories: list[Trajectory] = dataclasses.field(default_factory=list)
    exhaustive_rankings: list[RankingRow] = dataclasses.field(default_factory=list)
    exhaustive_proposals: int = 0
    exhaustive_distill_values: int = 0
    exhaustive_distill_authors: collections.Counter[str] = \
        dataclasses.field(default_factory=collections.Counter)
    teacher_sha256: str | None = None
    profile: str | None = None


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def value_row(raw: dict[str, object]) -> ValueRow:
    return ValueRow(
        str(raw["state"]), [float(value) for value in raw["behavior"]],
        int(raw["elapsed"]), float(raw["won"]), float(raw["score"]),
        float(raw["remaining"]), float(raw["weight"]),
        float(raw["blackPower"]) if raw.get("blackPower") is not None else None,
    )


def split_weighted_candidates(values: list[ValueRow], count: int) \
        -> list[list[ValueRow]]:
    groups: list[list[ValueRow]] = []
    offset = 0
    for _ in range(count):
        group: list[ValueRow] = []
        probability = 0.0
        while offset < len(values) and probability < 1 - 1e-6:
            value = values[offset]
            offset += 1
            group.append(value)
            probability += value.weight
        if not group or abs(probability - 1) > 1e-4:
            raise RuntimeError("exhaustive reply weights do not sum to one candidate")
        groups.append(group)
    if offset != len(values):
        raise RuntimeError("exhaustive reply values exceed candidate groups")
    return groups


def load_corpus(paths: Sequence[pathlib.Path], exhaustive_split: str | None = None) -> Corpus:
    result = Corpus()
    for path in paths:
        with gzip.open(path, "rt") as source:
            for line_number, line in enumerate(source, 1):
                record = json.loads(line)
                if record.get("schema") != CORPUS_SCHEMA:
                    raise RuntimeError(f"{path}:{line_number}: incompatible schema")
                if record.get("opponentOracle") != OPPONENT_ORACLE:
                    raise RuntimeError(f"{path}:{line_number}: opponent oracle mismatch")
                profile = str(record.get("profile"))
                teacher_sha = str(record.get("teacherSha256"))
                if result.profile not in (None, profile):
                    raise RuntimeError("mixed profiles")
                if result.teacher_sha256 not in (None, teacher_sha):
                    raise RuntimeError("mixed champion authorities")
                result.profile = profile
                result.teacher_sha256 = teacher_sha
                split = str(record.get("split", "train"))
                kind = str(record.get("kind", "proposal"))
                if kind == "actor":
                    raw = record["example"]
                    source_name = str(raw["source"])
                    raw_actions = raw.get("actions")
                    executed = raw.get("action")
                    actions = ([int(value) for value in raw_actions]
                               if isinstance(raw_actions, list)
                               else [int(executed)])
                    result.actors.append(ActorRow(
                        split, source_name, int(raw["episode"]), str(raw["state"]),
                        [float(value) for value in raw["behavior"]], int(raw["elapsed"]),
                        [int(value) for value in raw["moves"]], actions,
                        int(executed) if executed is not None else None,
                    ))
                elif kind == "actor-ranking":
                    raw = record["example"]
                    result.rankings.append(RankingRow(
                        split, str(raw["source"]), int(raw["episode"]), str(raw["state"]),
                        [float(value) for value in raw["behavior"]], int(raw["elapsed"]),
                        [int(value) for value in raw["moves"]], int(raw["bestMove"]),
                        [[value_row(value) for value in candidate]
                         for candidate in raw["candidates"]],
                    ))
                elif kind == "trajectory":
                    generation = record.get("generation", {})
                    source_name = str(generation.get("source", "champion"))
                    result.trajectories.append(Trajectory(
                        split, source_name, int(record["episode"]),
                        [value_row(value) for value in record.get("values", [])],
                        str(generation["counterfactualGroupId"])
                            if generation.get("counterfactualGroupId") is not None else None,
                        int(generation["counterfactualCandidateIndex"])
                            if generation.get("counterfactualCandidateIndex") is not None else None,
                        int(generation["counterfactualCandidateCount"])
                            if generation.get("counterfactualCandidateCount") is not None else None,
                        int(generation["forcedAction"])
                            if generation.get("forcedAction") is not None else None,
                        int(generation["chosenAction"])
                            if generation.get("chosenAction") is not None else None,
                        int(generation["originElapsed"])
                            if generation.get("originElapsed") is not None else None,
                        str(generation["splitComponentSha256"])
                            if generation.get("splitComponentSha256") is not None else None,
                        str(generation["selectionKind"])
                            if generation.get("selectionKind") is not None else None,
                        int(generation["studentAction"])
                            if generation.get("studentAction") is not None else None,
                        int(generation["handcraftedChosenAction"])
                            if generation.get("handcraftedChosenAction") is not None else None,
                        int(generation["kataGoPreferredAction"])
                            if generation.get("kataGoPreferredAction") is not None else None,
                        bool(generation["candidateFlags"].get(
                            "studentPolicyTop16",
                            generation["candidateFlags"].get("studentTop16")))
                            if isinstance(generation.get("candidateFlags"), dict)
                            and (generation["candidateFlags"].get("studentPolicyTop16") is not None
                                 or generation["candidateFlags"].get("studentTop16") is not None)
                            else None,
                        bool(generation["candidateFlags"]["studentFinalist"])
                            if isinstance(generation.get("candidateFlags"), dict)
                            and generation["candidateFlags"].get("studentFinalist") is not None
                            else None,
                    ))
                elif kind == "proposal":
                    result.exhaustive_proposals += 1
                    numeric_values = record.get("distill", [])
                    result.exhaustive_distill_values += len(numeric_values)
                    result.exhaustive_distill_authors.update(
                        str(value.get("author", "<missing>"))
                        for value in numeric_values)
                    if split == exhaustive_split:
                        raw = record["example"]
                        moves = [int(value) for value in raw["moves"]]
                        values = [value_row(value) for value in numeric_values]
                        result.exhaustive_rankings.append(RankingRow(
                            split, "champion", int(raw["episode"]), str(raw["state"]),
                            [float(value) for value in raw["behavior"]],
                            int(raw["elapsed"]), moves, int(raw["best_move"]),
                            split_weighted_candidates(values, len(moves)),
                        ))
                else:
                    raise RuntimeError(f"{path}:{line_number}: unknown record kind {kind}")
    return result


def ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def source_authority(corpus: Corpus) -> dict[str, object]:
    result: dict[str, object] = {}
    present = set(row.source for row in corpus.actors + corpus.rankings + corpus.trajectories)
    for source_name in SOURCES:
        if source_name not in present:
            continue
        actors = [row for row in corpus.actors if row.source == source_name]
        rankings = [row for row in corpus.rankings if row.source == source_name]
        all_routes = [row for row in corpus.trajectories if row.source == source_name]
        routes = [row for row in all_routes if row.counterfactual_group is None]
        counterfactuals = [row for row in all_routes if row.counterfactual_group is not None]
        route_outcomes = {
            route.episode: bool(route.values and route.values[0].won == 1)
            for route in routes
        }
        wins = sum(bool(route.values and route.values[0].won == 1) for route in routes)
        route_rounds = sum(route.values[0].remaining for route in routes if route.values)
        route_power = sum(route.values[0].score for route in routes if route.values)
        actor_actions = sum(len(row.actions) for row in actors)
        legal_actions = sum(len(row.moves) for row in actors)
        result[source_name] = {
            "policyActorRows": len(actors),
            "policyEpisodes": len(set(row.episode for row in actors)),
            "policyRowsAreWinningRouteOnly": source_name in ("katago", "handcrafted"),
            "labeledActions": actor_actions,
            "meanLabelsPerActor": ratio(actor_actions, len(actors)),
            "meanLegalActionsPerActor": ratio(legal_actions, len(actors)),
            "labelToLegalActionCoverage": ratio(actor_actions, legal_actions),
            "multiPositiveActorRate": ratio(sum(len(row.actions) > 1 for row in actors), len(actors)),
            "executedActionKnownRate": ratio(sum(row.executed is not None for row in actors), len(actors)),
            "passPositiveRate": ratio(sum((len(row.state.split("|")[0]) in row.actions)
                                           for row in actors), len(actors)),
            "relativeRankingRows": len(rankings),
            "rankingRowsOnWinningRoutes": sum(
                route_outcomes.get(row.episode) is True for row in rankings),
            "rankingRowsOnLosingRoutes": sum(
                route_outcomes.get(row.episode) is False for row in rankings),
            "rankingRowsWithoutRouteOutcome": sum(
                row.episode not in route_outcomes for row in rankings),
            "rankingAlternatives": sum(max(0, len(row.moves) - 1) for row in rankings),
            "realTerminalRoutes": len(routes),
            "routeWins": wins,
            "routeWinRate": ratio(wins, len(routes)),
            "meanRouteTurns": ratio(route_rounds, len(routes)),
            "lossPenalizedBlackPowerPerTotalTurn": ratio(route_power, route_rounds),
            "trajectoryStateRows": sum(len(route.values) for route in routes),
            "effectiveIndependentOutcomeLabels": len(routes),
            "counterfactualTerminalOutcomes": len(counterfactuals),
            "counterfactualGroups": len({
                row.counterfactual_group for row in counterfactuals}),
        }
    return result


def decode_predictions(raw: torch.Tensor) -> torch.Tensor:
    return torch.cat((
        torch.sigmoid(raw[:, :1]),
        torch.expm1(torch.clamp(torch.nn.functional.softplus(raw[:, 1:]), max=40)),
    ), dim=1)


@torch.no_grad()
def predict_policy(model, rows: Sequence[ActorRow | RankingRow], device: torch.device,
                   batch_size: int) -> list[list[float]]:
    output: list[list[float]] = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start:start + batch_size]
        inputs = set_elapsed(
            encode_states([row.state for row in batch], model.shape.extent, device),
            [row.elapsed for row in batch], model.shape.extent)
        behavior = torch.tensor(
            [row.behavior for row in batch], dtype=torch.float32, device=device)
        output.extend(model.forward_policy(inputs, behavior).cpu().tolist())
    return output


@torch.no_grad()
def predict_values(model, rows: Sequence[ValueRow], device: torch.device,
                   batch_size: int) -> list[tuple[float, float, float]]:
    output: list[tuple[float, float, float]] = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start:start + batch_size]
        inputs = set_elapsed(
            encode_states([row.state for row in batch], model.shape.extent, device),
            [row.elapsed for row in batch], model.shape.extent)
        behavior = post_reply_behavior(
            [row.behavior for row in batch], model.shape.extent,
            model.shape.behavior, device)
        output.extend(tuple(float(value) for value in row)
                      for row in decode_predictions(model.forward_value(inputs, behavior)).cpu())
    return output


def top_moves(row: ActorRow | RankingRow, logits: Sequence[float], top_k: int) -> set[int]:
    return set(sorted(row.moves, key=lambda move: (-logits[move], move))[:top_k])


def actor_input_key(row: ActorRow) -> tuple[object, ...]:
    """Exact paired-route neural input, using the f32 behavior consumed by torch."""
    return (row.episode, row.elapsed, row.state,
            tuple(struct.pack(">f", value) for value in row.behavior))


def teacher_complementarity(
    rows: Sequence[ActorRow], logits: Sequence[Sequence[float]] | None, top_k: int,
) -> dict[str, object]:
    if logits is not None and len(rows) != len(logits):
        raise ValueError("actor rows/logits length mismatch")
    indexed = list(zip(rows, logits if logits is not None else [None] * len(rows), strict=True))
    kata = {actor_input_key(row): (row, values) for row, values in indexed
            if row.source == "katago"}
    handcrafted = {actor_input_key(row): (row, values) for row, values in indexed
                   if row.source == "handcrafted"}
    shared = sorted(kata.keys() & handcrafted.keys())
    result: dict[str, object] = {
        "exactSharedPairedRouteInputs": len(shared),
        "distinctEpisodes": len({int(key[0]) for key in shared}),
        "elapsedHistogram": dict(sorted(collections.Counter(
            int(key[1]) for key in shared).items())),
    }
    if not shared:
        return result
    agreements = 0
    handcrafted_in_kata = 0
    union_elements = 0
    for key in shared:
        kata_row, _ = kata[key]
        handcrafted_row, _ = handcrafted[key]
        agreements += kata_row.executed == handcrafted_row.executed
        handcrafted_in_kata += handcrafted_row.executed in kata_row.actions
        union_elements += len(set(kata_row.actions) | set(handcrafted_row.actions))
    result.update({
        "executedMoveAgreement": ratio(agreements, len(shared)),
        "handcraftedMoveInKataProposalSet": ratio(handcrafted_in_kata, len(shared)),
        "meanUnionPositiveActions": ratio(union_elements, len(shared)),
    })
    if logits is None:
        return result
    shortlist: dict[str, object] = {}
    for limit in sorted({top_k, top_k * 2}):
        kata_any = kata_executed = handcrafted_in = both = all_union = retained = total = 0
        for key in shared:
            kata_row, values = kata[key]
            handcrafted_row, _ = handcrafted[key]
            assert values is not None
            top = top_moves(kata_row, values, limit)
            has_kata = bool(set(kata_row.actions) & top)
            has_handcrafted = handcrafted_row.executed in top
            union = set(kata_row.actions) | set(handcrafted_row.actions)
            kata_any += has_kata
            kata_executed += kata_row.executed in top
            handcrafted_in += has_handcrafted
            both += has_kata and has_handcrafted
            all_union += union <= top
            retained += len(union & top)
            total += len(union)
        shortlist[str(limit)] = {
            "kataAnyProposalIncluded": ratio(kata_any, len(shared)),
            "kataExecutedIncluded": ratio(kata_executed, len(shared)),
            "handcraftedIncluded": ratio(handcrafted_in, len(shared)),
            "bothSourcesRepresented": ratio(both, len(shared)),
            "allUnionActionsIncluded": ratio(all_union, len(shared)),
            "unionElementRecall": ratio(retained, total),
        }
    result["shortlist"] = shortlist
    return result


def legal_moves_from_state(state: str) -> list[int]:
    board, legal, *_ = state.split("|")
    return [index for index, value in enumerate(legal) if value == "1"] + [len(board)]


def policy_metrics(rows: Sequence[ActorRow], logits: Sequence[Sequence[float]],
                   top_k: int) -> dict[str, object]:
    by_source: dict[str, list[tuple[ActorRow, Sequence[float], set[int]]]] = collections.defaultdict(list)
    for row, values in zip(rows, logits, strict=True):
        by_source[row.source].append((row, values, top_moves(row, values, top_k)))
    result: dict[str, object] = {}
    for source_name, records in sorted(by_source.items()):
        def percentile_rank(values: Sequence[int], quantile: float) -> int | None:
            if not values:
                return None
            ordered = sorted(values)
            return ordered[min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)]

        route_last_elapsed: dict[int, int] = collections.defaultdict(int)
        for row, _, _ in records:
            route_last_elapsed[row.episode] = max(route_last_elapsed[row.episode], row.elapsed)

        def route_stage(row: ActorRow) -> str:
            fraction = row.elapsed / max(route_last_elapsed[row.episode] + 1, 1)
            return "early" if fraction < 1 / 3 else "middle" if fraction < 2 / 3 else "late"

        any_recall = sum(bool(set(row.actions) & top) for row, _, top in records)
        executed_rows = [(row, top) for row, _, top in records if row.executed is not None]
        executed_recall = sum(row.executed in top for row, top in executed_rows)
        positive_slots = sum(len(row.actions) for row, _, _ in records)
        retained_slots = sum(len(set(row.actions) & top) for row, _, top in records)
        top1_any = sum(bool(set(row.actions) & top_moves(row, values, 1))
                       for row, values, _ in records)
        positive_best_ranks: list[int] = []
        executed_ranks: list[int] = []
        for row, values, _ in records:
            order = sorted(row.moves, key=lambda move: (-values[move], move))
            ranks = {move: index + 1 for index, move in enumerate(order)}
            positive_best_ranks.append(min(ranks[action] for action in row.actions))
            if row.executed is not None:
                executed_ranks.append(ranks[row.executed])
        by_stage: dict[str, object] = {}
        for stage_name in ("early", "middle", "late"):
            stage_records = [(row, values, top) for row, values, top in records
                             if route_stage(row) == stage_name]
            stage_executed = [(row, top) for row, _, top in stage_records
                              if row.executed is not None]
            by_stage[stage_name] = {
                "rows": len(stage_records),
                "anyTeacherPositiveIncluded": ratio(
                    sum(bool(set(row.actions) & top) for row, _, top in stage_records),
                    len(stage_records)),
                "executedTeacherMoveIncluded": ratio(
                    sum(row.executed in top for row, top in stage_executed),
                    len(stage_executed)),
                "top1IsTeacherPositive": ratio(
                    sum(bool(set(row.actions) & top_moves(row, values, 1))
                        for row, values, _ in stage_records), len(stage_records)),
            }
        route_rows: dict[int, list[tuple[ActorRow, set[int]]]] = collections.defaultdict(list)
        for row, _, top in records:
            route_rows[row.episode].append((row, top))
        off_authority_rows = strict_off_rows = authority_misses = strict_misses = 0
        authority_never = strict_never = 0
        for episode_rows in route_rows.values():
            episode_rows.sort(key=lambda value: value[0].elapsed)
            authority_at = next((index for index, (row, top) in enumerate(episode_rows)
                                 if not set(row.actions) & top), None)
            strict_at = next((index for index, (row, top) in enumerate(episode_rows)
                              if row.executed is not None and row.executed not in top), None)
            if authority_at is None:
                authority_never += 1
            else:
                authority_misses += 1
                off_authority_rows += len(episode_rows) - authority_at - 1
            if strict_at is None:
                strict_never += 1
            else:
                strict_misses += 1
                strict_off_rows += len(episode_rows) - strict_at - 1
        result[source_name] = {
            "heldoutActorRows": len(records),
            "topK": top_k,
            "anyTeacherPositiveIncluded": ratio(any_recall, len(records)),
            "executedTeacherMoveIncluded": ratio(executed_recall, len(executed_rows)),
            "allPositiveElementRecall": ratio(retained_slots, positive_slots),
            "top1IsTeacherPositive": ratio(top1_any, len(records)),
            "teacherPositiveBestPolicyRank": {
                "mean": ratio(sum(positive_best_ranks), len(positive_best_ranks)),
                "median": percentile_rank(positive_best_ranks, 0.5),
                "p90": percentile_rank(positive_best_ranks, 0.9),
            },
            "executedTeacherPolicyRank": {
                "mean": ratio(sum(executed_ranks), len(executed_ranks)),
                "median": percentile_rank(executed_ranks, 0.5),
                "p90": percentile_rank(executed_ranks, 0.9),
            } if executed_ranks else None,
            "byRelativeRouteStage": by_stage,
            "routes": len(route_rows),
            "routesWithTeacherSetOmission": authority_misses,
            "routesNeverOmittingTeacherSet": authority_never,
            "laterRowsAfterFirstTeacherSetOmission": off_authority_rows,
            "laterRowFractionProvablyOffTeacherTrajectory": ratio(off_authority_rows, len(records)),
            "routesWithExecutedMoveOmission": strict_misses if executed_rows else None,
            "laterRowsAfterFirstExecutedMoveOmission": strict_off_rows if executed_rows else None,
            "laterRowFractionAfterExecutedMoveOmission": (
                ratio(strict_off_rows, len(records)) if executed_rows else None),
            "interpretation": (
                "later-row fractions are lower bounds: an omitted move proves departure; "
                "inclusion does not prove the value stage selects it"),
        }
    return result


def candidate_quality(values: Sequence[ValueRow], predictions: Sequence[tuple[float, float, float]],
                      actor_elapsed: int) -> tuple[float, float]:
    win = rate = 0.0
    for value, prediction in zip(values, predictions, strict=True):
        win += value.weight * prediction[0]
        rate += value.weight * prediction[1] / max(actor_elapsed + prediction[2], 1e-6)
    return win, rate


def exhaustive_numeric_metrics(
    rows: Sequence[RankingRow], policy_logits: Sequence[Sequence[float]],
    value_predictions: Sequence[tuple[float, float, float]], top_k: int,
) -> dict[str, object]:
    """Measure generalization to held-out frozen-champion numeric reply labels.

    These labels identify agreement with the losing frozen champion, not game
    truth. Keeping them separate from external categorical preferences and
    terminal trajectories prevents a lower imitation error from masquerading
    as improved counterfactual accuracy.
    """
    offset = 0
    totals: collections.defaultdict[str, float] = collections.defaultdict(float)
    for row, logits in zip(rows, policy_logits, strict=True):
        student_qualities: list[tuple[float, float]] = []
        target_qualities: list[tuple[float, float]] = []
        for candidate in row.candidates:
            predicted = value_predictions[offset:offset + len(candidate)]
            offset += len(candidate)
            student_qualities.append(candidate_quality(candidate, predicted, row.elapsed))
            target_qualities.append(candidate_quality(
                candidate,
                [(value.won, value.score, value.remaining) for value in candidate],
                row.elapsed))
            for value, prediction in zip(candidate, predicted, strict=True):
                totals["weight"] += value.weight
                totals["winMae"] += value.weight * abs(prediction[0] - value.won)
                totals["scoreMae"] += value.weight * abs(prediction[1] - value.score)
                totals["remainingMae"] += value.weight * abs(
                    prediction[2] - value.remaining)
                totals["replyValues"] += 1
        selected = row.moves.index(row.best_move)
        student_order = sorted(range(len(row.moves)), key=lambda index: (
            -student_qualities[index][0], -student_qualities[index][1], row.moves[index]))
        selected_rank = student_order.index(selected) + 1
        shortlist = top_moves(row, logits, top_k)
        shortlisted_indexes = [index for index, move in enumerate(row.moves)
                               if move in shortlist]
        deployed = min(shortlisted_indexes, key=lambda index: (
            -student_qualities[index][0], -student_qualities[index][1], row.moves[index]))
        totals["rows"] += 1
        totals["globalAgreement"] += selected_rank == 1
        totals["selectedRank"] += selected_rank
        totals["teacherBestAvailable"] += row.best_move in shortlist
        totals["deploymentAgreement"] += deployed == selected
        totals["availableAndSelected"] += row.best_move in shortlist and deployed == selected
        chosen_target = target_qualities[deployed]
        best_target = target_qualities[selected]
        totals["teacherWinRegret"] += max(0.0, best_target[0] - chosen_target[0])
        totals["teacherRateRegretOnWinTie"] += (
            max(0.0, best_target[1] - chosen_target[1])
            if abs(best_target[0] - chosen_target[0]) <= 1e-5 else 0.0)
    if offset != len(value_predictions):
        raise RuntimeError("unused exhaustive numeric predictions")
    available = totals["teacherBestAvailable"]
    return {
        "heldoutProposalRows": int(totals["rows"]),
        "heldoutWeightedReplyValues": int(totals["replyValues"]),
        "weightedWinMaeAgainstChampion": ratio(totals["winMae"], totals["weight"]),
        "weightedScoreMaeAgainstChampion": ratio(totals["scoreMae"], totals["weight"]),
        "weightedRemainingMaeAgainstChampion": ratio(
            totals["remainingMae"], totals["weight"]),
        "globalChampionBestTop1Agreement": ratio(
            totals["globalAgreement"], totals["rows"]),
        "meanChampionBestRankAmongLegalCandidates": ratio(
            totals["selectedRank"], totals["rows"]),
        "championBestInPolicyTopK": ratio(available, totals["rows"]),
        "deploymentChampionBestAgreement": ratio(
            totals["deploymentAgreement"], totals["rows"]),
        "valueSelectsChampionBestWhenAvailable": ratio(
            totals["availableAndSelected"], available),
        "meanChampionWinRegretOfDeploymentMove": ratio(
            totals["teacherWinRegret"], totals["rows"]),
        "meanChampionPowerPerTurnRegretOnWinTie": ratio(
            totals["teacherRateRegretOnWinTie"], totals["rows"]),
        "authority": "agreement with frozen losing champion numeric labels; not terminal truth",
    }


def ranking_metrics(rows: Sequence[RankingRow], policy_logits: Sequence[Sequence[float]],
                    value_predictions: Sequence[tuple[float, float, float]], top_k: int,
                    trajectories: Sequence[Trajectory]) -> dict[str, object]:
    actual_states = {
        (route.source, route.episode, index): value.state
        for route in trajectories for index, value in enumerate(route.values)
    }
    by_source: dict[str, dict[str, float]] = collections.defaultdict(lambda: collections.defaultdict(float))
    offset = 0
    for row, logits in zip(rows, policy_logits, strict=True):
        qualities: list[tuple[float, float]] = []
        for candidate in row.candidates:
            predicted = value_predictions[offset:offset + len(candidate)]
            offset += len(candidate)
            qualities.append(candidate_quality(candidate, predicted, row.elapsed))
        selected = row.moves.index(row.best_move)
        order = sorted(range(len(row.moves)), key=lambda index: (
            -qualities[index][0], -qualities[index][1], row.moves[index]))
        selected_rank = order.index(selected) + 1
        selected_quality = qualities[selected]
        negatives = [index for index in range(len(row.moves)) if index != selected]
        hardest = max(negatives, key=lambda index: (
            qualities[index][0], qualities[index][1], -row.moves[index]))
        global_legal = legal_moves_from_state(row.state)
        global_top = set(sorted(
            global_legal, key=lambda move: (-logits[move], move))[:top_k])
        source = by_source[row.source]
        source["rows"] += 1
        source["top1Agreement"] += selected_rank == 1
        source["selectedRank"] += selected_rank
        source["selectedInGlobalTopK"] += row.best_move in global_top
        source["anySampledNegativeInGlobalTopK"] += bool(global_top & {
            row.moves[index] for index in negatives})
        source["sampledNegatives"] += len(negatives)
        source["passNegatives"] += sum(
            row.moves[index] == len(row.state.split("|")[0]) for index in negatives)
        source["negativePredictedAboveSelected"] += selected_rank != 1
        source["hardestNegativeWinDelta"] += qualities[hardest][0] - selected_quality[0]
        source["hardestNegativeRateDelta"] += qualities[hardest][1] - selected_quality[1]
        selected_state = row.candidates[selected][0].state
        factual = actual_states.get((row.source, row.episode, row.elapsed))
        source["selectedTransitionComparable"] += factual is not None
        source["selectedTransitionMatchesRoute"] += factual == selected_state
    if offset != len(value_predictions):
        raise RuntimeError("unused ranking predictions")
    return {
        source_name: {
            "heldoutRankingRows": int(values["rows"]),
            "categoricalTeacherPreferenceTop1Agreement": ratio(
                values["top1Agreement"], values["rows"]),
            "meanSelectedRankAmongSample": ratio(values["selectedRank"], values["rows"]),
            "selectedMoveInGlobalTopK": ratio(values["selectedInGlobalTopK"], values["rows"]),
            "rowsWithAnySampledNegativeInGlobalTopK": ratio(
                values["anySampledNegativeInGlobalTopK"], values["rows"]),
            "meanSampledNegatives": ratio(values["sampledNegatives"], values["rows"]),
            "passShareOfSampledNegatives": ratio(values["passNegatives"], values["sampledNegatives"]),
            "rowsWhereChampionValuePrefersANegative": ratio(
                values["negativePredictedAboveSelected"], values["rows"]),
            "meanHardestNegativeMinusTeacherWin": ratio(
                values["hardestNegativeWinDelta"], values["rows"]),
            "meanHardestNegativeMinusTeacherPowerPerTurn": ratio(
                values["hardestNegativeRateDelta"], values["rows"]),
            "selectedPostReplyMatchesActualRoute": ratio(
                values["selectedTransitionMatchesRoute"],
                values["selectedTransitionComparable"]),
            "counterfactualAccuracyIdentifiable": False,
            "whyNot": (
                "actor-ranking won/score/remaining fields are selection markers; "
                "no alternative was continued to a terminal outcome"),
        }
        for source_name, values in sorted(by_source.items())
    }


def trajectory_value_metrics(routes: Sequence[Trajectory], model, device: torch.device,
                             batch_size: int) -> dict[str, object]:
    rows = [value for route in routes for value in route.values]
    predictions = predict_values(model, rows, device, batch_size)
    by_source: dict[str, dict[str, float]] = collections.defaultdict(lambda: collections.defaultdict(float))
    offset = 0
    for route in routes:
        source_name = (f"{route.source}-terminal-counterfactual"
                       if route.counterfactual_group else route.source)
        source = by_source[source_name]
        source["routes"] += 1
        for value in route.values:
            prediction = predictions[offset]
            offset += 1
            source["weight"] += value.weight
            source["winMae"] += value.weight * abs(prediction[0] - value.won)
            source["scoreMae"] += value.weight * abs(prediction[1] - value.score)
            source["remainingMae"] += value.weight * abs(prediction[2] - value.remaining)
    return {
        source_name: {
            "heldoutRoutes": int(values["routes"]),
            "routeWeightedOnTrajectoryWinMae": ratio(values["winMae"], values["weight"]),
            "routeWeightedOnTrajectoryScoreMae": ratio(values["scoreMae"], values["weight"]),
            "routeWeightedOnTrajectoryRemainingMae": ratio(values["remainingMae"], values["weight"]),
            "note": "accuracy is on teacher-visited states and does not validate deviations",
        }
        for source_name, values in sorted(by_source.items())
    }


def terminal_counterfactual_scope_metrics(
    groups: Sequence[tuple[str, Sequence[Trajectory], Sequence[tuple[float, float, float]]]],
    candidate_scope: str,
) -> dict[str, object]:
    totals: collections.defaultdict[str, float] = collections.defaultdict(float)
    components: set[str] = set()
    for _group_id, candidates, predicted in groups:
        indexes = [index for index, route in enumerate(candidates)
                   if candidate_scope == "all"
                   or candidate_scope == "finalists" and route.student_finalist is True
                   or candidate_scope == "policy-top16" and route.student_top_k is True]
        if not indexes:
            continue
        student_quality = [
            (estimate[0], estimate[1] / max((route.origin_elapsed or 0) + estimate[2], 1e-6))
            for route, estimate in zip(candidates, predicted, strict=True)
        ]
        truth_quality = []
        for route in candidates:
            value = route.values[0]
            truth_quality.append((
                value.won,
                value.score / max((route.origin_elapsed or 0) + value.remaining, 1e-6),
            ))
        student_best = min(indexes, key=lambda index: (
            -student_quality[index][0], -student_quality[index][1], index))
        truth_best = min(indexes, key=lambda index: (
            -truth_quality[index][0], -truth_quality[index][1], index))
        totals["groups"] += 1
        totals["candidates"] += len(indexes)
        totals["studentBestIsTerminalBest"] += student_best == truth_best
        totals["studentChoiceWins"] += truth_quality[student_best][0]
        totals["terminalBestWins"] += truth_quality[truth_best][0]
        totals["studentWinRegret"] += max(
            0.0, truth_quality[truth_best][0] - truth_quality[student_best][0])
        if truth_quality[truth_best][0] == truth_quality[student_best][0]:
            totals["studentPowerPerTurnRegretOnWinTie"] += max(
                0.0, truth_quality[truth_best][1] - truth_quality[student_best][1])
        if candidates[0].split_component is not None:
            components.add(candidates[0].split_component)

        references = {
            "handcrafted": candidates[0].handcrafted_action
                if candidates[0].handcrafted_action is not None
                else candidates[0].chosen_action,
            "kataGo": candidates[0].katago_action,
            "originatingStudent": candidates[0].student_action,
        }
        for name, action in references.items():
            reference = next((index for index in indexes
                              if candidates[index].forced_action == action), None)
            if reference is None:
                continue
            totals[f"{name}Available"] += 1
            totals[f"{name}IsTerminalBest"] += reference == truth_best
            totals[f"modelSelects{name[0].upper()}{name[1:]}"] += student_best == reference
    group_count = totals["groups"]
    result: dict[str, object] = {
        "heldoutGroups": int(group_count),
        "heldoutIndependentComponents": len(components),
        "meanCandidatesPerGroup": ratio(totals["candidates"], group_count),
        "modelTop1TerminalTruthAgreement": ratio(
            totals["studentBestIsTerminalBest"], group_count),
        "modelChoiceTerminalWinRate": ratio(totals["studentChoiceWins"], group_count),
        "terminalBestAvailableWinRate": ratio(totals["terminalBestWins"], group_count),
        "meanTerminalWinRegretOfModelChoice": ratio(
            totals["studentWinRegret"], group_count),
        "meanLossPenalizedPowerPerTurnRegretOnWinTie": ratio(
            totals["studentPowerPerTurnRegretOnWinTie"], group_count),
    }
    for name in ("handcrafted", "kataGo", "originatingStudent"):
        available = totals[f"{name}Available"]
        label = f"{name}Action"
        result[f"{label}AvailableGroups"] = int(available)
        result[f"{label}IsTerminalBest"] = ratio(
            totals[f"{name}IsTerminalBest"], available)
        result[f"modelSelects{name[0].upper()}{name[1:]}Action"] = ratio(
            totals[f"modelSelects{name[0].upper()}{name[1:]}"], available)
    return result


def terminal_counterfactual_metrics(routes: Sequence[Trajectory], model,
                                    device: torch.device, batch_size: int) -> dict[str, object]:
    groups: dict[str, list[Trajectory]] = collections.defaultdict(list)
    for route in routes:
        if route.counterfactual_group is not None:
            groups[route.counterfactual_group].append(route)
    for candidates in groups.values():
        candidates.sort(key=lambda route: route.candidate_index or 0)
    first_rows = [route.values[0] for group in groups.values() for route in group]
    predictions = iter(predict_values(model, first_rows, device, batch_size))
    evaluated_groups: list[
        tuple[str, Sequence[Trajectory], Sequence[tuple[float, float, float]]]
    ] = []
    for group_id, candidates in groups.items():
        if len(candidates) != candidates[0].candidate_count:
            raise RuntimeError(f"incomplete terminal counterfactual group {group_id}")
        predicted = [next(predictions) for _ in candidates]
        evaluated_groups.append((group_id, candidates, predicted))
    try:
        next(predictions)
        raise RuntimeError("unused terminal counterfactual predictions")
    except StopIteration:
        pass
    result = terminal_counterfactual_scope_metrics(evaluated_groups, "all")
    # Retain the old names for consumers of teacher-trajectory counterfactual audits.
    result["handcraftedChosenIsTerminalBest"] = result["handcraftedActionIsTerminalBest"]
    result["modelSelectsHandcraftedChosen"] = result["modelSelectsHandcraftedAction"]
    if any(route.student_top_k is not None for candidates in groups.values()
           for route in candidates):
        result["literalStudentTop16"] = terminal_counterfactual_scope_metrics(
            evaluated_groups, "policy-top16")
    if any(route.student_finalist is not None for candidates in groups.values()
           for route in candidates):
        result["deployedStudentFinalists"] = terminal_counterfactual_scope_metrics(
            evaluated_groups, "finalists")
    if any(route.student_top_k is not None or route.student_finalist is not None
           for candidates in groups.values() for route in candidates):
        selection_kinds = sorted({
            candidates[0].selection_kind for candidates in groups.values()
            if candidates[0].selection_kind is not None
        })
        result["bySelectionKind"] = {
            kind: {
                "allRecordedCandidates": terminal_counterfactual_scope_metrics(
                    [group for group in evaluated_groups
                     if group[1][0].selection_kind == kind], "all"),
                **({"deployedStudentFinalists": terminal_counterfactual_scope_metrics(
                    [group for group in evaluated_groups
                     if group[1][0].selection_kind == kind], "finalists")}
                   if any(route.student_finalist is not None
                          for group in evaluated_groups
                          for route in group[1]) else {}),
                **({"literalStudentTop16": terminal_counterfactual_scope_metrics(
                    [group for group in evaluated_groups
                     if group[1][0].selection_kind == kind], "policy-top16")}
                   if any(route.student_top_k is not None
                          for group in evaluated_groups
                          for route in group[1]) else {}),
            }
            for kind in selection_kinds
        }
    result.update({
        "authority": "real environment terminal outcomes under frozen handcrafted continuation",
        "statisticalUnit": "split components, not candidate continuations or correlated positions",
        "candidateScope": (
            "all recorded candidates; deployedStudentFinalists is the production value-choice set; "
            "literalStudentTop16 is policy-rank diagnostics only"),
    })
    return result


def sampled(values: Sequence[ActorRow], limit: int) -> list[ActorRow]:
    if len(values) <= limit:
        return list(values)
    return [values[min(len(values) - 1, math.floor(index * len(values) / limit))]
            for index in range(limit)]


def nearest_hamming(left: Sequence[ActorRow], right: Sequence[ActorRow],
                    same_source: bool) -> float | None:
    if not left or not right or same_source and len(left) < 2:
        return None
    a = torch.tensor([[ord(cell) for cell in row.state.split("|")[0]] for row in left],
                     dtype=torch.uint8)
    b = torch.tensor([[ord(cell) for cell in row.state.split("|")[0]] for row in right],
                     dtype=torch.uint8)
    total = 0.0
    for start in range(0, len(a), 64):
        distances = (a[start:start + 64, None, :] != b[None, :, :]).sum(dim=2)
        if same_source:
            indexes = torch.arange(start, min(start + 64, len(a)))
            distances[torch.arange(len(indexes)), indexes] = a.shape[1] + 1
        total += float(distances.min(dim=1).values.sum())
    return total / (len(a) * a.shape[1])


def state_overlap(rows: Sequence[ActorRow], sample_limit: int) -> dict[str, object]:
    by_source = {source_name: [row for row in rows if row.source == source_name]
                 for source_name in SOURCES}
    by_source = {key: value for key, value in by_source.items() if value}
    summaries: dict[str, object] = {}
    for source_name, source_rows in by_source.items():
        summaries[source_name] = {
            "actorRows": len(source_rows),
            "uniqueExactStates": len(set(row.state for row in source_rows)),
            "meanElapsed": sum(row.elapsed for row in source_rows) / len(source_rows),
            "meanBlackStones": sum(row.state.split("|")[0].count("X") for row in source_rows)
                / len(source_rows),
            "meanWhiteStones": sum(row.state.split("|")[0].count("O") for row in source_rows)
                / len(source_rows),
            "meanLegalPlacements": sum(row.state.split("|")[1].count("1") for row in source_rows)
                / len(source_rows),
        }
    pairs: dict[str, object] = {}
    names = sorted(by_source)
    sets = {name: set(row.state for row in by_source[name]) for name in names}
    samples = {name: sampled(by_source[name], sample_limit) for name in names}
    within = {name: nearest_hamming(samples[name], samples[name], True) for name in names}
    for left_index, left_name in enumerate(names):
        for right_name in names[left_index + 1:]:
            intersection = len(sets[left_name] & sets[right_name])
            left_cross = nearest_hamming(samples[left_name], samples[right_name], False)
            right_cross = nearest_hamming(samples[right_name], samples[left_name], False)
            pairs[f"{left_name}:{right_name}"] = {
                "exactSharedStates": intersection,
                "leftExactCoverage": ratio(intersection, len(sets[left_name])),
                "rightExactCoverage": ratio(intersection, len(sets[right_name])),
                "leftMeanNearestCrossSourceBoardHamming": left_cross,
                "rightMeanNearestCrossSourceBoardHamming": right_cross,
                "leftMeanNearestWithinSourceBoardHamming": within[left_name],
                "rightMeanNearestWithinSourceBoardHamming": within[right_name],
                "hammingDenominatorIncludesAllBoardPoints": True,
                "samplePerSource": min(sample_limit, len(by_source[left_name]),
                                       len(by_source[right_name])),
            }
    return {"sources": summaries, "pairs": pairs,
            "population": "actor rows; fixed-teacher actors are conditioned on route wins"}


def validate_model_authority(model_sha: str, teacher_sha: str | None,
                             candidate_model: bool) -> None:
    if model_sha != teacher_sha and not candidate_model:
        raise RuntimeError(
            f"model {model_sha} is not corpus champion authority {teacher_sha}; "
            "pass --candidate-model only when intentionally evaluating a learned student")


def run(args: argparse.Namespace) -> dict[str, object]:
    paths = [pathlib.Path(path) for path in args.corpus]
    corpus = load_corpus(paths, args.split)
    model_path = pathlib.Path(args.model)
    model_sha = file_sha256(model_path)
    validate_model_authority(model_sha, corpus.teacher_sha256, args.candidate_model)
    device = auto_device(args.device)
    configure_accelerator(device)
    model = load_v9(model_path, device).eval()
    if (corpus.profile == "daemon19") != (model.shape.extent == 19):
        raise RuntimeError("model/corpus profile mismatch")
    evaluation_actors = [row for row in corpus.actors if row.split == args.split]
    evaluation_rankings = [row for row in corpus.rankings if row.split == args.split]
    evaluation_routes = [row for row in corpus.trajectories if row.split == args.split]
    actor_logits = predict_policy(model, evaluation_actors, device, args.batch_size)
    ranking_logits = predict_policy(model, evaluation_rankings, device, args.batch_size)
    ranking_values = [value for row in evaluation_rankings for candidate in row.candidates
                      for value in candidate]
    ranking_predictions = predict_values(model, ranking_values, device, args.batch_size)
    numeric_logits = predict_policy(
        model, corpus.exhaustive_rankings, device, args.batch_size)
    numeric_values = [value for row in corpus.exhaustive_rankings
                      for candidate in row.candidates for value in candidate]
    numeric_predictions = predict_values(model, numeric_values, device, args.batch_size)
    return {
        "audit": "bitburner-go-v9-teacher-authority-v1",
        "profile": corpus.profile,
        "model": str(model_path),
        "modelSha256": model_sha,
        "modelRole": "candidate" if args.candidate_model else "frozen champion authority",
        "corpusTeacherSha256": corpus.teacher_sha256,
        "corpora": [{"path": str(path), "sha256": file_sha256(path)} for path in paths],
        "evaluationSplit": args.split,
        "authority": {
            "exhaustiveNumericProposalRows": corpus.exhaustive_proposals,
            "exhaustiveNumericReplyValues": corpus.exhaustive_distill_values,
            "exhaustiveNumericValueAuthors": dict(sorted(
                corpus.exhaustive_distill_authors.items())),
            "exhaustiveNumericValueAuthor": "none"
                if corpus.exhaustive_distill_values == 0
                else "frozen champion"
                if corpus.exhaustive_distill_authors == collections.Counter({
                    "champion": corpus.exhaustive_distill_values})
                else "mixed or implicit; inspect exhaustiveNumericValueAuthors",
            "externalTeacherValueTargets": "real terminal route outcomes only",
            "externalTeacherCounterfactualValueTargets": sum(
                len(route.values) for route in corpus.trajectories
                if route.counterfactual_group is not None),
            "bySource": source_authority(corpus),
        },
        "policy": policy_metrics(evaluation_actors, actor_logits, args.top_k),
        "fixedTeacherComplementarity": {
            "allActors": teacher_complementarity(corpus.actors, None, args.top_k),
            "evaluationSplit": teacher_complementarity(
                evaluation_actors, actor_logits, args.top_k),
        },
        "stateDistribution": state_overlap(corpus.actors, args.state_sample),
        "hardNegativesAndPreference": ranking_metrics(
            evaluation_rankings, ranking_logits, ranking_predictions,
            args.top_k, corpus.trajectories),
        "heldoutChampionNumeric": exhaustive_numeric_metrics(
            corpus.exhaustive_rankings, numeric_logits, numeric_predictions,
            args.top_k),
        "onTrajectoryValue": trajectory_value_metrics(
            evaluation_routes, model, device, args.batch_size),
        "heldoutTerminalCounterfactuals": terminal_counterfactual_metrics(
            evaluation_routes, model, device, args.batch_size),
        "limits": [
            "Top-K omission proves departure, but inclusion does not prove the value stage selects the teacher move.",
            "Ranking agreement is agreement with a categorical action preference, not counterfactual accuracy.",
            "Terminal counterfactual ordering is identifiable only for groups reported under heldoutTerminalCounterfactuals.",
        ],
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--model", required=True)
    result.add_argument(
        "--candidate-model", action="store_true",
        help="evaluate a learned candidate while retaining the corpus teacher as label authority")
    result.add_argument("--corpus", action="append", required=True)
    result.add_argument("--top-k", type=int, default=16)
    result.add_argument("--split", choices=("train", "heldout"), default="heldout")
    result.add_argument("--batch-size", type=int, default=2048)
    result.add_argument("--state-sample", type=int, default=512)
    result.add_argument("--device", default="auto")
    result.add_argument("--out")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    report = run(arguments)
    rendered = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if arguments.out:
        output = pathlib.Path(arguments.out)
        if output.exists():
            raise RuntimeError(f"refusing to overwrite {output}")
        output.write_text(rendered)
    print(rendered, end="")
