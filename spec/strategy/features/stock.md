# `stock` — the World Stock Exchange

33 symbols random-walk on a 6-second tick, biased by a hidden per-symbol forecast that
re-rolls on a 75-tick cycle. Each position pays a spread and a commission, so profit exists
only where the drift over the hold clears both. Hack and grow with `{stock: true}` move the
forecast of the symbol owned by the target's organization.

> Allocate capital across symbols for the most money at the END OF THE RUN, net of the
> spread, the commission and the 75-tick regime cycle — and steer the hacking farm's
> hack/grow at the symbols held, since those move prices.

**Theme** BN8 Ghost of Wall Street (`shared/features/registry.ts:96`) ·
**Status** done, rebuilt in phase 15 (`spec/progress.md`)

## Unlock

Money-gated, not capability-gated. Costs `StockMarket/data/Constants.ts:4-11`, gates `NetscriptFunctions/StockMarket.ts`.

| Purchase | Cost | What it buys a script |
|---|---|---|
| WSE account | $200m | nothing — `getSymbols` and every price getter check `hasTixApiAccess` (`:39-43`) |
| TIX API | $5b | prices, positions, `buyStock` / `sellStock` |
| 4S Market Data | $1b × `FourSigmaMarketDataCost` | nothing — it is the exchange UI's forecast column |
| 4S Market Data TIX API | $25b × `FourSigmaMarketDataApiCost` | `getForecast`, `getVolatility` (`:228-247`) |

- `purchase4SMarketDataTixApi` needs TIX access and **not** `has4SData` (`:275-297`), so the $1b
  buys an automated player nothing: `decide.ts`'s ladder has three rungs and no `buy4SData`.
- Shorts need BN8 or SF8 ≥ 2, `placeOrder` / `getOrders` BN8 or SF8 ≥ 3 (`:151, 163, 178, 192, 204`);
  we probe open orders and never place one. `disable4SData` blocks both 4S purchases (`:250, 276`).
- BN8 starts with $250m, WSE and TIX; SF8 ≥ 1 re-grants both at every prestige (`Prestige.ts:161-168, 302-312`).
  SF8's only multiplier is `hacking_grow` ×1.12 / 1.18 / 1.21 (`SourceFile/applySourceFile.ts:124-133`).
- **`stock` is unconditionally "yes"** (`shared/features/unlock.ts:122, 157-166`). Gating it
  on `hasWseAccount()` deadlocked: a driver never runs while its own feature reads "no", so
  nothing could buy the account that unlocks it.

## Rules

The tick (`StockMarket/StockMarket.ts:245-316`):

```
every 6 s (4 s floor while stored cycles burn):
  --ticksUntilCycle; at <= 0 each symbol flips bull/bear at p=0.45, mirrors its
                     otlkMagForecast (100 - x), and the counter resets to 75
  v   = Math.random()          // ONE draw, shared by ALL 33 symbols
  av  = v * mv / 100
  chc = (50 +/- otlkMag) / 100 // + bull, - bear
  price *= (1 + av) with probability chc, else price /= (1 + av)
  otlkMag         +/-= otlkMag * av      // x10 below 5, =1 at or below 1
  otlkMagForecast +/-= otlkMag * av / 2  // 50/50 coin flip
```

Consequences, in `shared/strategy/stock/market.ts`, pinned by `sim/tests/stock-parity.test.ts`:

| Fact | Source | Consequence |
|---|---|---|
| `v` is one shared draw ~U(0,1) | `StockMarket.ts:260` | `getVolatility()` is the CEILING; the mean move is half it (`meanLogStep`) |
| ask = `price·(1+spread/100)`, bid = `price·(1−spread/100)` | `Stock.ts:225-232` | a round trip costs `2·spreadPerc%` of notional — 10x–200x the $100k commission, charged on both legs (`StockMarketHelpers.ts:28, 53`) |
| `otlkMag` drifts by `otlkMag · av` | `StockMarket.ts:311` | the forecast is near-constant inside a cycle; what ends it is the scheduled boundary |
| `getForecastIncreaseChance` pulls the forecast toward `otlkMagForecast`, clamped ±45 | `Stock.ts:235-240` | the second-order forecast leads, and it is the only quantity hack/grow can move |
| every `shareTxForMovement` shares transacted drags `otlkMag` toward a floor of 5 and `otlkMagForecast` toward 50, recovering +10/tick | `StockMarketHelpers.ts:64-109`, `Stock.ts:5` | size degrades your own signal (`selfInfluenceCost`) |
| `mv`, `spreadPerc`, `initPrice`, `shareTxForMovement` are rolled once per world from declared `{min,max}` bands; `maxShares` is 20% of `marketCap / initPrice` | `Stock.ts:40, 139-150` | `mv` sits on a discrete 1/100 grid inside a PUBLIC band (`data/InitStockMetadata.ts` → `shared/features/stocks.ts`); `maxShares` silently caps every transaction |
| the shared `v` calibrates all symbols at once, and the tick sign is a Bernoulli draw on the forecast | `shared/strategy/stock/history.ts` | **no 4S is needed to trade**: intersecting the discrete grids usually recovers volatility exactly, and up-tick frequency estimates the forecast (EWMA α 0.08, shrunk toward 0.5 at prior strength 25). Only the cycle boundary needs 4S — ≥ 6 simultaneous 0.5 crossings, exact thereafter |

