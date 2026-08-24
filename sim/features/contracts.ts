import type { SimServer } from "../core/effects.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import type { CompanySystem } from "./companies.ts";
import type { FactionSystem } from "./factions.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { CodingContractName } from "../vendor/bitburner/src/CodingContract/Enums.ts";
import { CodingContractTypes } from "../vendor/bitburner/src/CodingContract/ContractTypes.ts";
import { FACTION_TABLE } from "../vendor/bitburner/src/Faction/FactionTable.ts";

export enum ContractRewardType {
  FactionReputation,
  FactionReputationAll,
  CompanyReputation,
  Money,
}

export interface SimContract {
  filename: string;
  host: string;
  type: CodingContractName;
  state: unknown;
  reward: ContractRewardType;
  rewardScaling: number;
  tries: number;
}

export interface ContractSystemOptions {
  world: SimWorld;
  player: SimPlayer;
  servers: Map<string, SimServer>;
  files: Map<string, Set<string>>;
  random: () => number;
  factions: FactionSystem;
  companies: CompanySystem;
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Controller-facing v3.0.1 Coding Contract lifecycle.
 *
 * Problem definitions are the vendored upstream implementations. This class
 * owns only placement, tries, rewards and the file-system projection that the
 * controller observes through ls/read/rm. */
export class ContractSystem {
  readonly contracts = new Map<string, SimContract>();
  readonly #opts: ContractSystemOptions;

  constructor(options: ContractSystemOptions) {
    this.#opts = options;
  }

  #key(host: string, filename: string): string {
    return `${host}\0${filename}`;
  }

  #int(maxExclusive: number): number {
    return Math.floor(this.#opts.random() * maxExclusive);
  }

  #filename(host: string): string | undefined {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += ALPHANUMERIC[this.#int(ALPHANUMERIC.length)];
    const filename = `contract-${suffix}.cct`;
    return this.contracts.has(this.#key(host, filename)) ? undefined : filename;
  }

