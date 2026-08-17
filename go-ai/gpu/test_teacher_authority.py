#!/usr/bin/env python3

from __future__ import annotations

import unittest
from unittest.mock import patch

from audit_teacher_authority import (ActorRow, Corpus, RankingRow, Trajectory,
                                     ValueRow, exhaustive_numeric_metrics,
                                     legal_moves_from_state,
                                     policy_metrics, ranking_metrics, source_authority,
                                     split_weighted_candidates,
                                     terminal_counterfactual_metrics,
                                     teacher_complementarity,
                                     validate_model_authority)


def actor(episode: int, elapsed: int, action: int, actions: list[int]) -> ActorRow:
    return ActorRow(
        "heldout", "katago", episode, "....|1111|0|0|0", [0.0], elapsed,
        [0, 1, 2, 3, 4], actions, action,
    )


class TeacherAuthorityTest(unittest.TestCase):
    def test_model_authority_requires_explicit_candidate_mode(self) -> None:
        validate_model_authority("champion", "champion", False)
        with self.assertRaisesRegex(RuntimeError, "--candidate-model"):
            validate_model_authority("student", "champion", False)

    def test_candidate_mode_keeps_distinct_teacher_authority(self) -> None:
        validate_model_authority("student", "champion", True)

    def test_departure_counts_only_later_unreachable_rows(self) -> None:
        rows = [
            actor(1, 0, 0, [0, 1]),
            actor(1, 1, 2, [2]),
            actor(1, 2, 3, [3]),
            actor(2, 0, 1, [1]),
        ]
        logits = [
            [4, 3, 2, 1, 0],
            [4, 3, 2, 1, 0],
            [0, 1, 2, 4, 3],
            [0, 4, 3, 2, 1],
        ]
        result = policy_metrics(rows, logits, 1)["katago"]
        self.assertEqual(result["routesWithTeacherSetOmission"], 1)
        self.assertEqual(result["laterRowsAfterFirstTeacherSetOmission"], 1)
        self.assertEqual(result["laterRowFractionProvablyOffTeacherTrajectory"], 0.25)
        self.assertEqual(result["routesWithExecutedMoveOmission"], 1)
        self.assertEqual(result["byRelativeRouteStage"]["early"]["rows"], 2)
        self.assertEqual(result["byRelativeRouteStage"]["middle"]["rows"], 1)
        self.assertEqual(result["byRelativeRouteStage"]["late"]["rows"], 1)

    def test_authority_does_not_count_ranking_markers_as_outcomes(self) -> None:
        value = ValueRow("....|1111|0|0|0", [0.0], 1, 1, 2, 3, 1)
        corpus = Corpus(
            actors=[actor(1, 0, 0, [0, 1])],
            trajectories=[Trajectory("heldout", "katago", 1, [value])],
        )
        result = source_authority(corpus)["katago"]
        self.assertEqual(result["effectiveIndependentOutcomeLabels"], 1)
        self.assertEqual(result["counterfactualTerminalOutcomes"], 0)
        self.assertEqual(result["labelToLegalActionCoverage"], 0.4)

    def test_authority_separates_rankings_from_losing_routes(self) -> None:
        win = ValueRow("....|1111|0|0|0", [0.0], 1, 1, 2, 3, 1)
        loss = ValueRow("....|1111|0|0|0", [0.0], 1, 0, 1, 3, 1)
        ranking = RankingRow(
            "heldout", "katago", 2, "....|1111|0|0|0", [0.0], 0,
            [0, 1], 0, [[loss], [loss]],
        )
        corpus = Corpus(
            rankings=[ranking],
            trajectories=[
                Trajectory("heldout", "katago", 1, [win]),
                Trajectory("heldout", "katago", 2, [loss]),
            ],
        )
        result = source_authority(corpus)["katago"]
        self.assertEqual(result["rankingRowsOnWinningRoutes"], 0)
        self.assertEqual(result["rankingRowsOnLosingRoutes"], 1)
        self.assertEqual(result["counterfactualTerminalOutcomes"], 0)

    def test_terminal_counterfactual_metric_uses_real_group_outcomes(self) -> None:
        losing_control = ValueRow("a", [0.0], 6, 0, 5, 3, 0.5, 10)
        winning_negative = ValueRow("b", [0.0], 6, 1, 20, 4, 0.5, 20)
        routes = [
            Trajectory("heldout", "handcrafted", 10, [losing_control],
                       "group", 0, 2, 4, 4, 5),
            Trajectory("heldout", "handcrafted", 20, [winning_negative],
                       "group", 1, 2, 7, 4, 5),
        ]
        with patch("audit_teacher_authority.predict_values",
                   return_value=[(0.9, 20, 3), (0.1, 5, 4)]):
            result = terminal_counterfactual_metrics(routes, None, None, 8)
        self.assertEqual(result["heldoutGroups"], 1)
        self.assertEqual(result["modelTop1TerminalTruthAgreement"], 0)
        self.assertEqual(result["handcraftedChosenIsTerminalBest"], 0)
        self.assertEqual(result["meanTerminalWinRegretOfModelChoice"], 1)

    def test_student_root_metrics_separate_live_top_k_from_expert_additions(self) -> None:
        values = [
            ValueRow("a", [0.0], 2, 0, 5, 3, 0.25),
            ValueRow("b", [0.0], 2, 1, 10, 3, 0.25),
            ValueRow("c", [0.0], 2, 1, 20, 3, 0.25),
        ]
        routes = [
            Trajectory("heldout", "handcrafted", 10 + index, [value],
                       "student-group", index, 3, action, None, 1, "component",
                       "first-divergence", 1, 2, 3, index < 2, True)
            for index, (value, action) in enumerate(zip(values, [1, 2, 3], strict=True))
        ]
        with patch("audit_teacher_authority.predict_values",
                   return_value=[(0.1, 5, 3), (0.9, 10, 3), (0.8, 20, 3)]):
            result = terminal_counterfactual_metrics(routes, None, None, 8)
        self.assertEqual(result["heldoutGroups"], 1)
        self.assertEqual(result["modelTop1TerminalTruthAgreement"], 0)
        self.assertEqual(result["literalStudentTop16"]["modelTop1TerminalTruthAgreement"], 1)
        self.assertEqual(result["literalStudentTop16"]["meanCandidatesPerGroup"], 2)
        self.assertEqual(result["deployedStudentFinalists"]["meanCandidatesPerGroup"], 3)
        self.assertEqual(result["bySelectionKind"]["first-divergence"]
                         ["literalStudentTop16"]["heldoutGroups"], 1)

    def test_legal_moves_reconstructs_global_pass(self) -> None:
        self.assertEqual(legal_moves_from_state("....|1010|0|0|0"), [0, 2, 4])

    def test_exhaustive_reply_groups_follow_probability_mass(self) -> None:
        def value(weight: float) -> ValueRow:
            return ValueRow("....|1111|0|0|0", [0.0], 1, 1, 2, 3, weight)
        groups = split_weighted_candidates(
            [value(0.25), value(0.75), value(1.0)], 2)
        self.assertEqual([len(group) for group in groups], [2, 1])

    def test_numeric_metrics_separate_policy_availability_from_value_choice(self) -> None:
        first = ValueRow("....|1111|0|0|0", [0.0], 1, 0.9, 4, 2, 1)
        second = ValueRow("....|1111|0|0|0", [0.0], 1, 0.8, 3, 2, 1)
        row = RankingRow(
            "heldout", "champion", 1, "....|1111|0|0|0", [0.0], 0,
            [0, 1], 0, [[first], [second]],
        )
        result = exhaustive_numeric_metrics(
            [row], [[2.0, 1.0, 0.0, 0.0, 0.0]],
            [(0.7, 4, 2), (0.95, 3, 2)], top_k=2)
        self.assertEqual(result["championBestInPolicyTopK"], 1)
        self.assertEqual(result["globalChampionBestTop1Agreement"], 0)
        self.assertEqual(result["deploymentChampionBestAgreement"], 0)
        self.assertEqual(result["weightedWinMaeAgainstChampion"], 0.175)

    def test_external_ranking_metrics_remain_separate_from_numeric_metrics(self) -> None:
        selected = ValueRow("selected", [0.0], 1, 1, 2, 3, 1)
        negative = ValueRow("negative", [0.0], 1, 0, 1, 3, 1)
        row = RankingRow(
            "heldout", "handcrafted", 1, "....|1111|0|0|0", [0.0], 0,
            [0, 1], 0, [[selected], [negative]],
        )
        result = ranking_metrics(
            [row], [[2.0, 1.0, 0.0, 0.0, 0.0]],
            [(0.8, 2, 3), (0.2, 1, 3)], 2,
            [Trajectory("heldout", "handcrafted", 1, [selected])])
        self.assertEqual(
            result["handcrafted"]["categoricalTeacherPreferenceTop1Agreement"], 1)

    def test_complementarity_measures_union_on_identical_inputs(self) -> None:
        kata = actor(1, 0, 0, [0, 1])
        handcrafted = ActorRow(
            kata.split, "handcrafted", kata.episode, kata.state, kata.behavior,
            kata.elapsed, kata.moves, [2], 2,
        )
        result = teacher_complementarity(
            [kata, handcrafted], [[5, 4, 3, 2, 1], [5, 4, 3, 2, 1]], 2)
        self.assertEqual(result["exactSharedPairedRouteInputs"], 1)
        self.assertEqual(result["executedMoveAgreement"], 0)
        self.assertEqual(result["meanUnionPositiveActions"], 3)
        self.assertEqual(result["shortlist"]["2"]["kataAnyProposalIncluded"], 1)
        self.assertEqual(result["shortlist"]["2"]["handcraftedIncluded"], 0)


if __name__ == "__main__":
    unittest.main()