**Manipulation.** Both flagged ops roll `random() < moneyMoved / server.moneyMax` and on success
move `otlkMagForecast` by ∓0.1 (`StockMarket/PlayerInfluencing.ts:12, 34-35, 57-58`), joined to a
symbol by `server.organizationName`. That probability is a FRACTION, so `moneyMax` cancels:
`joesguns` manipulates as fast as `ecorp`. It is priced INTO the same `$/GB/sec` target score
rather than arbitrated ([`../../targeting.md`](../../targeting.md)), with `{stock: true}` on the
grow for a long and the hack for a short, never both — in steady state the grow undoes the hack.

**The two hacking multipliers move that trade-off in OPPOSITE directions.** `ScriptHackMoney`
scales `percentMoneyHacked` (`Hacking.ts:54`) and so `moneyDrained`, which the influence roll
measures — cutting it weakens manipulation itself. `ScriptHackMoneyGain` scales only
`moneyGained = moneyDrained * gain`, after the drain and before the influence call
(`NetscriptHelpers.tsx:594, 614-616`) — cutting it weakens hacked money alone. BN8 sets 0.3 and 0.

**An install destroys the book.** `prestigeAugmentation` calls `initStockMarket`, replacing every
`Stock` (`Prestige.ts:170-172`, `StockMarket.ts:183-205`): shares go to zero, no money is credited,
every generated field is re-rolled. The unlocks survive an install and die with the BitNode — a
position's horizon is the INSTALL, an unlock's the NODE, so liquidate before `progression` resets.

## Needs · Gives · Contends

**Needs** `money` only — `stockModule` posts no `needs`, so there is no `NeedKind` edge; every rung
and position is a money claim in the shared `income:investment` band (`shared/strategy/arbiter.ts`).
**Gives** money; the two top-ranked symbols to `dnet` for `promoteStock`
(`game/lib/features/dnet.ts:722-725`); a per-host manipulation intent to `hacking` on
`stock.manipulation`, keyed by hostname.
**Contends** money against every other investment (no BN8 override needed — competing returns
collapse to zero there anyway); farm target choice, priced not arbitrated; dodge RAM, 12.1 GB.

## Challenges

- No plan may derive from the money grant: plan ← grant ← claim ← plan never closes while
  `moneyGranted` is 0, which is why the predecessor never traded. `stepStock` plans at full
  ambition; `fundedActions` cuts to the grant afterwards.
- The sampler must run strictly faster than 4 s (probe: 3 s) — both recoveries count each tick
  once and 4 s is the floor while cycles burn. `getPosition` is read inside the trade stub too,
  or a buy repeats every driver tick at a fresh commission.
- The $25b API priced against the install cadence rather than the node is unaffordable below
  ~$100b, which BN8 cannot reach without it. Meanwhile reserve exactly the viability floor: more
  freezes trading, the reserve's hyperbolic curve out-bidding the flat-valued entry.
- The entry loop walks the whole ranking; stopping at the head let one un-shortable bearish symbol block every long beneath it.
- Manipulation follows owned exposure only — a live position, a rooted skill-reachable host, the
  signal still favouring the held side. Nothing manufactures an entry (`planManipulation`).

## Rewards

Cash, in BN8 the only cash — no rep, no experience, no permanent multiplier. Positions die at the next install, the unlocks with the BitNode.

## Measured

Paired `bn5-hacking` / `bn5-hacking-stock`: same seeds, same vendored omega-net midpoint,
$12b → $20b, treatment paying the real $5.2b for WSE + TIX, only the stock flag differing.

| Seed | Hacking only | Hacking + stock | Improvement |
|---:|---:|---:|---:|
| 1 | 4.45h | 3.23h | 73.3m (27.4%) |
| 2 | 5.07h | 3.75h | 78.9m (25.9%) |
| 3 | 4.39h | 3.84h | 33.4m (12.7%) |
| median | 4.45h | 3.75h | 42.0m (15.7%) |

