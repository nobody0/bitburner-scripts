// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Augmentation/Augmentations.ts) — DO NOT EDIT
export interface VendoredAugmentation {
  name: string;
  /** Base money price, before the 1.9^queued escalation. */
  baseCost: number;
  /** Reputation requirement. Does NOT scale with the purchase queue. */
  baseRepRequirement: number;
  factions: string[];
  prereqs: string[];
  isSpecial: boolean;
  /** Multiplier fields only — every value is a finite number. */
  mults: Record<string, number>;
  /** One-off cash grant on install (CashRoot Starter Kit). NOT a multiplier. */
  startingMoney?: number;
  /** Programs granted on install (BigD's Big Brain). NOT multipliers. */
  programs?: string[];
  /** Set when upstream randomises this augmentation's multipliers at load
   *  time, so `mults` is NOT the truth and must not be scored. Exactly one
   *  augmentation is like this (Unstable Circadian Modulator). */
  multsUnknown?: boolean;
}

export const AUGMENTATION_TABLE: Record<string, VendoredAugmentation> = {
  "ADR-V1 Pheromone Gene": {
    "name": "ADR-V1 Pheromone Gene",
    "baseRepRequirement": 3750,
    "baseCost": 17500000,
    "factions": [
      "Tian Di Hui",
      "The Syndicate",
      "NWO",
      "MegaCorp",
      "Four Sigma"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.1,
      "faction_rep": 1.1,
      "charisma_exp": 1.05
    }
  },
  "ADR-V2 Pheromone Gene": {
    "name": "ADR-V2 Pheromone Gene",
    "baseRepRequirement": 62500,
    "baseCost": 550000000,
    "factions": [
      "Silhouette",
      "Four Sigma",
      "Bachman & Associates",
      "Clarke Incorporated"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.2,
      "faction_rep": 1.2,
      "charisma": 1.1
    }
  },
  "Artificial Bio-neural Network Implant": {
    "name": "Artificial Bio-neural Network Implant",
    "baseRepRequirement": 275000,
    "baseCost": 3000000000,
    "factions": [
      "BitRunners",
      "Fulcrum Secret Technologies"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.03,
      "hacking_money": 1.15,
      "hacking": 1.12
    }
  },
  "Artificial Synaptic Potentiation": {
    "name": "Artificial Synaptic Potentiation",
    "baseRepRequirement": 6250,
    "baseCost": 80000000,
    "factions": [
      "The Black Hand",
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.02,
      "hacking_chance": 1.05,
      "hacking_exp": 1.05
    }
  },
  "SoA - Beauty of Aphrodite": {
    "name": "SoA - Beauty of Aphrodite",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "charisma": 1.1
    }
  },
  "BigD's Big ... Brain": {
    "name": "BigD's Big ... Brain",
    "baseRepRequirement": Infinity,
    "baseCost": Infinity,
    "factions": [],
    "prereqs": [],
    "isSpecial": true,
    "startingMoney": 1000000000000,
    "programs": [
      "BruteSSH.exe",
      "FTPCrack.exe",
      "relaySMTP.exe",
      "HTTPWorm.exe",
      "SQLInject.exe",
      "DeepscanV1.exe",
      "DeepscanV2.exe",
      "ServerProfiler.exe",
      "AutoLink.exe",
      "Formulas.exe"
    ],
    "mults": {
      "hacking": 2,
      "strength": 2,
      "defense": 2,
      "dexterity": 2,
      "agility": 2,
      "charisma": 2,
      "hacking_exp": 2,
      "strength_exp": 2,
      "defense_exp": 2,
      "dexterity_exp": 2,
      "agility_exp": 2,
      "charisma_exp": 2,
      "hacking_chance": 2,
      "hacking_speed": 2,
      "hacking_money": 2,
      "hacking_grow": 2,
      "company_rep": 2,
      "faction_rep": 2,
      "crime_money": 2,
      "crime_success": 2,
      "work_money": 2,
      "hacknet_node_money": 2,
      "hacknet_node_purchase_cost": 0.5,
      "hacknet_node_ram_cost": 0.5,
      "hacknet_node_core_cost": 0.5,
      "hacknet_node_level_cost": 0.5,
      "bladeburner_max_stamina": 2,
      "bladeburner_stamina_gain": 2,
      "bladeburner_analysis": 2,
      "bladeburner_success_chance": 2
    }
  },
  "Bionic Arms": {
    "name": "Bionic Arms",
    "baseRepRequirement": 62500,
    "baseCost": 275000000,
    "factions": [
      "Tetrads"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.3,
      "dexterity": 1.3
    }
  },
  "Bionic Legs": {
    "name": "Bionic Legs",
    "baseRepRequirement": 150000,
    "baseCost": 375000000,
    "factions": [
      "Speakers for the Dead",
      "The Syndicate",
      "KuaiGong International",
      "OmniTek Incorporated",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "agility": 1.6
    }
  },
  "Bionic Spine": {
    "name": "Bionic Spine",
    "baseRepRequirement": 45000,
    "baseCost": 125000000,
    "factions": [
      "Speakers for the Dead",
      "The Syndicate",
      "KuaiGong International",
      "OmniTek Incorporated",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.15,
      "defense": 1.15,
      "agility": 1.15,
      "dexterity": 1.15
    }
  },
  "BitWire": {
    "name": "BitWire",
    "baseRepRequirement": 3750,
    "baseCost": 10000000,
    "factions": [
      "CyberSec",
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.05
    }
  },
  "BLADE-51b Tesla Armor": {
    "name": "BLADE-51b Tesla Armor",
    "baseRepRequirement": 12500,
    "baseCost": 1375000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "strength": 1.04,
      "defense": 1.04,
      "dexterity": 1.04,
      "agility": 1.04,
      "bladeburner_stamina_gain": 1.02,
      "bladeburner_success_chance": 1.03
    }
  },
  "BLADE-51b Tesla Armor: Energy Shielding Upgrade": {
    "name": "BLADE-51b Tesla Armor: Energy Shielding Upgrade",
    "baseRepRequirement": 21250,
    "baseCost": 5500000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "BLADE-51b Tesla Armor"
    ],
    "isSpecial": true,
    "mults": {
      "defense": 1.05,
      "bladeburner_success_chance": 1.06
    }
  },
  "BLADE-51b Tesla Armor: IPU Upgrade": {
    "name": "BLADE-51b Tesla Armor: IPU Upgrade",
    "baseRepRequirement": 15000,
    "baseCost": 1100000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "BLADE-51b Tesla Armor"
    ],
    "isSpecial": true,
    "mults": {
      "bladeburner_analysis": 1.15,
      "bladeburner_success_chance": 1.02
    }
  },
  "BLADE-51b Tesla Armor: Omnibeam Upgrade": {
    "name": "BLADE-51b Tesla Armor: Omnibeam Upgrade",
    "baseRepRequirement": 62500,
    "baseCost": 27500000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "BLADE-51b Tesla Armor: Unibeam Upgrade"
    ],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.1
    }
  },
  "BLADE-51b Tesla Armor: Power Cells Upgrade": {
    "name": "BLADE-51b Tesla Armor: Power Cells Upgrade",
    "baseRepRequirement": 18750,
    "baseCost": 2750000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "BLADE-51b Tesla Armor"
    ],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.05,
      "bladeburner_stamina_gain": 1.02,
      "bladeburner_max_stamina": 1.05
    }
  },
  "BLADE-51b Tesla Armor: Unibeam Upgrade": {
    "name": "BLADE-51b Tesla Armor: Unibeam Upgrade",
    "baseRepRequirement": 31250,
    "baseCost": 16500000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "BLADE-51b Tesla Armor"
    ],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.08
    }
  },
  "Blade's Runners": {
    "name": "Blade's Runners",
    "baseRepRequirement": 20000,
    "baseCost": 8250000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "agility": 1.05,
      "bladeburner_max_stamina": 1.05,
      "bladeburner_stamina_gain": 1.05
    }
  },
  "The Blade's Simulacrum": {
    "name": "The Blade's Simulacrum",
    "baseRepRequirement": 1250,
    "baseCost": 150000000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "BrachiBlades": {
    "name": "BrachiBlades",
    "baseRepRequirement": 12500,
    "baseCost": 90000000,
    "factions": [
      "The Syndicate"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.15,
      "defense": 1.15,
      "crime_success": 1.1,
      "crime_money": 1.15
    }
  },
  "CRTX42-AA Gene Modification": {
    "name": "CRTX42-AA Gene Modification",
    "baseRepRequirement": 45000,
    "baseCost": 225000000,
    "factions": [
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.08,
      "hacking_exp": 1.15
    }
  },
  "CashRoot Starter Kit": {
    "name": "CashRoot Starter Kit",
    "baseRepRequirement": 12500,
    "baseCost": 125000000,
    "factions": [
      "Sector-12"
    ],
    "prereqs": [],
    "isSpecial": false,
    "startingMoney": 1000000,
    "programs": [
      "BruteSSH.exe"
    ],
    "mults": {}
  },
  "SoA - Chaos of Dionysus": {
    "name": "SoA - Chaos of Dionysus",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Combat Rib I": {
    "name": "Combat Rib I",
    "baseRepRequirement": 7500,
    "baseCost": 23750000,
    "factions": [
      "Slum Snakes",
      "The Dark Army",
      "The Syndicate",
      "Volhaven",
      "Ishima",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.1,
      "defense": 1.1
    }
  },
  "Combat Rib II": {
    "name": "Combat Rib II",
    "baseRepRequirement": 18750,
    "baseCost": 65000000,
    "factions": [
      "The Dark Army",
      "The Syndicate",
      "Volhaven",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries"
    ],
    "prereqs": [
      "Combat Rib I"
    ],
    "isSpecial": false,
    "mults": {
      "strength": 1.14,
      "defense": 1.14
    }
  },
  "Combat Rib III": {
    "name": "Combat Rib III",
    "baseRepRequirement": 35000,
    "baseCost": 120000000,
    "factions": [
      "The Dark Army",
      "The Syndicate",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries",
      "The Covenant"
    ],
    "prereqs": [
      "Combat Rib II",
      "Combat Rib I"
    ],
    "isSpecial": false,
    "mults": {
      "strength": 1.18,
      "defense": 1.18
    }
  },
  "violet Congruity Implant": {
    "name": "violet Congruity Implant",
    "baseRepRequirement": Infinity,
    "baseCost": 50000000000000,
    "factions": [],
    "prereqs": [],
    "isSpecial": false,
    "mults": {}
  },
  "CordiARC Fusion Reactor": {
    "name": "CordiARC Fusion Reactor",
    "baseRepRequirement": 1125000,
    "baseCost": 5000000000,
    "factions": [
      "MegaCorp"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.35,
      "defense": 1.35,
      "dexterity": 1.35,
      "agility": 1.35,
      "strength_exp": 1.35,
      "defense_exp": 1.35,
      "dexterity_exp": 1.35,
      "agility_exp": 1.35
    }
  },
  "Cranial Signal Processors - Gen I": {
    "name": "Cranial Signal Processors - Gen I",
    "baseRepRequirement": 10000,
    "baseCost": 70000000,
    "factions": [
      "CyberSec",
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.01,
      "hacking": 1.05
    }
  },
  "Cranial Signal Processors - Gen II": {
    "name": "Cranial Signal Processors - Gen II",
    "baseRepRequirement": 18750,
    "baseCost": 125000000,
    "factions": [
      "CyberSec",
      "NiteSec"
    ],
    "prereqs": [
      "Cranial Signal Processors - Gen I"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.02,
      "hacking_chance": 1.05,
      "hacking": 1.07
    }
  },
  "Cranial Signal Processors - Gen III": {
    "name": "Cranial Signal Processors - Gen III",
    "baseRepRequirement": 50000,
    "baseCost": 550000000,
    "factions": [
      "NiteSec",
      "The Black Hand",
      "BitRunners"
    ],
    "prereqs": [
      "Cranial Signal Processors - Gen II",
      "Cranial Signal Processors - Gen I"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.02,
      "hacking_money": 1.15,
      "hacking": 1.09
    }
  },
  "Cranial Signal Processors - Gen IV": {
    "name": "Cranial Signal Processors - Gen IV",
    "baseRepRequirement": 125000,
    "baseCost": 1100000000,
    "factions": [
      "The Black Hand",
      "BitRunners"
    ],
    "prereqs": [
      "Cranial Signal Processors - Gen III",
      "Cranial Signal Processors - Gen II",
      "Cranial Signal Processors - Gen I"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.02,
      "hacking_money": 1.2,
      "hacking_grow": 1.25
    }
  },
  "Cranial Signal Processors - Gen V": {
    "name": "Cranial Signal Processors - Gen V",
    "baseRepRequirement": 250000,
    "baseCost": 2250000000,
    "factions": [
      "BitRunners"
    ],
    "prereqs": [
      "Cranial Signal Processors - Gen IV",
      "Cranial Signal Processors - Gen III",
      "Cranial Signal Processors - Gen II",
      "Cranial Signal Processors - Gen I"
    ],
    "isSpecial": false,
    "mults": {
      "hacking": 1.3,
      "hacking_money": 1.25,
      "hacking_grow": 1.75
    }
  },
  "DataJack": {
    "name": "DataJack",
    "baseRepRequirement": 112500,
    "baseCost": 450000000,
    "factions": [
      "BitRunners",
      "The Black Hand",
      "NiteSec",
      "Chongqing",
      "New Tokyo"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_money": 1.25
    }
  },
  "DermaForce Particle Barrier": {
    "name": "DermaForce Particle Barrier",
    "baseRepRequirement": 15000,
    "baseCost": 50000000,
    "factions": [
      "Volhaven"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "defense": 1.4,
      "charisma": 1.05
    }
  },
  "Eloquence Module": {
    "name": "Eloquence Module",
    "baseRepRequirement": 25000,
    "baseCost": 250000000,
    "factions": [
      "Speakers for the Dead"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.05,
      "crime_success": 1.1,
      "work_money": 1.2
    }
  },
  "EMS-4 Recombination": {
    "name": "EMS-4 Recombination",
    "baseRepRequirement": 2500,
    "baseCost": 275000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.03,
      "bladeburner_analysis": 1.05,
      "bladeburner_stamina_gain": 1.02
    }
  },
  "Embedded Netburner Module": {
    "name": "Embedded Netburner Module",
    "baseRepRequirement": 15000,
    "baseCost": 250000000,
    "factions": [
      "BitRunners",
      "The Black Hand",
      "NiteSec",
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.08
    }
  },
  "Embedded Netburner Module Analyze Engine": {
    "name": "Embedded Netburner Module Analyze Engine",
    "baseRepRequirement": 625000,
    "baseCost": 6000000000,
    "factions": [
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Daedalus",
      "The Covenant",
      "Illuminati"
    ],
    "prereqs": [
      "Embedded Netburner Module"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.1
    }
  },
  "Embedded Netburner Module Core Implant": {
    "name": "Embedded Netburner Module Core Implant",
    "baseRepRequirement": 175000,
    "baseCost": 2500000000,
    "factions": [
      "BitRunners",
      "The Black Hand",
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Blade Industries"
    ],
    "prereqs": [
      "Embedded Netburner Module"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.03,
      "hacking_money": 1.1,
      "hacking_chance": 1.03,
      "hacking_exp": 1.07,
      "hacking": 1.07
    }
  },
  "Embedded Netburner Module Core V2 Upgrade": {
    "name": "Embedded Netburner Module Core V2 Upgrade",
    "baseRepRequirement": 1000000,
    "baseCost": 4500000000,
    "factions": [
      "BitRunners",
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Blade Industries",
      "OmniTek Incorporated",
      "KuaiGong International"
    ],
    "prereqs": [
      "Embedded Netburner Module Core Implant",
      "Embedded Netburner Module"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.05,
      "hacking_money": 1.3,
      "hacking_chance": 1.05,
      "hacking_exp": 1.15,
      "hacking": 1.08
    }
  },
  "Embedded Netburner Module Core V3 Upgrade": {
    "name": "Embedded Netburner Module Core V3 Upgrade",
    "baseRepRequirement": 1750000,
    "baseCost": 7500000000,
    "factions": [
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Daedalus",
      "The Covenant",
      "Illuminati"
    ],
    "prereqs": [
      "Embedded Netburner Module Core V2 Upgrade",
      "Embedded Netburner Module Core Implant",
      "Embedded Netburner Module"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.05,
      "hacking_money": 1.4,
      "hacking_chance": 1.1,
      "hacking_exp": 1.25,
      "hacking": 1.1
    }
  },
  "Embedded Netburner Module Direct Memory Access Upgrade": {
    "name": "Embedded Netburner Module Direct Memory Access Upgrade",
    "baseRepRequirement": 1000000,
    "baseCost": 7000000000,
    "factions": [
      "ECorp",
      "MegaCorp",
      "Fulcrum Secret Technologies",
      "NWO",
      "Daedalus",
      "The Covenant",
      "Illuminati"
    ],
    "prereqs": [
      "Embedded Netburner Module"
    ],
    "isSpecial": false,
    "mults": {
      "hacking_money": 1.4,
      "hacking_chance": 1.2
    }
  },
  "Enhanced Myelin Sheathing": {
    "name": "Enhanced Myelin Sheathing",
    "baseRepRequirement": 100000,
    "baseCost": 1375000000,
    "factions": [
      "Fulcrum Secret Technologies",
      "BitRunners",
      "The Black Hand"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.03,
      "hacking_exp": 1.1,
      "hacking": 1.08
    }
  },
  "Enhanced Social Interaction Implant": {
    "name": "Enhanced Social Interaction Implant",
    "baseRepRequirement": 375000,
    "baseCost": 1375000000,
    "factions": [
      "Bachman & Associates",
      "NWO",
      "Clarke Incorporated",
      "OmniTek Incorporated",
      "Four Sigma"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.6,
      "charisma_exp": 1.6
    }
  },
  "EsperTech Bladeburner Eyewear": {
    "name": "EsperTech Bladeburner Eyewear",
    "baseRepRequirement": 1250,
    "baseCost": 165000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.03,
      "dexterity": 1.05
    }
  },
  "SoA - Flood of Poseidon": {
    "name": "SoA - Flood of Poseidon",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "FocusWire": {
    "name": "FocusWire",
    "baseRepRequirement": 75000,
    "baseCost": 900000000,
    "factions": [
      "Bachman & Associates",
      "Clarke Incorporated",
      "Four Sigma",
      "KuaiGong International"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.05,
      "strength_exp": 1.05,
      "defense_exp": 1.05,
      "dexterity_exp": 1.05,
      "agility_exp": 1.05,
      "charisma_exp": 1.05,
      "company_rep": 1.1,
      "work_money": 1.2
    }
  },
  "Glibness Enhancement": {
    "name": "Glibness Enhancement",
    "baseRepRequirement": 40500,
    "baseCost": 2500000000,
    "factions": [
      "Tetrads",
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma_exp": 1.2,
      "company_rep": 1.1
    }
  },
  "Golden Tongue Module": {
    "name": "Golden Tongue Module",
    "baseRepRequirement": 125000,
    "baseCost": 125000000,
    "factions": [
      "Speakers for the Dead"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.1,
      "charisma_exp": 1.3
    }
  },
  "GOLEM Serum": {
    "name": "GOLEM Serum",
    "baseRepRequirement": 31250,
    "baseCost": 11000000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "strength": 1.07,
      "defense": 1.07,
      "dexterity": 1.07,
      "agility": 1.07,
      "bladeburner_stamina_gain": 1.05
    }
  },
  "Graphene Bionic Arms Upgrade": {
    "name": "Graphene Bionic Arms Upgrade",
    "baseRepRequirement": 500000,
    "baseCost": 3750000000,
    "factions": [
      "The Dark Army"
    ],
    "prereqs": [
      "Bionic Arms"
    ],
    "isSpecial": false,
    "mults": {
      "strength": 1.85,
      "dexterity": 1.85
    }
  },
  "Graphene Bionic Legs Upgrade": {
    "name": "Graphene Bionic Legs Upgrade",
    "baseRepRequirement": 750000,
    "baseCost": 4500000000,
    "factions": [
      "MegaCorp",
      "ECorp",
      "Fulcrum Secret Technologies"
    ],
    "prereqs": [
      "Bionic Legs"
    ],
    "isSpecial": false,
    "mults": {
      "agility": 2.5
    }
  },
  "Graphene Bionic Spine Upgrade": {
    "name": "Graphene Bionic Spine Upgrade",
    "baseRepRequirement": 1625000,
    "baseCost": 6000000000,
    "factions": [
      "Fulcrum Secret Technologies",
      "ECorp"
    ],
    "prereqs": [
      "Bionic Spine"
    ],
    "isSpecial": false,
    "mults": {
      "strength": 1.6,
      "defense": 1.6,
      "agility": 1.6,
      "dexterity": 1.6
    }
  },
  "Graphene Bone Lacings": {
    "name": "Graphene Bone Lacings",
    "baseRepRequirement": 1125000,
    "baseCost": 4250000000,
    "factions": [
      "Fulcrum Secret Technologies",
      "The Covenant"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.7,
      "defense": 1.7
    }
  },
  "Graphene BrachiBlades Upgrade": {
    "name": "Graphene BrachiBlades Upgrade",
    "baseRepRequirement": 225000,
    "baseCost": 2500000000,
    "factions": [
      "Speakers for the Dead"
    ],
    "prereqs": [
      "BrachiBlades"
    ],
    "isSpecial": false,
    "mults": {
      "strength": 1.4,
      "defense": 1.4,
      "crime_success": 1.1,
      "crime_money": 1.3
    }
  },
  "Hacknet Node CPU Architecture Neural-Upload": {
    "name": "Hacknet Node CPU Architecture Neural-Upload",
    "baseRepRequirement": 3750,
    "baseCost": 11000000,
    "factions": [
      "Netburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacknet_node_money": 1.15,
      "hacknet_node_purchase_cost": 0.85
    }
  },
  "Hacknet Node Cache Architecture Neural-Upload": {
    "name": "Hacknet Node Cache Architecture Neural-Upload",
    "baseRepRequirement": 2500,
    "baseCost": 5500000,
    "factions": [
      "Netburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacknet_node_money": 1.1,
      "hacknet_node_level_cost": 0.85
    }
  },
  "Hacknet Node Core Direct-Neural Interface": {
    "name": "Hacknet Node Core Direct-Neural Interface",
    "baseRepRequirement": 12500,
    "baseCost": 60000000,
    "factions": [
      "Netburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacknet_node_money": 1.45
    }
  },
  "Hacknet Node Kernel Direct-Neural Interface": {
    "name": "Hacknet Node Kernel Direct-Neural Interface",
    "baseRepRequirement": 7500,
    "baseCost": 40000000,
    "factions": [
      "Netburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacknet_node_money": 1.25
    }
  },
  "Hacknet Node NIC Architecture Neural-Upload": {
    "name": "Hacknet Node NIC Architecture Neural-Upload",
    "baseRepRequirement": 1875,
    "baseCost": 4500000,
    "factions": [
      "Netburners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacknet_node_money": 1.1,
      "hacknet_node_purchase_cost": 0.9
    }
  },
  "HemoRecirculator": {
    "name": "HemoRecirculator",
    "baseRepRequirement": 10000,
    "baseCost": 45000000,
    "factions": [
      "Tetrads",
      "The Dark Army",
      "The Syndicate"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.08,
      "defense": 1.08,
      "agility": 1.08,
      "dexterity": 1.08,
      "charisma": 1.08
    }
  },
  "ECorp HVMind Implant": {
    "name": "ECorp HVMind Implant",
    "baseRepRequirement": 1500000,
    "baseCost": 5500000000,
    "factions": [
      "ECorp"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_grow": 3
    }
  },
  "SoA - Hunt of Artemis": {
    "name": "SoA - Hunt of Artemis",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Hydroflame Left Arm": {
    "name": "Hydroflame Left Arm",
    "baseRepRequirement": 1250000,
    "baseCost": 2500000000000,
    "factions": [
      "NWO"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 2.8
    }
  },
  "Hyperion Plasma Cannon V1": {
    "name": "Hyperion Plasma Cannon V1",
    "baseRepRequirement": 12500,
    "baseCost": 2750000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.06
    }
  },
  "Hyperion Plasma Cannon V2": {
    "name": "Hyperion Plasma Cannon V2",
    "baseRepRequirement": 25000,
    "baseCost": 5500000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "Hyperion Plasma Cannon V1"
    ],
    "isSpecial": true,
    "mults": {
      "bladeburner_success_chance": 1.08
    }
  },
  "HyperSight Corneal Implant": {
    "name": "HyperSight Corneal Implant",
    "baseRepRequirement": 150000,
    "baseCost": 2750000000,
    "factions": [
      "Blade Industries",
      "KuaiGong International"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "dexterity": 1.4,
      "hacking_speed": 1.03,
      "hacking_money": 1.1,
      "charisma": 1.03
    }
  },
  "INFRARET Enhancement": {
    "name": "INFRARET Enhancement",
    "baseRepRequirement": 7500,
    "baseCost": 30000000,
    "factions": [
      "Ishima"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "crime_success": 1.25,
      "crime_money": 1.1,
      "dexterity": 1.1
    }
  },
  "I.N.T.E.R.L.I.N.K.E.D": {
    "name": "I.N.T.E.R.L.I.N.K.E.D",
    "baseRepRequirement": 25000,
    "baseCost": 5500000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "strength_exp": 1.05,
      "defense_exp": 1.05,
      "dexterity_exp": 1.05,
      "agility_exp": 1.05,
      "bladeburner_max_stamina": 1.1
    }
  },
  "SoA - Knowledge of Apollo": {
    "name": "SoA - Knowledge of Apollo",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "LuminCloaking-V1 Skin Implant": {
    "name": "LuminCloaking-V1 Skin Implant",
    "baseRepRequirement": 1500,
    "baseCost": 5000000,
    "factions": [
      "Slum Snakes",
      "Tetrads"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "agility": 1.05,
      "charisma": 1.03,
      "crime_money": 1.1
    }
  },
  "LuminCloaking-V2 Skin Implant": {
    "name": "LuminCloaking-V2 Skin Implant",
    "baseRepRequirement": 5000,
    "baseCost": 30000000,
    "factions": [
      "Slum Snakes",
      "Tetrads"
    ],
    "prereqs": [
      "LuminCloaking-V1 Skin Implant"
    ],
    "isSpecial": false,
    "mults": {
      "agility": 1.1,
      "defense": 1.1,
      "charisma_exp": 1.1,
      "crime_money": 1.25
    }
  },
  "Magnetism Amplifier": {
    "name": "Magnetism Amplifier",
    "baseRepRequirement": 15000,
    "baseCost": 250000000,
    "factions": [
      "The Black Hand",
      "The Dark Army"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.05,
      "company_rep": 1.1
    }
  },
  "SoA - Might of Ares": {
    "name": "SoA - Might of Ares",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Nanofiber Weave": {
    "name": "Nanofiber Weave",
    "baseRepRequirement": 37500,
    "baseCost": 125000000,
    "factions": [
      "The Dark Army",
      "The Syndicate",
      "OmniTek Incorporated",
      "Blade Industries",
      "Tian Di Hui",
      "Speakers for the Dead",
      "Fulcrum Secret Technologies"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.2,
      "defense": 1.2,
      "charisma": 1.05
    }
  },
  "Neotra": {
    "name": "Neotra",
    "baseRepRequirement": 562500,
    "baseCost": 2875000000,
    "factions": [
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.55,
      "defense": 1.55,
      "charisma": 1.55
    }
  },
  "Neural Accelerator": {
    "name": "Neural Accelerator",
    "baseRepRequirement": 200000,
    "baseCost": 1750000000,
    "factions": [
      "BitRunners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.1,
      "hacking_exp": 1.15,
      "hacking_money": 1.2
    }
  },
  "Neural-Retention Enhancement": {
    "name": "Neural-Retention Enhancement",
    "baseRepRequirement": 20000,
    "baseCost": 250000000,
    "factions": [
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.25
    }
  },
  "Neuralstimulator": {
    "name": "Neuralstimulator",
    "baseRepRequirement": 50000,
    "baseCost": 3000000000,
    "factions": [
      "The Black Hand",
      "Chongqing",
      "Sector-12",
      "New Tokyo",
      "Aevum",
      "Ishima",
      "Volhaven",
      "Bachman & Associates",
      "Clarke Incorporated",
      "Four Sigma"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.02,
      "hacking_chance": 1.1,
      "hacking_exp": 1.12
    }
  },
  "Neuregen Gene Modification": {
    "name": "Neuregen Gene Modification",
    "baseRepRequirement": 37500,
    "baseCost": 375000000,
    "factions": [
      "Chongqing"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.4
    }
  },
  "NeuroFlux Governor": {
    "name": "NeuroFlux Governor",
    "baseRepRequirement": 500,
    "baseCost": 750000,
    "factions": [
      "Illuminati",
      "Daedalus",
      "The Covenant",
      "ECorp",
      "MegaCorp",
      "Bachman & Associates",
      "Blade Industries",
      "NWO",
      "Clarke Incorporated",
      "OmniTek Incorporated",
      "Four Sigma",
      "KuaiGong International",
      "Fulcrum Secret Technologies",
      "BitRunners",
      "The Black Hand",
      "NiteSec",
      "Aevum",
      "Chongqing",
      "Ishima",
      "New Tokyo",
      "Sector-12",
      "Volhaven",
      "Speakers for the Dead",
      "The Dark Army",
      "The Syndicate",
      "Silhouette",
      "Tetrads",
      "Slum Snakes",
      "Netburners",
      "Tian Di Hui",
      "CyberSec"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "hacking_chance": 1.01000262,
      "hacking_speed": 1.01000262,
      "hacking_money": 1.01000262,
      "hacking_grow": 1.01000262,
      "hacking": 1.01000262,
      "strength": 1.01000262,
      "defense": 1.01000262,
      "dexterity": 1.01000262,
      "agility": 1.01000262,
      "charisma": 1.01000262,
      "hacking_exp": 1.01000262,
      "strength_exp": 1.01000262,
      "defense_exp": 1.01000262,
      "dexterity_exp": 1.01000262,
      "agility_exp": 1.01000262,
      "charisma_exp": 1.01000262,
      "company_rep": 1.01000262,
      "faction_rep": 1.01000262,
      "crime_money": 1.01000262,
      "crime_success": 1.01000262,
      "hacknet_node_money": 1.01000262,
      "hacknet_node_purchase_cost": 0.990096441532003,
      "hacknet_node_ram_cost": 0.990096441532003,
      "hacknet_node_core_cost": 0.990096441532003,
      "hacknet_node_level_cost": 0.990096441532003,
      "work_money": 1.01000262
    }
  },
  "BitRunners Neurolink": {
    "name": "BitRunners Neurolink",
    "baseRepRequirement": 875000,
    "baseCost": 4375000000,
    "factions": [
      "BitRunners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "programs": [
      "FTPCrack.exe",
      "relaySMTP.exe"
    ],
    "mults": {
      "hacking": 1.15,
      "hacking_exp": 1.2,
      "hacking_chance": 1.1,
      "hacking_speed": 1.05
    }
  },
  "Neuronal Densification": {
    "name": "Neuronal Densification",
    "baseRepRequirement": 187500,
    "baseCost": 1375000000,
    "factions": [
      "Clarke Incorporated"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.15,
      "hacking_exp": 1.1,
      "hacking_speed": 1.03
    }
  },
  "Neuroreceptor Management Implant": {
    "name": "Neuroreceptor Management Implant",
    "baseRepRequirement": 75000,
    "baseCost": 550000000,
    "factions": [
      "Tian Di Hui"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {}
  },
  "Neurotrainer I": {
    "name": "Neurotrainer I",
    "baseRepRequirement": 1000,
    "baseCost": 4000000,
    "factions": [
      "CyberSec",
      "Aevum"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.1,
      "strength_exp": 1.1,
      "defense_exp": 1.1,
      "dexterity_exp": 1.1,
      "agility_exp": 1.1,
      "charisma_exp": 1.1
    }
  },
  "Neurotrainer II": {
    "name": "Neurotrainer II",
    "baseRepRequirement": 10000,
    "baseCost": 45000000,
    "factions": [
      "BitRunners",
      "NiteSec"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.15,
      "strength_exp": 1.15,
      "defense_exp": 1.15,
      "dexterity_exp": 1.15,
      "agility_exp": 1.15,
      "charisma_exp": 1.15
    }
  },
  "Neurotrainer III": {
    "name": "Neurotrainer III",
    "baseRepRequirement": 25000,
    "baseCost": 130000000,
    "factions": [
      "NWO",
      "Four Sigma"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_exp": 1.2,
      "strength_exp": 1.2,
      "defense_exp": 1.2,
      "dexterity_exp": 1.2,
      "agility_exp": 1.2,
      "charisma_exp": 1.2
    }
  },
  "Nuoptimal Nootropic Injector Implant": {
    "name": "Nuoptimal Nootropic Injector Implant",
    "baseRepRequirement": 5000,
    "baseCost": 20000000,
    "factions": [
      "Tian Di Hui",
      "Volhaven",
      "New Tokyo",
      "Chongqing",
      "Clarke Incorporated",
      "Four Sigma",
      "Bachman & Associates"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.2,
      "charisma": 1.03
    }
  },
  "NutriGen Implant": {
    "name": "NutriGen Implant",
    "baseRepRequirement": 6250,
    "baseCost": 2500000,
    "factions": [
      "New Tokyo"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength_exp": 1.2,
      "defense_exp": 1.2,
      "dexterity_exp": 1.2,
      "agility_exp": 1.2
    }
  },
  "nextSENS Gene Modification": {
    "name": "nextSENS Gene Modification",
    "baseRepRequirement": 437500,
    "baseCost": 1925000000,
    "factions": [
      "Clarke Incorporated"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.2,
      "strength": 1.2,
      "defense": 1.2,
      "dexterity": 1.2,
      "agility": 1.2,
      "charisma": 1.2
    }
  },
  "OmniTek InfoLoad": {
    "name": "OmniTek InfoLoad",
    "baseRepRequirement": 625000,
    "baseCost": 2875000000,
    "factions": [
      "OmniTek Incorporated"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.2,
      "hacking_exp": 1.25
    }
  },
  "ORION-MKIV Shoulder": {
    "name": "ORION-MKIV Shoulder",
    "baseRepRequirement": 6250,
    "baseCost": 550000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "defense": 1.05,
      "strength": 1.05,
      "dexterity": 1.05,
      "bladeburner_success_chance": 1.04
    }
  },
  "PC Direct-Neural Interface": {
    "name": "PC Direct-Neural Interface",
    "baseRepRequirement": 375000,
    "baseCost": 3750000000,
    "factions": [
      "Four Sigma",
      "OmniTek Incorporated",
      "ECorp",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.3,
      "hacking": 1.08
    }
  },
  "PC Direct-Neural Interface NeuroNet Injector": {
    "name": "PC Direct-Neural Interface NeuroNet Injector",
    "baseRepRequirement": 1500000,
    "baseCost": 7500000000,
    "factions": [
      "Fulcrum Secret Technologies"
    ],
    "prereqs": [
      "PC Direct-Neural Interface"
    ],
    "isSpecial": false,
    "mults": {
      "company_rep": 2,
      "hacking": 1.1,
      "hacking_speed": 1.05
    }
  },
  "PC Direct-Neural Interface Optimization Submodule": {
    "name": "PC Direct-Neural Interface Optimization Submodule",
    "baseRepRequirement": 500000,
    "baseCost": 4500000000,
    "factions": [
      "Fulcrum Secret Technologies",
      "ECorp",
      "Blade Industries"
    ],
    "prereqs": [
      "PC Direct-Neural Interface"
    ],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.75,
      "hacking": 1.1
    }
  },
  "PCMatrix": {
    "name": "PCMatrix",
    "baseRepRequirement": 100000,
    "baseCost": 2000000000,
    "factions": [
      "Aevum"
    ],
    "prereqs": [],
    "isSpecial": false,
    "programs": [
      "DeepscanV1.exe",
      "AutoLink.exe"
    ],
    "mults": {
      "charisma": 1.0777,
      "charisma_exp": 1.0777,
      "work_money": 1.777,
      "faction_rep": 1.0777,
      "company_rep": 1.0777,
      "crime_success": 1.0777,
      "crime_money": 1.0777
    }
  },
  "Photosynthetic Cells": {
    "name": "Photosynthetic Cells",
    "baseRepRequirement": 562500,
    "baseCost": 2750000000,
    "factions": [
      "KuaiGong International"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.4,
      "defense": 1.4,
      "agility": 1.4,
      "charisma": 1.2
    }
  },
  "Power Recirculation Core": {
    "name": "Power Recirculation Core",
    "baseRepRequirement": 25000,
    "baseCost": 180000000,
    "factions": [
      "Tetrads",
      "The Dark Army",
      "The Syndicate",
      "NWO"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.05,
      "strength": 1.05,
      "defense": 1.05,
      "dexterity": 1.05,
      "agility": 1.05,
      "charisma": 1.05,
      "hacking_exp": 1.1,
      "strength_exp": 1.1,
      "defense_exp": 1.1,
      "dexterity_exp": 1.1,
      "agility_exp": 1.1,
      "charisma_exp": 1.1
    }
  },
  "The Illustrated Primer": {
    "name": "The Illustrated Primer",
    "baseRepRequirement": 187500,
    "baseCost": 3375000000,
    "factions": [
      "The Dark Army",
      "The Syndicate"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.1,
      "charisma_exp": 1.4
    }
  },
  "QLink": {
    "name": "QLink",
    "baseRepRequirement": 1875000,
    "baseCost": 25000000000000,
    "factions": [
      "Illuminati"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.75,
      "hacking_speed": 2,
      "hacking_chance": 2.5,
      "hacking_money": 4
    }
  },
  "Social Negotiation Assistant (S.N.A)": {
    "name": "Social Negotiation Assistant (S.N.A)",
    "baseRepRequirement": 6250,
    "baseCost": 30000000,
    "factions": [
      "Tian Di Hui"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma_exp": 1.15,
      "work_money": 1.1,
      "company_rep": 1.15,
      "faction_rep": 1.15
    }
  },
  "Social Dynamics Processor": {
    "name": "Social Dynamics Processor",
    "baseRepRequirement": 225000,
    "baseCost": 1200000000,
    "factions": [
      "MegaCorp",
      "ECorp",
      "OmniTek Incorporated"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.1,
      "company_rep": 1.3
    }
  },
  "SPTN-97 Gene Modification": {
    "name": "SPTN-97 Gene Modification",
    "baseRepRequirement": 1250000,
    "baseCost": 4875000000,
    "factions": [
      "The Covenant"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.75,
      "defense": 1.75,
      "dexterity": 1.75,
      "agility": 1.75,
      "hacking": 1.15
    }
  },
  "The Shadow's Simulacrum": {
    "name": "The Shadow's Simulacrum",
    "baseRepRequirement": 37500,
    "baseCost": 400000000,
    "factions": [
      "The Syndicate",
      "The Dark Army",
      "Speakers for the Dead"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.15,
      "faction_rep": 1.15
    }
  },
  "SmartJaw": {
    "name": "SmartJaw",
    "baseRepRequirement": 375000,
    "baseCost": 2750000000,
    "factions": [
      "Bachman & Associates"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.5,
      "charisma_exp": 1.5,
      "company_rep": 1.25,
      "faction_rep": 1.25
    }
  },
  "SmartSonar Implant": {
    "name": "SmartSonar Implant",
    "baseRepRequirement": 22500,
    "baseCost": 75000000,
    "factions": [
      "Slum Snakes"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "dexterity": 1.1,
      "dexterity_exp": 1.15,
      "crime_money": 1.25
    }
  },
  "Speech Enhancement": {
    "name": "Speech Enhancement",
    "baseRepRequirement": 2500,
    "baseCost": 12500000,
    "factions": [
      "Tian Di Hui",
      "Speakers for the Dead",
      "Four Sigma",
      "KuaiGong International",
      "Clarke Incorporated",
      "Bachman & Associates"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "company_rep": 1.1,
      "charisma": 1.1
    }
  },
  "Speech Processor Implant": {
    "name": "Speech Processor Implant",
    "baseRepRequirement": 7500,
    "baseCost": 50000000,
    "factions": [
      "Tian Di Hui",
      "Chongqing",
      "Sector-12",
      "New Tokyo",
      "Aevum",
      "Ishima",
      "Volhaven",
      "Silhouette"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.2
    }
  },
  "Stanek's Gift - Genesis": {
    "name": "Stanek's Gift - Genesis",
    "baseRepRequirement": 0,
    "baseCost": 0,
    "factions": [
      "Church of the Machine God"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "hacking_chance": 0.9,
      "hacking_speed": 0.9,
      "hacking_money": 0.9,
      "hacking_grow": 0.9,
      "hacking": 0.9,
      "strength": 0.9,
      "defense": 0.9,
      "dexterity": 0.9,
      "agility": 0.9,
      "charisma": 0.9,
      "hacking_exp": 0.9,
      "strength_exp": 0.9,
      "defense_exp": 0.9,
      "dexterity_exp": 0.9,
      "agility_exp": 0.9,
      "charisma_exp": 0.9,
      "company_rep": 0.9,
      "faction_rep": 0.9,
      "crime_money": 0.9,
      "crime_success": 0.9,
      "hacknet_node_money": 0.9,
      "hacknet_node_purchase_cost": 1.1,
      "hacknet_node_ram_cost": 1.1,
      "hacknet_node_core_cost": 1.1,
      "hacknet_node_level_cost": 1.1,
      "work_money": 0.9
    }
  },
  "Stanek's Gift - Awakening": {
    "name": "Stanek's Gift - Awakening",
    "baseRepRequirement": 1000000,
    "baseCost": 0,
    "factions": [
      "Church of the Machine God"
    ],
    "prereqs": [
      "Stanek's Gift - Genesis"
    ],
    "isSpecial": true,
    "mults": {
      "hacking_chance": 1.0555555555555556,
      "hacking_speed": 1.0555555555555556,
      "hacking_money": 1.0555555555555556,
      "hacking_grow": 1.0555555555555556,
      "hacking": 1.0555555555555556,
      "strength": 1.0555555555555556,
      "defense": 1.0555555555555556,
      "dexterity": 1.0555555555555556,
      "agility": 1.0555555555555556,
      "charisma": 1.0555555555555556,
      "hacking_exp": 1.0555555555555556,
      "strength_exp": 1.0555555555555556,
      "defense_exp": 1.0555555555555556,
      "dexterity_exp": 1.0555555555555556,
      "agility_exp": 1.0555555555555556,
      "charisma_exp": 1.0555555555555556,
      "company_rep": 1.0555555555555556,
      "faction_rep": 1.0555555555555556,
      "crime_money": 1.0555555555555556,
      "crime_success": 1.0555555555555556,
      "hacknet_node_money": 1.0555555555555556,
      "hacknet_node_purchase_cost": 0.9545454545454545,
      "hacknet_node_ram_cost": 0.9545454545454545,
      "hacknet_node_core_cost": 0.9545454545454545,
      "hacknet_node_level_cost": 0.9545454545454545,
      "work_money": 1.0555555555555556
    }
  },
  "Stanek's Gift - Serenity": {
    "name": "Stanek's Gift - Serenity",
    "baseRepRequirement": 100000000,
    "baseCost": 0,
    "factions": [
      "Church of the Machine God"
    ],
    "prereqs": [
      "Stanek's Gift - Awakening",
      "Stanek's Gift - Genesis"
    ],
    "isSpecial": true,
    "mults": {
      "hacking_chance": 1.0526315789473684,
      "hacking_speed": 1.0526315789473684,
      "hacking_money": 1.0526315789473684,
      "hacking_grow": 1.0526315789473684,
      "hacking": 1.0526315789473684,
      "strength": 1.0526315789473684,
      "defense": 1.0526315789473684,
      "dexterity": 1.0526315789473684,
      "agility": 1.0526315789473684,
      "charisma": 1.0526315789473684,
      "hacking_exp": 1.0526315789473684,
      "strength_exp": 1.0526315789473684,
      "defense_exp": 1.0526315789473684,
      "dexterity_exp": 1.0526315789473684,
      "agility_exp": 1.0526315789473684,
      "charisma_exp": 1.0526315789473684,
      "company_rep": 1.0526315789473684,
      "faction_rep": 1.0526315789473684,
      "crime_money": 1.0526315789473684,
      "crime_success": 1.0526315789473684,
      "hacknet_node_money": 1.0526315789473684,
      "hacknet_node_purchase_cost": 0.9523809523809523,
      "hacknet_node_ram_cost": 0.9523809523809523,
      "hacknet_node_core_cost": 0.9523809523809523,
      "hacknet_node_level_cost": 0.9523809523809523,
      "work_money": 1.0526315789473684
    }
  },
  "NEMEAN Subdermal Weave": {
    "name": "NEMEAN Subdermal Weave",
    "baseRepRequirement": 875000,
    "baseCost": 3250000000,
    "factions": [
      "The Syndicate",
      "Fulcrum Secret Technologies",
      "Illuminati",
      "Daedalus",
      "The Covenant"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "defense": 2.2
    }
  },
  "Synaptic Enhancement Implant": {
    "name": "Synaptic Enhancement Implant",
    "baseRepRequirement": 2000,
    "baseCost": 7500000,
    "factions": [
      "CyberSec",
      "Aevum"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking_speed": 1.03
    }
  },
  "Synfibril Muscle": {
    "name": "Synfibril Muscle",
    "baseRepRequirement": 437500,
    "baseCost": 1125000000,
    "factions": [
      "KuaiGong International",
      "Fulcrum Secret Technologies",
      "Speakers for the Dead",
      "NWO",
      "The Covenant",
      "Daedalus",
      "Illuminati",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.3,
      "defense": 1.3
    }
  },
  "Synthetic Heart": {
    "name": "Synthetic Heart",
    "baseRepRequirement": 750000,
    "baseCost": 2875000000,
    "factions": [
      "KuaiGong International",
      "Fulcrum Secret Technologies",
      "Speakers for the Dead",
      "NWO",
      "The Covenant",
      "Daedalus",
      "Illuminati"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "agility": 1.5,
      "strength": 1.5,
      "charisma": 1.3
    }
  },
  "TITN-41 Gene-Modification Injection": {
    "name": "TITN-41 Gene-Modification Injection",
    "baseRepRequirement": 25000,
    "baseCost": 190000000,
    "factions": [
      "Silhouette"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.15,
      "charisma_exp": 1.15
    }
  },
  "Augmented Targeting I": {
    "name": "Augmented Targeting I",
    "baseRepRequirement": 5000,
    "baseCost": 15000000,
    "factions": [
      "Slum Snakes",
      "The Dark Army",
      "The Syndicate",
      "Sector-12",
      "Ishima",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "dexterity": 1.1
    }
  },
  "Augmented Targeting II": {
    "name": "Augmented Targeting II",
    "baseRepRequirement": 8750,
    "baseCost": 42500000,
    "factions": [
      "The Dark Army",
      "The Syndicate",
      "Sector-12",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries"
    ],
    "prereqs": [
      "Augmented Targeting I"
    ],
    "isSpecial": false,
    "mults": {
      "dexterity": 1.2
    }
  },
  "Augmented Targeting III": {
    "name": "Augmented Targeting III",
    "baseRepRequirement": 27500,
    "baseCost": 115000000,
    "factions": [
      "The Dark Army",
      "The Syndicate",
      "OmniTek Incorporated",
      "KuaiGong International",
      "Blade Industries",
      "The Covenant"
    ],
    "prereqs": [
      "Augmented Targeting II",
      "Augmented Targeting I"
    ],
    "isSpecial": false,
    "mults": {
      "dexterity": 1.3
    }
  },
  "The Black Hand": {
    "name": "The Black Hand",
    "baseRepRequirement": 100000,
    "baseCost": 550000000,
    "factions": [
      "The Black Hand"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "strength": 1.15,
      "dexterity": 1.15,
      "hacking": 1.1,
      "hacking_speed": 1.02,
      "hacking_money": 1.1
    }
  },
  "The W1ngs of Icarus": {
    "name": "The W1ngs of Icarus",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "charisma": 1.05,
      "agility": 1.1,
      "dnet_money": 1.3
    }
  },
  "The B00ts of Perseus": {
    "name": "The B00ts of Perseus",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [
      "The W1ngs of Icarus"
    ],
    "isSpecial": true,
    "mults": {
      "charisma": 1.06,
      "dexterity": 1.06
    }
  },
  "The H4mmer of Daedalus": {
    "name": "The H4mmer of Daedalus",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [
      "The B00ts of Perseus"
    ],
    "isSpecial": true,
    "mults": {
      "charisma": 1.07,
      "strength": 1.1,
      "dnet_money": 1.1
    }
  },
  "The St4ff of Asclepius": {
    "name": "The St4ff of Asclepius",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [
      "The H4mmer of Daedalus"
    ],
    "isSpecial": true,
    "mults": {
      "charisma_exp": 1.1,
      "defense": 1.1,
      "dnet_money": 1.1
    }
  },
  "The L4w of Bayes": {
    "name": "The L4w of Bayes",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [
      "The St4ff of Asclepius"
    ],
    "isSpecial": true,
    "mults": {
      "charisma": 1.09,
      "company_rep": 1.05,
      "dnet_money": 1.15
    }
  },
  "The B1ade of Solomonoff": {
    "name": "The B1ade of Solomonoff",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [],
    "prereqs": [
      "The L4w of Bayes"
    ],
    "isSpecial": true,
    "mults": {
      "charisma": 1.1,
      "hacking": 1.1,
      "company_rep": 1.1,
      "dnet_money": 1.1
    }
  },
  "The Red Pill": {
    "name": "The Red Pill",
    "baseRepRequirement": 2500000,
    "baseCost": 0,
    "factions": [
      "Daedalus"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "SoA - Trickery of Hermes": {
    "name": "SoA - Trickery of Hermes",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Unstable Circadian Modulator": {
    "name": "Unstable Circadian Modulator",
    "baseRepRequirement": 362500,
    "baseCost": 5000000000,
    "factions": [
      "Speakers for the Dead"
    ],
    "prereqs": [],
    "isSpecial": false,
    "multsUnknown": true,
    "mults": {}
  },
  "Vangelis Virus": {
    "name": "Vangelis Virus",
    "baseRepRequirement": 18750,
    "baseCost": 2750000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {
      "dexterity_exp": 1.1,
      "charisma_exp": 1.1,
      "bladeburner_analysis": 1.1,
      "bladeburner_success_chance": 1.04
    }
  },
  "Vangelis Virus 3.0": {
    "name": "Vangelis Virus 3.0",
    "baseRepRequirement": 37500,
    "baseCost": 11000000000,
    "factions": [
      "Bladeburners"
    ],
    "prereqs": [
      "Vangelis Virus"
    ],
    "isSpecial": true,
    "mults": {
      "defense_exp": 1.1,
      "dexterity_exp": 1.1,
      "charisma_exp": 1.1,
      "bladeburner_analysis": 1.15,
      "bladeburner_success_chance": 1.05
    }
  },
  "SoA - phyzical WKS harmonizer": {
    "name": "SoA - phyzical WKS harmonizer",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Wired Reflexes": {
    "name": "Wired Reflexes",
    "baseRepRequirement": 1250,
    "baseCost": 2500000,
    "factions": [
      "Tian Di Hui",
      "Slum Snakes",
      "Sector-12",
      "Volhaven",
      "Aevum",
      "Ishima",
      "The Syndicate",
      "The Dark Army",
      "Speakers for the Dead"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "agility": 1.05,
      "dexterity": 1.05
    }
  },
  "SoA - Wisdom of Athena": {
    "name": "SoA - Wisdom of Athena",
    "baseRepRequirement": 10000,
    "baseCost": 1000000,
    "factions": [
      "Shadows of Anarchy"
    ],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  },
  "Neural Wit Amplifier": {
    "name": "Neural Wit Amplifier",
    "baseRepRequirement": 5000,
    "baseCost": 10000000,
    "factions": [
      "Slum Snakes",
      "BitRunners"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "charisma": 1.03,
      "charisma_exp": 1.05,
      "company_rep": 1.05
    }
  },
  "Xanipher": {
    "name": "Xanipher",
    "baseRepRequirement": 875000,
    "baseCost": 4250000000,
    "factions": [
      "NWO"
    ],
    "prereqs": [],
    "isSpecial": false,
    "mults": {
      "hacking": 1.2,
      "strength": 1.2,
      "defense": 1.2,
      "dexterity": 1.2,
      "agility": 1.2,
      "charisma": 1.2,
      "hacking_exp": 1.15,
      "strength_exp": 1.15,
      "defense_exp": 1.15,
      "dexterity_exp": 1.15,
      "agility_exp": 1.15,
      "charisma_exp": 1.15
    }
  },
  "Z.O.Ë.": {
    "name": "Z.O.Ë.",
    "baseRepRequirement": Infinity,
    "baseCost": 1000000000000,
    "factions": [],
    "prereqs": [],
    "isSpecial": true,
    "mults": {}
  }
};
