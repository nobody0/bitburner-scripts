#!/usr/bin/env python3
"""Stream and validate V9.5 corpus semantics.

This is intentionally independent of torch so it can audit large retained
corpora before a GPU environment is installed.  It validates both individual
records and route-level relationships, then reports duplication and split
leakage across every input file supplied in one invocation.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import math
import pathlib
import struct
import sys
from dataclasses import dataclass, field
from typing import Any, Iterable


# External evaluators that score an independent post-reply board rather than
# playing a route. Their win estimate is usable supervision; their score and
# remaining fields are unsupervised placeholders. Keeping this an explicit
# allow-list stops a static estimate from being recorded as rollout evidence.
STATIC_VALUE_AUTHORS = {"katago-lookahead-leaf-v1"}

CORPUS_SCHEMA = "bitburner-go-exhaustive-proposals-v9.5"
OPPONENT_ORACLE = "bitburner-go-ai-v3.0.1"
BRANCHES = 13
PROFILE_SHAPES = {"small5": (5, 31), "daemon19": (19, 30)}
FIXED_SOURCES = {"katago", "handcrafted"}


def valid_full_student_root_stage_balance(
    stage_counts: collections.Counter[str],
) -> bool:
    """Recognize the two outcome-blind 128-root manifest designs.

    The original experiment paired last-aligned roots with first divergence.
    The corrected-timing K=1 experiment instead pairs first divergence with a
    later recovery state from the same frozen route.  Both designs deliberately
    contain 64 roots from each of their two strata.
    """
    observed = {stage: count for stage, count in stage_counts.items() if count}
    return observed in (
        {"last-aligned": 64, "first-divergence": 64},
        {"first-divergence": 64, "post-divergence": 64},
    )


@dataclass
class Route:
    split: str
    source: str
    actors: dict[int, str] = field(default_factory=dict)
    rankings: set[int] = field(default_factory=set)
    proposals: dict[int, str] = field(default_factory=dict)
    trajectory: dict[str, Any] | None = None
    student_root_actor_authority: bool = False
    certified_playbook_actor_authority: bool = False


class Validator:
    def __init__(self, paths: list[pathlib.Path], max_issues: int = 100,
                 require_numeric_reply_author: str | None = None,
                 require_student_root_groups: int | None = None,
                 require_student_root_continuations: int | None = None) -> None:
        self.paths = paths
        self.max_issues = max_issues
        self.require_numeric_reply_author = require_numeric_reply_author
        self.require_student_root_groups = require_student_root_groups
        self.require_student_root_continuations = require_student_root_continuations
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.stats: dict[str, Any] = {
            "files": {},
            "records": 0,
            "kinds": collections.Counter(),
            "sources": collections.Counter(),
            "splits": collections.Counter(),
            "responseFlags": collections.Counter(),
            "replyGroups": collections.Counter(),
            "numericReplyAuthors": collections.Counter(),
            "terminalValueAuthors": collections.Counter(),
            "counterfactualGroups": 0,
            "counterfactualContinuations": 0,
            "counterfactualStages": collections.Counter(),
            "counterfactualCandidateCounts": collections.Counter(),
            "counterfactualOutcomes": collections.Counter(),
            "counterfactualOriginRoutes": 0,
            "counterfactualMaxPositionsPerOriginRoute": 0,
            "studentRootGroups": 0,
            "studentRootContinuations": 0,
            "exactDuplicateRecords": 0,
            "semanticDuplicateRecords": 0,
            "splitLeakage": {"proposalInputs": 0, "valueInputs": 0},
        }
        self.record_locations: dict[bytes, tuple[str, int]] = {}
        self.heldout_proposal_inputs: set[bytes] = set()
        self.heldout_value_inputs: set[bytes] = set()
        self.counterfactual_groups: dict[str, list[dict[str, Any]]] = \
            collections.defaultdict(list)

    def error(self, where: str, message: str) -> None:
        if len(self.errors) < self.max_issues:
            self.errors.append(f"{where}: {message}")

    def warn(self, where: str, message: str) -> None:
        if len(self.warnings) < self.max_issues:
            self.warnings.append(f"{where}: {message}")

    @staticmethod
    def digest(value: Any) -> bytes:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                             allow_nan=False).encode()
        return hashlib.blake2b(encoded, digest_size=16).digest()

    @staticmethod
    def input_key(state: Any, behavior: Iterable[Any], elapsed: Any) -> tuple[Any, list[str], Any]:
        # PyTorch consumes behavior as f32. Distinct JSON decimal spellings
        # that round to one deployed/training tensor must share a split key.
        return state, [struct.pack(">f", float(value)).hex() for value in behavior], elapsed

    def note_split(self, table: set[bytes], key: Any, split: str,
                   category: str) -> None:
        del category
        digest = self.digest(key)
        if split == "heldout":
            table.add(digest)

    @staticmethod
    def finite_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) \
            and math.isfinite(float(value))

    @staticmethod
    def score_board(board: str, extent: int, komi: float) -> tuple[float, float]:
        """Mirror Bitburner's area scorer over column-major x * extent + y."""
        black = 0.0
        white = komi
        seen: set[int] = set()
        area = extent * extent
        for start, cell in enumerate(board):
            if cell == "X":
                black += 1
                continue
            if cell == "O":
                white += 1
                continue
            if cell != "." or start in seen:
                continue
            region: list[int] = []
            stack = [start]
            borders_black = False
            borders_white = False
            while stack:
                point = stack.pop()
                if point in seen or board[point] != ".":
                    continue
                seen.add(point)
                region.append(point)
                x, y = divmod(point, extent)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < extent and 0 <= ny < extent):
                        continue
                    neighbor = nx * extent + ny
                    adjacent = board[neighbor]
                    if adjacent == ".":
                        stack.append(neighbor)
                    elif adjacent == "X":
                        borders_black = True
                    elif adjacent == "O":
                        borders_white = True
            # The upstream almost-empty-board exception does not award a
            # region covering all but one or two playable points.
            if len(region) <= area - 3 and borders_black != borders_white:
                if borders_black:
                    black += len(region)
                else:
                    white += len(region)
        return black, white

    def number(self, value: Any, where: str, name: str,
               low: float | None = None, high: float | None = None) -> float:
        if not self.finite_number(value):
            self.error(where, f"{name} must be finite")
            return 0.0
        result = float(value)
        if low is not None and result < low:
            self.error(where, f"{name}={result} is below {low}")
        if high is not None and result > high:
            self.error(where, f"{name}={result} is above {high}")
        return result

    def state(self, value: Any, profile: str, where: str,
              expected_context: str | None = None) -> tuple[str, str, int, int, int] | None:
        extent, _ = PROFILE_SHAPES[profile]
        area = extent * extent
        if not isinstance(value, str):
            self.error(where, "state must be a string")
            return None
        parts = value.split("|")
        if len(parts) != 5:
            self.error(where, "state must have board|legal|passes|responsePass|responseNoOp")
            return None
        board, legal, passes_text, response_pass_text, response_noop_text = parts
        if len(board) != area or any(cell not in ".XO#" for cell in board):
            self.error(where, f"board must contain {area} .XO# cells")
        if len(legal) != area or any(cell not in "01" for cell in legal):
            self.error(where, f"legal plane must contain {area} bits")
        for index, bit in enumerate(legal[:len(board)]):
            if bit == "1" and board[index] != ".":
                self.error(where, f"legal point {index} is not empty")
                break
            if board[index] == "#" and bit != "0":
                self.error(where, f"offline point {index} is legal")
                break
        try:
            passes, response_pass, response_noop = map(
                int, (passes_text, response_pass_text, response_noop_text))
        except ValueError:
            self.error(where, "pass and response flags must be integers")
            return None
        if passes not in (0, 1, 2):
            self.error(where, f"pass count {passes} is outside 0..2")
        if response_pass not in (0, 1) or response_noop not in (0, 1):
            self.error(where, "response flags must be binary")
        if response_pass and response_noop:
            self.error(where, "response cannot be both pass and no-op")
        if expected_context == "decision" and (response_pass or response_noop):
            self.error(where, "Black decision state carries a consumed-response flag")
        self.stats["responseFlags"][
            "pass" if response_pass else "noOp" if response_noop else "move"] += 1
        return board, legal, passes, response_pass, response_noop

    def behavior(self, value: Any, profile: str, where: str, context: str) -> list[float]:
        _, width = PROFILE_SHAPES[profile]
        if not isinstance(value, list) or len(value) != width:
            self.error(where, f"{context} behavior must have width {width}")
            return []
        result = [self.number(item, where, f"behavior[{index}]")
                  for index, item in enumerate(value)]
        if len(result) != width:
            return result
        if context == "exact":
            if result[0] not in (0.0, 1.0):
                self.error(where, "exact smart field must be binary")
            for index in (1, 2, 3):
                if not 0 <= result[index] <= 1:
                    self.error(where, f"exact roll behavior[{index}] must be in [0,1]")
        elif context == "future":
            for index in (1, 2, 3):
                if result[index] != -1:
                    self.error(where, f"future roll behavior[{index}] must be -1")
            if not 0 <= result[0] <= 1:
                self.error(where, "future smart frequency must be in [0,1]")
        for index in range(4, 30):
            if not 0 <= result[index] <= 1:
                self.error(where, f"behavior[{index}] must be in [0,1]")
        if profile == "small5" and not 0 <= result[30] <= 1:
            self.error(where, "normalized komi must be in [0,1]")
        return result

    def split(self, record: dict[str, Any], episode: int, where: str) -> str:
        split = record.get("split")
        if split not in ("train", "heldout"):
            self.error(where, "split must be train or heldout")
            return "train"
        expected = "heldout" if episode % 10 == 0 else "train"
        if split != expected:
            self.error(where, f"episode {episode} belongs to {expected}, not {split}")
        return split

    def moves(self, raw: Any, state: tuple[str, str, int, int, int] | None,
              profile: str, where: str, exhaustive: bool) -> list[int]:
        extent, _ = PROFILE_SHAPES[profile]
        pass_move = extent * extent
        if not isinstance(raw, list) or not raw:
            self.error(where, "moves must be a non-empty list")
            return []
        moves: list[int] = []
        for index, value in enumerate(raw):
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= pass_move:
                self.error(where, f"moves[{index}] is outside 0..{pass_move}")
                continue
            moves.append(value)
        if len(set(moves)) != len(moves):
            self.error(where, "moves contain duplicates")
        if state is not None:
            legal = {index for index, bit in enumerate(state[1]) if bit == "1"}
            legal.add(pass_move)
            if any(move not in legal for move in moves):
                self.error(where, "moves contain a placement absent from the legal mask")
            if exhaustive and set(moves) != legal:
                self.error(where, "proposal moves are not the complete legal mask plus pass")
        return moves

    def value(self, raw: Any, profile: str, where: str, expected_elapsed: int | None,
              split: str, track_split: bool = True,
              static_evaluation: bool = False) -> dict[str, Any] | None:
        """`static_evaluation` marks an independent post-reply board scored by an
        external evaluator rather than a step of a played route. Such a record
        has no successor, so route-shaped constraints (sequential elapsed,
        remaining turns) do not apply and only the win estimate is supervised."""
        if not isinstance(raw, dict):
            self.error(where, "value must be an object")
            return None
        state = self.state(raw.get("state"), profile, where)
        behavior = self.behavior(raw.get("behavior"), profile, where, "future")
        elapsed = raw.get("elapsed")
        if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 1:
            self.error(where, "value elapsed must be a positive integer")
            elapsed = 1
        if expected_elapsed is not None and not static_evaluation \
                and elapsed != expected_elapsed:
            self.error(where, f"value elapsed {elapsed} != decision elapsed + 1 ({expected_elapsed})")
        self.number(raw.get("won"), where, "won", 0, 1)
        if static_evaluation:
            # Score and remaining are deliberately unsupervised placeholders: an
            # external win estimate carries no loss-penalized Black Power and no
            # remaining-turn count, and inventing them would fabricate targets.
            for field in ("score", "remaining"):
                if float(raw.get(field, -1)) != 0:
                    self.error(where, f"static evaluation must leave {field} at 0")
        else:
            self.number(raw.get("score"), where, "score", 0)
            self.number(raw.get("remaining"), where, "remaining", 1)
        self.number(raw.get("weight"), where, "weight", 0)
        if track_split and state is not None and behavior:
            self.note_split(self.heldout_value_inputs,
                            self.input_key(raw.get("state"), behavior, elapsed),
                            split, "valueInputs")
        return raw

    def probability_group(self, values: Any, profile: str, where: str,
                          expected_elapsed: int, split: str) -> list[dict[str, Any]]:
        if not isinstance(values, list) or not values:
            self.error(where, "candidate reply group must be non-empty")
            return []
        result = [value for index, raw in enumerate(values)
                  if (value := self.value(raw, profile, f"{where}[{index}]",
                                          expected_elapsed, split)) is not None]
        total = sum(float(value.get("weight", 0)) for value in result
                    if self.finite_number(value.get("weight")))
        if not math.isclose(total, 1, rel_tol=0, abs_tol=1e-4):
            self.error(where, f"reply probabilities sum to {total}, not 1")
        self.stats["replyGroups"]["total"] += 1
        self.stats["replyGroups"]["weighted" if len(result) > 1 else "singleton"] += 1
        self.stats["replyGroups"]["maxSize"] = max(
            self.stats["replyGroups"]["maxSize"], len(result))
        return result

    @staticmethod
    def source_of(record: dict[str, Any], raw: dict[str, Any], kind: str) -> str:
        generation = record.get("generation")
        generated = generation.get("source") if isinstance(generation, dict) else None
        source = raw.get("source") or generated
        if source is None and kind in ("proposal", "trajectory"):
            return "champion"
        return str(source)

    def validate_file(self, path: pathlib.Path) -> None:
        file_stats: dict[str, Any] = {
            "records": 0, "kinds": collections.Counter(),
            "sources": collections.Counter(), "splits": collections.Counter(),
            "routes": collections.Counter(), "routeWeight": collections.Counter(),
            "actorPassPositive": collections.Counter(), "maxElapsed": 0,
            "duplicateRecords": 0,
        }
        routes: dict[tuple[str, int], Route] = {}
        local_digests: set[bytes] = set()
        identity: tuple[str, str, str] | None = None
        try:
            source_file = gzip.open(path, "rt", encoding="utf-8")
            with source_file as source:
                for line_number, line in enumerate(source, 1):
                    where = f"{path}:{line_number}"
                    if not line.strip():
                        self.error(where, "blank JSONL record")
                        continue
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError) as error:
                        self.error(where, f"invalid JSON: {error}")
                        continue
                    if not isinstance(record, dict):
                        self.error(where, "record must be an object")
                        continue
                    raw_digest = hashlib.blake2b(line.strip().encode(), digest_size=16).digest()
                    if raw_digest in local_digests:
                        file_stats["duplicateRecords"] += 1
                        self.stats["exactDuplicateRecords"] += 1
                        self.error(where, "exact duplicate record in one corpus")
                    local_digests.add(raw_digest)
                    prior = self.record_locations.get(raw_digest)
                    if prior is not None and prior[0] != str(path):
                        self.stats["exactDuplicateRecords"] += 1
                    else:
                        self.record_locations[raw_digest] = (str(path), line_number)

                    if record.get("schema") != CORPUS_SCHEMA:
                        self.error(where, "incompatible corpus schema")
                    profile = record.get("profile")
                    if profile not in PROFILE_SHAPES:
                        self.error(where, "unknown profile")
                        continue
                    teacher = record.get("teacherSha256")
                    oracle = record.get("opponentOracle")
                    if not isinstance(teacher, str) or len(teacher) != 64:
                        self.error(where, "teacherSha256 must be a 64-digit digest")
                    if oracle != OPPONENT_ORACLE:
                        self.error(where, "opponent oracle mismatch")
                    current_identity = (profile, str(teacher), str(oracle))
                    if identity is None:
                        identity = current_identity
                    elif current_identity != identity:
                        self.error(where, "profile/teacher/oracle identity changes within file")

                    kind = str(record.get("kind", "proposal"))
                    raw = record.get("example", {})
                    if not isinstance(raw, dict):
                        raw = {}
                    episode_value = record.get("episode") if kind == "trajectory" else raw.get("episode")
                    if not isinstance(episode_value, int) or isinstance(episode_value, bool) \
                            or episode_value < 0:
                        self.error(where, "episode must be a non-negative integer")
                        continue
                    episode = episode_value
                    split = self.split(record, episode, where)
                    source_name = self.source_of(record, raw, kind)
                    if source_name not in {"champion", "katago", "handcrafted", "self", "counterfactual"}:
                        self.error(where, f"unknown source {source_name}")
                    route = routes.setdefault((source_name, episode),
                                              Route(split, source_name))
                    if route.split != split:
                        self.error(where, "one route crosses train/heldout split")
                    generation = record.get("generation")
                    if isinstance(generation, dict) \
                            and generation.get("authority") \
                            == "replay-validated-and-or-certificate-v6":
                        seeds = generation.get("effectiveSeeds")
                        if profile != "small5" or kind != "actor" \
                                or source_name != "handcrafted" \
                                or generation.get("source") != "certified-playbook" \
                                or generation.get("certifiedAllWhiteOutcomesWin") is not True \
                                or generation.get("selectedWithoutOutcome") is not False \
                                or not isinstance(generation.get("environmentId"), str) \
                                or not isinstance(generation.get("certificate"), str) \
                                or not isinstance(generation.get("certificateStateId"), int) \
                                or not isinstance(seeds, dict) \
                                or not isinstance(seeds.get("resetPhase"), int) \
                                or not isinstance(seeds.get("dispatchPhase"), int) \
                                or not isinstance(seeds.get("opponentAiSeed"), int):
                            self.error(where, "invalid certified-playbook actor authority provenance")
                        else:
                            route.certified_playbook_actor_authority = True
                    if isinstance(generation, dict) \
                            and generation.get("studentRootActorAuthority") is not None:
                        authority = generation.get("studentRootActorAuthority")
                        expected = ("frozen-handcrafted-exploit-root-v1"
                                    if source_name == "handcrafted"
                                    else "katago-preferred-root-v1"
                                    if source_name == "katago" else None)
                        if profile != "daemon19" or kind != "actor" or authority != expected \
                                or generation.get("selectionKind") not in (
                                    "last-aligned", "first-divergence") \
                                or not isinstance(generation.get("environmentId"), str) \
                                or generation.get("originatingStudentSha256") \
                                != "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065":
                            self.error(where, "invalid student-root actor authority provenance")
                        else:
                            route.student_root_actor_authority = True
                    if isinstance(generation, dict) \
                            and generation.get("kataGoDaggerAuthority") is not None:
                        schedule = generation.get("selectionSchedule")
                        seeds = generation.get("effectiveSeeds")
                        if profile not in ("small5", "daemon19") or kind != "actor" \
                                or source_name != "katago" \
                                or generation.get("kataGoDaggerAuthority") \
                                != "katago-exact-action-v1" \
                                or generation.get("selectedWithoutOutcome") is not True \
                                or not isinstance(generation.get("environmentId"), str) \
                                or not isinstance(generation.get("originatingStudentSha256"), str) \
                                or len(generation.get("originatingStudentSha256", "")) != 64 \
                                or not isinstance(schedule, dict) \
                                or schedule.get("kind") not in (
                                    "fixed-elapsed-stride-v1",
                                    "first-policy-state-at-or-after-stride-v1") \
                                or not isinstance(schedule.get("stride"), int) \
                                or schedule.get("stride", 0) <= 0 \
                                or not isinstance(schedule.get("pointsPerGame"), int) \
                                or schedule.get("pointsPerGame", 0) <= 0 \
                                or not isinstance(seeds, dict) \
                                or seeds.get("defenseSeed") is not None:
                            self.error(where, "invalid KataGo DAgger actor authority provenance")
                        else:
                            route.student_root_actor_authority = True

                    file_stats["records"] += 1
                    file_stats["kinds"][kind] += 1
                    file_stats["sources"][source_name] += 1
                    file_stats["splits"][split] += 1
                    self.stats["records"] += 1
                    self.stats["kinds"][kind] += 1
                    self.stats["sources"][source_name] += 1
                    self.stats["splits"][split] += 1

                    if kind == "proposal":
                        self.proposal_record(raw, record, profile, split, route, where)
                    elif kind == "actor":
                        self.actor_record(raw, profile, split, route, where, file_stats)
                    elif kind == "actor-ranking":
                        self.ranking_record(raw, profile, split, route, where)
                    elif kind == "trajectory":
                        self.trajectory_record(record, profile, split, route, where,
                                               file_stats)
                    else:
                        self.error(where, f"unknown record kind {kind}")
        except (OSError, EOFError) as error:
            self.error(str(path), f"truncated or invalid gzip stream: {error}")

        for (source_name, episode), route in routes.items():
            self.route(route, path, source_name, episode)
        file_stats["routes"] = collections.Counter(
            route.source for route in routes.values() if route.trajectory is not None)
        self.stats["files"][str(path)] = file_stats

    def proposal_record(self, raw: dict[str, Any], record: dict[str, Any], profile: str,
                        split: str, route: Route, where: str) -> None:
        elapsed = raw.get("elapsed")
        if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
            self.error(where, "proposal elapsed must be a non-negative integer")
            return
        if elapsed in route.proposals:
            self.error(where, f"duplicate proposal elapsed {elapsed} in route")
        route.proposals[elapsed] = str(raw.get("state"))
        state = self.state(raw.get("state"), profile, where, "decision")
        behavior = self.behavior(raw.get("behavior"), profile, where, "exact")
        moves = self.moves(raw.get("moves"), state, profile, where, True)
        self.note_split(self.heldout_proposal_inputs,
                        self.input_key(raw.get("state"), behavior, elapsed),
                        split, "proposalInputs")
        for name in ("targets", "regrets", "branches"):
            value = raw.get(name)
            if not isinstance(value, list) or len(value) != len(moves):
                self.error(where, f"{name} length must equal moves length")
        targets = raw.get("targets", [])
        if isinstance(targets, list) and any(value not in (0, 0.0, 1, 1.0) for value in targets):
            self.error(where, "proposal targets must be binary")
        regrets = raw.get("regrets", [])
        if isinstance(regrets, list):
            for index, value in enumerate(regrets):
                self.number(value, where, f"regrets[{index}]", 0)
        branches = raw.get("branches", [])
        if isinstance(branches, list):
            for index, group in enumerate(branches):
                if not isinstance(group, list) or len(group) != BRANCHES:
                    self.error(where, f"branches[{index}] must have {BRANCHES} values")
                    continue
                total = sum(self.number(value, where, f"branches[{index}]", 0, 1)
                            for value in group)
                if not math.isclose(total, 1, rel_tol=0, abs_tol=1e-4):
                    self.error(where, f"branches[{index}] sums to {total}, not 1")
        best = raw.get("best_move")
        safe = raw.get("safe_moves", [])
        upside = raw.get("upside_moves", [])
        bait = raw.get("bait_moves", [])
        desired = list(safe) + list(upside) if isinstance(safe, list) and isinstance(upside, list) else []
        if best not in moves or best not in safe:
            self.error(where, "best_move must be a legal safe move")
        if len(set(desired)) != len(desired) or any(move not in moves for move in desired):
            self.error(where, "safe/upside moves must be unique legal moves")
        if isinstance(targets, list):
            positives = {move for move, target in zip(moves, targets) if target == 1}
            if positives != set(desired):
                self.error(where, "targets do not equal safe plus upside moves")
        if not isinstance(bait, list) or any(move not in desired for move in bait):
            self.error(where, "bait moves must be a subset of desired moves")
        distill = record.get("distill")
        if not isinstance(distill, list):
            self.error(where, "proposal distill must be a list")
            return
        offset = 0
        for candidate_index in range(len(moves)):
            group: list[dict[str, Any]] = []
            total = 0.0
            while offset < len(distill) and total < 1 - 1e-6:
                raw_value = distill[offset]
                value = self.value(raw_value, profile,
                                   f"{where}.distill[{offset}]", elapsed + 1, split,
                                   track_split=split == "train")
                offset += 1
                if value is not None:
                    group.append(value)
                    author = value.get("author")
                    self.stats["numericReplyAuthors"][
                        str(author) if author is not None else "<missing>"] += 1
                    if self.require_numeric_reply_author is not None \
                            and author != self.require_numeric_reply_author:
                        self.error(
                            f"{where}.distill[{offset - 1}]",
                            "numeric reply author "
                            f"{author!r} != required {self.require_numeric_reply_author!r}",
                        )
                    if self.finite_number(value.get("weight")):
                        total += float(value["weight"])
            if not group or not math.isclose(total, 1, rel_tol=0, abs_tol=1e-4):
                self.error(where, f"distill candidate {candidate_index} probabilities sum to {total}")
                break
        if offset != len(distill):
            self.error(where, "distill reply groups do not match candidate count")

    def actor_record(self, raw: dict[str, Any], profile: str, split: str,
                     route: Route, where: str, file_stats: dict[str, Any]) -> None:
        elapsed = raw.get("elapsed")
        if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
            self.error(where, "actor elapsed must be a non-negative integer")
            return
        if elapsed in route.actors:
            self.error(where, f"duplicate actor elapsed {elapsed} in route")
        route.actors[elapsed] = str(raw.get("state"))
        state = self.state(raw.get("state"), profile, where, "decision")
        behavior = self.behavior(raw.get("behavior"), profile, where, "exact")
        moves = self.moves(raw.get("moves"), state, profile, where, True)
        self.note_split(self.heldout_proposal_inputs,
                        self.input_key(raw.get("state"), behavior, elapsed),
                        split, "proposalInputs")
        actions = raw.get("actions")
        selected = actions if isinstance(actions, list) else [raw.get("action")]
        if not selected or any(action not in moves for action in selected):
            self.error(where, "actor actions must be legal moves")
        if len(set(selected)) != len(selected):
            self.error(where, "actor actions contain duplicates")
        pass_move = PROFILE_SHAPES[profile][0] ** 2
        if pass_move in selected:
            file_stats["actorPassPositive"][route.source] += 1

    def ranking_record(self, raw: dict[str, Any], profile: str, split: str,
                       route: Route, where: str) -> None:
        elapsed = raw.get("elapsed")
        if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
            self.error(where, "ranking elapsed must be a non-negative integer")
            return
        if elapsed in route.rankings:
            self.error(where, f"duplicate actor-ranking elapsed {elapsed} in route")
        route.rankings.add(elapsed)
        state = self.state(raw.get("state"), profile, where, "decision")
        behavior = self.behavior(raw.get("behavior"), profile, where, "exact")
        moves = self.moves(raw.get("moves"), state, profile, where, False)
        best = raw.get("bestMove")
        if best not in moves:
            self.error(where, "ranking bestMove is not in moves")
        win_group_raw = raw.get("winGroupMoves", [best])
        if not isinstance(win_group_raw, list) or not win_group_raw:
            self.error(where, "ranking winGroupMoves must be a non-empty list")
            win_group: set[int] = {best} if isinstance(best, int) else set()
        else:
            win_group = {move for move in win_group_raw if isinstance(move, int)}
            if len(win_group) != len(win_group_raw) or best not in win_group \
                    or any(move not in moves for move in win_group):
                self.error(where, "ranking winGroupMoves must be unique candidate moves including bestMove")
        candidates = raw.get("candidates")
        if not isinstance(candidates, list) or len(candidates) != len(moves):
            self.error(where, "ranking candidates length must equal moves length")
            return
        ranking_value_fields = {
            "state", "behavior", "elapsed", "won", "score", "remaining", "weight", "author",
        }
        for index, group in enumerate(candidates):
            if isinstance(group, list):
                for value_index, value in enumerate(group):
                    if isinstance(value, dict):
                        extra = set(value) - ranking_value_fields
                        if extra:
                            self.error(
                                f"{where}.candidates[{index}][{value_index}]",
                                f"unsupported ranking value fields {sorted(extra)}",
                            )
            values = self.probability_group(
                group, profile, f"{where}.candidates[{index}]", elapsed + 1, split)
            if route.source in FIXED_SOURCES and values:
                expected = 1.0 if moves[index] in win_group else 0.0
                if any(float(value.get("won", -1)) != expected for value in values):
                    self.error(where, "fixed-teacher ranking markers disagree with winGroupMoves")

    def trajectory_record(self, record: dict[str, Any], profile: str, split: str,
                          route: Route, where: str, file_stats: dict[str, Any]) -> None:
        if route.trajectory is not None:
            self.error(where, "duplicate trajectory for one source/episode")
        route.trajectory = {"states": [], "won": False, "count": 0}
        values = record.get("values")
        if not isinstance(values, list) or not values:
            self.error(where, "trajectory values must be non-empty")
            return
        won_values: set[float] = set()
        score_values: set[float] = set()
        behavior_values: set[bytes] = set()
        weight_total = 0.0
        count = len(values)
        generation = record.get("generation")
        generation = generation if isinstance(generation, dict) else {}
        group_id = generation.get("counterfactualGroupId")
        is_counterfactual = isinstance(group_id, str) and bool(group_id)
        candidate_count = generation.get("counterfactualCandidateCount")
        candidate_index = generation.get("counterfactualCandidateIndex")
        origin_elapsed = generation.get("originElapsed")
        counterfactual_scope = generation.get("counterfactualTargetScope", "full-continuation")
        sampled_immediate_counterfactual = is_counterfactual \
            and counterfactual_scope == "immediate-post-reply"
        expected_immediate_counterfactual = is_counterfactual \
            and counterfactual_scope == "immediate-post-reply-future-marginalized"
        immediate_counterfactual = sampled_immediate_counterfactual \
            or expected_immediate_counterfactual
        certified_immediate_counterfactual = sampled_immediate_counterfactual \
            and generation.get("counterfactualAuthority") \
            == "certified-playbook-terminal-regret-v1"
        if is_counterfactual:
            self.stats["counterfactualContinuations"] += 1
            if not isinstance(candidate_count, int) or isinstance(candidate_count, bool) \
                    or candidate_count < 2:
                self.error(where, "counterfactual candidate count must be an integer >= 2")
                candidate_count = 1
            if not isinstance(candidate_index, int) or isinstance(candidate_index, bool) \
                    or not 0 <= candidate_index < candidate_count:
                self.error(where, "counterfactual candidate index is outside its group")
                candidate_index = -1
            if not isinstance(origin_elapsed, int) or isinstance(origin_elapsed, bool) \
                    or origin_elapsed < 0:
                self.error(where, "counterfactual origin elapsed must be non-negative")
                origin_elapsed = 0
            required = {
                "environmentId", "opponent", "forcedAction", "actualReply",
                "candidateMoves", "continuationPolicy", "effectiveSeeds",
                "terminalOutcome", "positionContentSha256", "originalEpisode",
            }
            required |= ({"certifiedAction", "kataGoActions",
                          "conditionalGroupSha256", "originalResponseCorpus",
                          "originalResponseCorpusSha256"}
                         if certified_immediate_counterfactual else
                         {"studentFinalistMoves", "studentPolicyTop16Moves",
                          "studentRequestedLimit", "studentAdaptiveLimit",
                          "studentPerSeedReserve", "studentProposalSeedCount",
                          "studentAction", "handcraftedChosenAction",
                          "kataGoPreferredAction", "candidateFlags", "selectionKind",
                          "originatingStudentSha256"}
                         if immediate_counterfactual else
                         {"chosenAction", "originalCorpus", "originalCorpusSha256"})
            if sampled_immediate_counterfactual:
                required |= {"continuationTrace", "continuationFinalState"}
            elif expected_immediate_counterfactual:
                required |= {"phaseOutcomes", "futurePhaseCount",
                             "futurePhaseStrideCycles"}
            missing = sorted(name for name in required if generation.get(name) is None)
            if missing:
                self.error(where, f"counterfactual provenance missing {missing}")
            candidate_moves = generation.get("candidateMoves")
            if not isinstance(candidate_moves, list) or len(candidate_moves) != candidate_count \
                    or len(set(candidate_moves)) != candidate_count:
                self.error(where, "counterfactual candidateMoves is malformed")
            elif candidate_index >= 0 \
                    and generation.get("forcedAction") != candidate_moves[candidate_index]:
                self.error(where, "forcedAction does not match candidate index")
            if immediate_counterfactual and not certified_immediate_counterfactual:
                finalists = generation.get("studentFinalistMoves")
                policy_top16 = generation.get("studentPolicyTop16Moves")
                requested_limit = generation.get("studentRequestedLimit")
                adaptive_limit = generation.get("studentAdaptiveLimit")
                per_seed_reserve = generation.get("studentPerSeedReserve")
                proposal_seed_count = generation.get("studentProposalSeedCount")
                student_action = generation.get("studentAction")
                handcrafted = generation.get("handcraftedChosenAction")
                katago = generation.get("kataGoPreferredAction")
                flags = generation.get("candidateFlags")
                expected_union = list(dict.fromkeys(
                    [*(finalists if isinstance(finalists, list) else []),
                     *(policy_top16 if isinstance(policy_top16, list) else []),
                     handcrafted, katago]))
                if candidate_moves != expected_union or not isinstance(finalists, list):
                    self.error(where, "student-root candidates are not the deduplicated authority union")
                if not isinstance(finalists, list) or not finalists \
                        or len(finalists) != len(set(finalists)):
                    self.error(where, "student finalist set is empty or duplicated")
                elif student_action not in finalists:
                    self.error(where, "frozen student action is absent from its exact finalist set")
                if not isinstance(policy_top16, list) or not policy_top16 \
                        or len(policy_top16) != len(set(policy_top16)) \
                        or student_action not in policy_top16 \
                        or not (set(policy_top16).issubset(set(finalists))
                                or set(finalists).issubset(set(policy_top16))):
                    self.error(where, "literal policy top-16 is malformed or inconsistent with the selector")
                for name, value, minimum in (
                        ("requested limit", requested_limit, 1),
                        ("adaptive limit", adaptive_limit, 1),
                        ("per-seed reserve", per_seed_reserve, 0),
                        ("proposal seed count", proposal_seed_count, 0)):
                    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
                        self.error(where, f"student {name} is invalid")
                if isinstance(adaptive_limit, int) and isinstance(finalists, list) \
                        and adaptive_limit != len(finalists):
                    self.error(where, "adaptive limit does not equal the exact finalist count")
                if proposal_seed_count == 0:
                    if per_seed_reserve != 0 or adaptive_limit != 1:
                        self.error(where, "immediate student decision has invalid selector metadata")
                elif proposal_seed_count == 1 and isinstance(adaptive_limit, int) \
                        and per_seed_reserve != max(1, adaptive_limit // 2):
                    self.error(where, "single-seed finalist reserve disagrees with production selector")
                forced_action = generation.get("forcedAction")
                expected_flags = {
                    "studentFinalist": forced_action in finalists
                        if isinstance(finalists, list) else False,
                    "studentPolicyTop16": forced_action in policy_top16
                        if isinstance(policy_top16, list) else False,
                    "handcraftedChosen": forced_action == handcrafted,
                    "kataGoPreferred": forced_action == katago,
                }
                if flags != expected_flags:
                    self.error(where, "student-root candidate flags disagree with authority moves")
                kind = generation.get("selectionKind")
                if kind not in ("last-aligned", "first-divergence", "post-divergence"):
                    self.error(where, "student-root selection kind is invalid")
                elif kind in ("last-aligned", "first-divergence") and \
                        (handcrafted in finalists if isinstance(finalists, list) else False) \
                        != (kind == "last-aligned"):
                    self.error(where, "student-root alignment disagrees with selection kind")
            origin_state = self.state(generation.get("originState"), profile,
                                      f"{where}.generation.originState", "decision")
            if origin_state is not None and isinstance(generation.get("forcedAction"), int):
                forced = int(generation["forcedAction"])
                legal = {index for index, bit in enumerate(origin_state[1]) if bit == "1"}
                legal.add(PROFILE_SHAPES[profile][0] ** 2)
                if forced not in legal:
                    self.error(where, "forcedAction is not legal in originState")
            reply = generation.get("actualReply")
            if not isinstance(reply, dict) or reply.get("type") not in ("move", "pass"):
                self.error(where, "actualReply must be a move or pass object")
            seeds = generation.get("effectiveSeeds")
            if not isinstance(seeds, dict):
                self.error(where, "effectiveSeeds must be an object")
            elif sampled_immediate_counterfactual or not immediate_counterfactual:
                dispatches = seeds.get("continuationDispatchPlaytimes")
                ai_seeds = seeds.get("continuationOpponentAiSeeds")
                continuation_length = generation.get("terminalOutcome", {}).get(
                    "continuationLength") if isinstance(generation.get("terminalOutcome"), dict) else count
                if not isinstance(dispatches, list) or len(dispatches) != continuation_length \
                        or not isinstance(ai_seeds, list) or len(ai_seeds) != continuation_length:
                    self.error(where, "continuation effective-seed ledger length mismatch")
                elif any(not isinstance(dispatch, int) or not isinstance(ai_seed, int)
                         or ai_seed != dispatch + 200
                         for dispatch, ai_seed in zip(dispatches, ai_seeds)):
                    self.error(where, "continuation opponent AI seeds do not match dispatch ticks")
            else:
                phase_count = generation.get("futurePhaseCount")
                stride = generation.get("futurePhaseStrideCycles")
                offsets = seeds.get("futurePhaseOffsetsCycles")
                if not isinstance(phase_count, int) or isinstance(phase_count, bool) \
                        or phase_count < 2:
                    self.error(where, "futurePhaseCount must be an integer >= 2")
                if not isinstance(stride, int) or isinstance(stride, bool) or stride <= 0:
                    self.error(where, "futurePhaseStrideCycles must be a positive integer")
                if not isinstance(offsets, list) or len(offsets) != phase_count \
                        or offsets != [index * stride for index in range(phase_count)]:
                    self.error(where, "future phase offsets do not match the declared stride")
            terminal = generation.get("terminalOutcome")
            if not isinstance(terminal, dict):
                self.error(where, "terminalOutcome must be an object")
            elif not immediate_counterfactual \
                    and (terminal.get("continuationLength") != count
                         or terminal.get("totalRouteTurns")
                         != origin_elapsed + terminal.get("continuationLength", -1)):
                self.error(where, "terminalOutcome turn counts disagree with continuation")
            if sampled_immediate_counterfactual:
                trace = generation.get("continuationTrace")
                if not isinstance(trace, list) or not isinstance(terminal, dict) \
                        or len(trace) != terminal.get("continuationLength") or count != 1:
                    self.error(where, "immediate counterfactual must retain one target and a complete diagnostic trace")
                elif any(not isinstance(turn, dict)
                         or turn.get("turn") != 2 * index
                         or turn.get("opponentAiSeed") != turn.get("dispatchPlaytime", -200) + 200
                         or not isinstance(turn.get("afterState"), str)
                         for index, turn in enumerate(trace)):
                    self.error(where, "immediate counterfactual diagnostic trace is malformed")
                elif trace[0].get("afterState") != values[0].get("state") \
                        or trace[-1].get("afterState") != generation.get("continuationFinalState"):
                    self.error(where, "immediate target/final state disagrees with diagnostic trace")
            elif expected_immediate_counterfactual:
                phases = generation.get("phaseOutcomes")
                phase_count = generation.get("futurePhaseCount")
                if not isinstance(phases, list) or len(phases) != phase_count or count != 1:
                    self.error(where, "future-marginalized target must retain one value and every phase")
                else:
                    for phase_index, phase in enumerate(phases):
                        phase_where = f"{where}.generation.phaseOutcomes[{phase_index}]"
                        if not isinstance(phase, dict) or phase.get("phase") != phase_index:
                            self.error(phase_where, "phase outcome index is malformed")
                            continue
                        dispatches = phase.get("continuationDispatchPlaytimes")
                        ai_seeds = phase.get("continuationOpponentAiSeeds")
                        length = phase.get("continuationLength")
                        if not isinstance(length, int) or isinstance(length, bool) or length < 1 \
                                or not isinstance(dispatches, list) or len(dispatches) != length \
                                or not isinstance(ai_seeds, list) or len(ai_seeds) != length:
                            self.error(phase_where, "phase continuation seed ledger length mismatch")
                        elif any(not isinstance(dispatch, int) or not isinstance(ai_seed, int)
                                 or ai_seed != dispatch + 200
                                 for dispatch, ai_seed in zip(dispatches, ai_seeds)):
                            self.error(phase_where, "phase opponent AI seeds do not match dispatch ticks")
                        if isinstance(length, int) and phase.get("totalRouteTurns") \
                                != origin_elapsed + length:
                            self.error(phase_where, "phase total turns disagree with continuation length")
            self.counterfactual_groups[str(group_id)].append({
                "where": where,
                "split": split,
                "component": generation.get("splitComponentSha256"),
                "environment": generation.get("environmentId"),
                "origin": generation.get("positionContentSha256"),
                "originRoute": ((generation.get("originalResponseCorpusSha256"),
                                 generation.get("originalEpisode"))
                                if certified_immediate_counterfactual else
                                (generation.get("originalCorpusSha256"),
                                 generation.get("originalEpisode"))
                                if not immediate_counterfactual else
                                (generation.get("originatingStudentSha256"),
                                 generation.get("environmentId"))),
                "stage": generation.get("selectionKind") if immediate_counterfactual else generation.get("stage"),
                "scope": counterfactual_scope,
                "authority": generation.get("counterfactualAuthority"),
                "candidateCount": candidate_count,
                "candidateIndex": candidate_index,
                "forcedAction": generation.get("forcedAction"),
                "chosenAction": (generation.get("certifiedAction")
                                 if certified_immediate_counterfactual else
                                 generation.get("handcraftedChosenAction")
                                 if immediate_counterfactual else generation.get("chosenAction")),
                "control": (generation.get("forcedAction") == generation.get("certifiedAction")
                            if certified_immediate_counterfactual else
                            generation.get("candidateFlags", {}).get("handcraftedChosen")
                            if immediate_counterfactual and isinstance(generation.get("candidateFlags"), dict)
                            else generation.get("controlCandidate")),
                "controlExact": generation.get("controlReproducesOriginal"),
                "weight": 0.0,
                "won": None,
            })
        static_evaluation = str(generation.get("numericAuthor", "")) in STATIC_VALUE_AUTHORS
        if static_evaluation and len(values) != 1:
            self.error(where, "static evaluation must carry exactly one value")
        for index, raw in enumerate(values):
            value = self.value(raw, profile, f"{where}.values[{index}]",
                               (origin_elapsed if is_counterfactual else 0) + index + 1,
                               split, track_split=split == "train",
                               static_evaluation=static_evaluation)
            if value is None:
                continue
            route.trajectory["states"].append(str(value.get("state")))
            won_values.add(float(value.get("won", 0)))
            score_values.add(float(value.get("score", 0)))
            behavior_values.add(self.digest(value.get("behavior")))
            author = value.get("author")
            if author is not None:
                self.stats["terminalValueAuthors"][str(author)] += 1
            if is_counterfactual:
                valid_authors = {"environment-rollout:handcrafted-continuation-v1",
                                 "environment-rollout:student-root-handcrafted-continuation-v1",
                                 "environment-rollout:student-root-handcrafted-continuation-v2",
                                 "environment-rollout:student-root-future-marginalized-v1",
                                 "environment-rollout:certified-root-handcrafted-continuation-v1",
                                 "environment-rollout:certified-root-book-aware-continuation-v1"}
                if author not in valid_authors:
                    self.error(where, "counterfactual terminal value has wrong numeric author")
                self.number(value.get("blackPower"), where, "blackPower", 0)
            if self.finite_number(value.get("weight")):
                weight_total += float(value["weight"])
            terminal = generation.get("terminalOutcome", {})
            continuation_length = terminal.get("continuationLength", count) \
                if isinstance(terminal, dict) else count
            if static_evaluation:
                continue
            expected_remaining = (terminal.get("effectiveContinuationLength")
                                  if expected_immediate_counterfactual
                                  and isinstance(terminal, dict)
                                  else continuation_length - index)
            if self.finite_number(value.get("remaining")) \
                    and not math.isclose(float(value["remaining"]), expected_remaining,
                                         rel_tol=0, abs_tol=1e-6):
                self.error(where, f"trajectory value {index} remaining != {expected_remaining}")
            expected_weight = (1 / candidate_count if immediate_counterfactual else
                               1 / (candidate_count * count) if is_counterfactual else 1 / count)
            if self.finite_number(value.get("weight")) \
                    and not math.isclose(float(value["weight"]), expected_weight,
                                         rel_tol=0, abs_tol=1e-9):
                self.error(where, f"trajectory value {index} weight is not {expected_weight}")
        if not static_evaluation and (len(won_values) != 1 or len(score_values) != 1):
            self.error(where, "trajectory outcome changes between turns")
        if len(behavior_values) != 1:
            self.error(where, "future behavior changes within one opponent route")
        expected_total = 1 / candidate_count if is_counterfactual else 1
        if not static_evaluation \
                and not math.isclose(weight_total, expected_total, rel_tol=0, abs_tol=1e-6):
            self.error(where, f"trajectory weights sum to {weight_total}, not {expected_total}")
        if is_counterfactual:
            self.counterfactual_groups[str(group_id)][-1]["weight"] = weight_total
            self.counterfactual_groups[str(group_id)][-1]["won"] = \
                next(iter(won_values), None)
        if expected_immediate_counterfactual and isinstance(terminal, dict) and values:
            phases = generation.get("phaseOutcomes")
            phase_targets: list[tuple[float, float, float, float, float]] = []
            if isinstance(phases, list):
                for phase_index, phase in enumerate(phases):
                    if not isinstance(phase, dict):
                        continue
                    phase_where = f"{where}.generation.phaseOutcomes[{phase_index}]"
                    final = self.state(phase.get("finalState"), profile, phase_where)
                    trace_sha = phase.get("traceSha256")
                    if not isinstance(trace_sha, str) or len(trace_sha) != 64 \
                            or any(character not in "0123456789abcdef" for character in trace_sha):
                        self.error(phase_where, "phase traceSha256 must be a lowercase digest")
                    if final is None:
                        continue
                    if final[2] < 2:
                        self.error(phase_where, "phase continuation did not reach two passes")
                    extent, _ = PROFILE_SHAPES[profile]
                    behavior = values[0].get("behavior", [])
                    komi = float(behavior[-1]) * 10 if profile == "small5" \
                        and isinstance(behavior, list) and behavior else 9.5
                    black, white = self.score_board(final[0], extent, komi)
                    won = 1.0 if black >= white else 0.0
                    penalized = black * (1.0 if won else 0.5)
                    length = phase.get("continuationLength")
                    total_turns = phase.get("totalRouteTurns")
                    expected_fields = {
                        "won": bool(won), "blackPower": black, "whiteScore": white,
                        "lossPenalizedBlackPower": penalized,
                    }
                    for name, expected in expected_fields.items():
                        actual = phase.get(name)
                        matches = actual is expected if isinstance(expected, bool) else \
                            self.finite_number(actual) and math.isclose(
                                float(actual), float(expected), rel_tol=0, abs_tol=1e-6)
                        if not matches:
                            self.error(phase_where, f"phase {name} disagrees with final board")
                    if isinstance(length, int) and self.finite_number(total_turns):
                        phase_targets.append((won, black, penalized, float(length),
                                              penalized / max(float(total_turns), 1)))
            if phase_targets:
                divisor = len(phase_targets)
                expected_win = sum(item[0] for item in phase_targets) / divisor
                mean_black = sum(item[1] for item in phase_targets) / divisor
                expected_rate = sum(item[4] for item in phase_targets) / divisor
                effective_remaining = sum(item[3] for item in phase_targets) / divisor
                effective_score = expected_rate * (origin_elapsed + effective_remaining)
                expected_aggregate = {
                    "expectedWinProbability": expected_win,
                    "expectedLossPenalizedPowerPerTotalTurn": expected_rate,
                    "effectiveContinuationLength": effective_remaining,
                    "effectiveLossPenalizedBlackPower": effective_score,
                    "meanBlackPower": mean_black,
                    "phaseCount": divisor,
                }
                for name, expected in expected_aggregate.items():
                    actual = terminal.get(name)
                    if not self.finite_number(actual) or not math.isclose(
                            float(actual), float(expected), rel_tol=0, abs_tol=1e-6):
                        self.error(where, f"terminalOutcome {name} disagrees with phase aggregate")
                value = values[0]
                for name, expected in (("won", expected_win), ("score", effective_score),
                                       ("remaining", effective_remaining),
                                       ("blackPower", mean_black)):
                    actual = value.get(name)
                    if not self.finite_number(actual) or not math.isclose(
                            float(actual), float(expected), rel_tol=0, abs_tol=1e-6):
                        self.error(where, f"future-marginalized value {name} disagrees with aggregate")
        # A static evaluation is a scored midgame board, not a finished route:
        # it has no terminal position, so completion and terminal-score checks
        # are meaningless here and would reject valid evidence.
        final_state_value = (None if expected_immediate_counterfactual or static_evaluation else
                             generation.get("continuationFinalState")
                             if immediate_counterfactual else values[-1].get("state"))
        final_state = None if final_state_value is None else \
            self.state(final_state_value, profile, where)
        if is_counterfactual and values:
            first_parts = str(values[0].get("state", "")).split("|")
            reply = generation.get("actualReply")
            if len(first_parts) == 5 and isinstance(reply, dict):
                expected_pass = int(reply.get("type") == "pass")
                expected_noop = int(reply.get("type") == "move" and reply.get("noOp") is True)
                if int(first_parts[3]) != expected_pass or int(first_parts[4]) != expected_noop:
                    self.error(where, "actualReply disagrees with first response flags")
        if final_state is not None and final_state[2] < 2:
            self.error(where, "trajectory is truncated: final state did not reach two passes")
        if final_state is not None and behavior_values:
            extent, _ = PROFILE_SHAPES[profile]
            final_behavior = values[-1].get("behavior", [])
            komi = float(final_behavior[-1]) * 10 if profile == "small5" \
                and isinstance(final_behavior, list) and final_behavior else 9.5
            black, white = self.score_board(final_state[0], extent, komi)
            expected_won = 1.0 if black >= white else 0.0
            expected_score = black * (1.0 if expected_won else 0.5)
            if won_values != {expected_won}:
                self.error(where, "trajectory won target disagrees with terminal area score")
            if len(score_values) != 1 or not math.isclose(
                    next(iter(score_values), math.nan), expected_score,
                    rel_tol=0, abs_tol=1e-6):
                self.error(
                    where,
                    f"trajectory score target disagrees with loss-penalized Black score {expected_score}",
                )
            if is_counterfactual:
                black_power_values = {float(value.get("blackPower", math.nan))
                                      for value in values if self.finite_number(value.get("blackPower"))}
                if len(black_power_values) != 1 or not math.isclose(
                        next(iter(black_power_values), math.nan), black,
                        rel_tol=0, abs_tol=1e-6):
                    self.error(where, f"counterfactual blackPower disagrees with terminal score {black}")
                terminal = generation.get("terminalOutcome", {})
                if isinstance(terminal, dict):
                    expected_terminal = {
                        "won": expected_won == 1,
                        "blackPower": black,
                        "whiteScore": white,
                        "lossPenalizedBlackPower": expected_score,
                    }
                    for name, expected in expected_terminal.items():
                        actual = terminal.get(name)
                        if isinstance(expected, bool):
                            matches = actual is expected
                        else:
                            matches = self.finite_number(actual) and math.isclose(
                                float(actual), float(expected), rel_tol=0, abs_tol=1e-6)
                        if not matches:
                            self.error(where, f"terminalOutcome {name} disagrees with final board")
        file_stats["routeWeight"][route.source] += weight_total
        file_stats["maxElapsed"] = max(file_stats["maxElapsed"], count)
        route.trajectory["won"] = bool(won_values == {1.0})
        route.trajectory["count"] = count

    def validate_counterfactual_groups(self) -> None:
        self.stats["counterfactualGroups"] = len(self.counterfactual_groups)
        positions_by_origin: collections.Counter[tuple[Any, Any]] = collections.Counter()
        student_root_groups = 0
        student_root_continuations = 0
        for group_id, rows in self.counterfactual_groups.items():
            where = f"counterfactual group {group_id}"
            counts = {row["candidateCount"] for row in rows}
            if len(counts) != 1:
                self.error(where, "candidate count changes within group")
                continue
            count = next(iter(counts))
            self.stats["counterfactualCandidateCounts"][str(count)] += 1
            stages = {row["stage"] for row in rows}
            scopes = {row["scope"] for row in rows}
            immediate = scopes in ({"immediate-post-reply"},
                                   {"immediate-post-reply-future-marginalized"})
            certified_root = {row["authority"] for row in rows} \
                == {"certified-playbook-terminal-regret-v1"}
            if immediate and not certified_root:
                student_root_groups += 1
                student_root_continuations += len(rows)
            allowed_stages = (("certified-root",) if certified_root else
                              ("last-aligned", "first-divergence", "post-divergence") if immediate else
                              ("early", "middle", "late"))
            if len(scopes) != 1:
                self.error(where, "target scope changes within group")
            if len(stages) != 1 or next(iter(stages)) not in allowed_stages:
                self.error(where, "stage changes within group or is invalid")
            else:
                self.stats["counterfactualStages"][next(iter(stages))] += 1
            self.stats["counterfactualOutcomes"].update(
                "win" if row["won"] == 1 else "loss" if row["won"] == 0
                else "expected" for row in rows)
            if len(rows) != count or {row["candidateIndex"] for row in rows} != set(range(count)):
                self.error(where, "candidate continuations are incomplete or duplicated")
            for field in ("split", "environment", "origin"):
                if len({row[field] for row in rows}) != 1:
                    self.error(where, f"{field} changes within group")
            components = {row["component"] for row in rows if row["component"] is not None}
            if len(components) > 1:
                self.error(where, "candidate continuations cross split components")
            controls = [row for row in rows if row["control"]]
            if len(controls) != 1:
                self.error(where, "group must contain exactly one authority-chosen candidate")
            elif controls[0]["forcedAction"] != controls[0]["chosenAction"]:
                self.error(where, "handcrafted-chosen candidate action is inconsistent")
            elif not immediate and controls[0]["controlExact"] is not True:
                self.error(where, "chosen-action control is not marked exact")
            if not immediate and any(row["controlExact"] is True and not row["control"] for row in rows):
                self.error(where, "non-control continuation claims original-route reproduction")
            total = sum(float(row["weight"]) for row in rows)
            if not math.isclose(total, 1, rel_tol=0, abs_tol=1e-6):
                self.error(where, f"group weights sum to {total}, not 1")
            positions_by_origin[rows[0]["originRoute"]] += 1
        self.stats["counterfactualOriginRoutes"] = len(positions_by_origin)
        self.stats["counterfactualMaxPositionsPerOriginRoute"] = max(
            positions_by_origin.values(), default=0)
        for origin, positions in positions_by_origin.items():
            limit = 1 if origin[0] == "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065" else 2
            if positions > limit:
                self.error(
                    f"counterfactual origin route {origin}",
                    f"contains {positions} selected positions, exceeding the cap of {limit}",
                )
        self.stats["studentRootGroups"] = student_root_groups
        self.stats["studentRootContinuations"] = student_root_continuations
        if self.require_student_root_groups is not None \
                and student_root_groups != self.require_student_root_groups:
            self.error("student-root corpus", f"contains {student_root_groups} groups, "
                       f"expected {self.require_student_root_groups}")
        if self.require_student_root_continuations is not None \
                and student_root_continuations != self.require_student_root_continuations:
            self.error("student-root corpus", f"contains {student_root_continuations} continuations, "
                       f"expected {self.require_student_root_continuations}")
        if self.require_student_root_groups == 128:
            stage_counts = self.stats["counterfactualStages"]
            if not valid_full_student_root_stage_balance(stage_counts):
                self.error(
                    "student-root corpus",
                    "does not contain a recognized 64/64 root split",
                )

    @staticmethod
    def state_without_response(value: str) -> str:
        parts = value.split("|")
        return "|".join((*parts[:3], "0", "0")) if len(parts) == 5 else value

    def route(self, route: Route, path: pathlib.Path, source: str, episode: int) -> None:
        where = f"{path}:route {source}:{episode}"
        trajectory = route.trajectory
        if source in FIXED_SOURCES and (route.actors or route.rankings) and trajectory is None \
                and not route.student_root_actor_authority \
                and not route.certified_playbook_actor_authority:
            self.error(where, "fixed-teacher supervision has no terminal trajectory")
            return
        if trajectory is None:
            return
        states = trajectory.get("states", [])
        count = int(trajectory.get("count", 0))
        won = bool(trajectory.get("won"))
        if source in FIXED_SOURCES and not won and route.actors:
            self.error(where, "losing fixed-teacher route contains positive actor labels")
        if source in FIXED_SOURCES and not won and route.rankings:
            self.error(where, "losing fixed-teacher route contains positive rankings")
        if source in FIXED_SOURCES and won and route.actors \
                and set(route.actors) != set(range(count)):
            self.error(where, "winning fixed-teacher actor route is incomplete")
        if route.proposals and set(route.proposals) != set(range(count)):
            self.error(where, "proposal route is incomplete")
        decision_rows = route.actors or route.proposals
        for elapsed, current_state in decision_rows.items():
            if elapsed == 0 or elapsed > len(states) - 1:
                continue
            if self.state_without_response(states[elapsed - 1]) != current_state:
                self.error(where, f"post-reply state {elapsed} does not feed the next decision")

    def scan_leakage(self) -> None:
        leaked_proposals: set[bytes] = set()
        leaked_values: set[bytes] = set()
        semantic_locations: dict[bytes, str] = {}

        def key(raw: Any) -> bytes | None:
            if not isinstance(raw, dict) or not isinstance(raw.get("behavior"), list):
                return None
            return self.digest(self.input_key(
                raw.get("state"), raw["behavior"], raw.get("elapsed")))

        for path in self.paths:
            try:
                with gzip.open(path, "rt", encoding="utf-8") as source:
                    for line in source:
                        record = json.loads(line)
                        semantic = {name: record[name] for name in (
                            "schema", "kind", "profile", "teacherSha256",
                            "opponentOracle", "split", "episode", "example",
                            "distill", "values",
                        ) if name in record}
                        kind = record.get("kind", "proposal")
                        raw = record.get("example", {})
                        if not isinstance(raw, dict):
                            raw = {}
                        # Source is training semantics, even when older records
                        # store it under generation. Other generation fields
                        # are provenance and must not hide copied payloads.
                        semantic["source"] = self.source_of(record, raw, str(kind))
                        semantic_digest = self.digest(semantic)
                        prior_path = semantic_locations.get(semantic_digest)
                        if prior_path is not None:
                            self.stats["semanticDuplicateRecords"] += 1
                        else:
                            semantic_locations[semantic_digest] = str(path)
                        if record.get("split") != "train":
                            continue
                        if kind in ("proposal", "actor"):
                            digest = key(raw)
                            if digest in self.heldout_proposal_inputs:
                                leaked_proposals.add(digest)
                        if kind == "proposal":
                            values = record.get("distill", [])
                        elif kind == "trajectory":
                            values = record.get("values", [])
                        elif kind == "actor-ranking":
                            values = [value for candidate in raw.get("candidates", [])
                                      for value in candidate]
                        else:
                            values = []
                        for value in values:
                            digest = key(value)
                            if digest in self.heldout_value_inputs:
                                leaked_values.add(digest)
            except (OSError, EOFError, json.JSONDecodeError):
                # The primary pass already records the precise stream/line error.
                continue
        self.stats["splitLeakage"] = {
            "proposalInputs": len(leaked_proposals),
            "valueInputs": len(leaked_values),
        }

    def run(self) -> dict[str, Any]:
        for path in self.paths:
            self.validate_file(path)
        self.validate_counterfactual_groups()
        self.scan_leakage()
        if self.stats["semanticDuplicateRecords"]:
            self.error(
                "corpus set",
                f"{self.stats['semanticDuplicateRecords']} records are duplicated in the input set after ignoring provenance-only generation metadata",
            )
        if self.stats["splitLeakage"]["proposalInputs"]:
            self.error("corpus set",
                       f"{self.stats['splitLeakage']['proposalInputs']} exact proposal inputs occur in both splits")
        if self.stats["splitLeakage"]["valueInputs"]:
            self.error("corpus set",
                       f"{self.stats['splitLeakage']['valueInputs']} exact value inputs occur in both splits")
        self.stats["errors"] = len(self.errors)
        self.stats["warnings"] = len(self.warnings)
        return make_jsonable(self.stats)


def make_jsonable(value: Any) -> Any:
    if isinstance(value, collections.Counter):
        return dict(sorted(value.items()))
    if isinstance(value, dict):
        return {key: make_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [make_jsonable(item) for item in value]
    return value


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", nargs="+", type=pathlib.Path)
    parser.add_argument("--max-issues", type=int, default=100)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--require-numeric-reply-author",
        choices=("champion",),
        help="reject exhaustive reply values without this explicit author",
    )
    parser.add_argument("--require-student-root-groups", type=int)
    parser.add_argument("--require-student-root-continuations", type=int)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    missing = [str(path) for path in args.corpus if not path.is_file()]
    if missing:
        print(json.dumps({"errors": [f"missing corpus: {path}" for path in missing]}))
        return 2
    validator = Validator(
        args.corpus, max(1, args.max_issues), args.require_numeric_reply_author,
        args.require_student_root_groups, args.require_student_root_continuations)
    summary = validator.run()
    output = {
        "summary": summary,
        "errors": validator.errors,
        "warnings": validator.warnings,
    }
    print(json.dumps(output, indent=2 if args.pretty else None,
                     sort_keys=args.pretty))
    return 1 if validator.errors else 0


if __name__ == "__main__":
    sys.exit(main())
