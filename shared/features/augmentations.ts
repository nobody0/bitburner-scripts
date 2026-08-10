/** Every augmentation the game defines, transcribed from
 * `bitburner-src v3.0.1 src/Augmentation/Augmentations.ts` (via the vendored
 * copy `sim/vendor/.../AugmentationTable.ts`).
 *
 * The telemetry `offers` list cannot answer "what does this give me, and where
 * do I get it?" on its own: it only ever contains augmentations offered by
 * factions we have already JOINED, and the whole point of the panel is to
 * decide which factions are worth joining. The static facts — price, rep, the
 * offering factions, prerequisites and the multipliers — never change within a
 * release, so they belong in the bundle rather than on the wire.
 *
 * What is NOT static, and must still come from telemetry: the escalated price
 * at the current queue depth (1.9^queued), the reputation actually held, and
 * whether it is owned. Those overlay this table; they do not replace it.
 *
 * Lives here rather than being read from the vendored copy because `ui/` may
 * not import `sim/` (tests/boundaries.test.ts). Pinned entry-by-entry by
 * `sim/tests/augmentation-parity.test.ts`. */

export interface AugmentationInfo {
  /** Reputation required. Does NOT scale with the purchase queue. */
  rep: number;
  /** Base money price, before the 1.9^queued escalation. */
  cost: number;
  factions: readonly string[];
  prereqs?: readonly string[];
  /** NeuroFlux, and the endgame/gift augmentations that price differently. */
  special?: boolean;
  mults?: Readonly<Record<string, number>>;
  /** One-off cash grant on install. NOT a multiplier. */
  startingMoney?: number;
  /** Programs granted on install. NOT multipliers. */
  programs?: readonly string[];
  /** Upstream randomises this one's multipliers at load time, so `mults` is
   *  NOT the truth for this save and must not be shown as if it were. */
  multsUnknown?: boolean;
}

