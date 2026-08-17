#!/usr/bin/env python3
"""Focused regression tests for the compact policy-topology assay."""

from __future__ import annotations

import pathlib
import tempfile
import unittest

import torch

from diagnose_policy_topology import (
    HybridGlobalPolicyNet,
    balanced_batch_indices,
    export_hybrid,
    freeze_except_policy_outputs,
    initialize_hybrid_from_v9,
    inject_dynamic_state_planes,
    update_checkpoint_path,
)


class DynamicStatePlaneTest(unittest.TestCase):
    def test_elapsed_normalization_uses_the_model_extent(self) -> None:
        small = torch.zeros((1, 8, 5, 5), dtype=torch.float32)
        daemon = torch.zeros((1, 8, 19, 19), dtype=torch.float32)
        small[:, 4].fill_(2)
        daemon[:, 4].fill_(2)

        inject_dynamic_state_planes(small, torch.tensor([25.0]), 5)
        inject_dynamic_state_planes(daemon, torch.tensor([361.0]), 19)

        self.assertTrue(torch.all(small[:, 4] == 1))
        self.assertTrue(torch.all(daemon[:, 4] == 1))
        self.assertTrue(torch.all(small[:, 5] == 0.5))
        self.assertTrue(torch.all(daemon[:, 5] == 0.5))

    def test_update_checkpoint_path_preserves_model_suffix(self) -> None:
        self.assertEqual(
            str(update_checkpoint_path(pathlib.Path("run/v9.model"), 1000)),
            "run/v9.u1000.model",
        )

    def test_hybrid_checkpoint_warm_start_is_policy_exact(self) -> None:
        device = torch.device("cpu")
        source = HybridGlobalPolicyNet(5, 3, 4, 1, 2, device, 11)
        target = HybridGlobalPolicyNet(5, 3, 4, 1, 2, device, 12)
        states = torch.randn(3, 8, 5, 5)
        behavior = torch.randn(3, 3)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "source.model"
            export_hybrid(source, path, 3, 11)
            initialize_hybrid_from_v9(target, path, device)
        torch.testing.assert_close(
            target(states, behavior), source(states, behavior), rtol=0, atol=0)

    def test_zero_conditional_head_preserves_warm_start(self) -> None:
        device = torch.device("cpu")
        source = HybridGlobalPolicyNet(5, 3, 4, 1, 2, device, 11)
        target = HybridGlobalPolicyNet(5, 3, 4, 1, 2, device, 12, conditional_rank=3)
        states = torch.randn(3, 8, 5, 5)
        behavior = torch.randn(3, 3)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "source.model"
            export_hybrid(source, path, 3, 11)
            initialize_hybrid_from_v9(target, path, device)
        torch.testing.assert_close(
            target(states, behavior), source(states, behavior), rtol=0, atol=0)

    def test_rank_zero_warm_start_has_no_zero_width_linear(self) -> None:
        device = torch.device("cpu")
        source = HybridGlobalPolicyNet(5, 3, 4, 1, 0, device, 11)
        target = HybridGlobalPolicyNet(
            5, 3, 4, 1, 0, device, 12, conditional_rank=3)
        states = torch.randn(3, 8, 5, 5)
        behavior = torch.randn(3, 3)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "source.model"
            export_hybrid(source, path, 3, 11)
            initialize_hybrid_from_v9(target, path, device)
        self.assertIsNone(target.global_context)
        self.assertIsNone(target.global_policy)
        torch.testing.assert_close(
            target(states, behavior), source(states, behavior), rtol=0, atol=0)

    def test_rank_zero_warm_start_can_add_an_exact_noop_global_branch(self) -> None:
        device = torch.device("cpu")
        source = HybridGlobalPolicyNet(5, 3, 4, 1, 0, device, 11)
        target = HybridGlobalPolicyNet(5, 3, 4, 1, 2, device, 12)
        states = torch.randn(3, 8, 5, 5)
        behavior = torch.randn(3, 3)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "source.model"
            export_hybrid(source, path, 3, 11)
            initialize_hybrid_from_v9(target, path, device)
        torch.testing.assert_close(
            target(states, behavior), source(states, behavior), rtol=0, atol=0)

    def test_balanced_batch_samples_each_opponent_with_replacement(self) -> None:
        groups = [torch.tensor([0, 1]), torch.tensor([9])]
        selected = balanced_batch_indices(groups, 8, torch.Generator().manual_seed(7))
        self.assertEqual(sum(int(value < 9) for value in selected), 4)
        self.assertEqual(sum(int(value == 9) for value in selected), 4)

    def test_policy_output_freeze_can_include_global_heads_without_the_trunk(self) -> None:
        model = HybridGlobalPolicyNet(5, 3, 4, 1, 2, torch.device("cpu"), 11)
        freeze_except_policy_outputs(model, include_global=True)
        trainable = {name for name, value in model.named_parameters()
                     if value.requires_grad}
        self.assertTrue(trainable)
        self.assertTrue(all(name.startswith(("local_policy.", "pass_policy.",
                                              "global_context.", "global_policy."))
                            for name in trainable))
        self.assertTrue(any(name.startswith("global_policy.") for name in trainable))
        self.assertFalse(any(name.startswith("stem.") for name in trainable))


if __name__ == "__main__":
    unittest.main()
