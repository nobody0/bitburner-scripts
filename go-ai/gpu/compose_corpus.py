#!/usr/bin/env python3
"""Compose V9.5 routes and assign an input-disjoint 90/10 episode split.

Every route sharing a deployed f32 proposal or value input is placed in one
connected component.  The component, rather than each independently generated
corpus, is then assigned wholly to train or held-out.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import io
import json
import os
import pathlib
from dataclasses import dataclass, field
from typing import Any, Iterable

from validate_corpus import Validator


@dataclass
class Route:
    path_index: int
    source: str
    episode: int
    opponent: str = ""
    records: list[dict[str, Any]] = field(default_factory=list)
    connection_keys: set[bytes] = field(default_factory=set)


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        left = self.find(left)
        right = self.find(right)
        if left != right:
            self.parent[right] = left


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def neural_key(head: str, raw: Any) -> bytes | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("behavior"), list):
        return None
    semantic = Validator.input_key(raw.get("state"), raw["behavior"], raw.get("elapsed"))
    return head.encode() + Validator.digest(semantic)


def record_inputs(record: dict[str, Any]) -> Iterable[bytes]:
    kind = record.get("kind", "proposal")
    raw = record.get("example", {})
    if kind in ("proposal", "actor"):
        if (key := neural_key("proposal", raw)) is not None:
            yield key
    if kind == "proposal":
        values = record.get("distill", [])
    elif kind == "trajectory":
        values = record.get("values", [])
    elif kind == "actor-ranking" and isinstance(raw, dict):
        values = [value for group in raw.get("candidates", []) for value in group]
    else:
        values = []
    for value in values:
        if (key := neural_key("value", value)) is not None:
            yield key


def record_route(record: dict[str, Any]) -> tuple[str, int]:
    kind = str(record.get("kind", "proposal"))
    raw = record.get("example", {})
    if not isinstance(raw, dict):
        raise ValueError("example must be an object")
    episode = record.get("episode") if kind == "trajectory" else raw.get("episode")
    if not isinstance(episode, int) or isinstance(episode, bool):
        raise ValueError("episode must be an integer")
    return Validator.source_of(record, raw, kind), episode


def next_episode(counters: dict[str, int], source: str, split: str) -> int:
    value = counters[source]
    if split == "heldout":
        counters[source] += 10
        return value
    while value % 10 == 0:
        value += 1
    counters[source] = value + 1
    return value


def route_stratum(route: Route) -> str:
    """Outcome-blind split quota, including declared experimental root class."""
    base = f"{route.source}:{route.opponent}"
    kinds: set[str] = set()
    for record in route.records:
        generation = record.get("generation")
        if isinstance(generation, dict) and (
                generation.get("studentRootActorAuthority") is not None
                or generation.get("counterfactualTargetScope") in (
                    "immediate-post-reply",
                    "immediate-post-reply-future-marginalized",
                )):
            kind = generation.get("selectionKind")
            certified_root = generation.get("counterfactualAuthority") \
                == "certified-playbook-terminal-regret-v1"
            allowed = (("certified-root",) if certified_root else
                       ("last-aligned", "first-divergence", "post-divergence"))
            if kind not in allowed:
                raise RuntimeError("student-root route lacks a valid pre-outcome selection kind")
            kinds.add(str(kind))
    if len(kinds) > 1:
        raise RuntimeError("student-root selection kind changes within one route")
    return f"{base}:{next(iter(kinds))}" if kinds else base


def heldout_fraction_for_stratum(name: str, student_root_fraction: float) -> float:
    return (student_root_fraction
            if name.rsplit(":", 1)[-1] in
            ("last-aligned", "first-divergence", "post-divergence")
            else 0.1)


def write_gzip(path: pathlib.Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8", newline="\n") as target:
                for record in records:
                    target.write(json.dumps(record, separators=(",", ":"), allow_nan=False))
                    target.write("\n")


def compose(paths: list[pathlib.Path], output: pathlib.Path,
            include_sources: set[str] | None = None,
            pair_fixed_by_original_episode: bool = False,
            require_numeric_reply_author: str | None = None,
            student_root_heldout_fraction: float = 0.1) -> dict[str, Any]:
    if not paths:
        raise ValueError("at least one input corpus is required")
    if output.exists():
        raise FileExistsError(f"refusing to overwrite {output}")
    partial = output.with_name(output.name + ".partial")
    if partial.exists():
        raise FileExistsError(f"remove stale partial output first: {partial}")
    output.parent.mkdir(parents=True, exist_ok=True)

    checksums: list[str] = []
    identities: set[tuple[Any, Any, Any, Any]] = set()
    routes_by_key: dict[tuple[int, str, int], Route] = {}
    legacy_pairs: dict[tuple[str, int], dict[str, tuple[int, str, int]]] = \
        collections.defaultdict(dict)
    for path_index, path in enumerate(paths):
        input_validator = Validator([path])
        input_validator.run()
        structural_errors = [error for error in input_validator.errors
                             if "exact proposal inputs occur in both splits" not in error
                             and "exact value inputs occur in both splits" not in error]
        if structural_errors:
            raise RuntimeError(
                f"input corpus failed validation: {path}: "
                + "; ".join(structural_errors)
            )
        checksums.append(file_sha256(path))
        with gzip.open(path, "rt", encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                record = json.loads(line)
                identities.add(tuple(record.get(name) for name in (
                    "schema", "profile", "teacherSha256", "opponentOracle")))
                try:
                    source_name, episode = record_route(record)
                except ValueError as error:
                    raise RuntimeError(f"{path}:{line_number}: {error}") from error
                if include_sources is not None and source_name not in include_sources:
                    continue
                generation = record.get("generation")
                if pair_fixed_by_original_episode \
                        and source_name in ("katago", "handcrafted"):
                    if not isinstance(generation, dict):
                        raise RuntimeError(
                            f"{path}:{line_number}: legacy fixed route lacks provenance")
                    original_episode = generation.get("originalEpisode")
                    original_sha256 = generation.get("originalCorpusSha256")
                    if not isinstance(original_episode, int) \
                            or isinstance(original_episode, bool) \
                            or not isinstance(original_sha256, str) \
                            or len(original_sha256) != 64:
                        raise RuntimeError(
                            f"{path}:{line_number}: legacy fixed route lacks exact original identity")
                    legacy_key = (original_sha256, original_episode)
                    route_key = (path_index, source_name, episode)
                    prior = legacy_pairs[legacy_key].setdefault(source_name, route_key)
                    if prior != route_key:
                        raise RuntimeError(
                            f"{path}:{line_number}: duplicate legacy {source_name} route for one episode")
                    profile = str(record.get("profile"))
                    if profile != "daemon19":
                        raise RuntimeError(
                            "--pair-fixed-by-original-episode is only valid for verified daemon19 history")
                    generation.setdefault("opponent", "????????????")
                    generation.setdefault(
                        "environmentId",
                        f"legacy:{profile}:{original_sha256}:{original_episode}",
                    )
                opponent = str(generation.get("opponent", "")) \
                    if isinstance(generation, dict) else ""
                route = routes_by_key.setdefault(
                    (path_index, source_name, episode),
                    Route(path_index, source_name, episode, opponent),
                )
                if route.opponent != opponent:
                    raise RuntimeError(
                        f"{path}:{line_number}: opponent changes within one route")
                route.records.append(record)
                route.connection_keys.update(record_inputs(record))
                environment = generation.get("environmentId") \
                    if isinstance(generation, dict) else None
                if isinstance(environment, str) and environment:
                    route.connection_keys.add(b"environment\0" + environment.encode())
                counterfactual_group = generation.get("counterfactualGroupId") \
                    if isinstance(generation, dict) else None
                if isinstance(counterfactual_group, str) and counterfactual_group:
                    route.connection_keys.add(
                        b"counterfactual\0" + counterfactual_group.encode())
    if len(identities) != 1:
        raise RuntimeError(f"input corpus identities differ: {sorted(identities)!r}")
    if pair_fixed_by_original_episode:
        incomplete = [key for key, sources in legacy_pairs.items()
                      if set(sources) != {"katago", "handcrafted"}]
        if incomplete:
            raise RuntimeError(
                f"legacy fixed pairing is incomplete for {len(incomplete)} original episodes")

    routes = sorted(routes_by_key.values(), key=lambda route: (
        route.path_index, route.source, route.episode))
    if not routes:
        raise RuntimeError("source filter removed every route")
    if any(not route.connection_keys for route in routes):
        empty = next(route for route in routes if not route.connection_keys)
        raise RuntimeError(
            f"route has no neural inputs: {paths[empty.path_index]}:{empty.source}:{empty.episode}")
    union = UnionFind(len(routes))
    owners: dict[bytes, int] = {}
    for index, route in enumerate(routes):
        for key in route.connection_keys:
            prior = owners.setdefault(key, index)
            union.union(index, prior)

    members: dict[int, list[int]] = collections.defaultdict(list)
    for index in range(len(routes)):
        members[union.find(index)].append(index)
    fingerprints: dict[int, str] = {}
    component_strata: dict[int, collections.Counter[str]] = {}
    total_strata: collections.Counter[str] = collections.Counter()
    for root, indices in members.items():
        digest = hashlib.sha256()
        for key in sorted({key for index in indices for key in routes[index].connection_keys}):
            digest.update(len(key).to_bytes(2, "big"))
            digest.update(key)
        fingerprints[root] = digest.hexdigest()
        strata = collections.Counter(route_stratum(routes[index]) for index in indices)
        component_strata[root] = strata
        total_strata.update(strata)

    # Select whole components while targeting ten percent independently for
    # every source/opponent stratum. Selection never consults outcomes or
    # labels. Hashes provide a deterministic pseudo-random tie break.
    if not 0 < student_root_heldout_fraction < 1:
        raise ValueError("student_root_heldout_fraction must be between zero and one")
    targets = {
        name: count * heldout_fraction_for_stratum(
            name, student_root_heldout_fraction)
        for name, count in total_strata.items()
    }
    heldout_counts: collections.Counter[str] = collections.Counter()
    heldout_roots: set[int] = set()
    remaining_roots = set(members)
    while remaining_roots:
        best_root: int | None = None
        best_improvement = 0.0
        for root in remaining_roots:
            improvement = 0.0
            for name, added in component_strata[root].items():
                target = targets[name]
                scale = max(target, 1.0)
                before = ((heldout_counts[name] - target) / scale) ** 2
                after = ((heldout_counts[name] + added - target) / scale) ** 2
                improvement += before - after
            if improvement > best_improvement + 1e-12 or (
                    abs(improvement - best_improvement) <= 1e-12
                    and improvement > 0
                    and (best_root is None
                         or fingerprints[root] < fingerprints[best_root])):
                best_root = root
                best_improvement = improvement
        if best_root is None:
            break
        heldout_roots.add(best_root)
        heldout_counts.update(component_strata[best_root])
        remaining_roots.remove(best_root)

    component: dict[int, tuple[str, str]] = {}
    for root, indices in members.items():
        split = "heldout" if root in heldout_roots else "train"
        fingerprint = fingerprints[root]
        for index in indices:
            component[index] = split, fingerprint

    train_counters: dict[str, int] = collections.defaultdict(lambda: 1)
    heldout_counters: dict[str, int] = collections.defaultdict(int)
    route_counts: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    output_records: list[dict[str, Any]] = []
    for index, route in enumerate(routes):
        split, fingerprint = component[index]
        counters = heldout_counters if split == "heldout" else train_counters
        episode = next_episode(counters, route.source, split)
        route_counts[route.source][split] += 1
        for record in route.records:
            kind = str(record.get("kind", "proposal"))
            if kind == "trajectory":
                record["episode"] = episode
            else:
                record["example"]["episode"] = episode
            record["split"] = split
            generation = record.get("generation")
            if not isinstance(generation, dict):
                generation = {}
            provenance = dict(generation)
            if "originalCorpus" not in provenance:
                provenance.update({
                    "originalCorpus": paths[route.path_index].name,
                    "originalCorpusSha256": checksums[route.path_index],
                    "originalEpisode": route.episode,
                })
            else:
                provenance.update({
                    "parentCorpus": paths[route.path_index].name,
                    "parentCorpusSha256": checksums[route.path_index],
                    "parentEpisode": route.episode,
                })
                if "splitComponentSha256" in provenance:
                    provenance["parentSplitComponentSha256"] = \
                        provenance["splitComponentSha256"]
            provenance["splitComponentSha256"] = fingerprint
            record["generation"] = provenance
            output_records.append(record)

    try:
        write_gzip(partial, output_records)
        validator = Validator(
            [partial], require_numeric_reply_author=require_numeric_reply_author)
        summary = validator.run()
        if summary["errors"]:
            raise RuntimeError("composed corpus failed validation: " + "; ".join(validator.errors))
        os.replace(partial, output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return {
        "output": str(output),
        "sha256": file_sha256(output),
        "records": len(output_records),
        "routes": len(routes),
        "components": len(members),
        "largestComponentRoutes": max(map(len, members.values()), default=0),
        "heldoutStrata": dict(heldout_counts),
        "legacyFixedPairs": len(legacy_pairs),
        "routeSplitsBySource": {source: dict(counts) for source, counts in route_counts.items()},
        "validator": summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--include-source", action="append", choices=(
        "champion", "katago", "handcrafted", "self"))
    parser.add_argument("--pair-fixed-by-original-episode", action="store_true",
                        help="pair verified historical daemon19 fixed routes by original provenance")
    parser.add_argument(
        "--require-numeric-reply-author",
        choices=("champion",),
        help="reject composed exhaustive reply values without this explicit author",
    )
    parser.add_argument(
        "--student-root-heldout-fraction", type=float, default=0.1,
        help="held-out target for declared student-root strata only (default: 0.1)",
    )
    parser.add_argument("inputs", nargs="+", type=pathlib.Path)
    args = parser.parse_args()
    try:
        selected = set(args.include_source) if args.include_source else None
        print(json.dumps(compose(
            args.inputs, args.output, selected,
            args.pair_fixed_by_original_episode,
            args.require_numeric_reply_author,
            args.student_root_heldout_fraction,
        ), indent=2, sort_keys=True))
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