export const AUGMENTATIONS: Readonly<Record<string, AugmentationInfo>> = {
  "ADR-V1 Pheromone Gene": { rep: 3750, cost: 17500000, factions: ["Tian Di Hui", "The Syndicate", "NWO", "MegaCorp", "Four Sigma"], mults: { "charisma_exp": 1.05, "company_rep": 1.1, "faction_rep": 1.1 } },
  "ADR-V2 Pheromone Gene": { rep: 62500, cost: 550000000, factions: ["Silhouette", "Four Sigma", "Bachman & Associates", "Clarke Incorporated"], mults: { "charisma": 1.1, "company_rep": 1.2, "faction_rep": 1.2 } },
  "Artificial Bio-neural Network Implant": { rep: 275000, cost: 3000000000, factions: ["BitRunners", "Fulcrum Secret Technologies"], mults: { "hacking": 1.12, "hacking_money": 1.15, "hacking_speed": 1.03 } },
  "Artificial Synaptic Potentiation": { rep: 6250, cost: 80000000, factions: ["The Black Hand", "NiteSec"], mults: { "hacking_chance": 1.05, "hacking_exp": 1.05, "hacking_speed": 1.02 } },
  "Augmented Targeting I": { rep: 5000, cost: 15000000, factions: ["Slum Snakes", "The Dark Army", "The Syndicate", "Sector-12", "Ishima", "OmniTek Incorporated", "KuaiGong International", "Blade Industries"], mults: { "dexterity": 1.1 } },
  "Augmented Targeting II": { rep: 8750, cost: 42500000, factions: ["The Dark Army", "The Syndicate", "Sector-12", "OmniTek Incorporated", "KuaiGong International", "Blade Industries"], prereqs: ["Augmented Targeting I"], mults: { "dexterity": 1.2 } },
  "Augmented Targeting III": { rep: 27500, cost: 115000000, factions: ["The Dark Army", "The Syndicate", "OmniTek Incorporated", "KuaiGong International", "Blade Industries", "The Covenant"], prereqs: ["Augmented Targeting II", "Augmented Targeting I"], mults: { "dexterity": 1.3 } },
  "BLADE-51b Tesla Armor": { rep: 12500, cost: 1375000000, factions: ["Bladeburners"], special: true, mults: { "agility": 1.04, "bladeburner_stamina_gain": 1.02, "bladeburner_success_chance": 1.03, "defense": 1.04, "dexterity": 1.04, "strength": 1.04 } },
  "BLADE-51b Tesla Armor: Energy Shielding Upgrade": { rep: 21250, cost: 5500000000, factions: ["Bladeburners"], prereqs: ["BLADE-51b Tesla Armor"], special: true, mults: { "bladeburner_success_chance": 1.06, "defense": 1.05 } },
  "BLADE-51b Tesla Armor: IPU Upgrade": { rep: 15000, cost: 1100000000, factions: ["Bladeburners"], prereqs: ["BLADE-51b Tesla Armor"], special: true, mults: { "bladeburner_analysis": 1.15, "bladeburner_success_chance": 1.02 } },
  "BLADE-51b Tesla Armor: Omnibeam Upgrade": { rep: 62500, cost: 27500000000, factions: ["Bladeburners"], prereqs: ["BLADE-51b Tesla Armor: Unibeam Upgrade"], special: true, mults: { "bladeburner_success_chance": 1.1 } },
  "BLADE-51b Tesla Armor: Power Cells Upgrade": { rep: 18750, cost: 2750000000, factions: ["Bladeburners"], prereqs: ["BLADE-51b Tesla Armor"], special: true, mults: { "bladeburner_max_stamina": 1.05, "bladeburner_stamina_gain": 1.02, "bladeburner_success_chance": 1.05 } },
  "BLADE-51b Tesla Armor: Unibeam Upgrade": { rep: 31250, cost: 16500000000, factions: ["Bladeburners"], prereqs: ["BLADE-51b Tesla Armor"], special: true, mults: { "bladeburner_success_chance": 1.08 } },
  "BigD's Big ... Brain": { rep: Infinity, cost: Infinity, factions: [], special: true, mults: { "agility": 2, "agility_exp": 2, "bladeburner_analysis": 2, "bladeburner_max_stamina": 2, "bladeburner_stamina_gain": 2, "bladeburner_success_chance": 2, "charisma": 2, "charisma_exp": 2, "company_rep": 2, "crime_money": 2, "crime_success": 2, "defense": 2, "defense_exp": 2, "dexterity": 2, "dexterity_exp": 2, "faction_rep": 2, "hacking": 2, "hacking_chance": 2, "hacking_exp": 2, "hacking_grow": 2, "hacking_money": 2, "hacking_speed": 2, "hacknet_node_core_cost": 0.5, "hacknet_node_level_cost": 0.5, "hacknet_node_money": 2, "hacknet_node_purchase_cost": 0.5, "hacknet_node_ram_cost": 0.5, "strength": 2, "strength_exp": 2, "work_money": 2 }, startingMoney: 1000000000000, programs: ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "DeepscanV1.exe", "DeepscanV2.exe", "ServerProfiler.exe", "AutoLink.exe", "Formulas.exe"] },
  "Bionic Arms": { rep: 62500, cost: 275000000, factions: ["Tetrads"], mults: { "dexterity": 1.3, "strength": 1.3 } },
  "Bionic Legs": { rep: 150000, cost: 375000000, factions: ["Speakers for the Dead", "The Syndicate", "KuaiGong International", "OmniTek Incorporated", "Blade Industries"], mults: { "agility": 1.6 } },
  "Bionic Spine": { rep: 45000, cost: 125000000, factions: ["Speakers for the Dead", "The Syndicate", "KuaiGong International", "OmniTek Incorporated", "Blade Industries"], mults: { "agility": 1.15, "defense": 1.15, "dexterity": 1.15, "strength": 1.15 } },
  "BitRunners Neurolink": { rep: 875000, cost: 4375000000, factions: ["BitRunners"], mults: { "hacking": 1.15, "hacking_chance": 1.1, "hacking_exp": 1.2, "hacking_speed": 1.05 }, programs: ["FTPCrack.exe", "relaySMTP.exe"] },
  "BitWire": { rep: 3750, cost: 10000000, factions: ["CyberSec", "NiteSec"], mults: { "hacking": 1.05 } },
  "Blade's Runners": { rep: 20000, cost: 8250000000, factions: ["Bladeburners"], special: true, mults: { "agility": 1.05, "bladeburner_max_stamina": 1.05, "bladeburner_stamina_gain": 1.05 } },
  "BrachiBlades": { rep: 12500, cost: 90000000, factions: ["The Syndicate"], mults: { "crime_money": 1.15, "crime_success": 1.1, "defense": 1.15, "strength": 1.15 } },
  "CRTX42-AA Gene Modification": { rep: 45000, cost: 225000000, factions: ["NiteSec"], mults: { "hacking": 1.08, "hacking_exp": 1.15 } },
  "CashRoot Starter Kit": { rep: 12500, cost: 125000000, factions: ["Sector-12"], startingMoney: 1000000, programs: ["BruteSSH.exe"] },
  "Combat Rib I": { rep: 7500, cost: 23750000, factions: ["Slum Snakes", "The Dark Army", "The Syndicate", "Volhaven", "Ishima", "OmniTek Incorporated", "KuaiGong International", "Blade Industries"], mults: { "defense": 1.1, "strength": 1.1 } },
  "Combat Rib II": { rep: 18750, cost: 65000000, factions: ["The Dark Army", "The Syndicate", "Volhaven", "OmniTek Incorporated", "KuaiGong International", "Blade Industries"], prereqs: ["Combat Rib I"], mults: { "defense": 1.14, "strength": 1.14 } },
  "Combat Rib III": { rep: 35000, cost: 120000000, factions: ["The Dark Army", "The Syndicate", "OmniTek Incorporated", "KuaiGong International", "Blade Industries", "The Covenant"], prereqs: ["Combat Rib II", "Combat Rib I"], mults: { "defense": 1.18, "strength": 1.18 } },
  "CordiARC Fusion Reactor": { rep: 1125000, cost: 5000000000, factions: ["MegaCorp"], mults: { "agility": 1.35, "agility_exp": 1.35, "defense": 1.35, "defense_exp": 1.35, "dexterity": 1.35, "dexterity_exp": 1.35, "strength": 1.35, "strength_exp": 1.35 } },
  "Cranial Signal Processors - Gen I": { rep: 10000, cost: 70000000, factions: ["CyberSec", "NiteSec"], mults: { "hacking": 1.05, "hacking_speed": 1.01 } },
  "Cranial Signal Processors - Gen II": { rep: 18750, cost: 125000000, factions: ["CyberSec", "NiteSec"], prereqs: ["Cranial Signal Processors - Gen I"], mults: { "hacking": 1.07, "hacking_chance": 1.05, "hacking_speed": 1.02 } },
  "Cranial Signal Processors - Gen III": { rep: 50000, cost: 550000000, factions: ["NiteSec", "The Black Hand", "BitRunners"], prereqs: ["Cranial Signal Processors - Gen II", "Cranial Signal Processors - Gen I"], mults: { "hacking": 1.09, "hacking_money": 1.15, "hacking_speed": 1.02 } },
  "Cranial Signal Processors - Gen IV": { rep: 125000, cost: 1100000000, factions: ["The Black Hand", "BitRunners"], prereqs: ["Cranial Signal Processors - Gen III", "Cranial Signal Processors - Gen II", "Cranial Signal Processors - Gen I"], mults: { "hacking_grow": 1.25, "hacking_money": 1.2, "hacking_speed": 1.02 } },
  "Cranial Signal Processors - Gen V": { rep: 250000, cost: 2250000000, factions: ["BitRunners"], prereqs: ["Cranial Signal Processors - Gen IV", "Cranial Signal Processors - Gen III", "Cranial Signal Processors - Gen II", "Cranial Signal Processors - Gen I"], mults: { "hacking": 1.3, "hacking_grow": 1.75, "hacking_money": 1.25 } },
  "DataJack": { rep: 112500, cost: 450000000, factions: ["BitRunners", "The Black Hand", "NiteSec", "Chongqing", "New Tokyo"], mults: { "hacking_money": 1.25 } },
  "DermaForce Particle Barrier": { rep: 15000, cost: 50000000, factions: ["Volhaven"], mults: { "charisma": 1.05, "defense": 1.4 } },
  "ECorp HVMind Implant": { rep: 1500000, cost: 5500000000, factions: ["ECorp"], mults: { "hacking_grow": 3 } },
  "EMS-4 Recombination": { rep: 2500, cost: 275000000, factions: ["Bladeburners"], special: true, mults: { "bladeburner_analysis": 1.05, "bladeburner_stamina_gain": 1.02, "bladeburner_success_chance": 1.03 } },
  "Eloquence Module": { rep: 25000, cost: 250000000, factions: ["Speakers for the Dead"], mults: { "charisma": 1.05, "crime_success": 1.1, "work_money": 1.2 } },
  "Embedded Netburner Module": { rep: 15000, cost: 250000000, factions: ["BitRunners", "The Black Hand", "NiteSec", "ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Blade Industries"], mults: { "hacking": 1.08 } },
  "Embedded Netburner Module Analyze Engine": { rep: 625000, cost: 6000000000, factions: ["ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Daedalus", "The Covenant", "Illuminati"], prereqs: ["Embedded Netburner Module"], mults: { "hacking_speed": 1.1 } },
  "Embedded Netburner Module Core Implant": { rep: 175000, cost: 2500000000, factions: ["BitRunners", "The Black Hand", "ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Blade Industries"], prereqs: ["Embedded Netburner Module"], mults: { "hacking": 1.07, "hacking_chance": 1.03, "hacking_exp": 1.07, "hacking_money": 1.1, "hacking_speed": 1.03 } },
  "Embedded Netburner Module Core V2 Upgrade": { rep: 1000000, cost: 4500000000, factions: ["BitRunners", "ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Blade Industries", "OmniTek Incorporated", "KuaiGong International"], prereqs: ["Embedded Netburner Module Core Implant", "Embedded Netburner Module"], mults: { "hacking": 1.08, "hacking_chance": 1.05, "hacking_exp": 1.15, "hacking_money": 1.3, "hacking_speed": 1.05 } },
  "Embedded Netburner Module Core V3 Upgrade": { rep: 1750000, cost: 7500000000, factions: ["ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Daedalus", "The Covenant", "Illuminati"], prereqs: ["Embedded Netburner Module Core V2 Upgrade", "Embedded Netburner Module Core Implant", "Embedded Netburner Module"], mults: { "hacking": 1.1, "hacking_chance": 1.1, "hacking_exp": 1.25, "hacking_money": 1.4, "hacking_speed": 1.05 } },
  "Embedded Netburner Module Direct Memory Access Upgrade": { rep: 1000000, cost: 7000000000, factions: ["ECorp", "MegaCorp", "Fulcrum Secret Technologies", "NWO", "Daedalus", "The Covenant", "Illuminati"], prereqs: ["Embedded Netburner Module"], mults: { "hacking_chance": 1.2, "hacking_money": 1.4 } },
  "Enhanced Myelin Sheathing": { rep: 100000, cost: 1375000000, factions: ["Fulcrum Secret Technologies", "BitRunners", "The Black Hand"], mults: { "hacking": 1.08, "hacking_exp": 1.1, "hacking_speed": 1.03 } },
  "Enhanced Social Interaction Implant": { rep: 375000, cost: 1375000000, factions: ["Bachman & Associates", "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma"], mults: { "charisma": 1.6, "charisma_exp": 1.6 } },
  "EsperTech Bladeburner Eyewear": { rep: 1250, cost: 165000000, factions: ["Bladeburners"], special: true, mults: { "bladeburner_success_chance": 1.03, "dexterity": 1.05 } },
  "FocusWire": { rep: 75000, cost: 900000000, factions: ["Bachman & Associates", "Clarke Incorporated", "Four Sigma", "KuaiGong International"], mults: { "agility_exp": 1.05, "charisma_exp": 1.05, "company_rep": 1.1, "defense_exp": 1.05, "dexterity_exp": 1.05, "hacking_exp": 1.05, "strength_exp": 1.05, "work_money": 1.2 } },
  "GOLEM Serum": { rep: 31250, cost: 11000000000, factions: ["Bladeburners"], special: true, mults: { "agility": 1.07, "bladeburner_stamina_gain": 1.05, "defense": 1.07, "dexterity": 1.07, "strength": 1.07 } },
  "Glibness Enhancement": { rep: 40500, cost: 2500000000, factions: ["Tetrads", "Bladeburners"], mults: { "charisma_exp": 1.2, "company_rep": 1.1 } },
  "Golden Tongue Module": { rep: 125000, cost: 125000000, factions: ["Speakers for the Dead"], mults: { "charisma": 1.1, "charisma_exp": 1.3 } },
  "Graphene Bionic Arms Upgrade": { rep: 500000, cost: 3750000000, factions: ["The Dark Army"], prereqs: ["Bionic Arms"], mults: { "dexterity": 1.85, "strength": 1.85 } },
  "Graphene Bionic Legs Upgrade": { rep: 750000, cost: 4500000000, factions: ["MegaCorp", "ECorp", "Fulcrum Secret Technologies"], prereqs: ["Bionic Legs"], mults: { "agility": 2.5 } },
  "Graphene Bionic Spine Upgrade": { rep: 1625000, cost: 6000000000, factions: ["Fulcrum Secret Technologies", "ECorp"], prereqs: ["Bionic Spine"], mults: { "agility": 1.6, "defense": 1.6, "dexterity": 1.6, "strength": 1.6 } },
  "Graphene Bone Lacings": { rep: 1125000, cost: 4250000000, factions: ["Fulcrum Secret Technologies", "The Covenant"], mults: { "defense": 1.7, "strength": 1.7 } },
  "Graphene BrachiBlades Upgrade": { rep: 225000, cost: 2500000000, factions: ["Speakers for the Dead"], prereqs: ["BrachiBlades"], mults: { "crime_money": 1.3, "crime_success": 1.1, "defense": 1.4, "strength": 1.4 } },
  "Hacknet Node CPU Architecture Neural-Upload": { rep: 3750, cost: 11000000, factions: ["Netburners"], mults: { "hacknet_node_money": 1.15, "hacknet_node_purchase_cost": 0.85 } },
  "Hacknet Node Cache Architecture Neural-Upload": { rep: 2500, cost: 5500000, factions: ["Netburners"], mults: { "hacknet_node_level_cost": 0.85, "hacknet_node_money": 1.1 } },
  "Hacknet Node Core Direct-Neural Interface": { rep: 12500, cost: 60000000, factions: ["Netburners"], mults: { "hacknet_node_money": 1.45 } },
  "Hacknet Node Kernel Direct-Neural Interface": { rep: 7500, cost: 40000000, factions: ["Netburners"], mults: { "hacknet_node_money": 1.25 } },
  "Hacknet Node NIC Architecture Neural-Upload": { rep: 1875, cost: 4500000, factions: ["Netburners"], mults: { "hacknet_node_money": 1.1, "hacknet_node_purchase_cost": 0.9 } },
  "HemoRecirculator": { rep: 10000, cost: 45000000, factions: ["Tetrads", "The Dark Army", "The Syndicate"], mults: { "agility": 1.08, "charisma": 1.08, "defense": 1.08, "dexterity": 1.08, "strength": 1.08 } },
  "Hydroflame Left Arm": { rep: 1250000, cost: 2500000000000, factions: ["NWO"], mults: { "strength": 2.8 } },
  "HyperSight Corneal Implant": { rep: 150000, cost: 2750000000, factions: ["Blade Industries", "KuaiGong International"], mults: { "charisma": 1.03, "dexterity": 1.4, "hacking_money": 1.1, "hacking_speed": 1.03 } },
  "Hyperion Plasma Cannon V1": { rep: 12500, cost: 2750000000, factions: ["Bladeburners"], special: true, mults: { "bladeburner_success_chance": 1.06 } },
  "Hyperion Plasma Cannon V2": { rep: 25000, cost: 5500000000, factions: ["Bladeburners"], prereqs: ["Hyperion Plasma Cannon V1"], special: true, mults: { "bladeburner_success_chance": 1.08 } },
  "I.N.T.E.R.L.I.N.K.E.D": { rep: 25000, cost: 5500000000, factions: ["Bladeburners"], special: true, mults: { "agility_exp": 1.05, "bladeburner_max_stamina": 1.1, "defense_exp": 1.05, "dexterity_exp": 1.05, "strength_exp": 1.05 } },
  "INFRARET Enhancement": { rep: 7500, cost: 30000000, factions: ["Ishima"], mults: { "crime_money": 1.1, "crime_success": 1.25, "dexterity": 1.1 } },
  "LuminCloaking-V1 Skin Implant": { rep: 1500, cost: 5000000, factions: ["Slum Snakes", "Tetrads"], mults: { "agility": 1.05, "charisma": 1.03, "crime_money": 1.1 } },
  "LuminCloaking-V2 Skin Implant": { rep: 5000, cost: 30000000, factions: ["Slum Snakes", "Tetrads"], prereqs: ["LuminCloaking-V1 Skin Implant"], mults: { "agility": 1.1, "charisma_exp": 1.1, "crime_money": 1.25, "defense": 1.1 } },
  "Magnetism Amplifier": { rep: 15000, cost: 250000000, factions: ["The Black Hand", "The Dark Army"], mults: { "charisma": 1.05, "company_rep": 1.1 } },
  "NEMEAN Subdermal Weave": { rep: 875000, cost: 3250000000, factions: ["The Syndicate", "Fulcrum Secret Technologies", "Illuminati", "Daedalus", "The Covenant"], mults: { "defense": 2.2 } },
  "Nanofiber Weave": { rep: 37500, cost: 125000000, factions: ["The Dark Army", "The Syndicate", "OmniTek Incorporated", "Blade Industries", "Tian Di Hui", "Speakers for the Dead", "Fulcrum Secret Technologies"], mults: { "charisma": 1.05, "defense": 1.2, "strength": 1.2 } },
  "Neotra": { rep: 562500, cost: 2875000000, factions: ["Blade Industries"], mults: { "charisma": 1.55, "defense": 1.55, "strength": 1.55 } },
  "Neural Accelerator": { rep: 200000, cost: 1750000000, factions: ["BitRunners"], mults: { "hacking": 1.1, "hacking_exp": 1.15, "hacking_money": 1.2 } },
  "Neural Wit Amplifier": { rep: 5000, cost: 10000000, factions: ["Slum Snakes", "BitRunners"], mults: { "charisma": 1.03, "charisma_exp": 1.05, "company_rep": 1.05 } },
  "Neural-Retention Enhancement": { rep: 20000, cost: 250000000, factions: ["NiteSec"], mults: { "hacking_exp": 1.25 } },
  "Neuralstimulator": { rep: 50000, cost: 3000000000, factions: ["The Black Hand", "Chongqing", "Sector-12", "New Tokyo", "Aevum", "Ishima", "Volhaven", "Bachman & Associates", "Clarke Incorporated", "Four Sigma"], mults: { "hacking_chance": 1.1, "hacking_exp": 1.12, "hacking_speed": 1.02 } },
  "Neuregen Gene Modification": { rep: 37500, cost: 375000000, factions: ["Chongqing"], mults: { "hacking_exp": 1.4 } },
  "NeuroFlux Governor": { rep: 500, cost: 750000, factions: ["Illuminati", "Daedalus", "The Covenant", "ECorp", "MegaCorp", "Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma", "KuaiGong International", "Fulcrum Secret Technologies", "BitRunners", "The Black Hand", "NiteSec", "Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12", "Volhaven", "Speakers for the Dead", "The Dark Army", "The Syndicate", "Silhouette", "Tetrads", "Slum Snakes", "Netburners", "Tian Di Hui", "CyberSec"], special: true, mults: { "agility": 1.01000262, "agility_exp": 1.01000262, "charisma": 1.01000262, "charisma_exp": 1.01000262, "company_rep": 1.01000262, "crime_money": 1.01000262, "crime_success": 1.01000262, "defense": 1.01000262, "defense_exp": 1.01000262, "dexterity": 1.01000262, "dexterity_exp": 1.01000262, "faction_rep": 1.01000262, "hacking": 1.01000262, "hacking_chance": 1.01000262, "hacking_exp": 1.01000262, "hacking_grow": 1.01000262, "hacking_money": 1.01000262, "hacking_speed": 1.01000262, "hacknet_node_core_cost": 0.990096441532003, "hacknet_node_level_cost": 0.990096441532003, "hacknet_node_money": 1.01000262, "hacknet_node_purchase_cost": 0.990096441532003, "hacknet_node_ram_cost": 0.990096441532003, "strength": 1.01000262, "strength_exp": 1.01000262, "work_money": 1.01000262 } },
  "Neuronal Densification": { rep: 187500, cost: 1375000000, factions: ["Clarke Incorporated"], mults: { "hacking": 1.15, "hacking_exp": 1.1, "hacking_speed": 1.03 } },
  "Neuroreceptor Management Implant": { rep: 75000, cost: 550000000, factions: ["Tian Di Hui"] },
  "Neurotrainer I": { rep: 1000, cost: 4000000, factions: ["CyberSec", "Aevum"], mults: { "agility_exp": 1.1, "charisma_exp": 1.1, "defense_exp": 1.1, "dexterity_exp": 1.1, "hacking_exp": 1.1, "strength_exp": 1.1 } },
  "Neurotrainer II": { rep: 10000, cost: 45000000, factions: ["BitRunners", "NiteSec"], mults: { "agility_exp": 1.15, "charisma_exp": 1.15, "defense_exp": 1.15, "dexterity_exp": 1.15, "hacking_exp": 1.15, "strength_exp": 1.15 } },
  "Neurotrainer III": { rep: 25000, cost: 130000000, factions: ["NWO", "Four Sigma"], mults: { "agility_exp": 1.2, "charisma_exp": 1.2, "defense_exp": 1.2, "dexterity_exp": 1.2, "hacking_exp": 1.2, "strength_exp": 1.2 } },
  "Nuoptimal Nootropic Injector Implant": { rep: 5000, cost: 20000000, factions: ["Tian Di Hui", "Volhaven", "New Tokyo", "Chongqing", "Clarke Incorporated", "Four Sigma", "Bachman & Associates"], mults: { "charisma": 1.03, "company_rep": 1.2 } },
  "NutriGen Implant": { rep: 6250, cost: 2500000, factions: ["New Tokyo"], mults: { "agility_exp": 1.2, "defense_exp": 1.2, "dexterity_exp": 1.2, "strength_exp": 1.2 } },
  "ORION-MKIV Shoulder": { rep: 6250, cost: 550000000, factions: ["Bladeburners"], special: true, mults: { "bladeburner_success_chance": 1.04, "defense": 1.05, "dexterity": 1.05, "strength": 1.05 } },
  "OmniTek InfoLoad": { rep: 625000, cost: 2875000000, factions: ["OmniTek Incorporated"], mults: { "hacking": 1.2, "hacking_exp": 1.25 } },
  "PC Direct-Neural Interface": { rep: 375000, cost: 3750000000, factions: ["Four Sigma", "OmniTek Incorporated", "ECorp", "Blade Industries"], mults: { "company_rep": 1.3, "hacking": 1.08 } },
  "PC Direct-Neural Interface NeuroNet Injector": { rep: 1500000, cost: 7500000000, factions: ["Fulcrum Secret Technologies"], prereqs: ["PC Direct-Neural Interface"], mults: { "company_rep": 2, "hacking": 1.1, "hacking_speed": 1.05 } },
  "PC Direct-Neural Interface Optimization Submodule": { rep: 500000, cost: 4500000000, factions: ["Fulcrum Secret Technologies", "ECorp", "Blade Industries"], prereqs: ["PC Direct-Neural Interface"], mults: { "company_rep": 1.75, "hacking": 1.1 } },
  "PCMatrix": { rep: 100000, cost: 2000000000, factions: ["Aevum"], mults: { "charisma": 1.0777, "charisma_exp": 1.0777, "company_rep": 1.0777, "crime_money": 1.0777, "crime_success": 1.0777, "faction_rep": 1.0777, "work_money": 1.777 }, programs: ["DeepscanV1.exe", "AutoLink.exe"] },
  "Photosynthetic Cells": { rep: 562500, cost: 2750000000, factions: ["KuaiGong International"], mults: { "agility": 1.4, "charisma": 1.2, "defense": 1.4, "strength": 1.4 } },
  "Power Recirculation Core": { rep: 25000, cost: 180000000, factions: ["Tetrads", "The Dark Army", "The Syndicate", "NWO"], mults: { "agility": 1.05, "agility_exp": 1.1, "charisma": 1.05, "charisma_exp": 1.1, "defense": 1.05, "defense_exp": 1.1, "dexterity": 1.05, "dexterity_exp": 1.1, "hacking": 1.05, "hacking_exp": 1.1, "strength": 1.05, "strength_exp": 1.1 } },
  "QLink": { rep: 1875000, cost: 25000000000000, factions: ["Illuminati"], mults: { "hacking": 1.75, "hacking_chance": 2.5, "hacking_money": 4, "hacking_speed": 2 } },
  "SPTN-97 Gene Modification": { rep: 1250000, cost: 4875000000, factions: ["The Covenant"], mults: { "agility": 1.75, "defense": 1.75, "dexterity": 1.75, "hacking": 1.15, "strength": 1.75 } },
  "SmartJaw": { rep: 375000, cost: 2750000000, factions: ["Bachman & Associates"], mults: { "charisma": 1.5, "charisma_exp": 1.5, "company_rep": 1.25, "faction_rep": 1.25 } },
  "SmartSonar Implant": { rep: 22500, cost: 75000000, factions: ["Slum Snakes"], mults: { "crime_money": 1.25, "dexterity": 1.1, "dexterity_exp": 1.15 } },
  "SoA - Beauty of Aphrodite": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true, mults: { "charisma": 1.1 } },
  "SoA - Chaos of Dionysus": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Flood of Poseidon": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Hunt of Artemis": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Knowledge of Apollo": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Might of Ares": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Trickery of Hermes": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - Wisdom of Athena": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "SoA - phyzical WKS harmonizer": { rep: 10000, cost: 1000000, factions: ["Shadows of Anarchy"], special: true },
  "Social Dynamics Processor": { rep: 225000, cost: 1200000000, factions: ["MegaCorp", "ECorp", "OmniTek Incorporated"], mults: { "charisma": 1.1, "company_rep": 1.3 } },
  "Social Negotiation Assistant (S.N.A)": { rep: 6250, cost: 30000000, factions: ["Tian Di Hui"], mults: { "charisma_exp": 1.15, "company_rep": 1.15, "faction_rep": 1.15, "work_money": 1.1 } },
  "Speech Enhancement": { rep: 2500, cost: 12500000, factions: ["Tian Di Hui", "Speakers for the Dead", "Four Sigma", "KuaiGong International", "Clarke Incorporated", "Bachman & Associates"], mults: { "charisma": 1.1, "company_rep": 1.1 } },
  "Speech Processor Implant": { rep: 7500, cost: 50000000, factions: ["Tian Di Hui", "Chongqing", "Sector-12", "New Tokyo", "Aevum", "Ishima", "Volhaven", "Silhouette"], mults: { "charisma": 1.2 } },
  "Stanek's Gift - Awakening": { rep: 1000000, cost: 0, factions: ["Church of the Machine God"], prereqs: ["Stanek's Gift - Genesis"], special: true, mults: { "agility": 1.0555555555555556, "agility_exp": 1.0555555555555556, "charisma": 1.0555555555555556, "charisma_exp": 1.0555555555555556, "company_rep": 1.0555555555555556, "crime_money": 1.0555555555555556, "crime_success": 1.0555555555555556, "defense": 1.0555555555555556, "defense_exp": 1.0555555555555556, "dexterity": 1.0555555555555556, "dexterity_exp": 1.0555555555555556, "faction_rep": 1.0555555555555556, "hacking": 1.0555555555555556, "hacking_chance": 1.0555555555555556, "hacking_exp": 1.0555555555555556, "hacking_grow": 1.0555555555555556, "hacking_money": 1.0555555555555556, "hacking_speed": 1.0555555555555556, "hacknet_node_core_cost": 0.9545454545454545, "hacknet_node_level_cost": 0.9545454545454545, "hacknet_node_money": 1.0555555555555556, "hacknet_node_purchase_cost": 0.9545454545454545, "hacknet_node_ram_cost": 0.9545454545454545, "strength": 1.0555555555555556, "strength_exp": 1.0555555555555556, "work_money": 1.0555555555555556 } },
  "Stanek's Gift - Genesis": { rep: 0, cost: 0, factions: ["Church of the Machine God"], special: true, mults: { "agility": 0.9, "agility_exp": 0.9, "charisma": 0.9, "charisma_exp": 0.9, "company_rep": 0.9, "crime_money": 0.9, "crime_success": 0.9, "defense": 0.9, "defense_exp": 0.9, "dexterity": 0.9, "dexterity_exp": 0.9, "faction_rep": 0.9, "hacking": 0.9, "hacking_chance": 0.9, "hacking_exp": 0.9, "hacking_grow": 0.9, "hacking_money": 0.9, "hacking_speed": 0.9, "hacknet_node_core_cost": 1.1, "hacknet_node_level_cost": 1.1, "hacknet_node_money": 0.9, "hacknet_node_purchase_cost": 1.1, "hacknet_node_ram_cost": 1.1, "strength": 0.9, "strength_exp": 0.9, "work_money": 0.9 } },
  "Stanek's Gift - Serenity": { rep: 100000000, cost: 0, factions: ["Church of the Machine God"], prereqs: ["Stanek's Gift - Awakening", "Stanek's Gift - Genesis"], special: true, mults: { "agility": 1.0526315789473684, "agility_exp": 1.0526315789473684, "charisma": 1.0526315789473684, "charisma_exp": 1.0526315789473684, "company_rep": 1.0526315789473684, "crime_money": 1.0526315789473684, "crime_success": 1.0526315789473684, "defense": 1.0526315789473684, "defense_exp": 1.0526315789473684, "dexterity": 1.0526315789473684, "dexterity_exp": 1.0526315789473684, "faction_rep": 1.0526315789473684, "hacking": 1.0526315789473684, "hacking_chance": 1.0526315789473684, "hacking_exp": 1.0526315789473684, "hacking_grow": 1.0526315789473684, "hacking_money": 1.0526315789473684, "hacking_speed": 1.0526315789473684, "hacknet_node_core_cost": 0.9523809523809523, "hacknet_node_level_cost": 0.9523809523809523, "hacknet_node_money": 1.0526315789473684, "hacknet_node_purchase_cost": 0.9523809523809523, "hacknet_node_ram_cost": 0.9523809523809523, "strength": 1.0526315789473684, "strength_exp": 1.0526315789473684, "work_money": 1.0526315789473684 } },
  "Synaptic Enhancement Implant": { rep: 2000, cost: 7500000, factions: ["CyberSec", "Aevum"], mults: { "hacking_speed": 1.03 } },
  "Synfibril Muscle": { rep: 437500, cost: 1125000000, factions: ["KuaiGong International", "Fulcrum Secret Technologies", "Speakers for the Dead", "NWO", "The Covenant", "Daedalus", "Illuminati", "Blade Industries"], mults: { "defense": 1.3, "strength": 1.3 } },
  "Synthetic Heart": { rep: 750000, cost: 2875000000, factions: ["KuaiGong International", "Fulcrum Secret Technologies", "Speakers for the Dead", "NWO", "The Covenant", "Daedalus", "Illuminati"], mults: { "agility": 1.5, "charisma": 1.3, "strength": 1.5 } },
  "TITN-41 Gene-Modification Injection": { rep: 25000, cost: 190000000, factions: ["Silhouette"], mults: { "charisma": 1.15, "charisma_exp": 1.15 } },
  "The B00ts of Perseus": { rep: 10000, cost: 1000000, factions: [], prereqs: ["The W1ngs of Icarus"], special: true, mults: { "charisma": 1.06, "dexterity": 1.06 } },
  "The B1ade of Solomonoff": { rep: 10000, cost: 1000000, factions: [], prereqs: ["The L4w of Bayes"], special: true, mults: { "charisma": 1.1, "company_rep": 1.1, "dnet_money": 1.1, "hacking": 1.1 } },
  "The Black Hand": { rep: 100000, cost: 550000000, factions: ["The Black Hand"], mults: { "dexterity": 1.15, "hacking": 1.1, "hacking_money": 1.1, "hacking_speed": 1.02, "strength": 1.15 } },
  "The Blade's Simulacrum": { rep: 1250, cost: 150000000000, factions: ["Bladeburners"], special: true },
  "The H4mmer of Daedalus": { rep: 10000, cost: 1000000, factions: [], prereqs: ["The B00ts of Perseus"], special: true, mults: { "charisma": 1.07, "dnet_money": 1.1, "strength": 1.1 } },
  "The Illustrated Primer": { rep: 187500, cost: 3375000000, factions: ["The Dark Army", "The Syndicate"], mults: { "charisma": 1.1, "charisma_exp": 1.4 } },
  "The L4w of Bayes": { rep: 10000, cost: 1000000, factions: [], prereqs: ["The St4ff of Asclepius"], special: true, mults: { "charisma": 1.09, "company_rep": 1.05, "dnet_money": 1.15 } },
  "The Red Pill": { rep: 2500000, cost: 0, factions: ["Daedalus"], special: true },
  "The Shadow's Simulacrum": { rep: 37500, cost: 400000000, factions: ["The Syndicate", "The Dark Army", "Speakers for the Dead"], mults: { "company_rep": 1.15, "faction_rep": 1.15 } },
  "The St4ff of Asclepius": { rep: 10000, cost: 1000000, factions: [], prereqs: ["The H4mmer of Daedalus"], special: true, mults: { "charisma_exp": 1.1, "defense": 1.1, "dnet_money": 1.1 } },
  "The W1ngs of Icarus": { rep: 10000, cost: 1000000, factions: [], special: true, mults: { "agility": 1.1, "charisma": 1.05, "dnet_money": 1.3 } },
  "Unstable Circadian Modulator": { rep: 362500, cost: 5000000000, factions: ["Speakers for the Dead"], multsUnknown: true },
  "Vangelis Virus": { rep: 18750, cost: 2750000000, factions: ["Bladeburners"], special: true, mults: { "bladeburner_analysis": 1.1, "bladeburner_success_chance": 1.04, "charisma_exp": 1.1, "dexterity_exp": 1.1 } },
  "Vangelis Virus 3.0": { rep: 37500, cost: 11000000000, factions: ["Bladeburners"], prereqs: ["Vangelis Virus"], special: true, mults: { "bladeburner_analysis": 1.15, "bladeburner_success_chance": 1.05, "charisma_exp": 1.1, "defense_exp": 1.1, "dexterity_exp": 1.1 } },
  "Wired Reflexes": { rep: 1250, cost: 2500000, factions: ["Tian Di Hui", "Slum Snakes", "Sector-12", "Volhaven", "Aevum", "Ishima", "The Syndicate", "The Dark Army", "Speakers for the Dead"], mults: { "agility": 1.05, "dexterity": 1.05 } },
  "Xanipher": { rep: 875000, cost: 4250000000, factions: ["NWO"], mults: { "agility": 1.2, "agility_exp": 1.15, "charisma": 1.2, "charisma_exp": 1.15, "defense": 1.2, "defense_exp": 1.15, "dexterity": 1.2, "dexterity_exp": 1.15, "hacking": 1.2, "hacking_exp": 1.15, "strength": 1.2, "strength_exp": 1.15 } },
  "Z.O.\u00cb.": { rep: Infinity, cost: 1000000000000, factions: [], special: true },
  "nextSENS Gene Modification": { rep: 437500, cost: 1925000000, factions: ["Clarke Incorporated"], mults: { "agility": 1.2, "charisma": 1.2, "defense": 1.2, "dexterity": 1.2, "hacking": 1.2, "strength": 1.2 } },
  "violet Congruity Implant": { rep: Infinity, cost: 50000000000000, factions: [] },
};


