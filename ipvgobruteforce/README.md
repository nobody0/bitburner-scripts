# IPvGO certified 5×5 playbooks

This directory is the exact-search and compilation component of the combined
IPvGO system. It proves phase-aware 5×5 policies, inventories their quality,
and packs replay-validated certificates into a compact runtime playbook.

It does **not** own the neural model, neural training, WebGPU inference, or the
19×19 strategy. Those remain under `go-ai/`, `shared/strategy/go/neural/`, and
`game/`. In particular, no model checkpoint is copied or pinned here.

## What is in git

Sources and docs are committed; `data/` and the CMake output are not. The rule
is *commit what regenerates the data, and what the game actually runs* — the two
ends of the pipeline, never the middle.

| | Where |
|---|---|
| Committed | `arena/`, `src/`, `include/`, `tests/`, `CMakeLists.txt`, this file, `TRAINING_DATA.md`, `RETIRED.md` |
| Committed elsewhere | the installed runtime playbook at `game/lib/generated/go-playbook.phase.js`; champions and the deployed derivative as LFS blobs under `go-ai/` |
| Not in git | `data/seeded-phases/` (28 GB), `data/training/` (the six certified v9.5 exports), `build-arena/` |

A fresh clone therefore builds and typechecks, and the suites that read fixtures
from `data/` skip instead of failing. To make them run, or to run
`go:playbook:residual` / `go:playbook:pack` / `go:combined:arena`, bring the
seeded-phase corpora over with `go-ai/remote/worker.sh` — the same hash-verified
out-of-band path the training corpora use, documented in
[`../go-ai/MAC_TO_WINDOWS_HANDOFF.md`](../go-ai/MAC_TO_WINDOWS_HANDOFF.md).
Never move them through git: they are larger than the entire repository and
none of them are reviewable.

Regenerating rather than transferring is the other supported option, and is what
the committed sources are for. Follow *Generate certificates* and *Inventory and
pack* below.

## Place in the combined system

```text
seed/RNG-aware exact 5×5 search
              |
              +--> certified playbook --> compact runtime table
              |
              +--> certified-game dataset (`TRAINING_DATA.md`)
                                      |
KataGo + handcrafted + champion + certified games
                                      |
                               V9 training/compression
                                      |
                       playbook first, neural fallback
```

The runtime uses a certificate while phase, board, pass count, alignment credit,
and exact-history discriminator match. A miss, unexpected timing transition,
unknown board, or successful `playTwoMoves` leaves the certified path and must
fall back to the neural policy.

## Canonical programs

- `ipvgo_seeded_batch` — independent exact-history AND/OR proofs over 5×5 WHRNG
  phases. It supports Netburners, Slum Snakes, The Black Hand, Tetrads,
  Daedalus, and every finite Illuminati handicap placement.
- `ipvgo_playbook_manifest` — validates certificates, selects the best
  certificate per supported root, and writes coverage, quality, and route data.
- `ipvgo_seeded_pack` — merges only replay-validated certificate states and
  emits binary, TypeScript, and standalone JavaScript tables.
- `arena/build-multi.ts` — builds a six-opponent router and compact runtime.
- `arena/build-residual-matches.ts` — identifies certified entries that the
  current neural policy already selects confidently, allowing safe
  model-assisted omission by the packer.
- `arena/export-certified-v9.ts` — converts replay-validated Black decisions
  into deduplicated V9.5 actor supervision without changing the playbook.
- `arena/main.ts` and `sim/ipvgobruteforce-arena.ts` — exercise the packed
  runtime in the simulator.

The old board-only forward/reverse search, meet-in-the-middle graph, global
seeded graph, and 19×19 rolling-search/model-copy experiments were removed. See
[RETIRED.md](RETIRED.md) for the conclusions worth retaining.

## Correctness contract

- Search states retain the complete positional-superko history. Different
  phases and histories are not merged while proving a policy.
- Black actions are OR choices. Every possible White outcome of a chosen action
  is an AND branch.
- Every legal Black move and ALIGN is enumerated at every relevant state.
- WHRNG timing is represented by 150,000 distinct 200 ms phases. White seeds
  WHRNG after exactly one full engine-cycle wait, so its seed phase is always
  dispatch `+1`. Completion is branch-exact: every later `waitCycle` (option
  evaluations, fallback selection, stone placement) is a real full-cycle phase
  advance recorded per predicted reply, so the base completion is
  `+1 + cycle_waits` (typically `+2` to `+5`). Ordinary play proves both the
  base and `base+1` (sub-tick offset plus fractional pattern sleeps); a
  controlled alignment targets the later edge, which the runtime realizes by
  waiting from an early arrival — an overshot arrival can never be undone.
- Browser `Math.random()` defense ties remain finite adversarial branches. They
  are never assumed deterministic.
- `WIN` means the exported certificate was replay validated. `UNKNOWN` is not a
  loss and must never be packed as a winning route.
- Illuminati enumeration includes every placement variant and, when upstream
  `applyHandicap` has an empty expansion list, the possible no-stone opening as
  well. A phase counts as fully certified only when all of these are proved.
- The optimality objective is aggregate power per round over the certificate's
  AND routes, each route weighted once, within `--max-rounds`. Rounds span
  several 200 ms ticks (branch-dependent, typically two to six) and DODGE waits
  count single ticks, so this is a proxy for (not identical to) power per real
  second.
