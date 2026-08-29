import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { COMPANY_TABLE, type VendoredCompany, type VendoredCompanyPosition } from "../vendor/bitburner/src/Company/CompanyTable.ts";
import { SERVER_METADATA } from "../vendor/bitburner/src/Server/data/ServerMetadata.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { addRepToFavor } from "../vendor/bitburner/src/Faction/formulas/favor.ts";
import { influenceStockThroughCompanyWork } from "../vendor/bitburner/src/StockMarket/PlayerInfluence.ts";

export interface SimCompanyStanding {
  rep: number;
  favor: number;
}

/** `isBackdoorInstalledInCompanyServer` (Server/ServerHelpers.ts:278-285): find
 * the ONE server whose `specialName` is this company, then ask whether it is
 * backdoored. Matching on `organizationName` instead would be wrong for Fulcrum,
 * where `fulcrumtech` and `fulcrumassets` share an organizationName but only the
 * former is Fulcrum Technologies' company server — so backdooring `fulcrumassets`
 * (which Fulcrum Secret Technologies' own invite requires) would hand out the
 * 0.75x company-rep discount the game does not give. */
export function isBackdoorInstalledInCompanyServer(world: SimWorld, companyName: string): boolean {
  const metadata = Object.values(SERVER_METADATA).find((entry) => entry.specialName === companyName);
  if (!metadata) return false;
  return world.servers.get(metadata.host)?.backdoorInstalled === true;
}

/** Exact v3.0.1 company application and work slice.
 *
 * Static jobs/companies are generated from the pinned upstream metadata. This
 * class owns only mutable standing and applies the same qualification,
 * promotion, salary, experience, reputation and prestige equations as the
 * game. */
export class CompanySystem {
  readonly standings = new Map<string, SimCompanyStanding>();
  #world: SimWorld;
  #player: SimPlayer;

  constructor(
    world: SimWorld,
    player: SimPlayer,
    initial: Record<string, number | Partial<SimCompanyStanding>> = {},
  ) {
    this.#world = world;
    this.#player = player;
    for (const name of Object.keys(COMPANY_TABLE.companies)) {
      const standing = initial[name];
      this.standings.set(name, typeof standing === "number"
        ? { rep: standing, favor: 0 }
        : { rep: standing?.rep ?? 0, favor: standing?.favor ?? 0 });
    }
  }

  rep(name: string): number {
    return this.standings.get(name)?.rep ?? 0;
  }

  favor(name: string): number {
    return this.standings.get(name)?.favor ?? 0;
  }

  gainReputation(name: string, amount: number): void {
    const standing = this.standings.get(name);
    if (!standing) throw new Error(`Invalid company: '${name}'`);
    standing.rep += amount;
  }

  positions(name: string): string[] {
    const company = this.company(name);
    return Object.keys(COMPANY_TABLE.positions).filter((position) => company.positions.includes(position));
  }

  positionInfo(companyName: string, positionName: string): {
    name: string;
    field: string;
    nextPosition: string | null;
    salary: number;
    requiredReputation: number;
    requiredSkills: Record<string, number>;
  } {
    const company = this.company(companyName);
    const position = this.position(positionName);
    if (!company.positions.includes(positionName)) {
      throw new Error(`Company '${companyName}' does not have position '${positionName}'`);
    }
    return {
      name: position.name,
      field: position.field,
      nextPosition: position.nextPosition,
      salary: position.baseSalary * company.salaryMultiplier,
      requiredReputation: this.effectiveRequiredReputation(companyName, position.requiredReputation),
      requiredSkills: this.requiredSkills(company, position),
    };
  }

  apply(companyName: string, field: string): string | null {
    const company = this.company(companyName);
    const track = COMPANY_TABLE.jobTracks[field];
    if (!track) throw new Error(`Invalid job field: '${field}'`);
    const entry = track[0];
    if (!entry || !company.positions.includes(entry)) return null;
    let best: string | undefined;
    for (const name of track) {
      if (!company.positions.includes(name)) break;
      const position = this.position(name);
      if (!this.qualified(company, position)) break;
      best = name;
    }
    if (!best || this.#player.jobs[companyName] === best) return null;
    this.#player.jobs[companyName] = best;
    this.#world.emit({ kind: "event", name: "company.hired", data: { company: companyName, position: best, field } });
    return best;
  }

  startWork(companyName: string, focus = true): boolean {
    if (!this.#player.jobs[companyName]) throw new Error(`You do not have a job at: '${companyName}'`);
    this.#player.startWork({
      kind: "company",
      subject: companyName,
      startedAt: this.#world.clock.now(),
      cyclesWorked: 0,
      focused: focus,
    });
    this.#player.focus = focus;
    this.#world.emit({ kind: "event", name: "company.work", data: { company: companyName, focus } });
    return true;
  }

