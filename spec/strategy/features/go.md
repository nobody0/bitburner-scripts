# `go` — IPvGO

IPvGO is a Go variant played on boards of 5, 7, 9 or 13 (`resetBoardState`, `types/NetscriptDefinitions.d.ts:5704`)
against seven AI opponents (`Go/Enums.ts:2-11`). Each accumulates its own **node power**, feeding a player
multiplier; wins against a joined faction also convert a fixed reputation amount into **favor**.

> "Maximise subnet score with rules-correct adversarial search plus parity-proven seeded AI forecasts, then farm the
> bonus worth most to other features."

**Theme** BN14 IPvGO Subnet Takeover (`shared/features/registry.ts:146`) · **Status** done (`spec/progress.md:37`)

## Unlock

**Playable in every BitNode with no Source-File.** The `Go` interface declares no Source-File requirement
(`types/NetscriptDefinitions.d.ts:5541-5545`) — unlike `go.cheat`, whose every member is marked "Requires Source-File
14.2 to use" (`:5404`, `:5712`) — and the gate call `go.getGameState()` costs **0 GB** (`:5672`). No
`BitNodeBooleanOptions` field names Go (`:1897-1905`). Our whole `go.core` probe is 0 GB
(`game/lib/probes/direct.ts:13`) and the driver is enabled from its success flag (`shared/features/unlock.ts:45,137`).

## Rules

**Node power.** `sim/vendor/bitburner/src/Go/effects/EffectOracle.ts:9-15` (upstream `Go/effects/effect.ts`):

```
effect = 1 + Math.log(nodes + 1) * Math.pow(nodes + 1, 0.3) * 0.002
           * bonusPower * GoPower * (SF14 held ? 2 : 1)
```

Stats are keyed per opponent (`getStats(): Partial<Record<GoOpponent, SimpleOpponentStats>>`, `:5326`;
`newOpponentStats()`, `Go/Constants.ts:76-87`), so the seven bonuses accumulate independently. Our
`goEffectMultiplier` passes accumulated node power as `nodes` (`shared/strategy/go/rewards.ts:205-215`).

| Opponent | `bonusPower` | `komi` | Player multiplier lifted |
|---|---|---|---|
| `????????????` (w0r1d_d43m0n) | 2.0 | 9.5 | `hacking` (level) |
| Netburners | 1.3 | 1.5 | `hacknet_node_money` |
| Slum Snakes | 1.2 | 3.5 | `crime_success` |
| Daedalus | 1.1 | 5.5 | `company_rep`, `faction_rep` |
| The Black Hand | 0.9 | 3.5 | `hacking_money` |
| Tetrads | 0.7 | 5.5 | `strength`, `defense`, `dexterity`, `agility` |
| Illuminati | 0.7 | 7.5 | `hacking_speed` |

`bonusPower`/`komi` from `Go/Constants.ts:6-70`, where the effect is prose only (`bonusDescription`); the multiplier
fields are our transcription, `shared/strategy/go/rules.ts:45-53`. Two rows matter far beyond BN14. **Daedalus** lifts
company *and* faction rep (`rules.ts:50`). **Illuminati** lifts `hacking_speed`, which cancels
`HackingSpeedMultiplier` exactly: hack time divides by their product (`Hacking.ts:73-76`).

**Score and streaks.** Black scores routers plus surrounded empty nodes; white scores the same plus komi
(`Go/boardAnalysis/ScoringOracle.ts:9-29`), and every komi is a half-integer, so the sums are never equal outside an
integer `komiOverride`. We model a finished game as granting `blackScore * difficulty * streakMultiplier` node power
(`rewards.ts:183-203`).

- `difficulty = (komi + 0.5) * 0.25`, **except** board size 5 at Illuminati's komi of 7.5, a flat `8`
  (`EffectOracle.ts:46-49`). Upstream keys that on the komi *value*; ours keys it on the opponent id
  (`rewards.ts:167-170`), which differs only under a `komiOverride`.
- `streakMultiplier = 1 + 0.25 * min(winStreak, 8)`, capping at 3.0; `0.5` while `winStreak < 0`; breaking a dry
  streak pays `1 + 0.5 * min(dryStreak, 8)`, up to 5.0 (`EffectOracle.ts:33-44`).
