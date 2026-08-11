// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Server/data/servers.ts) — DO NOT EDIT
/** A field upstream rolls at world generation, as [min, max]. A fixed
 *  value is emitted as a degenerate range. */
export type Range = [number, number];

export interface VendoredServer {
  host: string;
  /** The company this server belongs to. Load-bearing, not decorative: it
   *  is the key hack/grow stock influence looks the symbol up by
   *  (StockMarket/PlayerInfluencing.ts), so it is what maps a farm target
   *  onto a tradeable stock. */
  org: string;
  /** BASE money. The live `moneyMax` is `25 * roll * ServerMaxMoney`. */
  money?: Range;
  skill?: Range;
  /** Base security. `minDifficulty` is `round(roll / 3)`, both after
   *  ServerStartingSecurity. */
  sec?: Range;
  growth?: Range;
  ramExp?: Range;
  layer?: Range;
  /** Fields represented as an upstream min/max object. Only these consume
   *  a random roll; fixed numbers do not, even when normalized ranges match. */
  randomized: Partial<Record<"money" | "skill" | "sec" | "growth" | "ramExp" | "layer", true>>;
  ports: number;
}

export const SERVER_METADATA: Record<string, VendoredServer> = {
  "ecorp": {
    "host": "ecorp",
    "org": "ECorp",
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
    "layer": [
      15,
      15
    ],
    "randomized": {
      "money": true,
      "skill": true
    },
    "ports": 5
  },
  "megacorp": {
    "host": "megacorp",
    "org": "MegaCorp",
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
    "layer": [
      15,
      15
    ],
    "randomized": {
      "money": true,
      "skill": true
    },
    "ports": 5
  },
  "b-and-a": {
    "host": "b-and-a",
    "org": "Bachman & Associates",
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
    "layer": [
      14,
      14
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "blade": {
    "host": "blade",
    "org": "Blade Industries",
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
    "layer": [
      14,
      14
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "nwo": {
    "host": "nwo",
    "org": "NWO",
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
    "layer": [
      14,
      14
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "growth": true
    },
    "ports": 5
  },
  "clarkinc": {
    "host": "clarkinc",
    "org": "Clarke Incorporated",
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
    "layer": [
      14,
      14
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "omnitek": {
    "host": "omnitek",
    "org": "OmniTek Incorporated",
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
    "layer": [
      13,
      13
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "4sigma": {
    "host": "4sigma",
    "org": "Four Sigma",
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
    "layer": [
      13,
      13
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "kuai-gong": {
    "host": "kuai-gong",
    "org": "KuaiGong International",
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
    "layer": [
      13,
      13
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "fulcrumtech": {
    "host": "fulcrumtech",
    "org": "Fulcrum Technologies",
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
    "layer": [
      12,
      12
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "fulcrumassets": {
    "host": "fulcrumassets",
    "org": "Fulcrum Technologies",
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
    "layer": [
      15,
      15
    ],
    "randomized": {
      "skill": true
    },
    "ports": 5
  },
  "stormtech": {
    "host": "stormtech",
    "org": "Storm Technologies",
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
    "layer": [
      12,
      12
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "defcomm": {
    "host": "defcomm",
    "org": "DefComm",
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
    "layer": [
      9,
      9
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "infocomm": {
    "host": "infocomm",
    "org": "InfoComm",
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
    "layer": [
      10,
      10
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "helios": {
    "host": "helios",
    "org": "Helios Labs",
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
    "layer": [
      12,
      12
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "vitalife": {
    "host": "vitalife",
    "org": "VitaLife",
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
    "layer": [
      12,
      12
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "icarus": {
    "host": "icarus",
    "org": "Icarus Microsystems",
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
    "layer": [
      9,
      9
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "univ-energy": {
    "host": "univ-energy",
    "org": "Universal Energy",
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
    "layer": [
      9,
      9
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "titan-labs": {
    "host": "titan-labs",
    "org": "Titan Laboratories",
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
    "layer": [
      11,
      11
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "microdyne": {
    "host": "microdyne",
    "org": "Microdyne Technologies",
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
    "layer": [
      11,
      11
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "taiyang-digital": {
    "host": "taiyang-digital",
    "org": "Taiyang Digital",
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
    "layer": [
      10,
      10
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "galactic-cyber": {
    "host": "galactic-cyber",
    "org": "Galactic Cybersystems",
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
    "layer": [
      7,
      7
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "aerocorp": {
    "host": "aerocorp",
    "org": "AeroCorp",
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
    "layer": [
      7,
      7
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "omnia": {
    "host": "omnia",
    "org": "Omnia Cybersystems",
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
    "layer": [
      8,
      8
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "zb-def": {
    "host": "zb-def",
    "org": "ZB Defense Industries",
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
    "layer": [
      10,
      10
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 4
  },
  "applied-energetics": {
    "host": "applied-energetics",
    "org": "Applied Energetics",
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
    "layer": [
      11,
      11
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 4
  },
  "solaris": {
    "host": "solaris",
    "org": "Solaris Space Systems",
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
    "layer": [
      9,
      9
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "deltaone": {
    "host": "deltaone",
    "org": "DeltaOne",
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
    "layer": [
      8,
      8
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "global-pharm": {
    "host": "global-pharm",
    "org": "Global Pharmaceuticals",
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
    "layer": [
      7,
      7
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "nova-med": {
    "host": "nova-med",
    "org": "Nova Medical",
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
    "layer": [
      10,
      10
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 4
  },
  "zeus-med": {
    "host": "zeus-med",
    "org": "Zeus Medical",
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
    "layer": [
      9,
      9
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 5
  },
  "unitalife": {
    "host": "unitalife",
    "org": "UnitaLife Group",
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
    "layer": [
      8,
      8
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "lexo-corp": {
    "host": "lexo-corp",
    "org": "LexoCorp",
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
    "layer": [
      6,
      6
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "rho-construction": {
    "host": "rho-construction",
    "org": "Rho Construction",
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
    "layer": [
      6,
      6
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "alpha-ent": {
    "host": "alpha-ent",
    "org": "Alpha Enterprises",
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
    "layer": [
      6,
      6
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "aevum-police": {
    "host": "aevum-police",
    "org": "Aevum Police Headquarters",
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
    "layer": [
      6,
      6
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 4
  },
  "rothman-uni": {
    "host": "rothman-uni",
    "org": "Rothman University",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "zb-institute": {
    "host": "zb-institute",
    "org": "ZB Institute of Technology",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "summit-uni": {
    "host": "summit-uni",
    "org": "Summit University",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "syscore": {
    "host": "syscore",
    "org": "SysCore Securities",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 4
  },
  "catalyst": {
    "host": "catalyst",
    "org": "Catalyst Ventures",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "the-hub": {
    "host": "the-hub",
    "org": "The Hub",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 2
  },
  "computek": {
    "host": "computek",
    "org": "CompuTek",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 3
  },
  "netlink": {
    "host": "netlink",
    "org": "NetLink Technologies",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "johnson-ortho": {
    "host": "johnson-ortho",
    "org": "Johnson Orthopedics",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 2
  },
  "n00dles": {
    "host": "n00dles",
    "org": "Noodle Bar",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "foodnstuff": {
    "host": "foodnstuff",
    "org": "FoodNStuff",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "sigma-cosmetics": {
    "host": "sigma-cosmetics",
    "org": "Sigma Cosmetics",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "joesguns": {
    "host": "joesguns",
    "org": "Joe's Guns",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "zer0": {
    "host": "zer0",
    "org": "ZER0 Nightclub",
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
    "layer": [
      2,
      2
    ],
    "randomized": {},
    "ports": 1
  },
  "nectar-net": {
    "host": "nectar-net",
    "org": "Nectar Nightclub Network",
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
    "layer": [
      2,
      2
    ],
    "randomized": {},
    "ports": 0
  },
  "neo-net": {
    "host": "neo-net",
    "org": "Neo Nightclub Network",
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
    "layer": [
      3,
      3
    ],
    "randomized": {},
    "ports": 1
  },
  "silver-helix": {
    "host": "silver-helix",
    "org": "Silver Helix",
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
    "layer": [
      3,
      3
    ],
    "randomized": {},
    "ports": 2
  },
  "hong-fang-tea": {
    "host": "hong-fang-tea",
    "org": "HongFang Teahouse",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "harakiri-sushi": {
    "host": "harakiri-sushi",
    "org": "HaraKiri Sushi Bar Network",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 0
  },
  "phantasy": {
    "host": "phantasy",
    "org": "Phantasy Club",
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
    "layer": [
      3,
      3
    ],
    "randomized": {},
    "ports": 2
  },
  "max-hardware": {
    "host": "max-hardware",
    "org": "Max Hardware Store",
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
    "layer": [
      2,
      2
    ],
    "randomized": {},
    "ports": 1
  },
  "omega-net": {
    "host": "omega-net",
    "org": "Omega Software",
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
    "layer": [
      3,
      3
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 2
  },
  "crush-fitness": {
    "host": "crush-fitness",
    "org": "Crush Fitness",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "money": true,
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 2
  },
  "iron-gym": {
    "host": "iron-gym",
    "org": "Iron Gym Network",
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
    "layer": [
      1,
      1
    ],
    "randomized": {},
    "ports": 1
  },
  "millenium-fitness": {
    "host": "millenium-fitness",
    "org": "Millenium Fitness Network",
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
    "layer": [
      6,
      6
    ],
    "randomized": {
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 3
  },
  "powerhouse-fitness": {
    "host": "powerhouse-fitness",
    "org": "Powerhouse Fitness",
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
    "layer": [
      14,
      14
    ],
    "randomized": {
      "skill": true,
      "sec": true,
      "growth": true,
      "ramExp": true
    },
    "ports": 5
  },
  "snap-fitness": {
    "host": "snap-fitness",
    "org": "Snap Fitness",
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
    "layer": [
      7,
      7
    ],
    "randomized": {
      "skill": true,
      "sec": true,
      "growth": true
    },
    "ports": 4
  },
  "run4theh111z": {
    "host": "run4theh111z",
    "org": "The Runners",
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
    "layer": [
      11,
      11
    ],
    "randomized": {
      "skill": true,
      "ramExp": true
    },
    "ports": 4
  },
  "I.I.I.I": {
    "host": "I.I.I.I",
    "org": "I.I.I.I",
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
    "layer": [
      5,
      5
    ],
    "randomized": {
      "skill": true,
      "ramExp": true
    },
    "ports": 3
  },
  "avmnite-02h": {
    "host": "avmnite-02h",
    "org": "NiteSec",
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
    "layer": [
      4,
      4
    ],
    "randomized": {
      "skill": true,
      "ramExp": true
    },
    "ports": 2
  },
  ".": {
    "host": ".",
    "org": ".",
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
    "layer": [
      13,
      13
    ],
    "randomized": {
      "skill": true
    },
    "ports": 4
  },
  "CSEC": {
    "host": "CSEC",
    "org": "CyberSec",
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
    "layer": [
      2,
      2
    ],
    "randomized": {
      "skill": true
    },
    "ports": 1
  },
  "The-Cave": {
    "host": "The-Cave",
    "org": "Helios",
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
    "layer": [
      15,
      15
    ],
    "randomized": {},
    "ports": 5
  },
  "w0r1d_d43m0n": {
    "host": "w0r1d_d43m0n",
    "org": "w0r1d_d43m0n",
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
    "randomized": {},
    "ports": 5
  }
};
