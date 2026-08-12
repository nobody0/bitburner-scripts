# Frozen teacher source

The strategy under `strategy/` is a snapshot of the repository's current
production IPvGO policy at commit `23bbb772665fbfc866e3a464ff3d8dac2325ca04`.
Training and instrumentation must change wrappers under `teacher/`, never this
snapshot. `strategy/rewards.ts` is the exact three-function dependency subset
needed by `decide.ts`; it is not part of the learner reward definition.

| Source | SHA-256 |
|---|---|
| `decide.ts` | `f7821977450188758ae662192a0d13ea9fc29f57e7e8859dba810566ace39d5d` |
| `opponent.ts` | `0f050449aec91f02b7286a503ae35a67272cd3af2de28f3fa43e03058d990869` |
| `rng.ts` | `5126ffef2667b4a35d7c222ce1e264907761e2292e85f068fcd01a1661d70487` |
| `patterns.ts` | `33fbad3eaf249ac7307ac238a38c909caac087982147dc93da5b9852c1d8224b` |
| `analysis.ts` | `281ba52a6e811e8514f2ec2071d047254e0df53c7fb739aa76b507bdbb058a0c` |
| `policy-book.ts` | `ca5e51a090604d4080d2c3dd31268655c57b7195de5560865c84559b66f803ee` |
| `illuminati-book.ts` | `314546a4862bca0d7c1526c9424a3ce985d8a03bbdd3ccaa58837494bbcc65f8` |
| `secret-book.ts` | `84f3dfe180ba8091b4a89cfa2066d947a4138929e3ac8165758638f80c8c8fcd` |

The independent upstream v3.0.1 oracle remains the pinned simulator vendor
checkout; it is the opponent, not part of the teacher policy.