Real controller, three valid seeds, no unmodelled calls: the isolated mid-run capital phase, not
BN5 completion. It pinned three constraints — an unlock proposal reports ROI against ALL capital
the proposal requires, not just the next spend; a wealth snapshot combines cash and positions
from one probe, so a stale balance cannot complete a wealth goal; and outside BN8 the peak RAM
reserve waits for TIX (BN8 keeps it from pass one, TIX being free there).

The tab measures the run rather than the tick. Two bands, both drawn from the
viewer's fold of the topic (`ui/app/project.ts`), because in each case the gap is
the finding and differencing either curve destroys it:

- **book at market against book at cost** — the gap is unrealised P/L, and the
  crossing is the moment the open book goes underwater.
- **realised net against cumulative unlock spend** — the crossing is the moment
  the market has earned back the $200m/$5b/$25b of access it was given, which is
  the quantity the whole unlock ladder argues about. Realised net is taken at
  COST BASIS, matching `earnedSinceInstall`, so it is unmoved by opening a
  position and by price wobble.

Both are per-install: positions die at the reset and every symbol is re-rolled,
so a curve spanning one would be two markets drawn as one line. What survives is
one closed-out figure per install — sound because `plan.flat` is required to
install at all. The headline figure is `tradeCashFlow + portfolioValue`, the
contribution with no probe-cadence skew, next to the measured $/sec the
working-capital claim actually bids with. The unlock table now shows
`investmentCost` beside `cost`, so the ROI-against-all-capital constraint pinned
above is readable rather than asserted, and `plan.horizons` is shown as a tile
that says "collapsed" — the failure where no entry clears its round trip and the
feature looks idle instead of blocked.

## BitNode modifiers

| Field | Nodes |
|---|---|
| `FourSigmaMarketDataApiCost` (the $25b) | BN7 2 · BN9 4 · BN11 4 · BN12 `1.02^lvl` · BN13 10 |
| `FourSigmaMarketDataCost` (the $1b, unbought) | BN7 2 · BN9 5 · BN11 4 · BN12 `1.02^lvl` · BN13 10 |
| `ScriptHackMoney` — scales the nudge | BN3 0.2 · BN4 0.2 · BN5 0.15 · BN6 0.75 · BN7 0.5 · BN8 0.3 · BN9 0.1 · BN10 0.5 · BN12 `1/1.02^lvl` · BN13 0.2 · BN14 0.3 |
| `ScriptHackMoneyGain` — scales only hacking's cut | **BN8 0**, and no other node |

From `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`. No node multiplies price, forecast,
volatility, spread, commission or `maxShares`. [BN8](../bitnodes/bn08.md) is the theme node,
[BN5](../bitnodes/bn05.md) the benchmark above. The one non-BitNode modifier is the darknet's
`promoteStock`: volatility only, toward 4x, decaying ×0.4 each cycle (`DarkNet/effects/effects.ts:197-208`).

## Source map

| Concern | File |
|---|---|
| model · recovery · solver | `shared/strategy/stock/market.ts`, `history.ts`, `decide.ts`; symbol data `shared/features/stocks.ts` |
| driver · probes | `game/lib/features/stock.ts` · `game/lib/probes/dodged.ts` (`stock.account`, `stock.tick`, `stock.forecast`, `stock.orders`) |
| topic · tab · sim | `shared/telemetry/topics/stock.ts` · `ui/app/tabs/stock.ts` · `sim/features/stock.ts` |
| capital/earnings curves | `ui/app/project.ts` (`foldStockSeries`, `StockSeries`) · `ui/app/lib/chart.ts` |
| tests | `sim/tests/stock-parity.test.ts`, `stock-market.test.ts`, `stock-strategy.test.ts`, `stock-ladder-profile.test.ts`; viewer fold `tests/ui-stock-series.test.ts` |
| vendored rules | `sim/vendor/bitburner/src/StockMarket/` |

## Open

- The viewer's capital and earnings curves are built per browser session from the
  record stream, so a stored run served compacted (over `COMPACT_OVER_BYTES`,
  `ui/server.ts`) has no history to fold and the charts fill from connect time.
  A hub-side series sidecar in `RunStore.append` would fix it; not yet warranted.
- Does the discrete-grid volatility recovery in `history.ts` still resolve after a darknet
  `promoteStock` charge, which multiplies `mv` off that grid?
- `NUDGE_CONVERGENCE` is asserted at 0.5 as the convergence ramp's midpoint; what does the
  engine measure? And is the $200m WSE rung worth buying, given `purchaseTixApi` (`:317-334`)
  has no WSE prerequisite and nothing scripted reads the flag?
