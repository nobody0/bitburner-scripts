# Password solvers

The DNet password implementation is pure strategy code under
`shared/strategy/dnet/solvers/`. The game driver in `game/dnet/orders.ts`
executes its steps, while the simulator supplies the same feedback as the game.
See [dnet.md](dnet.md#the-24-server-models) for model mechanics and tiers.

All password models are implemented. `Labyrinth` is intentionally separate: it
is a PID-bound maze walk, not a password exchange.

## Solver contract

A feedback solver is a pure state machine:

```ts
interface Solver {
  readonly needsOracle: boolean;
  budget(facts: PasswordFacts): number;
  first(facts: PasswordFacts): SolverStep;
  next(facts: PasswordFacts, state: SolverState, seen: SolverObservation): SolverStep;
}
```

A step is an `attempt`, an `answer`, or a named `give-up`. Solver state must
remain JSON-serializable because the ledger can resume it from another process
or host. Its `scratch` data can contain nearly complete passwords and is always
redacted by `stripCredentials`.

`needsOracle` records whether a log-ring read is required. The per-attempt value
controls execution; the solver-level value is the conservative scheduling check
used below the charisma gate. Every solver declares a finite attempt budget.

The ledger stores the pending password and its oracle requirement in
`PENDING_ATTEMPT` and `PENDING_NEEDS_ORACLE`. A new worker resends that attempt
to reconstruct its deterministic response. `resumableState` accepts it only
when the model and identity fingerprint still match. `EXHAUSTED_PHASE` prevents
an eliminated search from restarting until the server identity changes.

Solver outcomes use the local 906–910 block:

| Code | Meaning |
|---|---|
| 906 | Budget reached; keep state for a later resume. |
| 907 | A valid-looking response produced no progress. |
| 908 | Required oracle feedback was unavailable. |
| 909 | Feedback did not match the documented grammar. |
| 910 | The modeled search space was exhausted. |

Engine responses 408, 351, and 503 are handled by the driver because they reveal
nothing about the password. Completed attempts and destructive log reads are
written through to the shared ledger immediately.

## Current strategies

| Models | Strategy |
|---|---|
| `ZeroLogon`, `FreshInstall_1.0`, `Laika4`, `EuroZone Free`, `TopPass` | Ordered dictionaries, pruned by facts and harvested evidence. |
| `DeskMemo_3.1`, `CloudBlare(tm)`, `110100100`, `OrdoXenos`, `PrimeTime 2`, `OctantVoxel`, `MathML`, `Pr0verFl0` | Decode server details without oracle calls. |
| `AccountsManager_4.2`, ranged `BellaCuore` | Median probe over the remaining bounded values. |
| `PHP 5.4` | Recover positions from RMS equations and the published digit multiset. |
| `NIL`, `RateMyPix.Auth` | Recover symbols and positions from exact-match feedback. |
| `DeepGreen` | Pack alphabet groups into probes, split only present groups, then locate their positions. |
| `2G_cellular` | Use log prefix feedback or calibrated timing, with balanced speculative suffix probes. |
| `Factori-Os` | Rank divisibility probes by generator coverage and test compatible prime completions. |
| `BigMo%od` | Query large coprime moduli and reconstruct with CRT. |
| `KingOfTheHill` | Retain viable WHRNG summit candidates across altitude samples. |
| `OpenWebAccessPoint` | Decode packet-sniffer feedback. |

`BellaCuore` selects direct Roman-numeral decoding or ranged search from the
shape of its published data. `MathML` uses a linear parser checked against the
upstream evaluator.

## Hints and evidence

Generic contains and placement hints are part of solver input, not benchmark
decoration. They prune finite candidate sets, prioritize alphabets, seed known
positions, and restrict final answers. Placement is trusted as a coordinate only
when the attempted character was unique; repeated characters remain constraints
rather than positions.

In-progress solvers persist their chosen alphabet and known positions so later
log drains cannot reorder a numeric cursor. Contradictory evidence produces a
named exhausted or unparsed result instead of silently falling back to an
evidence-blind search.

## Verification and benchmark

Run correctness with:

```sh
bun test
bun run typecheck
```

`tests/dnet-solvers-vs-sim.test.ts` checks every solver against simulator-minted
hosts. Model, evidence, resume, and driver tests cover the surrounding contract.

Run the deterministic benchmark with:

```sh
bun run bench:sim:dnet-auth
bun run bench:sim:dnet-auth -- --only DeepGreen --seeds 64 --repeats 5
```

It reports authenticate calls per host (mean, p95, maximum) and pure decision
milliseconds per attempt. Separate contains-only, placement-only, and combined
lanes report calls saved and hosts improved, making hint utilization an explicit
optimization metric. Generation, simulated feedback, and I/O are outside the CPU
timer.
