# Feature catalog

One entry per feature in `shared/features/registry.ts`:

- **Unlock** — what makes it playable, and what detecting that costs
- **Needs** — what it consumes, in `NeedKind` terms (`shared/strategy/needs.ts`)
- **Gives** — what it produces that others consume
- **Contends** — which arbitrated resource it fights over
  (`shared/strategy/arbiter.ts`: money, the work slot, dodge RAM)

Same edges as [`graph.md`](graph.md); this is the per-node view.
Status matches `spec/progress.md`: **sim** = has a simulator model,
**unit** = pure strategy + driver + unit tests only.

| Feature | Theme BNs | Status |
|---|---|---|
| `progression` | 12 | unit |
| `hacking` | 1, 5 | sim (targeting) |
| `factions` | 4 | sim |
| `career` | 11 | sim (crime) |
| `hacknet` | 9 | sim |
| `stock` | 8 | unit |
| `gang` | 2 | unit |
| `corp` | 3 | unit |
| `bladeburner` | 6, 7 | unit |
| `sleeves` | 10 | unit |
| `go` | 14 | unit |
| `stanek` | 13 | unit |
| `dnet` | 15 | unit |
| `side` | — | unit |

**A Source-File is no longer sufficient for "unlocked".** `BitNodeBooleanOptions`
lets a run disable gang, corp, bladeburner, 4S data, hacknet servers and sleeve
exp/augs, and `sourceFileOverrides` can lower an SF's active level.
`ns.getResetInfo()` returns `currentNode`, `ownedAugs`, `ownedSF` (active levels,
already options-aware — do not re-apply the overrides) and `bitNodeOptions`, all
for the 1 GB the gate probe already spends. `shared/features/unlock.ts` reads
them: `disableGang` / `disableCorporation` / `disableBladeburner` veto a feature
to `"no"`, while the four that merely degrade travel in `Capabilities
.restrictions` for drivers to lower their ambition against.

**Per-node multipliers are known without SF5.** `ns.getBitNodeMultipliers` costs
4 GB *and* requires BN5/SF5, so it is unusable as a general source — which used
to mean every consumer silently assumed 1.0. `shared/features/bitnode.ts` now
transcribes the whole table (`bitNodeMultipliers(n, sf12Level)`,
`worldDaemonSkill(n)`), pinned field-by-field against the vendored original by
`sim/tests/bitnode-parity.test.ts`. It returns `undefined` for an unknown node
rather than defaulting to BN1, because BN1 is the all-ones baseline and
guessing it is the most dangerous wrong answer available.

---

## `progression` — the reset loop

**Unlock** Always. Gate is `ns.getResetInfo` (1 GB).

**Needs** Everything: augs owned, faction rep and favor, money, SF levels.

**Gives** The install and BitNode-destroy decisions, and via augmentations the
permanent multipliers every other feature runs on. The only feature that raises
the others' ceiling.

**Contends** Money, decisively — an install spends everything.

**Must know:**
- Faction **rep resets to 0 on install** and converts to permanent **favor**
  (`addRepToFavor`). Favor is durable, rep is perishable.
- Donations unlock at `150 × FavorToDonateToFaction` favor, at **$1e6 per rep**.
- Augs escalate **×1.9 per queued aug**, reduced 4/6/7% by SF11 level.
- Install also resets money → $1000, city → Sector-12, jobs, purchased servers,
  all skills, **kills**, faction membership. It does **not** reset karma, favor,
  home RAM or programs.
- BitNode reset additionally zeroes karma and every feature's state.
- The Red Pill has **three** sources: Daedalus (except BN15), a gang faction in
  BN2, and the darknet labyrinth in every node except BN8. Bladeburner is the
  fourth completion route and needs no pill. Do not hard-code the Daedalus path.

---

## `hacking` — the farm

**Unlock** Always. Scan → root → deploy → HWGW dispatch (`spec/targeting.md`).

**Needs** Port openers (money or work slot), hacking skill, fleet RAM.

**Gives** Money; hacking exp → skill → **backdoors**, which is how `factions`
gets CyberSec, NiteSec, The Black Hand and BitRunners. In BN8, price movement
instead of money.

**Contends** Dodge RAM — the heap hands the dispatcher everything above
`HOME_RESERVE_GB`. In BN8 also target choice, against `stock`.

