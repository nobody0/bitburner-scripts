#!/usr/bin/env python3
"""Regression tests for V9 selective-head execution."""

from __future__ import annotations

import unittest
import tempfile
import random

import torch
import torch.nn.functional as F

from compress_v9 import (
    enable_export_quantization,
    enable_low_rank_value,
    parameter_counts,
    structured_initialize,
)
from train_v9 import (DistillExample, ProposalExample, V9Net, V9Shape,
                      encode_states, prepare_replay, proposal_objective,
                      proposal_strata, set_elapsed, split_candidate_groups,
                      stratified_proposals)


class SelectiveHeadTest(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(918273)
        self.model = V9Net(
            V9Shape(extent=5, channels=4, blocks=1, hidden=8, tower=4, behavior=3),
            torch.device("cpu"),
            seed=112233,
        )
        self.inputs = torch.randn(3, 8, 5, 5)
        self.behavior = torch.randn(3, 3)

    def assert_gradients_equal(self, full_loss: torch.Tensor,
                               selective_loss: callable) -> None:
        self.model.zero_grad(set_to_none=True)
        full_loss.backward()
        expected = {
            name: None if parameter.grad is None else parameter.grad.detach().clone()
            for name, parameter in self.model.named_parameters()
        }

        self.model.zero_grad(set_to_none=True)
        selective_loss().backward()
        for name, parameter in self.model.named_parameters():
            actual = parameter.grad
            if expected[name] is None:
                self.assertIsNone(actual, f"unexpected gradient for {name}")
            else:
                self.assertIsNotNone(actual, f"missing gradient for {name}")
                torch.testing.assert_close(actual, expected[name], rtol=0, atol=0)

    def test_selective_outputs_match_full_forward(self) -> None:
        with torch.no_grad():
            value, policy, branches = self.model(self.inputs, self.behavior)
            torch.testing.assert_close(
                self.model.forward_value(self.inputs, self.behavior), value, rtol=0, atol=0)
            torch.testing.assert_close(
                self.model.forward_policy(self.inputs, self.behavior), policy, rtol=0, atol=0)
            proposal_policy, proposal_branches = self.model.forward_proposal(
                self.inputs, self.behavior)
            torch.testing.assert_close(proposal_policy, policy, rtol=0, atol=0)
            torch.testing.assert_close(proposal_branches, branches, rtol=0, atol=0)

    def test_value_gradients_match_full_forward(self) -> None:
        full_value, _, _ = self.model(self.inputs, self.behavior)
        self.assert_gradients_equal(
            full_value.square().mean(),
            lambda: self.model.forward_value(self.inputs, self.behavior).square().mean(),
        )

    def test_proposal_gradients_match_full_forward(self) -> None:
        _, full_policy, full_branches = self.model(self.inputs, self.behavior)

        def selective_loss() -> torch.Tensor:
            policy, branches = self.model.forward_proposal(self.inputs, self.behavior)
            return policy.square().mean() + branches.square().mean()

        self.assert_gradients_equal(
            full_policy.square().mean() + full_branches.square().mean(),
            selective_loss,
        )

    def test_candidate_reply_groups_are_recovered_from_probability_mass(self) -> None:
        def value(weight: float) -> DistillExample:
            return DistillExample("state", [0.0], 1, 0.5, 1.0, 2.0, weight)

        groups = split_candidate_groups(
            [value(0.25), value(0.75), value(1.0), value(0.1), value(0.9)], 3)
        self.assertEqual([[row.weight for row in group] for group in groups],
                         [[0.25, 0.75], [1.0], [0.1, 0.9]])
        with self.assertRaises(RuntimeError):
            split_candidate_groups([value(0.4)], 1)

    def test_cached_proposal_strata_preserve_sampling_exactly(self) -> None:
        examples = [
            ProposalExample(
                index, "", [], 0, [0, 1, 25], [1, 0, 0], [0, 0, 0],
                [[1.0] + [0.0] * 12] * 3, 0,
                [25] if index % 3 == 0 else [0],
                [], [1] if index % 3 == 1 else [])
            for index in range(30)
        ]
        uncached_rng = random.Random(918273)
        cached_rng = random.Random(918273)
        uncached = stratified_proposals(examples, 20, 25, uncached_rng)
        cached = stratified_proposals(
            examples, 20, 25, cached_rng, proposal_strata(examples, 25))
        self.assertEqual([example.episode for example in cached],
                         [example.episode for example in uncached])

    def test_proposal_margin_uses_the_actual_top_k_boundary(self) -> None:
        example = ProposalExample(
            1, "", [], 0, list(range(10)), [1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
            [0] * 10, [[1.0] + [0.0] * 12] * 10, 0, [0], [1, 2, 3], [])
        policy = torch.tensor([[0.0, 0.0, 0.0, 0.0, 10.0, 9.0, 8.0, 7.0,
                                6.0, 5.0]])
        branches = torch.zeros(1, 10, 13)
        base = proposal_objective(
            policy, branches, [example], torch.device("cpu"), margin_weight=0)
        top_k = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=1, shortlist_k=8)
        strict = proposal_objective(
            policy, branches, [example], torch.device("cpu"), margin_weight=1)
        torch.testing.assert_close(
            top_k - base, F.softplus(torch.tensor(6.5)), rtol=0, atol=3e-6)
        torch.testing.assert_close(
            strict - base, F.softplus(torch.tensor(10.5)), rtol=0, atol=3e-6)

    def test_proposal_anchor_pressure_is_configurable(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 1, 2], [1, 1, 0], [0, 0, 0],
            [[1.0] + [0.0] * 12] * 3, 0, [0], [1], [])
        policy = torch.tensor([[0.0, 1.0, -1.0]])
        branches = torch.zeros(1, 3, 13)
        without_anchor = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=0, anchor_weight=0)
        with_anchor = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=0, anchor_weight=0.5)
        expected_anchor = 0.5 * F.cross_entropy(policy, torch.tensor([0]))
        torch.testing.assert_close(
            with_anchor - without_anchor, expected_anchor, rtol=0, atol=1e-7)

    def test_vectorized_proposal_objective_matches_row_reference(self) -> None:
        def example(moves: list[int], targets: list[float], labels: list[int]) -> ProposalExample:
            branches = [[1.0 if branch == label else 0.0 for branch in range(13)]
                        for label in labels]
            return ProposalExample(
                1, "", [], 0, moves, targets, [0.0] * len(moves), branches,
                moves[targets.index(1.0)], [], [], [])

        batch = [
            example([0, 2, 4, 5], [1, 0, 1, 0], [1, 1, 2, 3]),
            example([1, 3, 5], [0, 1, 0], [4, 4, 5]),
        ]
        policy = torch.randn(2, 6, requires_grad=True)
        branches = torch.randn(2, 6, 13, requires_grad=True)

        def reference(p: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
            policy_losses = []
            branch_losses = []
            for row, item in enumerate(batch):
                moves = torch.tensor(item.moves)
                target = torch.tensor(item.targets)
                selected = p[row, moves]
                positives = selected[target > 0.5]
                negatives = selected[target <= 0.5]
                policy_losses.append(
                    F.softplus(-positives).mean() + F.softplus(negatives).mean()
                    + 0.25 * F.softplus(0.5 - positives.min() + negatives.max()))
                target_branches = torch.tensor(item.branches)
                labels = target_branches.argmax(dim=1)
                counts = torch.bincount(labels, minlength=13).clamp_min(1)
                weights = counts[labels].reciprocal()
                weights /= weights.mean()
                cross_entropy = -(
                    target_branches * F.log_softmax(b[row, moves], dim=1)).sum(dim=1)
                branch_losses.append((cross_entropy * weights).mean())
            anchors = torch.tensor([item.best_move for item in batch])
            valid = torch.zeros_like(p, dtype=torch.bool)
            for row, item in enumerate(batch):
                valid[row, item.moves] = True
            anchor_loss = F.cross_entropy(p.masked_fill(~valid, -torch.inf), anchors)
            return torch.stack(policy_losses).mean() + 0.5 * anchor_loss \
                + 0.25 * torch.stack(branch_losses).mean()

        expected = reference(policy, branches)
        expected.backward()
        expected_policy_grad = policy.grad.detach().clone()
        expected_branch_grad = branches.grad.detach().clone()
        policy.grad = None
        branches.grad = None
        actual = proposal_objective(policy, branches, batch, torch.device("cpu"))
        actual.backward()
        torch.testing.assert_close(actual, expected, rtol=1e-6, atol=1e-7)
        torch.testing.assert_close(policy.grad, expected_policy_grad, rtol=1e-6, atol=1e-7)
        torch.testing.assert_close(branches.grad, expected_branch_grad, rtol=1e-6, atol=1e-7)


class StructuredCompressionTest(unittest.TestCase):
    def test_artifact_estimate_matches_the_exporter(self) -> None:
        self.assertEqual(parameter_counts(V9Shape(5, 32, 4, 256, 64, 31)),
                         (313_791, 302_949, 306_654))
        self.assertEqual(
            parameter_counts(V9Shape(5, 28, 4, 224, 56, 31))[2], 236_070)

    def test_structured_initialization_produces_a_finite_smaller_v9(self) -> None:
        teacher = V9Net(V9Shape(5, 8, 2, 16, 8, 31), torch.device("cpu"), 101)
        student = V9Net(V9Shape(5, 4, 1, 8, 4, 31), torch.device("cpu"), 202)
        structured_initialize(student, teacher)
        inputs = torch.randn(3, 8, 5, 5)
        behavior = torch.randn(3, 31)
        value, policy, branches = student(inputs, behavior)
        self.assertEqual(value.shape, (3, 3))
        self.assertEqual(policy.shape, (3, 26))
        self.assertEqual(branches.shape, (3, 26, 13))
        self.assertTrue(torch.isfinite(value).all())
        self.assertTrue(torch.isfinite(policy).all())
        self.assertTrue(torch.isfinite(branches).all())

    def test_export_quantization_uses_q8_rows_and_keeps_gradients(self) -> None:
        model = V9Net(V9Shape(5, 4, 1, 8, 4, 31), torch.device("cpu"), 303)
        enable_export_quantization(model)
        matrix = model.value_w1.reshape(8, -1)
        for row in matrix:
            scale = row.abs().max() / 127
            torch.testing.assert_close(row / scale, torch.round(row / scale), atol=1e-5, rtol=0)
        model.forward_value(torch.randn(2, 8, 5, 5), torch.randn(2, 31)).sum().backward()
        self.assertIsNotNone(model.parametrizations.value_w1.original.grad)

    def test_low_rank_value_reconstructs_the_serialized_matrix(self) -> None:
        model = V9Net(V9Shape(5, 4, 1, 8, 4, 31), torch.device("cpu"), 404)
        factor = enable_low_rank_value(model, 4, quantization_aware=False)
        left, right = factor.effective()
        torch.testing.assert_close(model.value_w1, left @ right, rtol=0, atol=0)
        model.forward_value(torch.randn(2, 8, 5, 5), torch.randn(2, 31)).sum().backward()
        self.assertIsNotNone(factor.left.grad)
        self.assertIsNotNone(factor.right.grad)


class PackedReplayTest(unittest.TestCase):
    def test_empty_online_replay_has_valid_packed_shapes(self) -> None:
        shape = V9Shape(5, 4, 1, behavior=3)
        prepared, summary = prepare_replay(
            [], [], [], [], [], shape, {"cacheSchema": "test"}, None)
        self.assertEqual(prepared.state_planes.shape, (0, 8, 5, 5))
        self.assertEqual(prepared.proposal_behavior.shape, (0, 3))
        self.assertEqual(prepared.value_behavior.shape, (0, 3))
        self.assertEqual(summary["states"], 0)

    def test_cache_round_trip_is_exact_and_reusable(self) -> None:
        state = "X.O.." + "." * 20 + "|" + "1" * 25 + "|1|0|1"
        proposal = ProposalExample(
            10, state, [0.25, 0.75], 7, [0, 25], [1.0, 0.0], [0.0, 1.0],
            [[1.0] + [0.0] * 12, [0.0, 1.0] + [0.0] * 11],
            0, [0], [], [25])
        value = DistillExample(state, [0.25, 0.75], 7, 1.0, 4.0, 9.0, 0.5)
        metadata = {"cacheSchema": "test", "corpusSha256": ["abc"]}
        with tempfile.TemporaryDirectory() as cache_dir:
            prepared, first = prepare_replay(
                [proposal], [], [], [value], [], V9Shape(5, 4, 1, behavior=2),
                metadata, cache_dir)
            cached, second = prepare_replay(
                [proposal], [], [], [value], [], V9Shape(5, 4, 1, behavior=2),
                metadata, cache_dir)
            self.assertFalse(first["hit"])
            self.assertTrue(second["hit"])
            expected = set_elapsed(encode_states([state], 5, torch.device("cpu")), [7], 5)
            torch.testing.assert_close(prepared.inputs([proposal], torch.device("cpu")), expected)
            torch.testing.assert_close(cached.inputs([value], torch.device("cpu")), expected)
            packed_target, packed_behavior = cached.value_batch([value], torch.device("cpu"))
            torch.testing.assert_close(
                packed_target, torch.tensor([[1.0, torch.log1p(torch.tensor(4.0)),
                                              torch.log1p(torch.tensor(9.0)), 0.5]]))
            torch.testing.assert_close(packed_behavior, torch.tensor([[0.25, 0.75]]))
            policy = torch.randn(1, 26)
            branches = torch.randn(1, 26, 13)
            expected_loss = proposal_objective(
                policy, branches, [proposal], torch.device("cpu"))
            packed = cached.proposal_batch([proposal], torch.device("cpu"))
            actual_loss = proposal_objective(
                policy, branches, [proposal], torch.device("cpu"), cached, packed)
            torch.testing.assert_close(actual_loss, expected_loss, rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