  #reward(): ContractRewardType {
    const count = currentNodeMults.CodingContractMoney > 0 ? 4 : 3;
    return this.#int(count) as ContractRewardType;
  }

  #withRandom<T>(fn: () => T): T {
    const original = Math.random;
    Math.random = this.#opts.random;
    try {
      return fn();
    } finally {
      Math.random = original;
    }
  }

  generate(host: string, rewardScaling = 1, maxDifficulty = 10): SimContract | undefined {
    if (!this.#opts.servers.has(host)) return undefined;
    const types = Object.values(CodingContractName).filter(
      (type) => CodingContractTypes[type].difficulty <= maxDifficulty,
    );
    const type = types[this.#int(types.length)]!;
    const filename = this.#filename(host);
    if (!filename) return undefined;
    const contract: SimContract = {
      filename,
      host,
      type,
      state: this.#withRandom(() => CodingContractTypes[type].generate()),
      reward: this.#reward(),
      rewardScaling,
      tries: 0,
    };
    this.contracts.set(this.#key(host, filename), contract);
    let files = this.#opts.files.get(host);
    if (!files) this.#opts.files.set(host, files = new Set());
    files.add(filename);
    return contract;
  }

  generateRandom(): SimContract | undefined {
    const eligible = [...this.#opts.servers.values()].filter(
      (server) => server.simKind === "Server"
        && !server.purchasedByPlayer
        && server.hostname !== "w0r1d_d43m0n"
        && server.hostname !== "home",
    );
    if (eligible.length === 0) return undefined;
    const server = eligible[this.#int(eligible.length)]!;
    const totalSourceFiles = Object.values(this.#opts.player.sourceFiles).reduce((sum, level) => sum + level, 0);
    return this.generate(server.hostname, 1, 2 * totalSourceFiles + 1);
  }

  generateAttempts(numberOfTries: number): void {
    let count = this.contracts.size;
    const tries = Math.min(Math.max(Math.floor(numberOfTries), 0), 1_576_800);
    for (let i = 0; i < tries; i++) {
      if (this.#opts.random() > 100 / (399 + Math.exp(0.0012 * count))) continue;
      if (this.generateRandom()) count++;
    }
  }

  get(host: string, filename: string): SimContract {
    const contract = this.contracts.get(this.#key(host, filename));
    if (!contract) throw new Error(`Cannot find contract '${filename}' on server '${host}'`);
    return contract;
  }

  type(host: string, filename: string): CodingContractName {
    return this.get(host, filename).type;
  }

  data(host: string, filename: string): unknown {
    const contract = this.get(host, filename);
    const definition = CodingContractTypes[contract.type];
    return structuredClone(definition.getData ? definition.getData(contract.state) : contract.state);
  }

  triesRemaining(host: string, filename: string): number {
    const contract = this.get(host, filename);
    return (CodingContractTypes[contract.type].numTries ?? 10) - contract.tries;
  }

  attempt(host: string, filename: string, answer: unknown): string {
    const contract = this.get(host, filename);
    const definition = CodingContractTypes[contract.type];
    let converted = answer;
    if (typeof converted === "string") converted = definition.convertAnswer(converted);
    if (!definition.validateAnswer(converted)) {
      throw new Error(`The answer is not in the right format for contract '${contract.type}'. Got: ${answer}`);
    }
    if (definition.solver(contract.state, converted)) {
      const reward = this.#gainReward(contract.reward, definition.difficulty, contract.rewardScaling);
      this.remove(host, filename);
      return reward;
    }
    contract.tries++;
    if (contract.tries >= (definition.numTries ?? 10)) this.remove(host, filename);
    return "";
  }

  remove(host: string, filename: string): void {
    this.contracts.delete(this.#key(host, filename));
    this.#opts.files.get(host)?.delete(filename);
  }

  forgetHost(host: string): void {
    for (const contract of [...this.contracts.values()]) {
      if (contract.host === host) this.remove(host, contract.filename);
    }
  }

  prestige(): void {
    for (const contract of [...this.contracts.values()]) this.remove(contract.host, contract.filename);
  }

  #hackingFactions(): string[] {
    return this.#opts.player.factions.filter((name) => FACTION_TABLE[name]?.offerHackingWork === true);
  }

  #gainReward(type: ContractRewardType, difficulty: number, rewardScaling: number): string {
    const adjustedScaling = rewardScaling / 3;
    if (type === ContractRewardType.FactionReputation) {
      const factions = this.#hackingFactions();
      if (factions.length === 0) return this.#gainReward(ContractRewardType.Money, difficulty, adjustedScaling);
      const faction = factions[this.#int(factions.length)]!;
      const gain = CONSTANTS.CodingContractBaseFactionRepGain * difficulty * adjustedScaling;
      this.#opts.factions.gainReputation(faction, gain);
      return `Gained ${gain} faction reputation for ${faction}`;
    }
    if (type === ContractRewardType.FactionReputationAll) {
      const factions = this.#hackingFactions();
      if (factions.length === 0) return this.#gainReward(ContractRewardType.Money, difficulty, adjustedScaling);
      const gain = Math.floor(CONSTANTS.CodingContractBaseFactionRepGain * difficulty * adjustedScaling / factions.length);
      for (const faction of factions) this.#opts.factions.gainReputation(faction, gain);
      return `Gained ${gain} reputation for each of the following factions: ${factions.join(", ")}`;
    }
    if (type === ContractRewardType.CompanyReputation) {
      const companies = Object.keys(this.#opts.player.jobs);
      if (companies.length === 0) {
        return this.#gainReward(
          this.#opts.random() < 0.5 ? ContractRewardType.FactionReputation : ContractRewardType.FactionReputationAll,
          difficulty,
          adjustedScaling,
        );
      }
      const company = companies[this.#int(companies.length)]!;
      const gain = CONSTANTS.CodingContractBaseCompanyRepGain * difficulty * adjustedScaling;
      this.#opts.companies.gainReputation(company, gain);
      return `Gained ${gain} company reputation for ${company}`;
    }
    const gain = CONSTANTS.CodingContractBaseMoneyGain * difficulty
      * currentNodeMults.CodingContractMoney * adjustedScaling;
    this.#opts.player.money += gain;
    this.#opts.world.recordMoney("codingcontract", gain);
    return `Gained $${gain}`;
  }
}