**Fragile to** `ScriptHackMoney`, `ServerMaxMoney`, `ServerGrowthRate`,
`ServerWeakenRate`, `HackExpGain`, and especially **`HackingSpeedMultiplier`**
(0.3 in BN14, 0.6 in BN15), which changes batch *timing*, not yield.

---

## `factions` — reputation and augmentations

**Unlock** BN4 or SF4. Without Singularity, joinable by hand but **not
automatable** — the most consequential capability gate we have.

**Needs** — the most inbound edges of any feature:

| From | Need | For |
|---|---|---|
| `hacking` | `backdoor` | CyberSec `CSEC`, NiteSec `avmnite-02h`, Black Hand `I.I.I.I`, BitRunners `run4theh111z`, Fulcrum `fulcrumassets` |
| `career` | `karma` | Slum Snakes −9, Tetrads −18, Silhouette −22, Speakers −45, Dark Army −45, Syndicate −90 |
| `career` | `kills` | Dark Army 5, Speakers 30 |
| `career` | `combatSkills` | Slum Snakes 30, Tetrads 75, Syndicate 200, Dark Army/Speakers 300, Covenant 850, Illuminati 1200, Daedalus 1500 |
| `career` | `jobTitle` | Silhouette — CTO, CFO or CEO |
| `career` | `companyRep` | Ten megacorp factions, 400 000 each |
| `career` | `quitCompany` | Speakers, Dark Army and Syndicate all require **not** working for CIA or NSA |
| `career` | `city` | Six city factions require *being in* the city; Tetrads / Tian Di Hui / Dark Army need Chongqing, New Tokyo or Ishima; Syndicate needs Aevum or Sector-12 |
| any | `money` | City factions $15m–$50m, Syndicate $10m, Silhouette $15m, Covenant $75b, Daedalus $100b, Illuminati $150b |
| `hacknet` | `hacknetRam`/`Cores`/`Levels` | Netburners: 8 RAM, 4 cores, 100 levels |
| `bladeburner` | `bladeburnerRank` | Bladeburners faction at rank 25 |
| `progression` | `augCount` | Covenant 20, Daedalus 30 (BN-dependent), Illuminati 30 |

**Gives** Augmentations — the only permanent multiplier source — and favor,
which persists across installs. Grafting lives here.

**Plans** A finite-horizon frontier of `(faction, reputation breakpoint,
augmentation package)` choices. Package value counts each shared augmentation
once, adds route-weighted multiplier utility, and includes the exact future
favor gained at install. The best package is extended only while its next
marginal value per second beats the best residual package at another faction.
That runner-up remains the opportunity cost after an enemy join: once the
promised breakpoint is complete, the feature recommends installing and chooses
the enemy afresh next cycle. Immediately before that recommendation it drains
every affordable joined-faction augmentation, including an exact donation when the
donation plus purchase can both be reserved.

**Chooses by value, pays by price.** Every queued non-SoA purchase multiplies the
price of the next by 1.9, and an augmentation does nothing until it is installed —
so there is no reason to want a cheap one early, and the dearest item belongs in
the cheapest slot. Sets are selected on value and bought in `orderPurchases` order,
and every cost estimate is taken from that ordered sequence. The budget behind both
is `settlingMoney`: cash **plus the market book**, which is liquidated before every
install. A cash shortfall on the dearest item therefore makes the feature wait
rather than buy something cheaper out of order — bounded by money that has a
settlement date, never by income over the horizon, and never on the run's first
purchase, because the liquidation it would be waiting for needs a non-empty install
queue to be triggered at all.

**Contends** The work slot, hard. `ns.singularity.workForFaction` **cancels**
whatever is running; the loser's progress is destroyed, not delayed. That is why
the arbiter needs pre-emption rules, not fairness rules. It bids the reputation
per second it would earn and is priced against the field like anything else —
only a route-MANDATORY install takes the slot by band instead.

**Source of truth** `sim/vendor/.../Faction/FactionTable.ts` — flat
`PlayerRequirement[]` exactly as `getFactionInviteRequirements` returns, so
`shared/strategy/factions/requirements.ts` evaluates live and vendored data with
one code path.

---

## `career` — jobs, crime, karma, skills

**Unlock** Always playable; automatable with SF4. Karma lives here because it is
a *precondition* others wait on, not an objective of its own.

**Needs** The work slot, and nothing else. The closest thing to a graph root.

**Gives** — the widest output set, which is why it is so contended:

