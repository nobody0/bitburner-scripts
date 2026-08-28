# `corp` — corporation foundation

`corp` currently automates one deliberately small result: establish a
six-city Agriculture division, configure one Operations, Engineer and Business
employee in each city, enable Smart Supply, sell Plants and Food at `MAX` / `MP`,
then stop once the corporation reports positive profit. It does not automate
investment rounds, products, research, advertising, upgrades, shares, going
public, dividends or bribery. No optimality claim is made for this baseline.

The implementation is split between the pure reconciler in
`shared/strategy/corp/decide.ts`, the Netscript driver in
`game/lib/features/corp.ts`, and observations in
`game/lib/probes/{gates,priced}.ts`. The simulator still has no corporation
model; corporation calls must continue to fail as `unmodeled()` there.

## Access and founding

Ownership and access are different facts. `corporation.hasCorporation()` says
only whether one exists. The free `canCreateCorporation(selfFund)` pre-flight
returns one of five enum strings: `Success`, `NoSf3OrDisabled`,
`CorporationExists`, `UseSeedMoneyOutsideBN3`, or `DisabledBySoftCap`
(`Corporation/helpers.ts:30-44`, `NetscriptFunctions/Corporation.ts:620-627`).
The gate probe reads both funding modes, so the driver can run before ownership.

- BN3 uses `createCorporation(name, false)` and seed funding.
- Outside BN3, seed funding is invalid. This implementation self-funds only
  with active SF3 level 3 and an exact $150b one-shot arbiter grant.
- The $50b restart price in `costOfCreatingCorporation(true)` is not reachable
  through the Netscript `createCorporation` function, which passes
  `restart=false`; it is therefore not an automation cost.
- `createCorporation` returns `false` for no access, an existing corporation,
  an empty name, or insufficient self-funding money. For backward compatibility
  the invalid seed path and the softcap prohibition throw instead
  (`NetscriptFunctions/Corporation.ts:629-638`, `Corporation/Actions.ts:33-68`).
- `CorporationSoftcap < 0.15` makes creation unavailable. This rules out BN8
  under the pinned v3.0.1 multipliers.

At creation, BN3 or active SF3 at exactly level 3 grants the Office and
Warehouse API unlocks (`PlayerObjectCorporationMethods.ts:20-24`). SF3.1 and
SF3.2 do not. Their corporations can buy each API for $50b of corporation
funds, but this bounded automation deliberately reports that state as
unsupported rather than pretending it can observe offices it cannot access or
spending permanent corporation funds without a complete bootstrap strategy.

## Reconciliation order

The pure decision function derives every action from the latest observations:

1. Found the corporation by the valid funding path.
2. Verify Office and Warehouse API access.
3. Buy Smart Supply for $25b.
4. Create Agriculture for $40b. A new division already includes its Sector-12
   office and warehouse (`Corporation/Division.ts`).
5. For each missing city, reserve the full $9b office-plus-warehouse cost before
   issuing either call. Existing cities missing only a warehouse cost $5b.
6. Hire one Operations, Engineer and Business employee where capacity allows.
   Existing assignments are never overwritten.
7. Enable Smart Supply and configure Plants and Food sales.
8. Wait for observed `revenue > expenses` and `revenue > 0`, then stop.

Smart Supply is bought before the division as a simple fixed ordering; every
warehouse is still enabled explicitly. `purchaseWarehouse` constructs a plain
`Warehouse`, whose `smartSupplyEnabled` field starts false
(`Corporation/Actions.ts:425-434`, `Corporation/Warehouse.ts:35-36`).
Agriculture is a material industry whose pinned starting cost is $40b
(`Corporation/data/IndustryData.ts:8-21`). Office and warehouse initial costs
are $4b and $5b (`Corporation/data/Constants.ts`).

The action API is mostly `void`, so completing a call is recorded as “issued;
awaiting probe”, not as proof that its effect occurred. Boolean calls such as
`createCorporation` and `hireEmployee` retain their returned success value. The
next observation reconciles partial batches safely.

## Observation and cadence

The core probe reads corporation totals plus the three unlocks. The slower
division probe runs only after both API unlocks are observed and reads offices,
warehouses, and the desired sale settings for Plants and Food. It never queries
an investment offer because investment policy is outside the implemented scope.

The source defines five corporation states — `START`, `PURCHASE`, `PRODUCTION`,
`EXPORT`, `SALE` — across a base 10-second market cycle
(`Corporation/data/Constants.ts:25,52-54`). Revenue and expenses exposed on the
corporation are rolled up at `START` (`Corporation/Corporation.ts:135-160`).
The driver therefore waits for a reported profitable cycle rather than
predicting revenue from a local formula.

Dividends are not automatic corporation income for the player: the corporation
must be public and a dividend rate must be configured. This implementation does
neither and makes no dividend claim.

## Source evidence

All behavior above is audited against pinned Bitburner v3.0.1 commit
`3162fd2590e221eadd0c0fbd46151913f7c4c41c`. The relevant checkout files are
hash-pinned by `tools/vendor.ts`, `sim/vendor/manifest.json`, and
`sim/transcription-sources.ts`:

- `src/Corporation/{Actions,Corporation,Division,OfficeSpace,Warehouse,helpers}.ts`
- `src/Corporation/data/{Constants,CorporationUnlocks,IndustryData}.ts`
- `src/NetscriptFunctions/Corporation.ts`
- `src/PersonObjects/Player/PlayerObjectCorporationMethods.ts`

See `spec/game-source.md` for checkout and drift-verification rules.

## Deferred questions

- Which investment timing and industry sequence is best under each BitNode's
  valuation and softcap multipliers?
- When are products, upgrades, advertising and research worth their cost?
- When should a corporation go public, pay dividends, issue shares or bribe?
- Should SF3.1/2 bootstrap their two API unlocks automatically, and with what
  strategy before office and warehouse state becomes observable?
