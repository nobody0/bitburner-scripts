# `career` — crime, jobs, karma, stats

One body, one `Player.currentWork` slot: crime, courses, company work, program writing, and the instant calls
(apply, promote, quit, travel). Nearly everything it produces is a precondition another feature waits on,
which makes it the needs board's main consumer and the graph root ([`graph.md`](../graph.md)).

> "Reach the stat, karma and company-rep thresholds other features depend on
> (gang needs -54k karma; Bladeburner needs 100 in every combat stat) as fast as
> possible, using crime as early income."

**Theme** BN11 The Big Crash (`shared/features/registry.ts:76-84`) · **Status** done (`spec/progress.md:30`) · citations are repo-root paths, abbreviated inside `shared/strategy/` (`career/`, `income.ts`, `progression/`, `arbiter.ts`), `game/lib/features/` and `sim/vendor/bitburner/src/`

## Unlock

Always playable (`shared/features/unlock.ts:107`); the *automation* is Singularity: outside BN4 it needs SF4,
at 16 / 4 / 1 × base RAM by SF4 level (`types/NetscriptDefinitions.d.ts:1910-1911`) — 5 GB for `commitCrime`,
`getCrimeStats`, `createProgram`, 3 GB for `applyToCompany`, 2 GB for class, gym and travel. No
`BitNodeBooleanOptions` field touches career, but `sourceFileOverrides` at SF4 0 removes the automation.

## Rules

`sim/vendor/bitburner/src/Crime/CrimeTable.ts`. Karma is stored **positive and subtracted** — a crime moves
karma *down*.

| Crime | Time | Money | Karma | Kills | Difficulty |
|---|---|---|---|---|---|
| Shoplift | 2 s | $15k | 0.1 | 0 | 0.05 |
| Homicide | 3 s | $45k | **3** | **1** | 1 |
| Mug | 4 s | $36k | 0.25 | 0 | 0.2 |
| Deal Drugs | 10 s | $120k | 0.5 | 0 | 1 |
| Traffick Arms | 40 s | $600k | 1 | 0 | 2 |
| Rob Store | 60 s | $400k | 0.5 | 0 | 0.2 |
| Grand Theft Auto | 80 s | $1.6m | 5 | 0 | 8 |
| Larceny | 90 s | $800k | 1.5 | 0 | 0.333 |
| Kidnap | 120 s | $3.6m | 6 | 0 | 5 |
| Bond Forgery | 300 s | $4.5m | 0.1 | 0 | 0.5 |
| Assassination | 300 s | $12m | 10 | **1** | 8 |
| Heist | 600 s | $120m | 15 | 0 | 18 |

Rates, transcribed at v3.0.1 in `career/crimes.ts:75-133` and `company.ts:61-113` (`MaxSkillLevel` 975,
`IntelligenceCrimeWeight` 0.025 — `Constants.ts:17,51`):

```
chance = min(1, (Σ weights[skill] × skills[skill] + 0.025 × int) / 975 / difficulty × crime_success × CrimeSuccessRate × (1 + int^0.8 / 600))
karmaPerSec  = (0.25 + 0.75 × chance) × crime.karma / seconds   // kills: chance × crime.kills
moneyPerSec  = chance × crime.money × crime_money × CrimeMoney / seconds
performance  = repMultiplier × (Σ effectiveness[skill] × skills[skill] / 100) / 975 + int / 975
repPerSec    = performance × company_rep × (1 + favor/100) × CompanyWorkRepGain × focus × 5
salaryPerSec = baseSalary × salaryMultiplier × sf11 × CompanyWorkMoney × work_money × sf15 × focus × 5
```

**Homicide is the karma and kill engine.** 3 karma per 3 s is **1 karma/s at full success and 0.25 karma/s at
zero** — failure banks a quarter of the karma and stat experience, kills and intelligence being success-only.
That is 16× the next best (Grand Theft Auto, Mug: 0.0625) and 0.333 kills/s against Assassination's 0.0033,
the only other crime that kills. `chance` is linear in the weighted skills, so early rates run far below that
ceiling and climb with strength and defense (weight 2 each); `CrimeSuccessRate` **0.4** in
[BN14](../bitnodes/bn14.md) scales it toward the 0.25 floor.