| Output | Source | Consumers |
|---|---|---|
| Karma | Crime (player, sleeves, gang) | `factions` invites, `gang` (−54 000) |
| Kills | Homicide and Assassination only | `factions` (Speakers 30, Dark Army 5) |
| Combat skills | Crime exp, gym, faction field work | `factions`, `bladeburner` |
| Charisma | Company work, university, `dnet` phishing | Promotions → `factions` (Silhouette), `dnet` heartbleed gate + labyrinth ladder |
| Hacking skill | University, and `hacking`'s own exp | `hacking`, `factions` |
| Company rep | Company work | `factions` — ten megacorps at 400k |
| Money | Salary, crime | Everything |
| City | Travel, $200 000 | `factions` city requirements |

**Contends** The work slot — the primary claimant. It bids what the option it
would run PRODUCES (money, experience, karma, company reputation), never an
urgency band: touching a blocking need is not the same as delivering it, and
scoring the two the same way once held `Player.currentWork` for six hours on a
crime worth a millionth of the farm's income.

A **program write** is the one option that is not a rate held for the rest of the
run: it blocks the slot for its whole duration and delivers the file at the end.
It is therefore scored on the share of the planning horizon left once it
finishes, and on what the file is actually worth — the board's own value for
every server the new opener unblocks (`ServerAccessPlan.writeProgramValueSec`),
not a nominal weight identical for BruteSSH and SQLInject. Both sides estimated,
and the auction decides.

**Crime table** (`sim/vendor/.../Crime/CrimeTable.ts`):

| Crime | Time | Money | Karma | Kills |
|---|---|---|---|---|
| Shoplift | 2 s | $15k | 0.1 | 0 |
| Mug | 4 s | $36k | 0.25 | 0 |
| Deal Drugs | 10 s | $120k | 0.5 | 0 |
| Traffick Arms | 40 s | $600k | 1 | 0 |
| Rob Store | 60 s | $400k | 0.5 | 0 |
| Larceny | 90 s | $800k | 1.5 | 0 |
| **Homicide** | **3 s** | $45k | **3** | **1** |
| Grand Theft Auto | 80 s | $1.6m | 5 | 0 |
| Kidnap | 120 s | $3.6m | 6 | 0 |
| Bond Forgery | 300 s | $4.5m | 0.1 | 0 |
| Assassination | 300 s | $12m | 10 | 1 |
| Heist | 600 s | $120m | 15 | 0 |

Homicide is the karma engine — 1 karma/second at full success, and the only
practical kill source. Everything else is strictly worse per second on the karma
axis. That is why `factions` posting `karma −45` and `gang` posting `karma
−54 000` resolve to the same action, and why the weights **add**.

Times are `timeMs`; success scales with skills, so early rates are far lower —
and `CrimeSuccessRate` is 0.4 in BN14.

---

## `hacknet` — nodes, servers, hashes

**Unlock** Always for Nodes. **Hacknet Servers** need BN9 or SF9 (and are
disableable by BitNode options).

**Needs** Money, continuously.

**Gives** Money (Nodes), or hashes (Servers) → money, server RAM/cores, target
min-security ↓ and max-money ↑, corporation funds, Bladeburner rank/SP, contract
generation. Hacknet Servers are also **fleet RAM**.

**Contends** Money. One-step node/level/RAM/core/cache candidates are valued in
`marginal $/sec / cost`. Candidates whose payback exceeds the planning horizon
are discarded, then the fastest ROI competes directly with home RAM, home
cores, and purchased-server purchases/upgrades through the shared money
arbiter. Hacknet-server RAM is part of the hacking fleet; its value accounts
for both hacking income and the hash production lost while that RAM is busy.

**The interesting edge** Hash upgrades that lower a target's min security and
raise its max money feed straight back into `hacking`'s target score, making
`hacknet` → `hacking` an optimization loop rather than a one-way income line.
The hash spender observes the live upgrade menu, reserves for the highest-value
available goal, requests cache when that goal exceeds capacity, and otherwise
sells hashes. It can serve faction Hacknet milestones, training/company needs,
the active Bladeburner or corporation route, and ROI-positive mutations of the
current farm target.

**Legacy comparison** The 2023 controller had Hacknet entirely commented out;
its saved policy bought any node/level/RAM/core quote below 1% of cash, without
ROI, horizon, hashes, or BitNode handling. That predecessor bought fixed 8 GB
servers, then doubled them only after filling every slot. The abandoned 2024
rewrite introduced the useful candidate-ranking idea: compare home RAM, home
cores, new servers, and server upgrades by capacity gained per dollar. The
current arbiter migrates that idea using actual marginal farm income, makes each
purchase atomic, and adds the missing run-horizon and cross-feature comparison.

