from __future__ import annotations

import gzip
import json
import pathlib
import tempfile
import unittest

from validate_corpus import Validator, valid_full_student_root_stage_balance


IDENTITY = {
    "schema": "bitburner-go-exhaustive-proposals-v9.5",
    "profile": "small5",
    "teacherSha256": "a" * 64,
    "opponentOracle": "bitburner-go-ai-v3.0.1",
}
BOARD = "." * 25
LEGAL = "1" * 25
EXACT = [1.0, 0.1, 0.2, 0.3] + [0.0] * 15 + [1.0] * 8 + [0.0] * 3 + [0.55]
FUTURE = [1.0, -1.0, -1.0, -1.0] + [0.0] * 15 + [1.0] * 8 + [0.0] * 3 + [0.55]


def state(passes: int = 0, response_pass: int = 0, response_noop: int = 0,
          board: str = BOARD, legal: str = LEGAL) -> str:
    return f"{board}|{legal}|{passes}|{response_pass}|{response_noop}"


def value(elapsed: int, remaining: int, weight: float, won: int = 1,
          author: str | None = None) -> dict[str, object]:
    terminal_board = ("X" if won else "O") * 25
    result: dict[str, object] = {
        "state": state(
            2 if remaining == 1 else 0,
            response_pass=int(remaining == 1),
            board=terminal_board if remaining == 1 else BOARD,
            legal="0" * 25 if remaining == 1 else LEGAL,
        ),
        "behavior": FUTURE,
        "elapsed": elapsed,
        "won": won,
        "score": 25.0 if won else 0.0,
        "remaining": remaining,
        "weight": weight,
    }
    if author is not None:
        result["author"] = author
    return result


def trajectory(episode: int = 1, won: int = 1) -> dict[str, object]:
    return {
        **IDENTITY,
        "kind": "trajectory",
        "split": "heldout" if episode % 10 == 0 else "train",
        "episode": episode,
        "values": [value(1, 2, 0.5, won), value(2, 1, 0.5, won)],
        "generation": {"source": "katago"},
    }


def counterfactual(episode: int, candidate: int, control: bool) -> dict[str, object]:
    record = trajectory(episode)
    for raw in record["values"]:  # type: ignore[index]
        raw["weight"] = 0.25
        raw["author"] = "environment-rollout:handcrafted-continuation-v1"
        raw["blackPower"] = 25.0
    record["generation"] = {
        "source": "handcrafted",
        "counterfactualGroupId": "group-1",
        "counterfactualCandidateIndex": candidate,
        "counterfactualCandidateCount": 2,
        "positionContentSha256": "b" * 64,
        "originalCorpus": "source.jsonl.gz",
        "originalCorpusSha256": "d" * 64,
        "originalEpisode": 7,
        "stage": "early",
        "originElapsed": 0,
        "originState": state(),
        "environmentId": "daemon19:test:1",
        "opponent": "????????????",
        "forcedAction": candidate,
        "chosenAction": 0,
        "candidateMoves": [0, 1],
        "actualReply": {"type": "move", "x": 0, "y": 0},
        "controlCandidate": control,
        "controlReproducesOriginal": control,
        "continuationPolicy": {"bundleSha256": "c" * 64},
        "effectiveSeeds": {
            "playtimeSeed": 1,
            "continuationDispatchPlaytimes": [0, 200],
            "continuationOpponentAiSeeds": [200, 400],
        },
        "terminalOutcome": {
            "won": True, "blackPower": 25, "whiteScore": 5.5,
            "lossPenalizedBlackPower": 25,
            "continuationLength": 2, "totalRouteTurns": 2,
        },
    }
    return record


def actor(episode: int = 1, elapsed: int = 0) -> dict[str, object]:
    return {
        **IDENTITY,
        "kind": "actor",
        "split": "heldout" if episode % 10 == 0 else "train",
        "example": {
            "episode": episode,
            "state": state(),
            "behavior": EXACT,
            "elapsed": elapsed,
            "moves": [*range(25), 25],
            "action": 0,
            "source": "katago",
        },
    }