**Two karma targets, one action.** Invites sit at −9 Slum Snakes, −18 Tetrads, −22 Silhouette, −45 Speakers
for the Dead and The Dark Army, −90 The Syndicate (`.../Faction/FactionTable.ts`, `inviteReqs`); a gang wants
**−54 000** (`progression/endgame.ts:41`). Karma is not a priced currency, so all open karma needs share one
board key and their worths **add** (`income.ts:337-356`), while the distance used is the nearest threshold
only (`decide.ts:227-248`).

**Company work.** 38 companies, 36 positions, 13 tracks (`.../Company/CompanyTable.ts`). Non-zero skill
requirements rise by the company's `jobStatReqOffset` (249 at ECorp, MegaCorp, NWO; 224 at other megacorps); a
backdoor on its server discounts every reputation gate by 0.75 (`Constants.ts:111`). `focus` is 1 when
part-time, focused, or holding Neuroreceptor Management Implant, else 0.8; 5 is cycles/second
(`sim/features/companies.ts:126-155`). Favor always multiplies reputation, and **SF11 makes it multiply salary
too** — the same `1 + favor/100` on both — over SF11's flat +32 / 48 / 56% to `work_money` and `company_rep`
(`.../SourceFile/applySourceFile.ts:154-164`). Ten megacorps invite at 400 000 reputation (the Head of
Software gate); CTO is 3 200 000, so the walker stops at the target, not the ladder top
(`company.ts:186-313`). Algorithms and Leadership give 8 exp/s at $960/s, each gym stat 10 exp/s at $2 400/s
(`training.ts:16-52`), ×0.9 backdoored, with a 30 s funding window; travel $200 000 (`Constants.ts:29`).

**The work-slot auction rule.** Career bids what an option **produces**, never an urgency band: `Σ_channel
(our rate / best announced rate) × what that channel is worth`, in BN-seconds (`decide.ts:294-341`,
`income.ts`); urgency survives only as a reporting `priority`. Banding it stalled a live BN12 run for six
hours: a crime worth $1.8e4/s against a $1e11 gate the farm closed at $3.25e8/s scored as blocking and held
the slot for four ten-thousandths of the progress (`arbiter.ts:296-313`).

A **program write** is the one option that is not a rate held for the rest of the run: it blocks the slot for
its whole duration and delivers at the end — so the duration is charged as `occupiesSec` outside the rate and
discounted by `deliveryFraction = 1 - occupiesSec / horizonSec` (`income.ts:212-216`, applied at
`decide.ts:307-311`), a part-finished write paying only for the time left. Its worth is the board's own value
for every server the new opener unblocks: `ServerAccessPlan.writeProgramValueSec`, the ranked candidates
summed and clamped to the node horizon (`hacking.ts:1479-1491`, `:2015-2031`) — never a nominal weight equal
for BruteSSH and SQLInject.

## Needs · Gives · Contends

**Needs** the work slot, money for tuition and fares, dodge RAM; inbound edges are rare (`go` node power,
`dnet` phishing charisma).

| Gives (`NeedKind`) | Source | Consumers |
|---|---|---|
| `karma`, `kills` | crime; kills only Homicide, Assassination | `factions` invites and kills (Speakers 30, Dark Army 5), `gang` at −54 000 |
| `combatSkills` | crime exp, gym, faction field work | `factions`, `bladeburner` |
| `charisma` | company work, Leadership, `dnet` phishing | `factions` (Silhouette), `dnet` labyrinth ladder |
| `skill:hacking` | Algorithms, and `hacking`'s own exp | `hacking`, `factions` |
| `companyRep` | company work | `factions` — ten megacorps at 400k |
| `money` · `city` | salary, crime · travel at $200 000 | everything · `factions` city requirements |
| `file` · `employment`, `jobTitle`, `quitCompany` | program write · apply / promote / quit | `hacking` server access · `factions` |