**Fragile to** `HacknetNodeMoney` — 0 in BN8, 0.05 in BN4. The feature needs an
explicit "off" state, not a slower cadence.

---

## `stock` — the market

**Unlock** Always — the market is money-gated, not capability-gated. WSE $200m →
TIX API $5b buys positions; SF8.1 grants both permanently. Shorts need SF8.2,
limit/stop orders SF8.3 (not modelled).

**Needs** Money. The **4S Market Data TIX API** ($25b, multiplied in BN9/BN11/
BN13 and disableable by BitNode options) is the only 4S purchase worth making:
`getForecast` and `getVolatility` check `has4SDataTixApi`, and buying it does not
require the $1b `has4SData` first — so the $1b buys an automated player nothing.
Without it, the forecast is recovered from up-tick frequency and the volatility
from the shared per-tick roll (`shared/strategy/stock/history.ts`).

**Gives** Money — and in BN8 it is the *only* money.

**Contends** Money; and **target choice** against `hacking`, because hack/grow
move prices. That contention is now priced: `stock` publishes a per-host
manipulation intent and a dollar value per influencing op, and `solveCycle` adds
it as a second income term to the same `$/GB/sec` score
([spec/targeting.md](../targeting.md)).

**Fragile to** `FourSigmaMarketDataApiCost` (whether the forecast is affordable),
and to `ScriptHackMoney` / `ScriptHackMoneyGain` — which move the manipulation
trade-off in OPPOSITE directions, since influence is measured before the player's
cut. A position is also destroyed outright by an augmentation install
(`prestigeAugmentation` → `initStockMarket`), so the portfolio must be liquid
before `progression` resets.

---

## `gang` — territory and respect

**Unlock** `gang.inGang()` — **0 GB**, our cheapest gate. Founding one needs
membership in one of seven factions (Slum Snakes, Tetrads, The Syndicate, The
Dark Army, Speakers for the Dead, **NiteSec**, **The Black Hand**) plus either
`bitNodeN === 2`, which waives the karma check, or SF2 **and karma ≤ −54 000**.

**Needs** `karma` −54 000 — by far the largest single need any feature posts,
and why `career`'s karma objective has two very different targets.

**Gives** Money, reputation with the gang's faction, and the **largest
augmentation pool of any faction**. This is the "gangs can also get us
augmentations" path: it substitutes for the faction-work rep grind entirely.
In BN2 the gang faction also sells **The Red Pill**.

**Contends** Money (equipment, ascension) — but notably **not the work slot**.
Gang members act independently of `Player.currentWork`, which makes gangs
unusually cheap in the resource that is otherwise scarcest.

---

## `corp` — the corporation

**Unlock** `corporation.hasCorporation()` — 0 GB. Creating one needs
`canAccessBitNodeFeature(3) && !bitNodeOptions.disableCorporation`. Being in BN3
**or** holding SF3 at exactly level 3 grants `WarehouseAPI` + `OfficeAPI` at
creation — the "full API".

**Needs** A large seed investment; later employees, research, market knowledge.

**Gives** Money at a scale nothing else reaches, and therefore faction rep via
donation.

**Contends** Money.

**Fragile to** `CorporationValuation` — 0 in BN8, 0.001 in BN13. The feature most
often disabled outright by a node, so the driver must **not run** gracefully.

---

## `bladeburner` — the NSA division

**Unlock** `bladeburner.inBladeburner()` — 0 GB. Both the division and the ns
API need `canAccessBitNodeFeature(6) || canAccessBitNodeFeature(7)` — **BN6 or
SF6 is enough for scripting**; SF7 only adds multipliers. Disableable by BitNode
options.

**Needs** Combat skills, and continuous stamina/health management.

**Gives** Rank → the Bladeburners faction (rank 25) and its 18 augmentations,
plus money. **SF7.3 grants The Blade's Simulacrum on joining** — which installs
an augmentation, and therefore bans the Church of the Machine God outside BN13.
With SF7.3, accept Stanek's Gift *first*.

**Contends** The work slot.

---

## `sleeves` — parallelism

**Unlock** BN10 or SF10. Count is
`min(3, SF10 level + (BN10 ? 1 : 0)) + sleevesFromCovenant`, covenant capped at
**5**, so a ceiling of **8**. Sleeves cannot be bought or upgraded outside BN10.

