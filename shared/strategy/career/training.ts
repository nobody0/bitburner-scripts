export type TrainingKind = "university" | "gym";
export type TrainingSkill = "hacking" | "charisma" | "strength" | "defense" | "dexterity" | "agility";

export interface TrainingOption {
  kind: TrainingKind;
  name: string;
  skill: TrainingSkill;
  expPerSec: number;
  costPerSec: number;
  location: string;
  aliases?: readonly string[];
}

/** Static base values for the Sector-12 training options exposed by career. */
export const CAREER_TRAINING_OPTIONS: readonly TrainingOption[] = [
  {
    kind: "university",
    name: "Algorithms",
    skill: "hacking",
    expPerSec: 8,
    costPerSec: 960,
    location: "Rothman University",
  },
  {
    kind: "university",
    name: "Leadership",
    skill: "charisma",
    expPerSec: 8,
    costPerSec: 960,
    location: "Rothman University",
  },
  ...([
    ["strength", "str"],
    ["defense", "def"],
    ["dexterity", "dex"],
    ["agility", "agi"],
  ] as const).map(([skill, alias]): TrainingOption => ({
    kind: "gym",
    name: skill,
    skill,
    expPerSec: 10,
    costPerSec: 2_400,
    location: "Powerhouse Gym",
    aliases: [alias],
  })),
];

export function trainingOption(kind: TrainingKind, subject: string): TrainingOption | undefined {
  const normalized = subject.toLowerCase();
  return CAREER_TRAINING_OPTIONS.find((option) =>
    option.kind === kind
    && (option.name.toLowerCase() === normalized || option.aliases?.includes(normalized)),
  );
}