- D4 symmetry may share pure Go-rule calculations. It never identifies graph
  states or caches orientation-sensitive opponent decisions.
- Packing may deduplicate an exact state only after proof. The generated lookup
  matches certified states by a 32-bit seeded hash of board, passes, alignment
  credit, and both history hashes; the compiler proves it collision-free across
  every packed entry of a phase, so on-certificate lookups are exact. States
  outside the certificate are rejected probabilistically (~2^-32 per packed
  entry), and every selected move is checked for legality at runtime.
- `--playtime-epoch` is part of the board-generation model. Do not combine
  certificates from different 30,000-second epochs without regenerating and
  validating their manifests.

## Build and test

```sh
cmake -S ipvgobruteforce -B ipvgobruteforce/build -DCMAKE_BUILD_TYPE=Release
cmake --build ipvgobruteforce/build -j 12
ctest --test-dir ipvgobruteforce/build --output-on-failure
bun run typecheck
bun test tests/ipvgo-bruteforce-arena.test.ts \
  tests/ipvgo-bruteforce-multi-arena.test.ts
```

The default generator worker count is
`min(12, std::thread::hardware_concurrency())`; `--threads` overrides it.

## Generate certificates

Use a new versioned output directory for every search-model change. Never mix
results produced with different timing, horizon, opponent, or epoch settings.

```sh
ipvgobruteforce/build/ipvgo_seeded_batch \
  --output-dir ipvgobruteforce/data/seeded-phases/netburners-5x5-example \
  --opponent netburners \
  --phase-begin 0 --phase-end 150000 \
  --threads 12 \
  --playtime-epoch 2697 \
  --runtime-ticks 1 \
  --max-rounds 40 \
  --ram-percent 90
```

The batch owns an output-directory lock, checkpoints resumable UNKNOWN graphs,
writes completed results atomically, and deletes winning snapshots by default
after their certificate is validated. Re-running the same command resumes its
unfinished phases. SIGINT/SIGTERM requests a checkpointed stop.

For bounded exploratory passes, use `--discard-incomplete` and
`--compact-incomplete`; these intentionally preserve only wins plus a compact
UNKNOWN ledger.

The generator reports `WIN` only after the aggregate power/turn maximum is
proved across every legal Black action and all AND routes within `--max-rounds`.
Resource limits checkpoint an unfinished proof as `UNKNOWN`; there is no
weaker bounded-policy mode.

## Inventory and pack

```sh
ipvgobruteforce/build/ipvgo_playbook_manifest \
  Netburners \
  ipvgobruteforce/data/seeded-phases/netburners-5x5-example

ipvgobruteforce/build/ipvgo_seeded_pack \
  --input-dir ipvgobruteforce/data/seeded-phases/netburners-5x5-example \
  --binary /tmp/netburners.playbook.bin \
  --typescript /tmp/netburners.playbook.ts \
  --javascript /tmp/netburners.playbook.js \
  --phase-javascript /tmp/netburners.phase.js \
  --collision-report /tmp/netburners.collisions.tsv \
  --root-routes /tmp/netburners.routes.tsv \
  --quality /tmp/netburners.quality.tsv
```

`bun run go:bruteforce:pack -- --allow-incomplete-generation` builds the
multi-opponent diagnostic runtime. Omit that override for a promotion build:
the packer must then reject incomplete or non-optimal generation. Large
per-state collision audit files are optional via `--collision-audits`; internal
collision validation always runs.

## Data policy and next handoff

The `policies/` certificate TSVs are source evidence, not caches. Preserve them
until the certified-game V9 dataset exporter has been implemented and its
output can be reproduced. Snapshots are resumable work state; generated
manifests, route tables, packed artifacts, and collision audits are derived.

The certified actor exporter and its training/deployment plan are documented in
[TRAINING_DATA.md](TRAINING_DATA.md). It records the certified Black action and
exact opponent behavior context, keeps connected starting-seed families on one
side of the split, and never trains from UNKNOWN branches. Expected value
targets remain deliberately separate because an adversarial proof tree is not
a sampled outcome distribution.

The combined arena belongs in `sim/` and should compare model-only,
playbook-only, and playbook-plus-model on identical seed/timing ledgers. This
directory should expose stable certificate and packed-runtime contracts to that
arena rather than grow another neural runtime.

## Current handoff status

The current canonical proof source is
`data/seeded-phases/netburners-5x5-epoch2697-v7-full`. Its latest manifest has
24,956 validated certificates, 21,742 immediate-entry phases, maximum dodge 70,
and routed mean Power per turn 1.118200. The certified V9 exporter consumed
this exact manifest and certificate set.

The packed artifact in `merged/` is still the older exhaustively replayed cut:
15,521 certificates, 14,545 retained policies, 1,639,667 shared states, and all
29,090 minimum/maximum timing games passing. Rebuild and exhaustively replay
the packer before treating the newly expanded 24,956-certificate source as a
runtime promotion candidate.

The prior six-opponent `all-5x5-v1/merged` runtime was a diagnostic artifact,
not a promotion candidate. It was quarantined because it misses certified state
lookups and cannot be reproduced by the cleaned packer: Black Hand, Tetrads,
Daedalus, and Illuminati still have v4 certificates without the required
playtime-epoch field. Slum Snakes has a small current-schema v7 corpus;
Netburners is current. Regenerate the remaining four faction corpora, produce
their manifests, then rebuild the multi-opponent artifact before enabling its
arena suite.