class CorpusValidatorTest(unittest.TestCase):
    def test_recognizes_both_declared_full_student_root_stage_splits(self) -> None:
        self.assertTrue(valid_full_student_root_stage_balance(
            {"last-aligned": 64, "first-divergence": 64}))
        self.assertTrue(valid_full_student_root_stage_balance(
            {"first-divergence": 64, "post-divergence": 64}))
        self.assertFalse(valid_full_student_root_stage_balance(
            {"first-divergence": 63, "post-divergence": 65}))
        self.assertFalse(valid_full_student_root_stage_balance(
            {"last-aligned": 64, "post-divergence": 64}))

    def validate(self, records: list[dict[str, object]]) -> Validator:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = pathlib.Path(temporary.name) / "corpus.jsonl.gz"
        with gzip.open(path, "wt") as output:
            for record in records:
                output.write(json.dumps(record) + "\n")
        validator = Validator([path])
        validator.run()
        return validator

    def test_can_require_explicit_numeric_reply_authorship(self) -> None:
        proposal = {
            **IDENTITY,
            "kind": "proposal",
            "split": "train",
            "example": {
                "episode": 1,
                "state": state(),
                "behavior": EXACT,
                "elapsed": 0,
                "moves": [*range(25), 25],
                "targets": [1] + [0] * 25,
                "regrets": [0] * 26,
                "branches": [[1.0] + [0.0] * 12] * 26,
                "best_move": 0,
                "safe_moves": [0],
                "upside_moves": [],
                "bait_moves": [],
                "source": "champion",
            },
            "distill": [value(1, 1, 1.0, author="champion") for _ in range(26)],
        }
        validator = self.validate([proposal])
        self.assertEqual(validator.stats["numericReplyAuthors"], {"champion": 26})
        strict = Validator(validator.paths, require_numeric_reply_author="champion")
        strict.run()
        self.assertEqual(strict.errors, [])

        proposal["distill"][0].pop("author")  # type: ignore[index, union-attr]
        missing = self.validate([proposal])
        strict_missing = Validator(
            missing.paths, require_numeric_reply_author="champion")
        strict_missing.run()
        self.assertIn("numeric reply author None != required 'champion'",
                      "\n".join(strict_missing.errors))

    def test_student_root_actor_authority_allows_standalone_fixed_label(self) -> None:
        record = actor()
        record["profile"] = "daemon19"
        example = record["example"]  # type: ignore[assignment]
        example["state"] = f"{'.' * 361}|{'1' * 361}|0|0|0"
        example["behavior"] = EXACT[:-1]
        example["moves"] = [*range(361), 361]
        record["generation"] = {
            "studentRootActorAuthority": "katago-preferred-root-v1",
            "selectionKind": "first-divergence",
            "environmentId": "daemon19-student-root:test",
            "originatingStudentSha256":
                "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065",
        }
        validator = self.validate([record])
        self.assertEqual(validator.errors, [])

    def test_student_root_actor_authority_rejects_wrong_teacher_identity(self) -> None:
        record = actor()
        record["generation"] = {
            "studentRootActorAuthority": "frozen-handcrafted-exploit-root-v1",
            "selectionKind": "first-divergence",
            "environmentId": "daemon19-student-root:test",
            "originatingStudentSha256":
                "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065",
        }
        validator = self.validate([record])
        self.assertTrue(any("invalid student-root actor authority provenance" in error
                            for error in validator.errors))

    def test_certified_playbook_authority_allows_actor_only_route(self) -> None:
        record = actor()
        record["example"]["source"] = "handcrafted"  # type: ignore[index]
        record["generation"] = {
            "source": "certified-playbook",
            "authority": "replay-validated-and-or-certificate-v6",
            "environmentId": "ipvgo-certified-v6:Netburners:1:2:board",
            "certificate": "2.tsv",
            "certificateStateId": 3,
            "certifiedAllWhiteOutcomesWin": True,
            "selectedWithoutOutcome": False,
            "effectiveSeeds": {
                "resetPhase": 2,
                "dispatchPhase": 4,
                "opponentAiSeed": 1000,
            },
        }
        validator = self.validate([record])
        self.assertEqual(validator.errors, [])

    def test_certified_playbook_authority_rejects_incomplete_provenance(self) -> None:
        record = actor()
        record["example"]["source"] = "handcrafted"  # type: ignore[index]
        record["generation"] = {
            "source": "certified-playbook",
            "authority": "replay-validated-and-or-certificate-v6",
        }
        validator = self.validate([record])
        self.assertTrue(any("invalid certified-playbook actor authority provenance" in error
                            for error in validator.errors))

    def test_katago_dagger_authority_allows_fixed_schedule_actor_only_route(self) -> None:
        record = actor()
        record["profile"] = "daemon19"
        example = record["example"]  # type: ignore[assignment]
        example["state"] = f"{'.' * 361}|{'1' * 361}|0|0|0"
        example["behavior"] = EXACT[:-1]
        example["moves"] = [*range(361), 361]
        record["generation"] = {
            "source": "katago",
            "environmentId": "daemon19-katago-dagger:test",
            "kataGoDaggerAuthority": "katago-exact-action-v1",
            "originatingStudentSha256": "b" * 64,
            "selectedWithoutOutcome": True,
            "selectionSchedule": {
                "kind": "fixed-elapsed-stride-v1", "stride": 8, "pointsPerGame": 8,
            },
            "effectiveSeeds": {"defenseSeed": None},
        }
        validator = self.validate([record])
        self.assertEqual(validator.errors, [])

        record["generation"]["selectionSchedule"]["kind"] = \
            "first-policy-state-at-or-after-stride-v1"  # type: ignore[index]
        deferred = self.validate([record])
        self.assertEqual(deferred.errors, [])

        record["generation"]["selectedWithoutOutcome"] = False  # type: ignore[index]
        invalid = self.validate([record])
        self.assertIn("invalid KataGo DAgger actor authority provenance",
                      "\n".join(invalid.errors))

    def test_terminal_counterfactual_group_has_unit_mass_and_rollout_authority(self) -> None:
        validator = self.validate([
            counterfactual(1, 0, True),
            counterfactual(2, 1, False),
        ])
        self.assertEqual(validator.errors, [])
        self.assertEqual(validator.stats["counterfactualGroups"], 1)
        self.assertEqual(validator.stats["counterfactualContinuations"], 2)
        self.assertEqual(
            validator.stats["terminalValueAuthors"],
            {"environment-rollout:handcrafted-continuation-v1": 4},
        )

        broken = counterfactual(2, 1, False)
        broken["values"][0]["author"] = "champion"  # type: ignore[index]
        bad = self.validate([counterfactual(1, 0, True), broken])
        self.assertIn("wrong numeric author", "\n".join(bad.errors))

    def test_terminal_counterfactual_selection_cap_is_retained_in_provenance(self) -> None:
        records: list[dict[str, object]] = []
        for group_index in range(3):
            for candidate_index in range(2):
                record = counterfactual(group_index * 2 + candidate_index + 1,
                                        candidate_index, candidate_index == 0)
                generation = record["generation"]  # type: ignore[assignment]
                generation["counterfactualGroupId"] = f"group-{group_index}"
                generation["positionContentSha256"] = str(group_index) * 64
                records.append(record)
        validator = self.validate(records)
        self.assertIn("exceeding the cap of 2", "\n".join(validator.errors))

    def test_immediate_student_root_counterfactual_has_one_target_and_full_diagnostic(self) -> None:
        records = []
        for candidate in range(2):
            record = trajectory(candidate + 1)
            record["values"] = [{
                **value(1, 3, 0.5,
                          author="environment-rollout:student-root-handcrafted-continuation-v2"),
                "state": state(), "blackPower": 25.0,
            }]
            record["generation"] = {
                "source": "handcrafted",
                "counterfactualTargetScope": "immediate-post-reply",
                "counterfactualGroupId": "student-root-1",
                "counterfactualCandidateIndex": candidate,
                "counterfactualCandidateCount": 2,
                "positionContentSha256": "e" * 64,
                "originalEpisode": 0,
                "originElapsed": 0,
                "originState": state(),
                "environmentId": "student-env-1",
                "opponent": "????????????",
                "forcedAction": candidate,
                "candidateMoves": [0, 1],
                "actualReply": {"type": "move", "x": 0, "y": 0},
                "studentAction": 0,
                "studentFinalistMoves": [0],
                "studentPolicyTop16Moves": [0],
                "studentRequestedLimit": 16,
                "studentAdaptiveLimit": 1,
                "studentPerSeedReserve": 0,
                "studentProposalSeedCount": 0,
                "handcraftedChosenAction": 0,
                "kataGoPreferredAction": 1,
                "candidateFlags": {
                    "studentFinalist": candidate == 0,
                    "studentPolicyTop16": candidate == 0,
                    "handcraftedChosen": candidate == 0,
                    "kataGoPreferred": candidate == 1,
                },
                "selectionKind": "last-aligned",
                "originatingStudentSha256":
                    "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065",
                "continuationPolicy": {"kind": "frozen-handcrafted-policy"},
                "continuationTrace": [
                    {"turn": 0, "dispatchPlaytime": 0, "opponentAiSeed": 200,
                     "afterState": state()},
                    {"turn": 2, "dispatchPlaytime": 200, "opponentAiSeed": 400,
                     "afterState": state()},
                    {"turn": 4, "dispatchPlaytime": 400, "opponentAiSeed": 600,
                     "afterState": state(2, 1, board="X" * 25, legal="0" * 25)},
                ],
                "continuationFinalState": state(
                    2, 1, board="X" * 25, legal="0" * 25),
                "effectiveSeeds": {
                    "continuationDispatchPlaytimes": [0, 200, 400],
                    "continuationOpponentAiSeeds": [200, 400, 600],
                },
                "terminalOutcome": {
                    "won": True, "blackPower": 25, "whiteScore": 5.5,
                    "lossPenalizedBlackPower": 25,
                    "continuationLength": 3, "totalRouteTurns": 3,
                },
            }
            records.append(record)
        validator = self.validate(records)
        self.assertEqual(validator.errors, [])
        self.assertEqual(validator.stats["counterfactualGroups"], 1)
        self.assertEqual(validator.stats["terminalValueAuthors"], {
            "environment-rollout:student-root-handcrafted-continuation-v2": 2,
        })
        for record in records:
            record["generation"]["studentAction"] = 1
        invalid = self.validate(records)
        self.assertTrue(any(
            "frozen student action is absent from its exact finalist set" in error
            for error in invalid.errors))

    def test_certified_root_terminal_regret_has_distinct_authority(self) -> None:
        records = []
        for candidate in range(2):
            record = trajectory(candidate + 1)
            record["values"] = [{
                **value(1, 3, 0.5,
                          author="environment-rollout:certified-root-handcrafted-continuation-v1"),
                "state": state(), "blackPower": 25.0,
            }]
            record["generation"] = {
                "source": "handcrafted",
                "authority": "certified-playbook-terminal-regret-v1",
                "counterfactualAuthority": "certified-playbook-terminal-regret-v1",
                "counterfactualTargetScope": "immediate-post-reply",
                "counterfactualGroupId": "certified-root-1",
                "counterfactualCandidateIndex": candidate,
                "counterfactualCandidateCount": 2,
                "positionContentSha256": "f" * 64,
                "originalEpisode": 4,
                "originElapsed": 0,
                "originState": state(),
                "environmentId": "certified-env-1",
                "opponent": "Netburners",
                "forcedAction": candidate,
                "certifiedAction": 0,
                "kataGoActions": [1],
                "candidateMoves": [0, 1],
                "actualReply": {"type": "move", "x": 0, "y": 0},
                "selectionKind": "certified-root",
                "conditionalGroupSha256": "b" * 64,
                "originalResponseCorpus": "response.jsonl.gz",
                "originalResponseCorpusSha256": "c" * 64,
                "continuationPolicy": {"kind": "frozen-handcrafted-policy"},
                "continuationTrace": [
                    {"turn": 0, "dispatchPlaytime": 0, "opponentAiSeed": 200,
                     "afterState": state()},
                    {"turn": 2, "dispatchPlaytime": 200, "opponentAiSeed": 400,
                     "afterState": state()},
                    {"turn": 4, "dispatchPlaytime": 400, "opponentAiSeed": 600,
                     "afterState": state(2, 1, board="X" * 25, legal="0" * 25)},
                ],
                "continuationFinalState": state(
                    2, 1, board="X" * 25, legal="0" * 25),
                "effectiveSeeds": {
                    "continuationDispatchPlaytimes": [0, 200, 400],
                    "continuationOpponentAiSeeds": [200, 400, 600],
                },
                "terminalOutcome": {
                    "won": True, "blackPower": 25, "whiteScore": 5.5,
                    "lossPenalizedBlackPower": 25,
                    "continuationLength": 3, "totalRouteTurns": 3,
                },
            }
            records.append(record)
        validator = self.validate(records)
        self.assertEqual(validator.errors, [])
        self.assertEqual(validator.stats["counterfactualStages"], {"certified-root": 1})
        self.assertEqual(validator.stats["studentRootGroups"], 0)

    def test_future_marginalized_student_root_target_recomputes_every_phase(self) -> None:
        records = []
        expected_rate = (25 / 3 + 0) / 2
        for candidate in range(2):
            record = trajectory(candidate + 1)
            record["values"] = [{
                **value(1, 3, 0.5,
                          author="environment-rollout:student-root-future-marginalized-v1"),
                "state": state(), "won": 0.5, "score": expected_rate * 3,
                "remaining": 3.0, "blackPower": 12.5,
            }]
            common_phase = {
                "continuationLength": 3, "totalRouteTurns": 3,
                "continuationDispatchPlaytimes": [0, 200, 400],
                "continuationOpponentAiSeeds": [200, 400, 600],
                "traceSha256": "f" * 64,
            }
            record["generation"] = {
                "source": "handcrafted",
                "numericAuthor": "environment-rollout:student-root-future-marginalized-v1",
                "counterfactualTargetScope": "immediate-post-reply-future-marginalized",
                "counterfactualGroupId": "expected-root-1",
                "counterfactualCandidateIndex": candidate,
                "counterfactualCandidateCount": 2,
                "positionContentSha256": "e" * 64,
                "originalEpisode": 0, "originElapsed": 0, "originState": state(),
                "environmentId": "expected-student-env-1", "opponent": "????????????",
                "forcedAction": candidate, "candidateMoves": [0, 1],
                "actualReply": {"type": "move", "x": 0, "y": 0},
                "studentAction": 0, "studentFinalistMoves": [0],
                "studentPolicyTop16Moves": [0, 1], "studentRequestedLimit": 1,
                "studentAdaptiveLimit": 1, "studentPerSeedReserve": 0,
                "studentProposalSeedCount": 0, "handcraftedChosenAction": 0,
                "kataGoPreferredAction": 1,
                "candidateFlags": {"studentFinalist": candidate == 0,
                                   "studentPolicyTop16": True,
                                   "handcraftedChosen": candidate == 0,
                                   "kataGoPreferred": candidate == 1},
                "selectionKind": "last-aligned",
                "originatingStudentSha256":
                    "d4a4b23a8ea16b3ffb4e785229b1d9ae43c59d43b813b99b2ce1549669b66065",
                "continuationPolicy": {"kind": "frozen-handcrafted-policy"},
                "futurePhaseCount": 2, "futurePhaseStrideCycles": 7919,
                "effectiveSeeds": {"futurePhaseOffsetsCycles": [0, 7919]},
                "phaseOutcomes": [
                    {**common_phase, "phase": 0, "dispatchOffsetCycles": 0,
                     "won": True, "blackPower": 25, "whiteScore": 5.5,
                     "lossPenalizedBlackPower": 25,
                     "finalState": state(2, 1, board="X" * 25, legal="0" * 25)},
                    {**common_phase, "phase": 1, "dispatchOffsetCycles": 7919,
                     "won": False, "blackPower": 0, "whiteScore": 30.5,
                     "lossPenalizedBlackPower": 0,
                     "finalState": state(2, 1, board="O" * 25, legal="0" * 25)},
                ],
                "terminalOutcome": {
                    "expectedWinProbability": 0.5,
                    "expectedLossPenalizedPowerPerTotalTurn": expected_rate,
                    "effectiveLossPenalizedBlackPower": expected_rate * 3,
                    "effectiveContinuationLength": 3,
                    "meanBlackPower": 12.5, "phaseCount": 2,
                },
            }
            records.append(record)
        validator = self.validate(records)
        self.assertEqual(validator.errors, [])
        recovery = json.loads(json.dumps(records))
        for record in recovery:
            generation = record["generation"]
            generation["selectionKind"] = "post-divergence"
        recovery_validator = self.validate(recovery)
        self.assertEqual(recovery_validator.errors, [])
        broken = json.loads(json.dumps(records))
        broken[1]["generation"]["phaseOutcomes"][1]["won"] = True
        invalid = self.validate(broken)
        self.assertIn("phase won disagrees with final board", "\n".join(invalid.errors))

    def test_valid_complete_route_and_weighted_ranking(self) -> None:
        ranking = {
            **IDENTITY,
            "kind": "actor-ranking",
            "split": "train",
            "example": {
                "episode": 1,
                "state": state(),
                "behavior": EXACT,
                "elapsed": 0,
                "moves": [0, 1],
                "bestMove": 0,
                "winGroupMoves": [0, 1],
                "source": "katago",
                "candidates": [
                    [{**value(1, 1, 0.25), "won": 1},
                     {**value(1, 1, 0.75), "won": 1}],
                    [{**value(1, 1, 1.0), "won": 1}],
                ],
            },
        }
        validator = self.validate([actor(), actor(elapsed=1), ranking, trajectory()])
        self.assertEqual(validator.errors, [])
        self.assertEqual(validator.stats["replyGroups"]["weighted"], 1)

    def test_rejects_stale_behavior_bad_remaining_and_truncation(self) -> None:
        broken = trajectory()
        broken["values"][0]["behavior"] = EXACT  # type: ignore[index]
        broken["values"][0]["remaining"] = 99  # type: ignore[index]
        broken["values"][-1]["state"] = state()  # type: ignore[index]
        validator = self.validate([broken])
        messages = "\n".join(validator.errors)
        self.assertIn("future roll behavior[1] must be -1", messages)
        self.assertIn("remaining != 2", messages)
        self.assertIn("final state did not reach two passes", messages)

    def test_rejects_terminal_outcome_and_score_mismatch(self) -> None:
        broken = trajectory()
        broken["values"][-1]["state"] = state(  # type: ignore[index]
            2, 1, board="O" * 25, legal="0" * 25,
        )
        validator = self.validate([broken])
        messages = "\n".join(validator.errors)
        self.assertIn("won target disagrees", messages)
        self.assertIn("score target disagrees", messages)

    def test_rejects_losing_fixed_teacher_actor_and_wrong_split(self) -> None:
        bad_actor = actor(10)
        bad_actor["split"] = "train"
        losing = trajectory(10, won=0)
        validator = self.validate([bad_actor, losing])
        messages = "\n".join(validator.errors)
        self.assertIn("belongs to heldout", messages)
        self.assertIn("losing fixed-teacher route contains positive actor", messages)

    def test_rejects_malformed_probability_group(self) -> None:
        ranking = {
            **IDENTITY,
            "kind": "actor-ranking",
            "split": "train",
            "example": {
                "episode": 1,
                "state": state(),
                "behavior": EXACT,
                "elapsed": 0,
                "moves": [0, 1],
                "bestMove": 0,
                "source": "katago",
                "candidates": [
                    [{**value(1, 1, 0.4), "won": 1}],
                    [{**value(1, 1, 1.0), "won": 0}],
                ],
            },
        }
        validator = self.validate([ranking, trajectory()])
        self.assertIn("reply probabilities sum to 0.4", "\n".join(validator.errors))
        ranking["example"]["candidates"][0][0]["blackPower"] = 10
        validator = self.validate([ranking, trajectory()])
        self.assertIn("unsupported ranking value fields ['blackPower']",
                      "\n".join(validator.errors))

    def test_detects_cross_file_copy_with_only_provenance_changed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = [pathlib.Path(directory) / f"copy-{index}.jsonl.gz"
                     for index in range(2)]
            for index, path in enumerate(paths):
                record = trajectory()
                record["generation"] = {"source": "katago", "copy": index}
                with gzip.open(path, "wt") as output:
                    output.write(json.dumps(record) + "\n")
            validator = Validator(paths)
            validator.run()
        self.assertEqual(validator.stats["semanticDuplicateRecords"], 1)
        self.assertIn("duplicated in the input set", "\n".join(validator.errors))

    def test_detects_same_file_copy_with_only_provenance_changed(self) -> None:
        first = trajectory()
        second = trajectory()
        first["generation"] = {"source": "katago", "copy": 1}
        second["generation"] = {"source": "katago", "copy": 2}
        validator = self.validate([first, second])
        self.assertEqual(validator.stats["semanticDuplicateRecords"], 1)


if __name__ == "__main__":
    unittest.main()
