import { describe, expect, test } from "bun:test";
import { ContractRewardType, ContractSystem } from "../features/contracts.ts";
import { CompanySystem } from "../features/companies.ts";
import { FactionSystem } from "../features/factions.ts";
import { ShareSystem } from "../features/share.ts";
import { CodingContractTypes } from "../vendor/bitburner/src/CodingContract/ContractTypes.ts";
import { mockServer } from "../core/mocks.ts";
import { mulberry32 } from "../core/rng.ts";
import { SimWorld } from "../world.ts";
import type { SimServer } from "../core/effects.ts";

function harness(seed = 1) {
  const world = new SimWorld({ seed, bitnode: 1, network: [] });
  const target = mockServer({ hostname: "n00dles", hasAdminRights: true }) as SimServer;
  target.simKind = "Server";
  target.purchasedByPlayer = false;
  world.servers.set(target.hostname, target);
  const files = new Map<string, Set<string>>([["home", new Set()], [target.hostname, new Set()]]);
  const factions = new FactionSystem(world, world.player, {}, new ShareSystem(world));
  const companies = new CompanySystem(world, world.player);
  const contracts = new ContractSystem({
    world,
    player: world.player,
    servers: world.servers,
    files,
    random: mulberry32(seed),
    factions,
    companies,
  });
  return { world, files, contracts };
}

describe("coding-contract runtime", () => {
  test("a generated contract is discoverable, pays, and disappears when solved", () => {
    const { world, files, contracts } = harness(4);
    const contract = contracts.generate("n00dles", 0.5, 1)!;
    contract.reward = ContractRewardType.Money;
    const beforeMoney = world.player.money;
    const beforeContractMoney = world.moneySources.sinceStart.codingcontract;
    expect(contract.filename).toMatch(/^contract-[A-Za-z0-9]{6}\.cct$/);
    expect(files.get("n00dles")).toContain(contract.filename);

    const answer = CodingContractTypes[contract.type].getAnswer(contract.state);
    expect(contracts.attempt("n00dles", contract.filename, answer)).not.toBe("");
    const gain = world.player.money - beforeMoney;
    expect(gain).toBeGreaterThan(0);
    expect(world.moneySources.sinceStart.codingcontract - beforeContractMoney).toBe(gain);
    expect(files.get("n00dles")).not.toContain(contract.filename);
    expect(() => contracts.triesRemaining("n00dles", contract.filename)).toThrow();
  });
});
