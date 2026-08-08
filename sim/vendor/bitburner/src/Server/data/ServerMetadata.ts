// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Server/data/servers.ts) — DO NOT EDIT
/** A field upstream rolls at world generation, as [min, max]. A fixed
 *  value is emitted as a degenerate range. */
export type Range = [number, number];

export interface VendoredServer {
  host: string;
  /** BASE money. The live `moneyMax` is `25 * roll * ServerMaxMoney`. */
  money?: Range;
  skill?: Range;
  /** Base security. `minDifficulty` is `round(roll / 3)`, both after
   *  ServerStartingSecurity. */
  sec?: Range;
  growth?: Range;
  ramExp?: Range;
  ports: number;
}

export const SERVER_METADATA: Record<string, VendoredServer> = {
  "ecorp": {
    "host": "ecorp",
    "money": [
      30000000000,
      70000000000
    ],
    "skill": [
      1050,
      1400
    ],
    "sec": [
      99,
      99
    ],
    "growth": [
      99,
      99
    ],
    "ports": 5
  },
  "megacorp": {
    "host": "megacorp",
    "money": [
      40000000000,
      60000000000
    ],
    "skill": [
      1100,
      1350
    ],
    "sec": [
      99,
      99
    ],
    "growth": [
      99,
      99
    ],
    "ports": 5
  },
  "b-and-a": {
    "host": "b-and-a",
    "money": [
      15000000000,
      30000000000
    ],
    "skill": [
      900,
      1150
    ],
    "sec": [
      72,
      88
    ],
    "growth": [
      60,
      80
    ],
    "ports": 5
  },
  "blade": {
    "host": "blade",
    "money": [
      10000000000,
      40000000000
    ],
    "skill": [
      900,
      1200
    ],
    "sec": [
      88,
      97
    ],
    "growth": [
      55,
      85
    ],
    "ramExp": [
      5,
      9
    ],
    "ports": 5
  },
  "nwo": {
    "host": "nwo",
    "money": [
      20000000000,
      40000000000
    ],
    "skill": [
      950,
      1300
    ],
    "sec": [
      99,
      99
    ],
    "growth": [
      65,
      95
    ],
    "ports": 5
  },
  "clarkinc": {
    "host": "clarkinc",
    "money": [
      15000000000,
      25000000000
    ],
    "skill": [
      950,
      1250
    ],
    "sec": [
      45,
      65
    ],
    "growth": [
      45,
      75
    ],
    "ports": 5
  },
  "omnitek": {
    "host": "omnitek",
    "money": [
      13000000000,
      22000000000
    ],
    "skill": [
      900,
      1100
    ],
    "sec": [
      90,
      99
    ],
    "growth": [
      95,
      99
    ],
    "ramExp": [
      7,
      9
    ],
    "ports": 5
  },
  "4sigma": {
    "host": "4sigma",
    "money": [
      15000000000,
      25000000000
    ],
    "skill": [
      900,
      1250
    ],
    "sec": [
      55,
      75
    ],
    "growth": [
      75,
      99
    ],
    "ports": 5
  },
  "kuai-gong": {
    "host": "kuai-gong",
    "money": [
      20000000000,
      30000000000
    ],
    "skill": [
      950,
      1300
    ],
    "sec": [
      95,
      99
    ],
    "growth": [
      90,
      99
    ],
    "ports": 5
  },
  "fulcrumtech": {
    "host": "fulcrumtech",
    "money": [
      1400000000,
      1800000000
    ],
    "skill": [
      950,
      1250
    ],
    "sec": [
      83,
      97
    ],
    "growth": [
      80,
      99
    ],
    "ramExp": [
      7,
      11
    ],
    "ports": 5
  },
  "fulcrumassets": {
    "host": "fulcrumassets",
    "money": [
      1000000,
      1000000
    ],
    "skill": [
      1100,
      1600
    ],
    "sec": [
      99,
      99
    ],
    "growth": [
      1,
      1
    ],
    "ports": 5
  },
  "stormtech": {
    "host": "stormtech",
    "money": [
      1000000000,
      1200000000
    ],
    "skill": [
      875,
      1075
    ],
    "sec": [
      78,
      92
    ],
    "growth": [
      68,
      92
    ],
    "ports": 5
  },
  "defcomm": {
    "host": "defcomm",
    "money": [
      800000000,
      950000000
    ],
    "skill": [
      850,
      1050
    ],
    "sec": [
      84,
      96
    ],
    "growth": [
      47,
      73
    ],
    "ports": 5
  },
  "infocomm": {
    "host": "infocomm",
    "money": [
      600000000,
      900000000
    ],
    "skill": [
      875,
      950
    ],
    "sec": [
      70,
      90
    ],
    "growth": [
      35,
      75
    ],
    "ports": 5
  },
  "helios": {
    "host": "helios",
    "money": [
      550000000,
      750000000
    ],
    "skill": [
      800,
      900
    ],
    "sec": [
      85,
      95
    ],
    "growth": [
      70,
      80
    ],
    "ramExp": [
      5,
      8
    ],
    "ports": 5
  },
  "vitalife": {
    "host": "vitalife",
    "money": [
      700000000,
      800000000
    ],
    "skill": [
      775,
      900
    ],
    "sec": [
      80,
      90
    ],
    "growth": [
      60,
      80
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 5
  },
  "icarus": {
    "host": "icarus",
    "money": [
      900000000,
      1000000000
    ],
    "skill": [
      850,
      925
    ],
    "sec": [
      85,
      95
    ],
    "growth": [
      85,
      95
    ],
    "ports": 5
  },
  "univ-energy": {
    "host": "univ-energy",
    "money": [
      1100000000,
      1200000000
    ],
    "skill": [
      800,
      900
    ],
    "sec": [
      80,
      90
    ],
    "growth": [
      80,
      90
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 4
  },
  "titan-labs": {
    "host": "titan-labs",
    "money": [
      750000000,
      900000000
    ],
    "skill": [
      800,
      875
    ],
    "sec": [
      70,
      80
    ],
    "growth": [
      60,
      80
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 5
  },
  "microdyne": {
    "host": "microdyne",
    "money": [
      500000000,
      700000000
    ],
    "skill": [
      800,
      875
    ],
    "sec": [
      65,
      75
    ],
    "growth": [
      70,
      90
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 5
  },
  "taiyang-digital": {
    "host": "taiyang-digital",
    "money": [
      800000000,
      900000000
    ],
    "skill": [
      850,
      950
    ],
    "sec": [
      70,
      80
    ],
    "growth": [
      70,
      80
    ],
    "ports": 5
  },
  "galactic-cyber": {
    "host": "galactic-cyber",
    "money": [
      750000000,
      850000000
    ],
    "skill": [
      825,
      875
    ],
    "sec": [
      55,
      65
    ],
    "growth": [
      70,
      90
    ],
    "ports": 5
  },
  "aerocorp": {
    "host": "aerocorp",
    "money": [
      1000000000,
      1200000000
    ],
    "skill": [
      850,
      925
    ],
    "sec": [
      80,
      90
    ],
    "growth": [
      55,
      65
    ],
    "ports": 5
  },
  "omnia": {
    "host": "omnia",
    "money": [
      900000000,
      1000000000
    ],
    "skill": [
      850,
      950
    ],
    "sec": [
      85,
      95
    ],
    "growth": [
      60,
      70
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 5
  },
  "zb-def": {
    "host": "zb-def",
    "money": [
      900000000,
      1100000000
    ],
    "skill": [
      775,
      825
    ],
    "sec": [
      55,
      65
    ],
    "growth": [
      65,
      75
    ],
    "ports": 4
  },
  "applied-energetics": {
    "host": "applied-energetics",
    "money": [
      700000000,
      1000000000
    ],
    "skill": [
      775,
      850
    ],
    "sec": [
      60,
      80
    ],
    "growth": [
      70,
      75
    ],
    "ports": 4
  },
  "solaris": {
    "host": "solaris",
    "money": [
      700000000,
      900000000
    ],
    "skill": [
      750,
      850
    ],
    "sec": [
      70,
      80
    ],
    "growth": [
      70,
      80
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 5
  },
  "deltaone": {
    "host": "deltaone",
    "money": [
      1300000000,
      1700000000
    ],
    "skill": [
      800,
      900
    ],
    "sec": [
      75,
      85
    ],
    "growth": [
      50,
      70
    ],
    "ports": 5
  },
  "global-pharm": {
    "host": "global-pharm",
    "money": [
      1500000000,
      1750000000
    ],
    "skill": [
      750,
      850
    ],
    "sec": [
      75,
      85
    ],
    "growth": [
      80,
      90
    ],
    "ramExp": [
      3,
      6
    ],
    "ports": 4
  },
  "nova-med": {
    "host": "nova-med",
    "money": [
      1100000000,
      1250000000
    ],
    "skill": [
      775,
      850
    ],
    "sec": [
      60,
      80
    ],
    "growth": [
      65,
      85
    ],
    "ports": 4
  },
  "zeus-med": {
    "host": "zeus-med",
    "money": [
      1300000000,
      1500000000
    ],
    "skill": [
      800,
      850
    ],
    "sec": [
      70,
      90
    ],
    "growth": [
      70,
      80
    ],
    "ports": 5
  },
  "unitalife": {
    "host": "unitalife",
    "money": [
      1000000000,
      1100000000
    ],
    "skill": [
      775,
      825
    ],
    "sec": [
      70,
      80
    ],
    "growth": [
      70,
      80
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 4
  },
  "lexo-corp": {
    "host": "lexo-corp",
    "money": [
      700000000,
      800000000
    ],
    "skill": [
      650,
      750
    ],
    "sec": [
      60,
      80
    ],
    "growth": [
      55,
      65
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 4
  },
  "rho-construction": {
    "host": "rho-construction",
    "money": [
      500000000,
      700000000
    ],
    "skill": [
      475,
      525
    ],
    "sec": [
      40,
      60
    ],
    "growth": [
      40,
      60
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 3
  },
  "alpha-ent": {
    "host": "alpha-ent",
    "money": [
      600000000,
      750000000
    ],
    "skill": [
      500,
      600
    ],
    "sec": [
      50,
      70
    ],
    "growth": [
      50,
      60
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 4
  },
  "aevum-police": {
    "host": "aevum-police",
    "money": [
      200000000,
      400000000
    ],
    "skill": [
      400,
      450
    ],
    "sec": [
      70,
      80
    ],
    "growth": [
      30,
      50
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 4
  },
  "rothman-uni": {
    "host": "rothman-uni",
    "money": [
      175000000,
      250000000
    ],
    "skill": [
      370,
      430
    ],
    "sec": [
      45,
      55
    ],
    "growth": [
      35,
      45
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 3
  },
  "zb-institute": {
    "host": "zb-institute",
    "money": [
      800000000,
      1100000000
    ],
    "skill": [
      725,
      775
    ],
    "sec": [
      65,
      85
    ],
    "growth": [
      75,
      85
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 5
  },
  "summit-uni": {
    "host": "summit-uni",
    "money": [
      200000000,
      350000000
    ],
    "skill": [
      425,
      475
    ],
    "sec": [
      45,
      65
    ],
    "growth": [
      40,
      60
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 3
  },
  "syscore": {
    "host": "syscore",
    "money": [
      400000000,
      600000000
    ],
    "skill": [
      550,
      650
    ],
    "sec": [
      60,
      80
    ],
    "growth": [
      60,
      70
    ],
    "ports": 4
  },
  "catalyst": {
    "host": "catalyst",
    "money": [
      300000000,
      550000000
    ],
    "skill": [
      400,
      450
    ],
    "sec": [
      60,
      70
    ],
    "growth": [
      25,
      55
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 3
  },
  "the-hub": {
    "host": "the-hub",
    "money": [
      150000000,
      200000000
    ],
    "skill": [
      275,
      325
    ],
    "sec": [
      35,
      45
    ],
    "growth": [
      45,
      55
    ],
    "ramExp": [
      3,
      6
    ],
    "ports": 2
  },
  "computek": {
    "host": "computek",
    "money": [
      220000000,
      250000000
    ],
    "skill": [
      300,
      400
    ],
    "sec": [
      55,
      65
    ],
    "growth": [
      45,
      65
    ],
    "ports": 3
  },
  "netlink": {
    "host": "netlink",
    "money": [
      275000000,
      275000000
    ],
    "skill": [
      375,
      425
    ],
    "sec": [
      60,
      80
    ],
    "growth": [
      45,
      75
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 3
  },
  "johnson-ortho": {
    "host": "johnson-ortho",
    "money": [
      70000000,
      85000000
    ],
    "skill": [
      250,
      300
    ],
    "sec": [
      35,
      65
    ],
    "growth": [
      35,
      65
    ],
    "ports": 2
  },
  "n00dles": {
    "host": "n00dles",
    "money": [
      70000,
      70000
    ],
    "skill": [
      1,
      1
    ],
    "sec": [
      1,
      1
    ],
    "growth": [
      3000,
      3000
    ],
    "ramExp": [
      2,
      2
    ],
    "ports": 0
  },
  "foodnstuff": {
    "host": "foodnstuff",
    "money": [
      2000000,
      2000000
    ],
    "skill": [
      1,
      1
    ],
    "sec": [
      10,
      10
    ],
    "growth": [
      5,
      5
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "sigma-cosmetics": {
    "host": "sigma-cosmetics",
    "money": [
      2300000,
      2300000
    ],
    "skill": [
      5,
      5
    ],
    "sec": [
      10,
      10
    ],
    "growth": [
      10,
      10
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "joesguns": {
    "host": "joesguns",
    "money": [
      2500000,
      2500000
    ],
    "skill": [
      10,
      10
    ],
    "sec": [
      15,
      15
    ],
    "growth": [
      20,
      20
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "zer0": {
    "host": "zer0",
    "money": [
      7500000,
      7500000
    ],
    "skill": [
      75,
      75
    ],
    "sec": [
      25,
      25
    ],
    "growth": [
      40,
      40
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 1
  },
  "nectar-net": {
    "host": "nectar-net",
    "money": [
      2750000,
      2750000
    ],
    "skill": [
      20,
      20
    ],
    "sec": [
      20,
      20
    ],
    "growth": [
      25,
      25
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "neo-net": {
    "host": "neo-net",
    "money": [
      5000000,
      5000000
    ],
    "skill": [
      50,
      50
    ],
    "sec": [
      25,
      25
    ],
    "growth": [
      25,
      25
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 1
  },
  "silver-helix": {
    "host": "silver-helix",
    "money": [
      45000000,
      45000000
    ],
    "skill": [
      150,
      150
    ],
    "sec": [
      30,
      30
    ],
    "growth": [
      30,
      30
    ],
    "ramExp": [
      6,
      6
    ],
    "ports": 2
  },
  "hong-fang-tea": {
    "host": "hong-fang-tea",
    "money": [
      3000000,
      3000000
    ],
    "skill": [
      30,
      30
    ],
    "sec": [
      15,
      15
    ],
    "growth": [
      20,
      20
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "harakiri-sushi": {
    "host": "harakiri-sushi",
    "money": [
      4000000,
      4000000
    ],
    "skill": [
      40,
      40
    ],
    "sec": [
      15,
      15
    ],
    "growth": [
      40,
      40
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 0
  },
  "phantasy": {
    "host": "phantasy",
    "money": [
      24000000,
      24000000
    ],
    "skill": [
      100,
      100
    ],
    "sec": [
      20,
      20
    ],
    "growth": [
      35,
      35
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 2
  },
  "max-hardware": {
    "host": "max-hardware",
    "money": [
      10000000,
      10000000
    ],
    "skill": [
      80,
      80
    ],
    "sec": [
      15,
      15
    ],
    "growth": [
      30,
      30
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 1
  },
  "omega-net": {
    "host": "omega-net",
    "money": [
      60000000,
      70000000
    ],
    "skill": [
      180,
      220
    ],
    "sec": [
      25,
      35
    ],
    "growth": [
      30,
      40
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 2
  },
  "crush-fitness": {
    "host": "crush-fitness",
    "money": [
      40000000,
      60000000
    ],
    "skill": [
      225,
      275
    ],
    "sec": [
      35,
      45
    ],
    "growth": [
      27,
      33
    ],
    "ports": 2
  },
  "iron-gym": {
    "host": "iron-gym",
    "money": [
      20000000,
      20000000
    ],
    "skill": [
      100,
      100
    ],
    "sec": [
      30,
      30
    ],
    "growth": [
      20,
      20
    ],
    "ramExp": [
      5,
      5
    ],
    "ports": 1
  },
  "millenium-fitness": {
    "host": "millenium-fitness",
    "money": [
      250000000,
      250000000
    ],
    "skill": [
      475,
      525
    ],
    "sec": [
      45,
      55
    ],
    "growth": [
      25,
      45
    ],
    "ramExp": [
      4,
      8
    ],
    "ports": 3
  },
  "powerhouse-fitness": {
    "host": "powerhouse-fitness",
    "money": [
      900000000,
      900000000
    ],
    "skill": [
      950,
      1100
    ],
    "sec": [
      55,
      65
    ],
    "growth": [
      50,
      60
    ],
    "ramExp": [
      4,
      6
    ],
    "ports": 5
  },
  "snap-fitness": {
    "host": "snap-fitness",
    "money": [
      450000000,
      450000000
    ],
    "skill": [
      675,
      800
    ],
    "sec": [
      40,
      60
    ],
    "growth": [
      40,
      60
    ],
    "ports": 4
  },
  "run4theh111z": {
    "host": "run4theh111z",
    "money": [
      0,
      0
    ],
    "skill": [
      505,
      550
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ramExp": [
      5,
      9
    ],
    "ports": 4
  },
  "I.I.I.I": {
    "host": "I.I.I.I",
    "money": [
      0,
      0
    ],
    "skill": [
      340,
      365
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ramExp": [
      4,
      8
    ],
    "ports": 3
  },
  "avmnite-02h": {
    "host": "avmnite-02h",
    "money": [
      0,
      0
    ],
    "skill": [
      202,
      220
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ramExp": [
      4,
      7
    ],
    "ports": 2
  },
  ".": {
    "host": ".",
    "money": [
      0,
      0
    ],
    "skill": [
      505,
      550
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ramExp": [
      4,
      4
    ],
    "ports": 4
  },
  "CSEC": {
    "host": "CSEC",
    "money": [
      0,
      0
    ],
    "skill": [
      51,
      60
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ramExp": [
      3,
      3
    ],
    "ports": 1
  },
  "The-Cave": {
    "host": "The-Cave",
    "money": [
      0,
      0
    ],
    "skill": [
      925,
      925
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ports": 5
  },
  "w0r1d_d43m0n": {
    "host": "w0r1d_d43m0n",
    "money": [
      0,
      0
    ],
    "skill": [
      3000,
      3000
    ],
    "sec": [
      0,
      0
    ],
    "growth": [
      0,
      0
    ],
    "ports": 5
  }
};
