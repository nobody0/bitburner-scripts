#!/usr/bin/env python3
"""Persistent JSON-lines PyTorch backend for the shared TypeScript V9 selector."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import torch

from train_v9 import load_v9


def decode_batch(request: dict, extent: int, behavior_features: int,
                 input_channels: int, device: torch.device):
    count = int(request["count"])
    area = extent * extent
    words = (area + 15) // 16
    legal_words = (area + 31) // 32
    packed = torch.tensor(request["packed"], dtype=torch.int64).reshape(count, words)
    legal = torch.tensor(request["legal"], dtype=torch.int64).reshape(count, legal_words)
    points = torch.arange(area, dtype=torch.int64)
    codes = (packed[:, points // 16] >> ((points % 16) * 2)) & 3
    legal_bits = (legal[:, points // 32] >> (points % 32)) & 1
    inputs = torch.zeros((count, input_channels, extent, extent), dtype=torch.float32)
    flat = inputs.flatten(2)
    flat[:, 0] = codes == 1
    flat[:, 1] = codes == 2
    flat[:, 2] = codes == 3
    flat[:, 3] = legal_bits
    state = torch.tensor(request["state"], dtype=torch.float32).reshape(count, 4)
    for offset, plane in enumerate((4, 5, 6, 7)):
        inputs[:, plane] = state[:, offset, None, None]
    if input_channels == 16:
        tactical_values = request.get("tactical")
        if tactical_values is None:
            raise ValueError("tactical-v1 checkpoint requires tactical planes")
        tactical = torch.tensor(tactical_values, dtype=torch.int64).reshape(
            count, 8, legal_words)
        inputs[:, 8:] = ((tactical[:, :, points // 32]
                          >> (points % 32)[None, None, :]) & 1).reshape(
                              count, 8, extent, extent)
    behavior = torch.tensor(request["behavior"], dtype=torch.float32).reshape(
        count, behavior_features)
    return inputs.to(device), behavior.to(device)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=pathlib.Path, required=True)
    parser.add_argument("--device", default="mps")
    args = parser.parse_args()
    device = torch.device(args.device)
    model = load_v9(args.model, device).eval()
    print(json.dumps({"ready": True, "extent": model.shape.extent,
                      "behaviorFeatures": model.shape.behavior,
                      "inputChannels": model.shape.input_channels}), flush=True)
    with torch.inference_mode():
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request.get("kind") == "close":
                    break
                inputs, behavior = decode_batch(
                    request, model.shape.extent, model.shape.behavior,
                    model.shape.input_channels, device)
                if request["kind"] == "proposal":
                    spatial, pooled = model.trunk(inputs, behavior)
                    value = model.value_head(pooled)
                    moves = model.policy_head(spatial, pooled)
                    response = {"value": value.cpu().flatten().tolist(),
                                "moves": moves.cpu().flatten().tolist()}
                elif request["kind"] == "value":
                    value = model.forward_value(inputs, behavior)
                    response = {"value": value.cpu().flatten().tolist()}
                else:
                    raise ValueError("unknown request kind")
                print(json.dumps(response, separators=(",", ":")), flush=True)
            except Exception as error:  # keep the caller from hanging on protocol failures
                print(json.dumps({"error": f"{type(error).__name__}: {error}"}), flush=True)


if __name__ == "__main__":
    main()
