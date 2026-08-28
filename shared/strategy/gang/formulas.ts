/** Gang gain formulas transcribed from Bitburner v3.0.1.
 * Source: bitburner-src@3162fd2590e221eadd0c0fbd46151913f7c4c41c
 * src/Gang/formulas/formulas.ts */

export interface FormulaGang {
  respect: number;
  territory: number;
  wantedLevel: number;
}

export interface FormulaMember {
  skills: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
}

export interface GangTaskStats {
  name: string;
  baseRespect: number;
  baseWanted: number;
  difficulty: number;
  hackWeight: number;
  strWeight: number;
  defWeight: number;
  dexWeight: number;
  agiWeight: number;
  chaWeight: number;
  territory: { respect: number; wanted: number };
}

export function gangWantedPenalty(gang: FormulaGang): number {
  return gang.respect / (gang.respect + gang.wantedLevel);
}

function statWeight(member: FormulaMember, task: GangTaskStats, difficultyFactor: number): number {
  return (task.hackWeight / 100) * member.skills.hack
    + (task.strWeight / 100) * member.skills.str
    + (task.defWeight / 100) * member.skills.def
    + (task.dexWeight / 100) * member.skills.dex
    + (task.agiWeight / 100) * member.skills.agi
    + (task.chaWeight / 100) * member.skills.cha
    - difficultyFactor * task.difficulty;
}

function territoryMultiplier(gang: FormulaGang, exponent: number): number {
  return Math.max(0.005, Math.pow(gang.territory * 100, exponent) / 100);
}

/** Respect gained per game cycle. */
export function gangRespectGain(gang: FormulaGang, member: FormulaMember, task: GangTaskStats, gangSoftcap: number): number {
  if (task.baseRespect === 0) return 0;
  const weight = statWeight(member, task, 4);
  if (weight <= 0) return 0;
  const territory = territoryMultiplier(gang, task.territory.respect);
  if (Number.isNaN(territory) || territory <= 0) return 0;
  const exponent = (0.2 * gang.territory + 0.8) * gangSoftcap;
  return Math.pow(11 * task.baseRespect * weight * territory * gangWantedPenalty(gang), exponent);
}

/** Wanted-level change per game cycle. Negative values reduce wanted. */
export function gangWantedGain(gang: FormulaGang, member: FormulaMember, task: GangTaskStats): number {
  if (task.baseWanted === 0) return 0;
  const weight = statWeight(member, task, 3.5);
  if (weight <= 0) return 0;
  const territory = territoryMultiplier(gang, task.territory.wanted);
  if (Number.isNaN(territory) || territory <= 0) return 0;
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * weight * territory;
  return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * weight * territory, 0.8));
}