  quit(companyName: string): void {
    if (this.#player.currentWork?.kind === "company" && this.#player.currentWork.subject === companyName) {
      this.#player.stopWork();
    }
    delete this.#player.jobs[companyName];
  }

  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "company") return;
    const company = this.company(work.subject);
    const positionName = this.#player.jobs[company.name];
    if (!positionName) {
      this.#player.stopWork();
      return;
    }
    const position = this.position(positionName);
    const standing = this.standings.get(company.name)!;
    const person = this.#world.person;
    const mults = person.mults as unknown as Record<string, number>;
    const focus = position.isPartTime || work.focused || this.#player.hasAugmentation("Neuroreceptor Management Implant", true) ? 1 : 0.8;
    const favorMult = 1 + standing.favor / 100;
    const sf11Mult = (this.#player.sourceFiles["11"] ?? 0) > 0 ? favorMult : 1;
    const sf15Mult = (this.#player.sourceFiles["15"] ?? 0) > 1
      ? 1 + 0.5 * (1 - Math.exp(-0.0002 * person.skills.charisma))
        + 0.6 * (1 - Math.exp(-0.00004 * person.skills.charisma)) * 1.5
      : 1;

    const money = position.baseSalary * company.salaryMultiplier * sf11Mult
      * currentNodeMults.CompanyWorkMoney * (mults["work_money"] ?? 1) * sf15Mult * focus * cycles;
    this.#player.money += money;
    this.#world.recordMoney("work", money);

    const exp = person.exp as unknown as Record<string, number>;
    for (const [skill, base] of Object.entries(position.expGain)) {
      exp[skill] = (exp[skill] ?? 0) + base * company.expMultiplier
        * currentNodeMults.CompanyWorkExpGain * (mults[`${skill}_exp`] ?? 1) * focus * cycles;
    }

    let weightedSkill = 0;
    for (const [skill, effectiveness] of Object.entries(position.effectiveness)) {
      weightedSkill += effectiveness * ((person.skills as unknown as Record<string, number>)[skill] ?? 0) / 100;
    }
    const performance = position.repMultiplier * weightedSkill / CONSTANTS.MaxSkillLevel
      + person.skills.intelligence / CONSTANTS.MaxSkillLevel;
    const reputationRate = performance * (mults["company_rep"] ?? 1) * favorMult
      * currentNodeMults.CompanyWorkRepGain * focus;
    standing.rep += reputationRate * cycles;
    influenceStockThroughCompanyWork(company, reputationRate, cycles);
    work.cyclesWorked += cycles;
    this.#world.recalculateSkills();
  }

  prestigeAugmentation(): void {
    for (const standing of this.standings.values()) {
      standing.favor = addRepToFavor(standing.favor, standing.rep);
      standing.rep = 0;
    }
    for (const company of Object.keys(this.#player.jobs)) delete this.#player.jobs[company];
  }

  private company(name: string): VendoredCompany {
    const company = COMPANY_TABLE.companies[name];
    if (!company) throw new Error(`Invalid company: '${name}'`);
    return company;
  }

  private position(name: string): VendoredCompanyPosition {
    const position = COMPANY_TABLE.positions[name];
    if (!position) throw new Error(`Invalid company position: '${name}'`);
    return position;
  }

  private requiredSkills(company: VendoredCompany, position: VendoredCompanyPosition): Record<string, number> {
    return Object.fromEntries(Object.entries(position.requiredSkills).map(([skill, base]) => [
      skill,
      base > 0 ? base + company.jobStatReqOffset : 0,
    ]));
  }

  private qualified(company: VendoredCompany, position: VendoredCompanyPosition): boolean {
    const skills = this.requiredSkills(company, position);
    for (const [skill, needed] of Object.entries(skills)) {
      if (((this.#world.person.skills as unknown as Record<string, number>)[skill] ?? 0) < needed) return false;
    }
    return this.rep(company.name) >= this.effectiveRequiredReputation(company.name, position.requiredReputation);
  }

  private effectiveRequiredReputation(companyName: string, base: number): number {
    const backdoored = isBackdoorInstalledInCompanyServer(this.#world, companyName);
    return base * (backdoored ? CONSTANTS.CompanyRequiredReputationMultiplier : 1);
  }
}