- `resetBoardState` accepts only `5 | 7 | 9 | 13` (`:5704`); the 19×19 BitVerse board (`Go/Constants.ts:72,89-109`)
  comes only from the secret opponent (`rules.ts:59-66`).

**Favor.** An even positive win streak against a **joined** faction converts `maxRep / 200` through the nonlinear
favor formula (`rewards.ts:401-412`, `Faction/formulas/favor.ts:23`) until that opponent's Go rep counter reaches
`maxRep` — 100 000, rising to 200 000 / 300 000 / 400 000 at SF14 level 1/2/3 (`EffectOracle.ts:17-31`), so the grant
per event is 500 / 1000 / 1500 / 2000. Not ordinary faction rep: a separate capped counter whose only output is favor,
and favor grows only at install (`rewards.ts:96-98`, `shared/strategy/factions/rep.ts:309-311`).

**Wall time and RAM.** Nothing in the vendored Go sources reads player money or `Player.currentWork`, and the registry
lists no money source (`shared/features/registry.ts:152`): dodge RAM and wall time are Go's only costs. `waitCycle`
sleeps **200 ms**, or **40 ms** while `Go.storedCycles > 0`, decrementing it by 2
(`Go/boardAnalysis/goAI.ts:879-885`); one AI response spends two (`goAI.ts:185,213`), and bonus cycles read from
`getGameState().bonusCycles` for 0 GB (`:5672-5680`).

| GB | Calls (`types/NetscriptDefinitions.d.ts:5176-5714`) |
|---|---|
| 0 | `passTurn`, `opponentNextTurn`, `getMoveHistory`, `getCurrentPlayer`, `getGameState`, `getOpponent`, `resetBoardState`, `analysis.getStats`, `analysis.resetStats`, highlight calls |
| 1 | `cheat.getCheatSuccessChance`, `cheat.getCheatCount` |
| 4 | `makeMove`, `getBoardState`, `analysis.setTestingBoardState` |
| 8 | `analysis.getValidMoves`, `cheat.removeRouter`, `cheat.playTwoMoves`, `cheat.repairOfflineNode`, `cheat.destroyNode` |
| 16 | `analysis.getChains`, `analysis.getLiberties`, `analysis.getControlledEmptyNodes` |

The essential 4 GB board probe stays split from the optional 16 GB territory calls, so Go still plays on small fleets.
The ranker offers **5×5 only**: larger ordinary boards take substantially longer to finish and plan, with no measured
win-rate evidence compensating for the slower streak (`rewards.ts:420-424`). 5×5 is also the only board with the 8×
difficulty case.

**RNG: what is predictable.** The faction AI builds a Wichmann–Hill generator *after* its first wait, from
`Player.totalPlaytime` (`goAI.ts:185-186`), seeding all three streams with the same `(totalPlaytime / 1000) % 30000`
(`Casino/RNG.ts:46-52`), then draws exactly four values: smartness, move-option shuffle, faction priority tree,
fallback choice (`goAI.ts:187,188,190,212`). `totalPlaytime` advances one `CONSTANTS.MilliPerCycle` — 200 ms — per
engine cycle (`sim/vendor/.../Constants.ts:20`, `shared/strategy/go/rng.ts:20-22`), so the seed is fixed by the tick
we dispatch in; offline-node placement uses the same seed (`Go/boardState/offlineNodes.ts:14`). Three limits on our
parity stream (`rng.ts`, with phase anchoring and the 2 ms read-to-call guard in `tick.ts`):

- At normal speed the AI's first 200 ms wait yields **one exact** next-cycle seed (`rng.ts:35-37,63-65`).
- Across a 40 ms bonus wait the dispatch may or may not cross a rollover, so the forecast retains **current and next**
  only (`rng.ts:84-88`).
- `getDefendMove` breaks its tie with unseeded `Math.random()` (`goAI.ts:623`), so the predictor returns the
  **complete possible reply set** rather than a value public state cannot determine.

Move selection and the training arena: [`../../go-ai.md`](../../go-ai.md).

## Needs · Gives · Contends

