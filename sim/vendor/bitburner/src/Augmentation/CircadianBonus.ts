// Vendored from bitburner-src v3.0.1:src/Augmentation/CircadianModulator.ts (getRandomBonus only, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import type { Multipliers } from "../PersonObjects/Multipliers";
import { WHRNG } from "../Casino/RNG";
interface CircadianBonus { bonuses: Partial<Multipliers>; description: string; }

export function getRandomBonus(): CircadianBonus {
  const bonuses = [
    {
      bonuses: {
        hacking_chance: 1.25,
        hacking_speed: 1.1,
        hacking_money: 1.25,
        hacking_grow: 1.1,
      },
      description:
        "Increases the player's hacking chance by 25%.\n" +
        "Increases the player's hacking speed by 10%.\n" +
        "Increases the amount of money the player gains from hacking by 25%.\n" +
        "Improves the effectiveness of grow() by 10%.",
    },
    {
      bonuses: {
        hacking: 1.15,
        hacking_exp: 2,
      },
      description:
        "Increases the player's hacking skill by 15%.\n" +
        "Increases the player's hacking experience gain rate by 100%.",
    },
    {
      bonuses: {
        strength: 1.25,
        strength_exp: 2,
        defense: 1.25,
        defense_exp: 2,
        dexterity: 1.25,
        dexterity_exp: 2,
        agility: 1.25,
        agility_exp: 2,
      },
      description:
        "Increases all of the player's combat stats by 25%.\n" +
        "Increases all of the player's combat stat experience gain rate by 100%.",
    },
    {
      bonuses: {
        charisma: 1.5,
        charisma_exp: 2,
      },
      description:
        "This augmentation increases the player's charisma by 50%.\n" +
        "Increases the player's charisma experience gain rate by 100%.",
    },
    {
      bonuses: {
        hacknet_node_money: 1.2,
        hacknet_node_purchase_cost: 0.85,
        hacknet_node_ram_cost: 0.85,
        hacknet_node_core_cost: 0.85,
        hacknet_node_level_cost: 0.85,
      },
      description: "Increases Hacknet production by 20%.\n" + "Decreases all costs related to Hacknet by 15%.",
    },
    {
      bonuses: {
        company_rep: 1.25,
        faction_rep: 1.15,
        work_money: 1.7,
      },
      description:
        "Increases the amount of money the player gains from working by 70%.\n" +
        "Increases the amount of reputation the player gains when working for a company by 25%.\n" +
        "Increases the amount of reputation the player gains for a faction by 15%.",
    },
    {
      bonuses: {
        crime_success: 2,
        crime_money: 2,
      },
      description:
        "Increases the player's crime success rate by 100%.\n" +
        "Increases the amount of money the player gains from crimes by 100%.",
    },
  ];

  const randomNumber = new WHRNG(Math.floor(Date.now() / 3600000));
  for (let i = 0; i < 5; i++) randomNumber.step();

  return bonuses[Math.floor(bonuses.length * randomNumber.random())];
}
