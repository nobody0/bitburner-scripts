#!/usr/bin/env python3
"""Regression tests for V9 selective-head execution."""

from __future__ import annotations

import unittest
import tempfile
import random
import gzip
import hashlib
import json
import collections
import dataclasses
import pathlib

import torch
import torch.nn.functional as F

from compress_v9 import (
    enable_export_quantization,
    enable_low_rank_value,
    load_knowledge,
    parameter_counts,
    structured_initialize,
)
from train_v9 import (Candidate, DistillExample, PhaseTimings, ProposalExample,
                      RankingExample, Reply, State, ValueExample, V9Net, V9Shape,
                      actor_corpus_record, checkpoint_metrics, configure_training_scope,
                      corpus_record, candidate_ranking_objective,
                      encode_states, encode_tactical_state_planes, load_corpora,
                      prepare_replay, proposal_objective,
                      load_v9, save_model,
                      post_reply_behavior, ranking_metrics, replay_metadata,
                      reinitialize_zero_value_head,
                      shortlist_metrics,
                      source_ranking_metrics, source_shortlist_metrics,
                      proposal_source_strata, proposal_strata, set_elapsed, split_candidate_groups,
                      stratified_proposals, stratified_rankings, stratified_values,
                      target_exploration_actions, train_updates,
                      transform_actor_symmetry,
                      trajectory_corpus_record, trajectory_outcome_source,
                      v9_actor_actions, v9_shortlist, valid_actor_symmetries,
                      validate_exhaustive_actor, value_head_is_zero)
