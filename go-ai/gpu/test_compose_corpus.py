import gzip
import json
import pathlib
import tempfile
import unittest

from compose_corpus import Route, compose, heldout_fraction_for_stratum, route_stratum
from validate_corpus import Validator


SCHEMA = "bitburner-go-exhaustive-proposals-v9.5"
ORACLE = "bitburner-go-ai-v3.0.1"


def behavior(last: float) -> list[float]:
    return [0, 0.5, 0.5, 0.5, *([0] * 26), last]


def future_behavior(last: float) -> list[float]:
    return [0.5, -1, -1, -1, *([0] * 26), last]


def ranking(episode: int, split: str, decimal: float,
            environment: str | None = None, source: str = "self",
            generation: dict | None = None) -> dict:
    record = {
        "schema": SCHEMA,
        "kind": "actor-ranking",
        "profile": "small5",
        "teacherSha256": "a" * 64,
        "opponentOracle": ORACLE,
        "split": split,
        "example": {
            "episode": episode,
            "state": "." * 25 + "|" + "1" * 25 + "|0|0|0",
            "behavior": behavior(0.55),
            "elapsed": 0,
            "moves": [0],
            "bestMove": 0,
            "candidates": [[{
                "state": "X" + "." * 24 + "|" + "0" + "1" * 24 + "|0|0|0",
                "behavior": future_behavior(decimal),
                "elapsed": 1,
                "won": 1,
                "score": 1,
                "remaining": 1,
                "weight": 1,
            }]],
            "source": source,
        },
    }
    if environment is not None:
        record["generation"] = {"environmentId": environment, "opponent": "Netburners"}
    if generation is not None:
        record["generation"] = generation
    return record


def fixed_trajectory(source: str, episode: int, decimal: float,
                     generation: dict) -> dict:
    future = future_behavior(decimal)
    return {
        "schema": SCHEMA,
        "kind": "trajectory",
        "profile": "small5",
        "teacherSha256": "a" * 64,
        "opponentOracle": ORACLE,
        "split": "heldout" if episode % 10 == 0 else "train",
        "episode": episode,
        "values": [
            {
                "state": "." * 25 + "|" + "1" * 25 + "|0|0|0",
                "behavior": future,
                "elapsed": 1,
                "won": 1,
                "score": 25,
                "remaining": 2,
                "weight": 0.5,
            },
            {
                "state": "X" * 25 + "|" + "0" * 25 + "|2|1|0",
                "behavior": future,
                "elapsed": 2,
                "won": 1,
                "score": 25,
                "remaining": 1,
                "weight": 0.5,
            },
        ],
        "generation": {"source": source, **generation},
    }


class ComposeCorpusTest(unittest.TestCase):
    def test_student_root_selection_kind_is_an_outcome_blind_split_stratum(self) -> None:
        route = Route(0, "handcrafted", 1, "????????????", records=[{
            "generation": {
                "counterfactualTargetScope": "immediate-post-reply",
                "selectionKind": "last-aligned",
                # Outcome fields must not participate in the stratum.
                "terminalOutcome": {"won": False},
            },
        }])
        self.assertEqual(
            route_stratum(route), "handcrafted:????????????:last-aligned")
        route.records[0]["generation"]["terminalOutcome"]["won"] = True
        self.assertEqual(
            route_stratum(route), "handcrafted:????????????:last-aligned")
        route.records[0]["generation"]["counterfactualTargetScope"] = \
            "immediate-post-reply-future-marginalized"
        self.assertEqual(
            route_stratum(route), "handcrafted:????????????:last-aligned")
        self.assertEqual(heldout_fraction_for_stratum(
            route_stratum(route), 1 / 3), 1 / 3)
        route.records[0]["generation"]["selectionKind"] = "post-divergence"
        self.assertEqual(
            route_stratum(route), "handcrafted:????????????:post-divergence")
        self.assertEqual(heldout_fraction_for_stratum(
            route_stratum(route), 1 / 3), 1 / 3)
        self.assertEqual(heldout_fraction_for_stratum(
            "handcrafted:????????????", 1 / 3), 0.1)

    def test_f32_equal_inputs_keep_whole_routes_in_one_split(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            inputs = []
            for index, record in enumerate((
                    ranking(1, "train", 0.55),
                    ranking(10, "heldout", 0.550000011920929))):
                path = root / f"input-{index}.jsonl.gz"
                with gzip.open(path, "wt") as target:
                    target.write(json.dumps(record) + "\n")
                inputs.append(path)
            output = root / "composed.jsonl.gz"
            input_validator = Validator(inputs)
            input_summary = input_validator.run()
            self.assertEqual(input_summary["splitLeakage"]["valueInputs"], 1)
            summary = compose(inputs, output)
            self.assertEqual(summary["components"], 1)
            with gzip.open(output, "rt") as source:
                records = [json.loads(line) for line in source]
            self.assertEqual(len({record["split"] for record in records}), 1)
            self.assertEqual(len({record["example"]["episode"] for record in records}), 2)
            validator = Validator([output])
            result = validator.run()
            self.assertEqual(validator.errors, [])
            self.assertEqual(result["splitLeakage"], {"proposalInputs": 0, "valueInputs": 0})

    def test_environment_id_keeps_diverged_teacher_routes_together(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records = [
                ranking(1, "train", 0.55, "small5:Netburners:1:2:3"),
                ranking(2, "train", 0.65, "small5:Netburners:1:2:3"),
            ]
            # Make the second value input genuinely different; only the shared
            # generation environment may connect these routes.
            records[1]["example"]["candidates"][0][0]["state"] = \
                "XX" + "." * 23 + "|00" + "1" * 23 + "|0|0|0"
            input_path = root / "input.jsonl.gz"
            with gzip.open(input_path, "wt") as target:
                for record in records:
                    target.write(json.dumps(record) + "\n")
            output = root / "composed.jsonl.gz"
            summary = compose([input_path], output)
            self.assertEqual(summary["components"], 1)

    def test_legacy_episode_pairing_rejects_unverified_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            provenance = {"originalCorpusSha256": "b" * 64, "originalEpisode": 7}
            records = [
                ranking(1, "train", 0.55, source="katago", generation={
                    "source": "katago", **provenance}),
                fixed_trajectory("katago", 1, 0.55, provenance),
                ranking(2, "train", 0.65, source="handcrafted", generation={
                    "source": "handcrafted", **provenance}),
                fixed_trajectory("handcrafted", 2, 0.65, provenance),
            ]
            input_path = root / "legacy.jsonl.gz"
            with gzip.open(input_path, "wt") as target:
                for record in records:
                    target.write(json.dumps(record) + "\n")
            output = root / "composed.jsonl.gz"
            # The explicit historical override is daemon-only. Change only
            # identity/profile; record shapes remain the validator's small5
            # fixture, so exercise the guard separately from real integration.
            with self.assertRaisesRegex(RuntimeError, "only valid for verified daemon19"):
                compose([input_path], output, pair_fixed_by_original_episode=True)


if __name__ == "__main__":
    unittest.main()