**Needs** Dodge RAM only. It *reads* the open needs board (`shared/strategy/go/demand.ts:53`) to price which
multiplier is worth farming; it posts no `NeedKind`.

**Gives** Favor to [`factions`](factions.md) — persistent, and it unlocks donations. Node power to whichever feature
owns the lifted field: [`hacking`](hacking.md), [`career`](career.md) (combat stats, `crime_success`),
[`hacknet`](hacknet.md). Edges in [`../graph.md`](../graph.md).

**Contends** Dodge RAM, as a `long`-lane lease defaulting to `probe:detail` priority
(`game/lib/features/dodge.ts:81-105`). Nothing else: selection reads the needs board without reserving what it
improves, so a Daedalus game raises rep multipliers in parallel with real faction work.

## Challenges

- **Opponent selection is a separate problem from move selection**, ranked by expected seconds of critical path saved
  per game second. That needs the remaining ETA attributed to money, crime, combat, reputation, hacknet, hacking speed
  and hacking level, then scaled by the affected subsystem's measured *share* of that bottleneck (`demand.ts:9-31`).
  Current bonus percentage alone is not a value function.
- **Favor pays on an even streak, not per win.** From an odd streak the next win is a one-win favor event; any other
  state must pay for two (`rewards.ts:280-285,359`). Streaks are per-opponent, so a filler game against a *different*
  opponent cannot disturb the cadence (`shared/strategy/go/schedule.ts:31-52`).
- **The dispatch tick is the prediction.** A rollover between reading `totalPlaytime` and calling `makeMove`
  invalidates the forecast, so the phase anchor is re-verified every turn (`tick.ts:41-48`).
- **Board coordinates are column-major** (`rows[x][y]`) while the UI reads row-major (`rules.ts:1-8`).
- **Cheating is one-shot.** A failed cheat skips the turn and, after the first attempt, can eject from the subnet
  outright (`:5398-5399`), so the roll must succeed in the dispatch tick *and* the next (`rng.ts:77-80`).

## BitNode modifiers

| Field | Nodes |
|---|---|
| `GoPower` | BN14 **4** (`sim/vendor/.../BitNode/BitNodeMults.ts:484`) · every other node 1 (`BitNodeMultipliers.ts:98`) |

[BN14](../bitnodes/bn14.md) also changes what Go is *for* without touching its rules:
`FactionWorkRepGain`/`CompanyWorkRepGain` 0.2 (`BitNodeMults.ts:507-508`) make Daedalus favor the substitute rep
engine, and `HackingSpeedMultiplier` 0.3 (`:487`) — the game's lowest, next is BN15's 0.6 (`:530`) — is what
Illuminati offsets.

## Source map

| Concern | File |
|---|---|
| rules, board, effect fields, analysis, patterns | `shared/strategy/go/rules.ts`, `analysis.ts`, `patterns.ts` |
| clean-room faction AI, WHRNG parity, tick phase | `shared/strategy/go/opponent.ts`, `rng.ts`, `tick.ts` |
| rewards, ranking, ETA attribution, scheduling | `shared/strategy/go/rewards.ts`, `demand.ts`, `schedule.ts` |
| driver (go lane), neural runtime, probe | `game/lib/features/remaining.ts`, `go-neural.ts`, `probes/direct.ts` |
| telemetry topic · tab | `shared/telemetry/topics/go.ts` · `ui/app/tabs/go.ts` |
| sim model, arenas · vendored rules · policy | `sim/features/go.ts`, `sim/go-arena.ts` · `sim/vendor/bitburner/src/Go/` · [`../../go-ai.md`](../../go-ai.md) |

## Open

- Which `OpponentStats` field feeds `CalculateEffect`? Both `nodes` and `nodePower` exist (`Go/Constants.ts:76-87`)
  and the scoring-time grant is not vendored, so the node-power transition is confirmable only in our own model.
- Does node power survive an install or a BitNode reset? Not in the extract, not encoded in our code. Our model bounds
  favor's value at the node horizon (`rewards.ts:96-98`).
- What decides the winner when the sums are equal? Unreachable at every shipped komi, and the game-end branch is not
  vendored.
- The exact `cheat.getCheatSuccessChance` formula: the declaration gives only the direction of scaling (`:5394-5396`).