**Needs** Money (covenant sleeves cost `10^n × base`; sleeve augs), and shock
recovery time.

**Gives** **The work slot, N more times** — the only feature that relieves the
game's tightest constraint. A sleeve can commit crime (karma and kills in
parallel), work a faction, train, recover shock, or work a company — but only
one the **player already holds a job at** (`Sleeve.ts:410` checks
`Player.jobs[companyName]`). So the pattern is: player collects jobs, sleeves
grind their reputations.

**Contends** It *supplies* the contended resource rather than consuming it.
That structural difference is why enabling sleeves should change the arbiter's
model, not just add a driver.

---

## `go` — IPvGO

**Unlock** `go.getGameState()` — 0 GB, **available in every BitNode with no
Source-File**. `go.cheat` needs SF14.2.

**Needs** Wall time and dodge RAM, but no money and not the player's work slot.
The essential board/action calls cost 4 GB. The controller handcrafts the
published WHRNG for seed-aware opponent forecasts without importing game source
at runtime. It is still the cheapest feature in the graph by economic resources.

**Gives** Node **power** (stat multipliers, ×4 in BN14, +100% with SF14.1) and
**faction favor** from winstreaks, capped by SF14 level.

Because favor survives installs and unlocks donations, a Go win is a
*permanent* contribution to `factions` — one of very few things that is.

**Contends** Only dodge RAM. Opponent selection consumes the needs board but
does not reserve what it improves: a Daedalus game can raise faction/company
rep multipliers in parallel with faction work, for example.

---

## `stanek` — the Gift

**Unlock** BN13 or SF13. Outside BN13 the Church is **banned** if you own any
augmentation other than NeuroFlux Governor, so acceptance is install-timed and
irreversible. **In BN13 there is no ban.**

**Needs** RAM and script time to charge fragments; grid space is the constraint
(`StaneksGiftExtraSize`, additive, −99 in BN8 to +2).

**Gives** Multipliers scaling with charge and `StaneksGiftPowerMultiplier`
(2× in BN2 and BN13).

**Contends** Fleet RAM, against `hacking`.

**Ordering** With SF7.3, accept the Gift **before** joining Bladeburner.

---

## `dnet` — the darknet

**Unlock** BN15, an active SF15, **or** `DarkscapeNavigator.exe` on home — the
last is not source-file gated. **SF15.1 unlocks the full dark web in every
BitNode** and permanently grants the TOR router and DarkScape.

**Needs** **Charisma**, for the **labyrinth ladder** (`LABYRINTH_CHARISMA =
[300, 600, 1500, 2500, 3000, 3500, 4000]`) and as a hard gate on `heartbleed`.
For `authenticate` charisma is only a duration scalar, not a requirement.
SF15.2/15.3 scale job and faction rep off it, and BN15 is the only node that
buffs `CharismaLevelMultiplier`. Also needs **a credential per host** and **a
directly-connected host we already run scripts on** — those are the real gates.

**Gives** Money, where the node allows it — `DarknetMoneyMultiplier` is 1 in
BN15 but 0 in BN8 and as low as 0.05 elsewhere. Charisma back to `career`, via
`phishingAttack()` and the labyrinth augmentations. A `stock` interaction via
`promoteStock()`, which raises volatility rather than earning directly. And
**The Red Pill** from the labyrinth — in every BitNode except BN8, not just
BN15.

**Contends** **Dodge RAM on home**, for the report sweep and the launch stub.
Not fleet RAM: darknet hosts never appear in `ns.scan`, so they are never in the
server snapshot or the heap, part of their RAM is owner-blocked, and they can
vanish. `memoryReallocation()` grows that separate pool. Also the work slot for
labyrinth actions.

**Remote execution** See [`spec/dnet.md`](../dnet.md) — `probe()` is host-local,
sessions are per-PID, and only `exec` is distance-gated.

---

## `side` — coding contracts

**Unlock** Always.

**Needs** Fleet scanning and CPU.

**Gives** Money (`CodingContractMoney`) and occasional faction reputation.

**Contends** No player-time slot. Contract inspection and attempts use bounded
fleet RAM dodges.

**Intentional boundary** Infiltration and the casino are manual UI gameplay.
They are not probed, ranked, simulated, or presented as automation work.
Shadows of Anarchy invitation/membership is accepted as evidence of the one
manual infiltration the game requires.