**Contends** the work slot with `factions`, `bladeburner`, grafting and program creation; money with every
other buyer. `career:progress-lock` 120 (hard, bounded by the in-flight unit's bank time),
`career:blocking-need` 109 and `career:income` 30 are money/RAM bands — the time claim has none
(`arbiter.ts:313-339`).

## Challenges

- **Progress work is a transaction.** Crime and grafting bank only at completion, so the lock must be bounded
  by the computed bank time — an unarmed watcher once held the slot for a whole run, and re-committing the
  longest crime at each boundary renewed it forever (`schedule.ts:52-88`).
- **A cold menu is not an empty menu.** The crime table comes from a five-minute priced probe, so an option
  that must occupy the slot waits while `menuComplete` is false; and `Player.currentWork` survives a reload,
  so career needs an explicit `stop` path (`decide.ts:653-716`).
- **A combat need is met by the weakest of four stats**, so a crime or gym session scores on the minimum;
  and an unrequested program write, priced at `-purchaseCost / seconds`, makes the longest look cheapest, so
  only requested files are offered (`decide.ts:343-367`, `:506-519`).

## Rewards

Money and experience immediately; the Gives table as unblocking. Across an **install**
(`sim/world.ts:340-390`, `sim/features/companies.ts:161-168`) skills reset to 1, kills to 0, jobs and city
clear, and company reputation becomes permanent **favor**; karma is never touched, so kills are per-install
and karma long-lived.

## BitNode modifiers

| Field | Nodes |
|---|---|
| `CrimeMoney` | BN2 **3** · BN3 0.25 · BN4 0.2 · BN5 0.5 · BN6/7 0.75 · BN8 **0** · BN9/10 0.5 · BN11 **3** · BN13 0.4 · BN14 0.75 |
| `CompanyWorkMoney` | BN3 0.25 · BN4 **0.1** · BN6/7 0.5 · BN8 **0** · BN10 0.5 · BN11 0.5 · BN13 0.4 |
| BN14 only | `CrimeSuccessRate` **0.4** · `CompanyWorkRepGain` **0.2** — no other node changes either |
| `CrimeExpGain`, `CompanyWorkExpGain`, `ClassGymExpGain` | BN4 0.5 · BN13 0.5 — but see the note below |
| combat · `CharismaLevelMultiplier` | combat BN9 0.45 · BN10 0.4 · BN13 0.7 · BN14 0.5 · BN15 0.7; charisma BN9 0.45 · BN10 0.4 · BN15 **1.1**, the only stat buff anywhere |
| `InfiltrationMoney` · `InfiltrationRep` | money BN2 3 · BN5 1.5 · BN6/7 0.75 · BN8 0 · BN10 0.5 · BN11 **2.5** · BN14 0.75; rep BN5 1.5 · BN11 **2.5** |

> `ClassGymExpGain` is declared by these nodes but **inert in v3.0.1**: `calculateClassEarnings` (`src/Work/Formulas.ts:108-121`) never reads it, so university and gym run at full rate.

[BN12](../bitnodes/bn12.md) scales all of these with node level. [BN11](../bitnodes/bn11.md) is the theme
node: crime ×3 and infiltration ×2.5 against a 1% farm, so career carries the run; [BN2](../bitnodes/bn02.md)
pairs `CrimeMoney` 3 with the karma-gated crime factions, or a backdoor route to a zero-karma gang.
**Infiltration stays out of the roster**: a manual minigame whose automation would need DOM or synthetic
input, a boundary that holds even at BN11's ×2.5.

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/career/` — `crimes`, `company`, `programs`, `training`, `schedule`, `decide` |
| driver · probes | `game/lib/features/career.ts` · `game/lib/probes/priced.ts` (`career.work`, `career.crimes`) |
| telemetry · tab | `shared/telemetry/topics/career.ts` · `ui/app/tabs/career.ts` |
| sim · vendored | `sim/features/` (`crime`, `companies`, `education`, `programs`) · `sim/vendor/bitburner/src/` (`Crime/CrimeTable.ts`, `Company/CompanyTable.ts`, `Constants.ts`) |

## Open

- Does karma reset on entering a new BitNode? The install path is verified (`sim/world.ts:340-390` never
  touches it), but the sim has no node-reset path and the vendored extract carries no `prestigeSourceFile`.
- Can the registry's "Bladeburner needs 100 in every combat stat" be checked here? That requirement is not in
  the vendored extract.
