import { describe, expect, test } from "bun:test";
import {
  cacheProfit,
  emptyDnetProfit,
  mergeDnetProfit,
  phishProfit,
  promotionProfit,
} from "../game/dnet/profit.ts";

const observedCache = (filename = "loot.cache") => ({
  filename,
  contractsCreated: 0,
  dataFilesRead: 0,
  dataFilesParsed: 0,
});

describe("darknet return telemetry", () => {
  test("phishing distinguishes failures, cache wins, and displayed cash", () => {
    const total = emptyDnetProfit();
    mergeDnetProfit(total, phishProfit("There were no takers on that phishing attempt.", false));
    mergeDnetProfit(total, phishProfit("Phishing attack succeeded! Found a cache file. (Gained 50 cha xp)", true));
    mergeDnetProfit(total, phishProfit("Phishing attack succeeded! $123.40k retrieved. (Gained 50 cha xp)", true));

    expect(total.phishAttempts).toBe(3);
    expect(total.phishSuccesses).toBe(2);
    expect(total.phishCachesCreated).toBe(1);
    expect(total.phishCash).toBe(123_400);
  });

  test("cache results retain useful non-cash identities without log lines", () => {
    const total = emptyDnetProfit();
    for (const message of [
      "You have discovered the program BruteSSH.exe.",
      "You have discovered a stock option cache containing 17 shares of ECP!",
      "New coding contracts are now available on the network!",
      "You have discovered a cache with $2.500m.",
    ]) mergeDnetProfit(total, cacheProfit(message, observedCache()));

    expect(total.cachesOpened).toBe(4);
    expect(total.cacheCash).toBe(2_500_000);
    expect(total.cacheShares).toBe(17);
    expect(total.cacheRewards).toEqual({
      "program: BruteSSH.exe": 1,
      "shares: ECP": 1,
      "coding contracts": 1,
      money: 1,
    });
  });

  test("cache file observations expose the phishing-to-contract and data-file funnel", () => {
    const total = emptyDnetProfit();
    mergeDnetProfit(total, cacheProfit("New coding contracts are now available on the network!", {
      filename: "mail_123.d.cache",
      contractsCreated: 2,
      dataFilesRead: 3,
      dataFilesParsed: 2,
    }));
    expect(total).toMatchObject({
      cachesOpened: 1,
      phishCachesOpened: 1,
      cacheContractsCreated: 2,
      cacheDataFilesRead: 3,
      cacheDataFilesParsed: 2,
    });
  });

  test("cache cash follows currency display settings without mistaking an augmentation for money", () => {
    const total = emptyDnetProfit();
    mergeDnetProfit(total, cacheProfit("You have discovered a cache with €2,500m.", observedCache()));
    mergeDnetProfit(total, cacheProfit("You have discovered a cache with 1.250m¤.", observedCache()));
    mergeDnetProfit(total, cacheProfit("You have discovered a cache with the augmentation SPTN-97 Gene Modification!", observedCache()));

    expect(total.cachesOpened).toBe(3);
    expect(total.cacheCash).toBe(3_750_000);
    expect(total.cacheRewards).toEqual({ money: 2, "augmentation: SPTN-97 Gene Modification": 1 });
  });

  test("promotion reports activity and threads without inventing cash profit", () => {
    const total = emptyDnetProfit();
    mergeDnetProfit(total, promotionProfit("ECP", 8, true));
    mergeDnetProfit(total, promotionProfit("ECP", 4, false));

    expect(total.promotionAttempts).toBe(2);
    expect(total.promotionBatches).toBe(1);
    expect(total.promotionThreads).toBe(8);
    expect(total.promotionSymbols).toEqual({ ECP: 1 });
  });
});