/** Which factions offer an augmentation. Empty for one the table has not met
 * (a modded or newer aug), which is different from "no faction offers it". */
export function offeredBy(name: string): readonly string[] {
  return AUGMENTATIONS[name]?.factions ?? [];
}

/** Display names for the multiplier fields, so a panel can say "hack money"
 * rather than "hacking_money". */
const MULT_LABELS: Readonly<Record<string, string>> = {
  agility: "agility",
  agility_exp: "agi exp",
  bladeburner_analysis: "bb analysis",
  bladeburner_max_stamina: "bb stamina max",
  bladeburner_stamina_gain: "bb stamina gain",
  bladeburner_success_chance: "bb success",
  charisma: "charisma",
  charisma_exp: "cha exp",
  company_rep: "company rep",
  crime_money: "crime $",
  crime_success: "crime success",
  defense: "defense",
  defense_exp: "def exp",
  dexterity: "dexterity",
  dexterity_exp: "dex exp",
  dnet_money: "darknet $",
  faction_rep: "faction rep",
  hacking: "hacking",
  hacking_chance: "hack chance",
  hacking_exp: "hack exp",
  hacking_grow: "grow",
  hacking_money: "hack $",
  hacking_speed: "hack speed",
  hacknet_node_core_cost: "hacknet core cost",
  hacknet_node_level_cost: "hacknet level cost",
  hacknet_node_money: "hacknet $",
  hacknet_node_purchase_cost: "hacknet buy cost",
  hacknet_node_ram_cost: "hacknet ram cost",
  strength: "strength",
  strength_exp: "str exp",
  work_money: "work $",
};

export function multLabel(field: string): string {
  return MULT_LABELS[field] ?? field;
}

/** What an augmentation actually gives, biggest effect first.
 *
 * A cost multiplier below 1.0 is a BENEFIT (hacknet upgrades get cheaper), so
 * "how far from 1.0" is the wrong ordering on its own — the sort is by the
 * magnitude of the improvement, and the sign is rendered as written. */
export function describeMults(
  mults: Readonly<Record<string, number>> | undefined,
  limit = 3,
): { label: string; delta: number; text: string }[] {
  if (!mults) return [];
  return Object.entries(mults)
    .map(([field, value]) => ({
      label: multLabel(field),
      delta: value - 1,
      text: `${multLabel(field)} ${value >= 1 ? "+" : ""}${((value - 1) * 100).toFixed(0)}%`,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}