from select_self_routes import run as select_self_routes
from diagnose_v9_topology import RoutedV9Net, deployed_cost


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

    def test_policy_only_zero_value_head_requires_explicit_reinitialization(self) -> None:
        with torch.no_grad():
            for name, parameter in self.model.named_parameters():
                if name.startswith("value_"):
                    parameter.zero_()
        self.assertTrue(value_head_is_zero(self.model))
        reinitialize_zero_value_head(self.model, 12345)
        self.assertFalse(value_head_is_zero(self.model))
        self.assertGreater(float(self.model.forward_value(
            self.inputs, self.behavior).std().detach()), 0)
        with self.assertRaisesRegex(RuntimeError, "nonzero value head"):
            reinitialize_zero_value_head(self.model, 12345)

    def test_global_policy_checkpoint_round_trip_preserves_every_output(self) -> None:
        model = V9Net(V9Shape(5, 4, 1, 8, 4, 3, 2), torch.device("cpu"), 77)
        expected = model(self.inputs, self.behavior)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = pathlib.Path(directory) / "global.model"
            save_model(model, checkpoint)
            restored = load_v9(checkpoint, torch.device("cpu"))
        self.assertEqual(restored.shape.policy_rank, 2)
        for actual, wanted in zip(restored(self.inputs, self.behavior), expected, strict=True):
            torch.testing.assert_close(actual, wanted, rtol=0, atol=0)

    def test_tactical_global_checkpoint_round_trip_preserves_every_output(self) -> None:
        model = V9Net(V9Shape(5, 4, 1, 8, 4, 3, 2, 16), torch.device("cpu"), 78)
        inputs = torch.randn(3, 16, 5, 5)
        expected = model(inputs, self.behavior)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = pathlib.Path(directory) / "tactical.model"
            save_model(model, checkpoint)
            restored = load_v9(checkpoint, torch.device("cpu"))
        self.assertEqual(restored.shape.input_channels, 16)
        for actual, wanted in zip(restored(inputs, self.behavior), expected, strict=True):
            torch.testing.assert_close(actual, wanted, rtol=0, atol=0)

    def test_post_reply_behavior_preserves_future_policy_on_daemon(self) -> None:
        future = [[1.0, -1.0, -1.0]]
        actual = post_reply_behavior(
            future, extent=19, features=3, device=torch.device("cpu"))
        torch.testing.assert_close(actual, torch.tensor(future), rtol=0, atol=0)

    def test_tactical_planes_expose_liberties_and_candidate_capture_exactly(self) -> None:
        board = "X...." "..X.." ".XO.." "..X.." "....."
        capture = 2 * 5 + 3
        legal = "".join("1" if point == capture else "0" for point in range(25))
        planes = encode_tactical_state_planes(
            f"{board}|{legal}|0|0|0", 5)
        self.assertEqual(tuple(planes.shape), (16, 5, 5))
        self.assertEqual(int(planes[9, 0, 0]), 1)   # Black corner group: two liberties.
        self.assertEqual(int(planes[10, 2, 2]), 1)  # White group: one liberty.
        self.assertEqual(int(planes[12, 2, 3]), 1)  # Playing there captures it.
        self.assertEqual(int(planes[13, 2, 3]), 0)  # Exactly one captured stone.
        self.assertEqual(int(planes[14, 2, 3]), 0)  # Capture is not self-atari.

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

    def test_sequential_head_backwards_match_summed_objective(self) -> None:
        self.model.zero_grad(set_to_none=True)
        policy, branches = self.model.forward_proposal(self.inputs, self.behavior)
        value = self.model.forward_value(self.inputs, self.behavior)
        proposal_loss = 0.7 * (policy.square().mean() + branches.square().mean())
        value_loss = 1.3 * value.square().mean()
        (proposal_loss + value_loss).backward()
        expected = {
            name: None if parameter.grad is None else parameter.grad.detach().clone()
            for name, parameter in self.model.named_parameters()
        }

        self.model.zero_grad(set_to_none=True)
        policy, branches = self.model.forward_proposal(self.inputs, self.behavior)
        (0.7 * (policy.square().mean() + branches.square().mean())).backward()
        value = self.model.forward_value(self.inputs, self.behavior)
        (1.3 * value.square().mean()).backward()
        for name, parameter in self.model.named_parameters():
            actual = parameter.grad
            if expected[name] is None:
                self.assertIsNone(actual, f"unexpected gradient for {name}")
            else:
                self.assertIsNotNone(actual, f"missing gradient for {name}")
                torch.testing.assert_close(actual, expected[name], rtol=1e-6, atol=1e-7)

    def test_exact_actor_filter_applies_to_actor_and_ranking_rows(self) -> None:
        identity = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "profile": "small5",
            "teacherSha256": "teacher",
            "opponentOracle": "oracle",
            "split": "train",
        }

        def trajectory(episode: int, won: int) -> dict[str, object]:
            return {**identity, "kind": "trajectory", "episode": episode,
                    "values": [{"won": won, "score": 1, "remaining": 2}]}

        def actor(episode: int, elapsed: int, state: str, action: int) -> dict[str, object]:
            return {**identity, "kind": "actor", "example": {
                "episode": episode, "elapsed": elapsed, "state": state,
                "action": action,
            }}

        def proposal(episode: int, elapsed: int, state: str) -> dict[str, object]:
            value = {"state": state, "behavior": [0.0], "elapsed": elapsed + 1,
                     "won": 0.0, "score": 0.0, "remaining": 1.0, "weight": 1.0}
            return {**identity, "kind": "proposal", "example": {
                "episode": episode, "elapsed": elapsed, "state": state,
                "behavior": [0.0], "moves": [0, 1, 2], "best_move": 0,
            }, "distill": [value, value, value]}

        with tempfile.TemporaryDirectory() as directory:
            control = f"{directory}/control.jsonl.gz"
            exploration = f"{directory}/exploration.jsonl.gz"
            output = f"{directory}/selected.jsonl.gz"
            with gzip.open(control, "wt") as target:
                for row in (trajectory(1, 0), trajectory(2, 0)):
                    target.write(json.dumps(row) + "\n")
            with gzip.open(exploration, "wt") as target:
                rows = [
                    trajectory(1, 1), actor(1, 0, "one", 1), proposal(1, 0, "one"),
                    trajectory(2, 1), actor(2, 0, "two-a", 1),
                    proposal(2, 0, "two-a"), actor(2, 1, "two-b", 2),
                    proposal(2, 1, "two-b"),
                ]
                for row in rows:
                    target.write(json.dumps(row) + "\n")
            summary = select_self_routes(
                pathlib.Path(control), pathlib.Path(exploration), pathlib.Path(output),
                "win-flip", emit_rankings=True, exact_actors_per_episode=1,
                supervision_overlay=True)
            self.assertEqual(summary["selectedEpisodesBeforeActorFilter"], 2)
            self.assertEqual(summary["selectedEpisodes"], 1)
            self.assertEqual(summary["actorRecordsKept"], 1)
            self.assertEqual(summary["rankingRecords"], 1)
            with gzip.open(output, "rt") as source:
                rows = [json.loads(line) for line in source]
            self.assertEqual(
                [row["kind"] for row in rows], ["actor", "actor-ranking"])
            supervised = [row for row in rows
                          if row["kind"] in ("actor", "actor-ranking")]
            self.assertEqual([row["example"]["episode"] for row in supervised], [1, 1])

    def test_tail_scope_changes_only_last_block_and_heads(self) -> None:
        model = V9Net(
            V9Shape(extent=5, channels=4, blocks=3, hidden=8, tower=4, behavior=3),
            torch.device("cpu"), seed=445566)
        before = {name: parameter.detach().clone()
                  for name, parameter in model.named_parameters()}
        optimizer = configure_training_scope(
            model, learning_rate=0.01, weight_decay=0.1, train_tail_blocks=1)
        value, policy, branches = model(self.inputs, self.behavior)
        optimizer.zero_grad(set_to_none=True)
        (value.square().mean() + policy.square().mean()
         + branches.square().mean()).backward()
        optimizer.step()
        torch.testing.assert_close(model.stem, before["stem"], rtol=0, atol=0)
        for name in ("residual", "residual_bias", "conditioning_w", "conditioning_b"):
            parameter = getattr(model, name)
            torch.testing.assert_close(parameter[:2], before[name][:2], rtol=0, atol=0)
            self.assertFalse(torch.equal(parameter[2], before[name][2]))
        self.assertFalse(torch.equal(model.value_out_w, before["value_out_w"]))
        self.assertFalse(torch.equal(model.policy_w, before["policy_w"]))

    def test_pass_head_scope_freezes_every_other_parameter(self) -> None:
        model = V9Net(
            V9Shape(extent=5, channels=4, blocks=3, hidden=8, tower=4, behavior=3),
            torch.device("cpu"), seed=445566)
        configure_training_scope(
            model, learning_rate=0.01, weight_decay=0.1, pass_head_only=True)
        trainable = {name for name, parameter in model.named_parameters()
                     if parameter.requires_grad}
        self.assertEqual(trainable, {"pass_w", "pass_b"})

    def test_route_separation_is_initially_exact_and_blocks_cross_head_gradients(self) -> None:
        separated = RoutedV9Net(self.model, separate_blocks=1)
        with torch.no_grad():
            expected_value = self.model.forward_value(self.inputs, self.behavior)
            expected_policy, expected_branches = self.model.forward_proposal(
                self.inputs, self.behavior)
            torch.testing.assert_close(
                separated.forward_value(self.inputs, self.behavior), expected_value,
                rtol=0, atol=0)
            actual_policy, actual_branches = separated.forward_proposal(
                self.inputs, self.behavior)
            torch.testing.assert_close(actual_policy, expected_policy, rtol=0, atol=0)
            torch.testing.assert_close(actual_branches, expected_branches, rtol=0, atol=0)

        separated.zero_grad(set_to_none=True)
        separated.forward_policy(self.inputs, self.behavior).square().mean().backward()
        self.assertIsNotNone(separated.proposal_residual.grad)
        self.assertIsNone(separated.value_residual.grad)
        separated.zero_grad(set_to_none=True)
        separated.forward_value(self.inputs, self.behavior).square().mean().backward()
        self.assertIsNone(separated.proposal_residual.grad)
        self.assertIsNotNone(separated.value_residual.grad)

    def test_route_separation_cost_preserves_inference_convolution_count(self) -> None:
        shape = V9Shape(19, 48, 8, behavior=30)
        shared = deployed_cost(shape, 0)
        partial = deployed_cost(shape, 2)
        isolated = deployed_cost(shape, 8)
        self.assertEqual(shared["q8PayloadBytes"], 680_926)
        self.assertEqual(partial["q8PayloadBytes"], 768_478)
        self.assertEqual(isolated["q8PayloadBytes"], 1_034_878)
        self.assertEqual(partial["inferenceConvolutionCountChange"], 0)
        self.assertEqual(isolated["inferenceConvolutionCountChange"], 0)

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

    def test_external_teacher_routes_are_reserved_in_proposal_batches(self) -> None:
        def example(index: int, source: str) -> ProposalExample:
            return ProposalExample(
                index, "", [], 0, [0, 1], [1, 0], [0, 0],
                [[1.0] + [0.0] * 12] * 2, 0, [0], [], [], source)

        examples = ([example(index, "champion") for index in range(20)]
                    + [example(100 + index, "katago") for index in range(4)]
                    + [example(200 + index, "handcrafted") for index in range(4)])
        selected = stratified_proposals(
            examples, 16, 25, random.Random(918273),
            proposal_strata(examples, 25), proposal_source_strata(examples))
        self.assertGreaterEqual(sum(row.source == "katago" for row in selected), 4)
        self.assertGreaterEqual(sum(row.source == "handcrafted" for row in selected), 4)

    def test_each_fixed_teacher_reserves_sparse_pass_targets(self) -> None:
        def example(index: int, source: str, action: int) -> ProposalExample:
            return ProposalExample(
                index, "", [], 0, [0, 25],
                [1, 0] if action == 0 else [0, 1], [0, 0],
                [[1.0] + [0.0] * 12] * 2, action, [action], [], [], source)

        examples = [example(index, "champion", 0) for index in range(100)]
        for offset, source in ((100, "katago"), (200, "handcrafted")):
            examples.extend(example(offset + index, source, 0) for index in range(20))
            examples.append(example(offset + 99, source, 25))
        randomizer = random.Random(918273)
        selected = [row for _ in range(2_000) for row in stratified_proposals(
            examples, 40, 25, randomizer,
            proposal_strata(examples, 25), proposal_source_strata(examples),
            fixed_source_fraction=0.25, self_source_fraction=0)]
        for source in ("katago", "handcrafted"):
            source_rows = [row for row in selected if row.source == source]
            self.assertEqual(len(source_rows), 20_000)
            pass_rows = sum(25 in row.safe_moves for row in source_rows)
            self.assertLess(abs(pass_rows / len(source_rows) - 0.05), 0.005)

    def test_each_fixed_teacher_can_reserve_route_entrances(self) -> None:
        def example(index: int, source: str, elapsed: int, action: int = 0) \
                -> ProposalExample:
            return ProposalExample(
                index, "", [], elapsed, [0, 25],
                [1, 0] if action == 0 else [0, 1], [0, 0],
                [[1.0] + [0.0] * 12] * 2, action, [action], [], [], source)

        examples = [example(index, "champion", 1) for index in range(100)]
        for offset, source in ((100, "katago"), (200, "handcrafted")):
            examples.extend(example(offset + index, source, 0) for index in range(4))
            examples.extend(example(offset + 20 + index, source, 1) for index in range(16))
            examples.append(example(offset + 99, source, 1, 25))
        randomizer = random.Random(918273)
        selected = [row for _ in range(2_000) for row in stratified_proposals(
            examples, 40, 25, randomizer,
            proposal_strata(examples, 25), proposal_source_strata(examples),
            fixed_source_fraction=0.25, self_source_fraction=0,
            fixed_source_pass_fraction=0.05,
            fixed_source_opening_fraction=0.25)]
        for source in ("katago", "handcrafted"):
            source_rows = [row for row in selected if row.source == source]
            self.assertEqual(len(source_rows), 20_000)
            opening_rows = sum(row.elapsed == 0 for row in source_rows)
            pass_rows = sum(25 in row.safe_moves for row in source_rows)
            self.assertLess(abs(opening_rows / len(source_rows) - 0.25), 0.005)
            self.assertLess(abs(pass_rows / len(source_rows) - 0.05), 0.005)

    def test_proposal_strata_are_disjoint_when_pass_is_one_of_several_targets(self) -> None:
        pass_target = ProposalExample(
            1, "", [], 0, [0, 25], [1, 1], [0, 0],
            [[0.0] * 13] * 2, 0, [0, 25], [], [])
        bait = dataclasses.replace(
            pass_target, episode=2, targets=[1, 0], safe_moves=[0], bait_moves=[0])
        ordinary = dataclasses.replace(
            pass_target, episode=3, targets=[1, 0], safe_moves=[0])
        strata = proposal_strata([pass_target, bait, ordinary], 25)
        self.assertEqual([[row.episode for row in bucket] for bucket in strata],
                         [[1], [2], [3]])

    def test_external_teacher_action_only_competes_with_top_k_boundary(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 1, 3], [1, 0, 0], [0, 0, 0],
            [[0.0] * 13] * 3, 0, [0], [], [], "katago")
        policy = torch.tensor([[0.0, 2.0, -4.0, 1.0]], requires_grad=True)
        branches = torch.zeros((1, 4, 13), requires_grad=True)
        loss = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=1, shortlist_k=1, anchor_weight=1)
        loss.backward()
        self.assertLess(policy.grad[0, 0].item(), 0)
        self.assertGreater(policy.grad[0, 1].item(), 0)
        self.assertEqual(policy.grad[0, 2].item(), 0)
        self.assertGreater(policy.grad[0, 3].item(), 0)

    def test_exact_actor_distillation_orders_the_executed_move(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 1, 2], [1, 0, 1], [0, 0, 0],
            [[0.0] * 13] * 3, 0, [0, 2], [], [], "katago")
        policy = torch.tensor([[0.0, 1.0, 2.0, -4.0]], requires_grad=True)
        branches = torch.zeros((1, 4, 13), requires_grad=True)
        loss = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=0, anchor_weight=0, branch_weight=0,
            exact_actor_source="katago")
        expected = F.cross_entropy(policy[:, :3], torch.tensor([0]))
        torch.testing.assert_close(loss, expected)
        loss.backward()
        self.assertLess(policy.grad[0, 0].item(), 0)
        self.assertGreater(policy.grad[0, 1].item(), 0)
        self.assertGreater(policy.grad[0, 2].item(), 0)
        self.assertEqual(policy.grad[0, 3].item(), 0)

    def test_exact_actor_source_partitions_replay_cache(self) -> None:
        shape = V9Shape(19, 24, 6, 64, 32, 30)
        ordinary = replay_metadata([], "daemon19", "teacher", shape, 1, 1, 1, 1, 7)
        exact = replay_metadata(
            [], "daemon19", "teacher", shape, 1, 1, 1, 1, 7, "katago")
        self.assertIsNone(ordinary["exactActorSource"])
        self.assertEqual(exact["exactActorSource"], "katago")

    def test_external_teacher_boundary_gradient_is_tunable(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 1, 2], [1, 0, 0], [0, 0, 0],
            [[0.0] * 13] * 3, 0, [0], [], [], "katago")

        def gradient(weight: float) -> float:
            policy = torch.tensor([[0.0, 2.0, 1.0]], requires_grad=True)
            branches = torch.zeros((1, 3, 13), requires_grad=True)
            proposal_objective(
                policy, branches, [example], torch.device("cpu"),
                margin_weight=1, shortlist_k=1, anchor_weight=0,
                actor_boundary_gradient_weight=weight).backward()
            return policy.grad[0, 1].item()

        self.assertEqual(gradient(0), 0)
        self.assertGreater(gradient(1), 0)

    def test_sparse_external_teacher_without_top_k_boundary_stays_finite(self) -> None:
        # A one-action adviser row has fewer outsiders than a four-move
        # shortlist. Its missing boundary used to be -inf, and the tunable
        # boundary expression turned -inf - -inf into NaN before masking.
        example = ProposalExample(
            1, "", [], 0, [0], [1], [0],
            [[0.0] * 13], 0, [0], [], [], "katago")
        policy = torch.tensor([[0.0, -1.0, -2.0, -3.0]], requires_grad=True)
        branches = torch.zeros((1, 4, 13), requires_grad=True)
        loss = proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=1, shortlist_k=4, anchor_weight=0,
            actor_boundary_gradient_weight=1)
        self.assertTrue(torch.isfinite(loss).item())
        loss.backward()
        self.assertTrue(torch.isfinite(policy.grad).all().item())
        self.assertTrue(torch.isfinite(branches.grad).all().item())

    def test_external_teacher_pass_positive_is_not_penalized(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 3], [0, 1], [0, 0],
            [[0.0] * 13] * 2, 3, [3], [], [], "katago")
        policy = torch.tensor([[0.0, -4.0, -4.0, 0.0]], requires_grad=True)
        branches = torch.zeros((1, 4, 13), requires_grad=True)
        proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=0, anchor_weight=0).backward()
        self.assertLess(policy.grad[0, 3].item(), 0)

    def test_external_nonpass_evidence_scales_the_global_pass_negative(self) -> None:
        example = ProposalExample(
            1, "", [], 0, [0, 3], [1, 0], [0, 0],
            [[0.0] * 13] * 2, 0, [0], [], [], "katago")

        def pass_gradient(weight: float) -> float:
            policy = torch.zeros((1, 4), requires_grad=True)
            branches = torch.zeros((1, 4, 13), requires_grad=True)
            proposal_objective(
                policy, branches, [example], torch.device("cpu"),
                margin_weight=0, anchor_weight=0,
                actor_pass_negative_weight=weight).backward()
            return policy.grad[0, 3].item()

        self.assertAlmostEqual(pass_gradient(0), 0)
        self.assertAlmostEqual(pass_gradient(0.05), 0.05 * pass_gradient(1), places=7)

    def test_external_teacher_outcomes_are_balanced_against_champion(self) -> None:
        examples = [
            ValueExample("", [], 0, 0, 0, 1, 1, source)
            for source, count in (("champion", 100), ("katago", 4), ("handcrafted", 8))
            for _ in range(count)
        ]
        selected = stratified_values(
            examples, 30, random.Random(918273), "uniform")
        counts = {source: sum(row.source == source for row in selected)
                  for source in ("champion", "katago", "handcrafted")}
        self.assertEqual(sum(counts[source] for source in ("katago", "handcrafted")), 15)
        self.assertEqual(counts["champion"], 15)
        self.assertEqual(
            abs(counts["katago"] - counts["handcrafted"]), 1)

    def test_fixed_teacher_batch_share_is_tunable_and_zero_is_exact(self) -> None:
        examples = [
            ValueExample("", [], 0, 0, 0, 1, 1, source)
            for source, count in (("champion", 100), ("katago", 4), ("handcrafted", 4))
            for _ in range(count)
        ]
        selected = stratified_values(
            examples, 20, random.Random(918273), "uniform",
            fixed_source_fraction=0.05)
        self.assertEqual(
            {source: sum(row.source == source for row in selected)
             for source in ("champion", "katago", "handcrafted")},
            {"champion": 18, "katago": 1, "handcrafted": 1})
        selected = stratified_values(
            examples, 20, random.Random(918273), "uniform",
            fixed_source_fraction=0)
        self.assertTrue(all(row.source == "champion" for row in selected))

    def test_target_exploration_uses_only_exhaustive_positive_moves(self) -> None:
        examples = [ProposalExample(
            row, "", [], 0, [2, 4, 6], [0, 1, 1], [0, 0, 0],
            [[1.0] + [0.0] * 12] * 3, 4, [4], [6], [])
            for row in range(32)]
        explored = target_exploration_actions(
            [0] * len(examples), examples, 1, random.Random(918273))
        self.assertTrue(all(action in (1, 2) for action in explored))
        self.assertEqual(
            target_exploration_actions([0] * len(examples), examples, 0,
                                       random.Random(918273)),
            [0] * len(examples))

    def test_any_self_intervention_owns_the_route_outcome(self) -> None:
        self.assertEqual(trajectory_outcome_source({"champion"}), "champion")
        self.assertEqual(trajectory_outcome_source({"self"}), "self")
        self.assertEqual(
            trajectory_outcome_source({"champion", "self"}), "self")

    def test_broad_exploration_uses_low_regret_non_targets(self) -> None:
        examples = [ProposalExample(
            row, "", [], 0, list(range(8)), [1, 1, 1, 1, 0, 0, 0, 0],
            [float(index) for index in range(8)],
            [[1.0] + [0.0] * 12] * 8, 0, [0], [1, 2, 3], [])
            for row in range(32)]
        explored = target_exploration_actions(
            [0] * len(examples), examples, 0, random.Random(918273),
            broad_fraction=1, broad_pool=6)
        self.assertTrue(all(action in (4, 5) for action in explored))

    def test_exhaustive_actor_bypasses_policy_and_values_every_candidate(self) -> None:
        state_text = "." * 25 + "|" + "1" * 25 + "|0|0|0"
        state = State(0, 0, 0, 0, [0.0, 0.0, 0.0], [-1.0, -1.0, -1.0], state_text, [
            Candidate(0, True, [Reply(1.0, 0, state_text, 0.0, 2.0)]),
            Candidate(1, False, [Reply(1.0, 0, state_text, 1.0, 2.0)]),
        ])

        def forbidden_policy(*_args: object) -> torch.Tensor:
            raise AssertionError("exhaustive actor consulted the policy head")

        self.model.forward_policy = forbidden_policy  # type: ignore[method-assign]
        actions = v9_actor_actions(
            self.model, [state], torch.device("cpu"), top_k=1,
            inference_batch=8, exhaustive=True)
        self.assertEqual(actions, [1])

    def test_actor_shortlist_matches_deployment_expansion_and_ties(self) -> None:
        moves = list(range(10))
        flat = torch.tensor([10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.8, 0.0])
        self.assertEqual(v9_shortlist(flat, moves, 8), list(range(10)))
        steep = flat.clone()
        steep[8] = 2.7
        self.assertEqual(v9_shortlist(steep, moves, 8), list(range(8)))
        tied = torch.tensor([1.0, 1.0, 0.0])
        self.assertEqual(v9_shortlist(tied, [1, 0, 2], 1), [0])

    def test_actor_authority_metrics_use_the_adaptive_deployment_set(self) -> None:
        moves = list(range(10))
        example = ProposalExample(
            0, "", [], 0, moves, [0.0] * 8 + [1.0, 0.0],
            [1.0] * 8 + [0.0, 1.0], [[0.0] * 13 for _ in moves],
            8, [8], [], [])
        logits = torch.tensor([10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.8, 0.0])
        evaluated = {id(example): logits}
        hard = shortlist_metrics(
            self.model, [example], torch.device("cpu"), 8, evaluated=evaluated)
        deployed = shortlist_metrics(
            self.model, [example], torch.device("cpu"), 8,
            evaluated=evaluated, adaptive=True)
        self.assertEqual(hard["topKRecall"], 0)
        self.assertEqual(deployed["topKRecall"], 1)

    def test_shortlist_metrics_report_false_pass_inclusion(self) -> None:
        example = ProposalExample(
            0, "", [], 0, [0, 25], [1.0, 0.0], [0.0, 0.0],
            [[0.0] * 13, [0.0] * 13], 0, [0], [], [])
        logits = torch.zeros(26)
        logits[25] = 1
        result = shortlist_metrics(
            self.model, [example], torch.device("cpu"), 1,
            evaluated={id(example): logits})
        self.assertEqual(result["nonPassPositions"], 1)
        self.assertEqual(result["passFalseInclusionRate"], 1)

    def test_terminal_actor_replies_bypass_value_inference(self) -> None:
        state_text = "." * 25 + "|" + "1" * 25 + "|1|0|0"
        state = State(0, 0, 0, 7, [0.0, 0.0, 0.0], [-1.0, -1.0, -1.0], state_text, [
            Candidate(0, True, [Reply(1.0, 12, state_text, 1.0, 4.0)]),
            Candidate(1, True, [Reply(1.0, 12, state_text, 0.0, 20.0)]),
        ])

        def policy(*_args: object) -> torch.Tensor:
            result = torch.full((1, 26), -20.0)
            result[0, 0] = 20.0
            return result

        def forbidden_value(*_args: object) -> torch.Tensor:
            raise AssertionError("terminal actor reply reached value inference")

        self.model.forward_policy = policy  # type: ignore[method-assign]
        self.model.forward_value = forbidden_value  # type: ignore[method-assign]
        actions = v9_actor_actions(
            self.model, [state], torch.device("cpu"), top_k=1, inference_batch=8)
        self.assertEqual(actions, [0])

    def test_actor_exact_value_ties_use_candidate_scan_order(self) -> None:
        state_text = "." * 25 + "|" + "1" * 25 + "|1|0|0"
        state = State(0, 0, 0, 0, [0.0, 0.0, 0.0], [-1.0, -1.0, -1.0], state_text, [
            Candidate(0, True, [Reply(1.0, 12, state_text, 1.0, 4.0)]),
            Candidate(1, True, [Reply(1.0, 12, state_text, 1.0, 4.0)]),
        ])

        def reverse_policy(*_args: object) -> torch.Tensor:
            result = torch.full((1, 26), -20.0)
            result[0, 1] = 20.0
            result[0, 0] = 19.9
            return result

        self.model.forward_policy = reverse_policy  # type: ignore[method-assign]
        actions = v9_actor_actions(
            self.model, [state], torch.device("cpu"), top_k=2, inference_batch=8)
        self.assertEqual(actions, [0])

    def test_exhaustive_actor_requires_identity_and_parity_not_recall(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            model_path = f"{directory}/actor.model"
            summary_path = f"{directory}/summary.json"
            contents = b"research checkpoint"
            with open(model_path, "wb") as output:
                output.write(contents)
            summary = {
                "profile": "daemon19",
                "modelSha256": hashlib.sha256(contents).hexdigest(),
                "cppParityRelativeError": 1e-6,
                "shortlistDataAllowed": False,
            }
            with open(summary_path, "w") as output:
                json.dump(summary, output)
            validate_exhaustive_actor(summary_path, model_path, "daemon19")
            summary["cppParityRelativeError"] = 3e-4
            with open(summary_path, "w") as output:
                json.dump(summary, output)
            with self.assertRaisesRegex(RuntimeError, "parity"):
                validate_exhaustive_actor(summary_path, model_path, "daemon19")

    def test_monte_carlo_and_distillation_value_weights_are_independent(self) -> None:
        state = "." * 25 + "|" + "1" * 25 + "|0|0|0"
        monte_carlo = ValueExample(state, [0.1, 0.2, 0.3], 4, 0.0, 9.0, 5.0, 1.0)
        distilled = DistillExample(state, [0.1, 0.2, 0.3], 4, 1.0, 3.0, 2.0, 1.0)
        inputs = set_elapsed(encode_states([state], 5, torch.device("cpu")), [4], 5)
        behavior = torch.tensor([[0.1, 0.2, 0.3]])
        with torch.no_grad():
            raw = self.model.forward_value(inputs, behavior)[0]
            expected_mc = torch.square(F.softplus(raw[1]) - torch.log1p(torch.tensor(9.0)))
            expected_distill = F.binary_cross_entropy_with_logits(
                raw[0], torch.tensor(1.0))
        optimizer = torch.optim.SGD(self.model.parameters(), lr=0)
        _, mc_loss, distill_loss, _ = train_updates(
            self.model, optimizer, [], [monte_carlo], [distilled], [],
            updates=1, batch_size=1, device=torch.device("cpu"),
            randomizer=random.Random(918273), distill_weight=1,
            value_sampling="uniform", proposal_weight=0,
            proposal_margin_weight=0, proposal_anchor_weight=0,
            proposal_shortlist_k=1, mc_value_weight=1,
            mc_value_loss_weights=(0, 1, 0),
            distill_value_loss_weights=(1, 0, 0),
            ranking_weight=0, ranking_batch_size=1)
        self.assertAlmostEqual(mc_loss, float(expected_mc), places=6)
        self.assertAlmostEqual(distill_loss, float(expected_distill), places=6)

    def test_detailed_timing_preserves_optimizer_step_bit_exactly(self) -> None:
        shape = V9Shape(extent=5, channels=4, blocks=1, hidden=8, tower=4, behavior=3)
        plain = V9Net(shape, torch.device("cpu"), seed=445566)
        profiled = V9Net(shape, torch.device("cpu"), seed=445566)
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        example = ProposalExample(
            1, state, [0.1, 0.2, 0.3], 0, [0, 25], [1.0, 0.0], [0.0, 1.0],
            [[1.0] + [0.0] * 12, [0.0, 1.0] + [0.0] * 11],
            0, [0], [], [])

        def step(model: V9Net, timings: PhaseTimings | None) -> None:
            train_updates(
                model, configure_training_scope(model, 1e-4, 1e-6),
                collections.deque([example]), collections.deque(),
                collections.deque(), collections.deque(), updates=1, batch_size=1,
                device=torch.device("cpu"), randomizer=random.Random(778899),
                distill_weight=0, value_sampling="uniform", proposal_weight=1,
                proposal_margin_weight=0.25, proposal_anchor_weight=0.5,
                proposal_shortlist_k=1, mc_value_weight=0,
                mc_value_loss_weights=(1, 1, 1),
                distill_value_loss_weights=(1, 1, 1), ranking_weight=0,
                ranking_batch_size=1, timings=timings)

        step(plain, None)
        timing = PhaseTimings()
        step(profiled, timing)
        for left, right in zip(plain.parameters(), profiled.parameters(), strict=True):
            torch.testing.assert_close(left, right, rtol=0, atol=0)
        self.assertGreater(timing.seconds["branchHeadForward"], 0)
        self.assertGreater(timing.seconds["backpropagation"], 0)

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

    def test_branch_inverse_frequency_balances_modal_classes(self) -> None:
        labels = [0, 0, 0, 1]
        example = ProposalExample(
            1, "", [], 0, list(range(4)), [1, 0, 0, 0], [0.0] * 4,
            [[1.0 if branch == label else 0.0 for branch in range(13)]
             for label in labels],
            0, [0], [], [])
        policy = torch.zeros((1, 4))
        branches = torch.zeros((1, 4, 13), requires_grad=True)
        proposal_objective(
            policy, branches, [example], torch.device("cpu"),
            margin_weight=0, anchor_weight=0, branch_weight=1).backward()
        torch.testing.assert_close(
            branches.grad[0, :3, 0].sum(), branches.grad[0, 3, 1],
            rtol=0, atol=1e-7)

    def test_ranking_uses_power_per_turn_only_inside_equal_win_group(self) -> None:
        proposal = ProposalExample(
            1, "", [], 2, [0, 1], [1, 0], [0, 0],
            [[0.0] * 13] * 2, 0, [0], [], [])
        tied = DistillExample("", [], 3, 0.5, 0, 1, 1)
        decoded = torch.tensor(
            [[0.4, 6.0, 3.0], [0.4, 6.0, 3.0]], requires_grad=True)
        candidate_ranking_objective(
            decoded, [RankingExample(proposal, [[tied], [tied]])],
            torch.device("cpu")).backward()
        torch.testing.assert_close(decoded.grad[:, 0], torch.zeros(2), rtol=0, atol=1e-7)
        self.assertLess(decoded.grad[0, 1].item(), 0)
        self.assertGreater(decoded.grad[0, 2].item(), 0)
        self.assertGreater(decoded.grad[1, 1].item(), 0)
        self.assertLess(decoded.grad[1, 2].item(), 0)

    def test_ranking_quadratic_win_order_does_not_use_efficiency_across_win_groups(self) -> None:
        proposal = ProposalExample(
            1, "", [], 2, [0, 1], [1, 0], [0, 0],
            [[0.0] * 13] * 2, 0, [0], [], [])
        best = DistillExample("", [], 3, 1.0, 0, 1, 1)
        worse = dataclasses.replace(best, won=0.0)
        decoded = torch.tensor(
            [[0.4, 1.0, 8.0], [0.4, 100.0, 1.0]], requires_grad=True)
        candidate_ranking_objective(
            decoded, [RankingExample(proposal, [[best], [worse]])],
            torch.device("cpu")).backward()
        self.assertLess(decoded.grad[0, 0].item(), 0)
        self.assertGreater(decoded.grad[1, 0].item(), 0)
        torch.testing.assert_close(decoded.grad[:, 1:], torch.zeros((2, 2)), rtol=0, atol=0)

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
    def test_compression_ignores_actor_and_trajectory_records(self) -> None:
        branches = [[1.0, *([0.0] * 12)]]

        def proposal(episode: int) -> ProposalExample:
            return ProposalExample(
                episode, "." * 25 + "|" + "1" * 25 + "|0|0|0",
                [0.0] * 31, 0, [0], [1.0], [0.0], branches,
                0, [0], [], [], "champion")

        value = DistillExample(
            "." * 25 + "|" + "1" * 25 + "|0|0|0",
            [0.0] * 31, 1, 1.0, 2.0, 3.0, 1.0)
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/mixed.jsonl.gz"
            records = [
                corpus_record("small5", "teacher", proposal(1), [value]),
                actor_corpus_record("small5", "teacher", proposal(1), 0, "self"),
                trajectory_corpus_record("small5", "teacher", 1, [
                    ValueExample(value.state, value.behavior, value.elapsed,
                                 value.won, value.score, value.remaining,
                                 value.weight, "self")]),
                corpus_record("small5", "teacher", proposal(0), [value]),
            ]
            with gzip.open(path, "wt") as target:
                for record in records:
                    target.write(json.dumps(record) + "\n")
            training, heldout, training_values, heldout_values = load_knowledge(
                [path], 0, 123)
        self.assertEqual((len(training), len(heldout)), (1, 1))
        self.assertEqual((len(training_values), len(heldout_values)), (1, 1))

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
    def test_cache_identity_includes_monte_carlo_reservoir_limit(self) -> None:
        shape = V9Shape(5, 4, 1, behavior=3)
        first = replay_metadata([], "small5", "abc", shape, 10, 20, 30, 40, 50)
        second = replay_metadata([], "small5", "abc", shape, 10, 21, 30, 40, 50)
        self.assertNotEqual(first, second)
        self.assertEqual(first["valueReplay"], 20)

    def test_tactical_replay_cache_validates_declared_input_planes(self) -> None:
        shape = V9Shape(5, 16, 4, 32, 8, 31, 16, 16)
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        proposal = ProposalExample(
            1, state, [0.0] * 31, 0, [0], [1.0], [0.0],
            [[1.0] + [0.0] * 12], 0, [0], [], [])
        metadata = {"test": "tactical-replay-v1"}
        with tempfile.TemporaryDirectory() as directory:
            prepared, first = prepare_replay(
                [proposal], [], [], [], [], shape, metadata, directory)
            cached, second = prepare_replay(
                [proposal], [], [], [], [], shape, metadata, directory)
        self.assertEqual(tuple(prepared.state_planes.shape), (1, 16, 5, 5))
        self.assertFalse(first["hit"])
        self.assertTrue(second["hit"])
        self.assertEqual(tuple(cached.state_planes.shape), (1, 16, 5, 5))

    def test_actor_augmentation_preserves_asymmetric_blocker_geometry(self) -> None:
        blocker_rows = (
            "#####...........###", "####..........#####", "##..............###",
            "#................##", "......###......####", ".......###.......##",
            "........##........#", "..............#####", "...................",
            "..####.............", "...................", "..............#####",
            "........##........#", ".......###.......##", "......###......####",
            "#................##", "##..............###", "####..........#####",
            "#####...........###",
        )
        board = "".join(blocker_rows)
        legal = "".join("0" if cell == "#" else "1" for cell in board)
        example = ProposalExample(
            1, f"{board}|{legal}|0|0|0", [0.0] * 30, 0,
            [5, 19 * 19], [1.0, 1.0], [0.0, 0.0],
            [[0.0] * 13, [0.0] * 13], 5, [5, 19 * 19], [], [], "katago")
        augmented = valid_actor_symmetries(example)
        exhaustive = []
        for symmetry in range(8):
            transformed = transform_actor_symmetry(example, symmetry)
            transformed_board = transformed.state.split("|", maxsplit=1)[0]
            if "".join("#" if cell == "#" else "." for cell in transformed_board) \
                    == board:
                exhaustive.append(transformed)
        self.assertEqual(augmented, exhaustive)
        self.assertEqual(len(augmented), 2)
        for transformed in augmented:
            transformed_board = transformed.state.split("|", maxsplit=1)[0]
            self.assertEqual(
                "".join("#" if cell == "#" else "." for cell in transformed_board),
                board)
            self.assertIn(19 * 19, transformed.safe_moves)

    def test_mixed_corpus_replays_training_trajectories_only(self) -> None:
        proposal = ProposalExample(
            10, "state", [0.0], 2, [0], [1.0], [0.0],
            [[1.0] + [0.0] * 12], 0, [0], [], [])
        training = ValueExample(
            "reply", [0.0], 3, 1.0, 4.0, 5.0, 0.5, "handcrafted",
            "environment-rollout:handcrafted-continuation-v1", 8.0)
        heldout = ValueExample("heldout", [0.0], 3, 0.0, 1.0, 5.0, 0.5)
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/mixed.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for record in (
                    corpus_record("small5", "abc", proposal, []),
                    {
                        "schema": "bitburner-go-exhaustive-proposals-v9.5",
                        "kind": "actor", "profile": "small5",
                        "teacherSha256": "abc",
                        "opponentOracle": "bitburner-go-ai-v3.0.1",
                        "split": "train",
                        "example": {
                            "episode": 2,
                            "state": f"{'.' * 25}|{'1' * 25}|0|0|0",
                            "behavior": [0.0],
                            "elapsed": 1, "moves": [0, 25], "action": 25,
                            "actions": [25, 0],
                            "source": "katago",
                        },
                    },
                    trajectory_corpus_record(
                        "small5", "abc", 1, [training],
                        {"exhaustiveActorSha256": "research"}),
                    trajectory_corpus_record("small5", "abc", 10, [heldout]),
                ):
                    output.write(json.dumps(record) + "\n")
            proposals, heldout_proposals, values, distill, rankings, \
                heldout_rankings = load_corpora(
                [path], "small5", "abc")
        self.assertEqual(len(proposals), 8)
        self.assertTrue(all(proposal.source == "katago" for proposal in proposals))
        self.assertTrue(all(proposal.best_move == 25 for proposal in proposals))
        self.assertEqual({proposal.safe_moves[1] for proposal in proposals}, {0, 4, 20, 24})
        self.assertTrue(all(proposal.targets == [1.0, 1.0] for proposal in proposals))
        self.assertEqual(len(heldout_proposals), 1)
        self.assertEqual(list(values), [training])
        self.assertEqual(len(distill), 0)
        self.assertEqual(len(rankings), 0)
        self.assertEqual(len(heldout_rankings), 0)

    def test_certified_actor_authority_is_distinct_from_handcrafted(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        base = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor", "profile": "small5", "teacherSha256": "abc",
            "opponentOracle": "bitburner-go-ai-v3.0.1", "split": "train",
            "example": {
                "episode": 1, "state": state, "behavior": [0.0],
                "elapsed": 0, "moves": [0, 25], "action": 0,
                "actions": [0], "source": "handcrafted",
            },
            "generation": {
                "source": "certified-playbook",
                "authority": "replay-validated-and-or-certificate-v6",
                "certifiedAllWhiteOutcomesWin": True,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/certified.jsonl.gz"
            with gzip.open(path, "wt") as output:
                output.write(json.dumps(base) + "\n")
            certified, *_ = load_corpora(
                [path], "small5", "abc",
                exact_actor_source="certified-playbook")
            handcrafted, *_ = load_corpora(
                [path], "small5", "abc", exact_actor_source="handcrafted")
            with gzip.open(path, "wt") as output:
                output.write(json.dumps({
                    **base,
                    "generation": {**base["generation"],
                                   "certifiedAllWhiteOutcomesWin": False},
                }) + "\n")
            with self.assertRaisesRegex(RuntimeError, "malformed certified actor"):
                load_corpora([path], "small5", "abc")
        self.assertEqual(len(certified), 1)
        self.assertEqual(certified[0].source, "certified-playbook")
        self.assertEqual(certified[0].opponent, "")
        self.assertEqual(len(handcrafted), 0)

    def test_certified_actor_replay_can_balance_opponents(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        base = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor", "profile": "small5", "teacherSha256": "abc",
            "opponentOracle": "bitburner-go-ai-v3.0.1", "split": "train",
            "example": {
                "episode": 1, "state": state, "behavior": [0.0],
                "elapsed": 0, "moves": [0, 25], "action": 0,
                "actions": [0], "source": "handcrafted",
            },
            "generation": {
                "source": "certified-playbook",
                "authority": "replay-validated-and-or-certificate-v6",
                "certifiedAllWhiteOutcomesWin": True,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/certified.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for opponent, count in (("Netburners", 12), ("Slum Snakes", 3)):
                    for elapsed in range(count):
                        output.write(json.dumps({
                            **base,
                            "example": {**base["example"], "elapsed": elapsed},
                            "generation": {**base["generation"], "opponent": opponent},
                        }) + "\n")
            proposals, *_ = load_corpora(
                [path], "small5", "abc", proposal_limit=4,
                exact_actor_source="certified-playbook",
                balance_actor_opponents=True)
        self.assertEqual(collections.Counter(
            proposal.opponent for proposal in proposals),
            {"Netburners": 2, "Slum Snakes": 2})

    def test_actor_ranking_loads_only_as_relative_value_supervision(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        selected = {
            "state": state, "behavior": [0.0], "elapsed": 4,
            "won": 1.0, "score": 0.0, "remaining": 1.0, "weight": 1.0,
        }
        alternative = {
            **selected, "state": f"X{'.' * 24}|{'1' * 25}|0|1|0", "won": 0.0,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/ranking.jsonl.gz"
            record = {
                "schema": "bitburner-go-exhaustive-proposals-v9.5",
                "kind": "actor-ranking", "profile": "small5",
                "teacherSha256": "abc",
                "opponentOracle": "bitburner-go-ai-v3.0.1",
                "split": "train",
                "example": {
                    "episode": 3, "state": state, "behavior": [0.0],
                    "elapsed": 3, "moves": [25, 0], "bestMove": 25,
                    "source": "handcrafted",
                    "candidates": [[selected], [alternative]],
                },
            }
            with gzip.open(path, "wt") as output:
                output.write(json.dumps(record) + "\n")
                output.write(json.dumps({
                    **record, "split": "heldout",
                    "example": {
                        **record["example"], "episode": 10,
                        "candidates": [
                            [{**selected, "state": "heldout-selected"}],
                            [{**alternative, "state": "heldout-alternative"}],
                        ],
                    },
                }) + "\n")
            proposals, heldout, values, distill, rankings, \
                heldout_rankings = load_corpora(
                [path], "small5", "abc")
        self.assertEqual(len(proposals), 0)
        self.assertEqual(len(heldout), 0)
        self.assertEqual(len(values), 0)
        self.assertEqual(len(distill), 0)
        self.assertEqual(len(rankings), 1)
        self.assertEqual(len(heldout_rankings), 1)
        ranking = rankings[0]
        self.assertEqual(ranking.proposal.source, "handcrafted")
        self.assertEqual(ranking.proposal.best_move, 25)
        self.assertEqual([len(group) for group in ranking.candidates], [1, 1])
        self.assertEqual(ranking.candidates[0][0].won, 1.0)
        self.assertEqual(ranking.candidates[1][0].won, 0.0)
        self.assertEqual(heldout_rankings[0].proposal.episode, 10)

    def test_loader_rejects_value_inputs_shared_across_splits(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        candidate = {
            "state": state, "behavior": [0.1], "elapsed": 1,
            "won": 1.0, "score": 0.0, "remaining": 1.0, "weight": 1.0,
        }
        base = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor-ranking", "profile": "small5",
            "teacherSha256": "abc",
            "opponentOracle": "bitburner-go-ai-v3.0.1",
            "example": {
                "state": state, "behavior": [0.0], "elapsed": 0,
                "moves": [0], "bestMove": 0, "source": "katago",
                "candidates": [[candidate]],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/leak.jsonl.gz"
            with gzip.open(path, "wt") as output:
                output.write(json.dumps({
                    **base, "split": "train",
                    "example": {**base["example"], "episode": 1},
                }) + "\n")
                output.write(json.dumps({
                    **base, "split": "heldout",
                    "example": {
                        **base["example"], "episode": 10,
                        "candidates": [[{
                            **candidate, "behavior": [0.10000000149011612],
                        }]],
                    },
                }) + "\n")
            with self.assertRaisesRegex(RuntimeError, "1 value inputs"):
                load_corpora([path], "small5", "abc")

    def test_sparse_actor_rankings_cannot_be_evicted_by_champion_replay(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        proposal = ProposalExample(
            1, state, [0.0], 0, [0], [1.0], [0.0],
            [[1.0] + [0.0] * 12], 0, [0], [], [])
        value = DistillExample(state, [0.0], 1, 1.0, 1.0, 1.0, 1.0)
        actor = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor-ranking", "profile": "small5",
            "teacherSha256": "abc", "opponentOracle": "bitburner-go-ai-v3.0.1",
            "split": "train",
            "example": {
                "episode": 3, "state": state, "behavior": [0.0], "elapsed": 0,
                "moves": [0, 25], "bestMove": 0, "source": "katago",
                "candidates": [
                    [dataclasses.asdict(value)],
                    [dataclasses.asdict(dataclasses.replace(value, won=0.0))],
                ],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/rankings.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for episode in [*range(1, 10), 11]:
                    champion = dataclasses.replace(proposal, episode=episode)
                    output.write(json.dumps(corpus_record(
                        "small5", "abc", champion, [value])) + "\n")
                output.write(json.dumps(actor) + "\n")
            *_, rankings, heldout_rankings = load_corpora(
                [path], "small5", "abc", ranking_limit=4, seed=123)
        sources = collections.Counter(value.proposal.source for value in rankings)
        self.assertEqual(sources["champion"], 3)
        self.assertEqual(sources["katago"], 1)
        self.assertEqual(len(rankings), 4)
        self.assertEqual(len(heldout_rankings), 0)

    def test_actor_rankings_borrow_unused_champion_replay_capacity(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        selected = {
            "state": state, "behavior": [0.0], "elapsed": 1,
            "won": 1.0, "score": 0.0, "remaining": 1.0, "weight": 1.0,
        }
        record = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor-ranking", "profile": "small5",
            "teacherSha256": "abc", "opponentOracle": "bitburner-go-ai-v3.0.1",
            "split": "train",
            "example": {
                "state": state, "behavior": [0.0], "elapsed": 0,
                "moves": [0], "bestMove": 0, "source": "handcrafted",
                "candidates": [[selected]],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/actor-rankings.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for episode in range(6):
                    output.write(json.dumps({
                        **record,
                        "example": {**record["example"], "episode": episode},
                    }) + "\n")
            *_, rankings, heldout_rankings = load_corpora(
                [path], "small5", "abc", ranking_limit=4, seed=123)
        self.assertEqual(len(rankings), 4)
        self.assertTrue(all(
            value.proposal.source == "handcrafted" for value in rankings))
        self.assertEqual(len(heldout_rankings), 0)

    def test_counterfactual_rankings_have_an_order_independent_reservation(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        selected = {
            "state": state, "behavior": [0.0], "elapsed": 1,
            "won": 1.0, "score": 0.0, "remaining": 1.0, "weight": 1.0,
        }
        record = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor-ranking", "profile": "small5",
            "teacherSha256": "abc", "opponentOracle": "bitburner-go-ai-v3.0.1",
            "split": "train",
            "example": {
                "state": state, "behavior": [0.0], "elapsed": 0,
                "moves": [0], "bestMove": 0,
                "candidates": [[selected]],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/counterfactual-rankings.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for episode in range(20):
                    source = "katago" if episode < 10 else "handcrafted"
                    output.write(json.dumps({
                        **record,
                        "example": {**record["example"], "episode": episode,
                                    "source": source},
                    }) + "\n")
                # Deliberately last: the old final prefix slice erased it.
                output.write(json.dumps({
                    **record,
                    "example": {**record["example"], "episode": 21,
                                "source": "counterfactual"},
                }) + "\n")
            *_, rankings, _ = load_corpora(
                [path], "small5", "abc", ranking_limit=10, seed=123)
        sources = collections.Counter(value.proposal.source for value in rankings)
        self.assertEqual(len(rankings), 10)
        self.assertEqual(sources["counterfactual"], 1)

    def test_exact_ranking_source_filters_training_and_heldout_authority(self) -> None:
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        candidate = {
            "state": state, "behavior": [0.0], "elapsed": 1,
            "won": 1.0, "score": 0.0, "remaining": 1.0, "weight": 1.0,
        }
        template = {
            "schema": "bitburner-go-exhaustive-proposals-v9.5",
            "kind": "actor-ranking", "profile": "small5",
            "teacherSha256": "abc", "opponentOracle": "bitburner-go-ai-v3.0.1",
            "example": {"state": state, "behavior": [0.0], "elapsed": 0,
                        "moves": [0], "bestMove": 0,
                        "candidates": [[candidate]]},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/exact-rankings.jsonl.gz"
            with gzip.open(path, "wt") as output:
                for episode, source, split in (
                        (1, "katago", "train"),
                        (2, "counterfactual", "train"),
                        (3, "handcrafted", "heldout"),
                        (4, "counterfactual", "heldout")):
                    output.write(json.dumps({
                        **template, "split": split,
                        "example": {**template["example"], "episode": episode,
                                    "source": source,
                                    "candidates": [[{**candidate,
                                                     "elapsed": episode + 1}]]},
                    }) + "\n")
            *_, rankings, heldout = load_corpora(
                [path], "small5", "abc", ranking_limit=10, seed=123,
                exact_ranking_source="counterfactual")
        self.assertEqual([row.proposal.source for row in rankings], ["counterfactual"])
        self.assertEqual([row.proposal.source for row in heldout], ["counterfactual"])

    def test_ranking_batches_reserve_fixed_and_self_sources(self) -> None:
        def ranking(source: str, episode: int):
            proposal = ProposalExample(
                episode, "state", [0.0], 0, [0], [1.0], [0.0],
                [[1.0] + [0.0] * 12], 0, [0], [], [], source)
            value = DistillExample("state", [0.0], 1, 1.0, 1.0, 1.0, 1.0)
            return RankingExample(proposal, [[value]])

        examples = [ranking("champion", index) for index in range(20)] + [
            ranking("katago", 21), ranking("handcrafted", 22), ranking("self", 23)]
        batch = stratified_rankings(
            examples, 16, random.Random(91),
            fixed_source_fraction=0.125, self_source_fraction=0.25)
        sources = collections.Counter(value.proposal.source for value in batch)
        self.assertEqual(sources, {
            "champion": 8, "katago": 2, "handcrafted": 2, "self": 4,
        })

    def test_two_row_ranking_batches_preserve_source_fractions_in_expectation(self) -> None:
        def ranking(source: str, episode: int) -> RankingExample:
            proposal = ProposalExample(
                episode, "state", [0.0], 0, [0], [1.0], [0.0],
                [[1.0] + [0.0] * 12], 0, [0], [], [], source)
            value = DistillExample("state", [0.0], 1, 1.0, 1.0, 1.0, 1.0)
            return RankingExample(proposal, [[value]])

        examples = [ranking("champion", index) for index in range(20)] + [
            ranking("katago", 21), ranking("handcrafted", 22)]
        randomizer = random.Random(20260814)
        sources: collections.Counter[str] = collections.Counter()
        for _ in range(2_000):
            sources.update(value.proposal.source for value in stratified_rankings(
                examples, 2, randomizer,
                fixed_source_fraction=0.25, self_source_fraction=0))
        self.assertEqual(sources["champion"], 2_000)
        self.assertLess(abs(sources["katago"] - 1_000), 75)
        self.assertLess(abs(sources["handcrafted"] - 1_000), 75)

    def test_ranking_metrics_use_heldout_teacher_order(self) -> None:
        model = V9Net(
            V9Shape(extent=5, channels=4, blocks=1, hidden=8, tower=4, behavior=3),
            torch.device("cpu"), seed=112233)
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        proposal = ProposalExample(
            10, state, [0.0, 0.0, 0.0], 2, [0, 1], [1.0, 0.0], [0.0, 0.0],
            [[0.0] * 13, [0.0] * 13], 0, [0], [], [], "katago")
        value = DistillExample(
            state, [0.0, 0.0, 0.0], 3, 1.0, 1.0, 1.0, 1.0)
        metrics = ranking_metrics(
            model, [RankingExample(proposal, [[value], [value]])],
            torch.device("cpu"))
        self.assertEqual(metrics["positions"], 1)
        self.assertEqual(metrics["top1Agreement"], 1)
        self.assertEqual(metrics["meanBestRank"], 1)
        self.assertEqual(metrics["meanWinMargin"], 0)

    def test_source_ranking_metrics_reports_counterfactual_authority(self) -> None:
        model = V9Net(
            V9Shape(extent=5, channels=4, blocks=1, hidden=8, tower=4, behavior=3),
            torch.device("cpu"), seed=112233)
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        proposal = ProposalExample(
            10, state, [0.0, 0.0, 0.0], 2, [0, 1], [1.0, 0.0], [0.0, 0.0],
            [[0.0] * 13, [0.0] * 13], 0, [0], [], [], "counterfactual")
        value = DistillExample(
            state, [0.0, 0.0, 0.0], 3, 1.0, 1.0, 1.0, 1.0)
        metrics = source_ranking_metrics(
            model, [RankingExample(proposal, [[value], [value]])],
            torch.device("cpu"))
        self.assertEqual(set(metrics), {"counterfactual"})
        self.assertEqual(metrics["counterfactual"]["positions"], 1)

    def test_checkpoint_metrics_reuse_is_bit_exact(self) -> None:
        model = V9Net(
            V9Shape(extent=5, channels=4, blocks=1, hidden=8, tower=4, behavior=3),
            torch.device("cpu"), seed=998877)
        state = f"{'.' * 25}|{'1' * 25}|0|0|0"
        proposals = [ProposalExample(
            episode, state, [0.0, 0.25, 0.5], 2, [0, 1], [1.0, 0.0],
            [0.0, 0.5], [[1.0] + [0.0] * 12, [0.0, 1.0] + [0.0] * 11],
            0, [0], [1], [1], source)
            for episode, source in enumerate(
                ("champion", "katago", "handcrafted"), start=10)]
        rankings = []
        for proposal in proposals[1:]:
            selected = DistillExample(
                state, [0.0, 0.25, 0.5], 3, 1.0, 2.0, 4.0, 1.0)
            alternative = dataclasses.replace(selected, won=0.0, score=1.0)
            rankings.append(RankingExample(
                proposal, [[selected], [alternative]]))
        expected = (
            shortlist_metrics(model, proposals, torch.device("cpu"), 1),
            source_shortlist_metrics(model, proposals, torch.device("cpu"), 1),
            ranking_metrics(model, rankings, torch.device("cpu")),
            source_ranking_metrics(model, rankings, torch.device("cpu")),
        )
        self.assertEqual(
            checkpoint_metrics(model, proposals, rankings, torch.device("cpu"), 1),
            expected)

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
