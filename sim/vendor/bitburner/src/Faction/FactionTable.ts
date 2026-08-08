// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Faction/FactionJoinCondition.ts, src/Faction/FactionInfo.tsx) — DO NOT EDIT
import type { PlayerRequirement } from "@nsdefs";

export interface VendoredFaction {
  enemies: string[];
  offerHackingWork: boolean;
  offerFieldWork: boolean;
  offerSecurityWork: boolean;
  special: boolean;
  keepOnInstall: boolean;
  /** Flattened exactly as ns.singularity.getFactionInviteRequirements returns. */
  inviteReqs: PlayerRequirement[];
  rumorReqs: PlayerRequirement[];
}

export const FACTION_TABLE: Record<string, VendoredFaction> = {
  "Illuminati": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "numAugmentations",
        "numAugmentations": 30
      },
      {
        "type": "money",
        "money": 150000000000
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 1500
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 1200
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 1200
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 1200
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 1200
        }
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "the-hidden-world.lit"
      }
    ]
  },
  "Daedalus": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "numAugmentations",
        "numAugmentations": 30
      },
      {
        "type": "money",
        "money": 100000000000
      },
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "skills",
            "skills": {
              "hacking": 2500
            }
          },
          {
            "type": "skills",
            "skills": {
              "strength": 1500,
              "defense": 1500,
              "dexterity": 1500,
              "agility": 1500
            }
          }
        ]
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "truthgazer.msg"
      }
    ]
  },
  "The Covenant": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "numAugmentations",
        "numAugmentations": 20
      },
      {
        "type": "money",
        "money": 75000000000
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 850
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 850
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 850
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 850
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 850
        }
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "bitNodeN",
            "bitNodeN": 10
          },
          {
            "type": "everyCondition",
            "conditions": [
              {
                "type": "numAugmentations",
                "numAugmentations": 10
              },
              {
                "type": "money",
                "money": 35000000000
              },
              {
                "type": "skills",
                "skills": {
                  "hacking": 425
                }
              },
              {
                "type": "skills",
                "skills": {
                  "strength": 425,
                  "defense": 425,
                  "dexterity": 425,
                  "agility": 425
                }
              }
            ]
          }
        ]
      }
    ]
  },
  "ECorp": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "ECorp"
      },
      {
        "type": "companyReputation",
        "company": "ECorp",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "ECorp"
      }
    ]
  },
  "MegaCorp": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "MegaCorp"
      },
      {
        "type": "companyReputation",
        "company": "MegaCorp",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "MegaCorp"
      }
    ]
  },
  "Bachman & Associates": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "Bachman & Associates"
      },
      {
        "type": "companyReputation",
        "company": "Bachman & Associates",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "Bachman & Associates"
      }
    ]
  },
  "Blade Industries": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "Blade Industries"
      },
      {
        "type": "companyReputation",
        "company": "Blade Industries",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "Blade Industries"
      }
    ]
  },
  "NWO": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "NWO"
      },
      {
        "type": "companyReputation",
        "company": "NWO",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "NWO"
      }
    ]
  },
  "Clarke Incorporated": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "Clarke Incorporated"
      },
      {
        "type": "companyReputation",
        "company": "Clarke Incorporated",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "Clarke Incorporated"
      }
    ]
  },
  "OmniTek Incorporated": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "OmniTek Incorporated"
      },
      {
        "type": "companyReputation",
        "company": "OmniTek Incorporated",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "OmniTek Incorporated"
      }
    ]
  },
  "Four Sigma": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "Four Sigma"
      },
      {
        "type": "companyReputation",
        "company": "Four Sigma",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "Four Sigma"
      }
    ]
  },
  "KuaiGong International": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "KuaiGong International"
      },
      {
        "type": "companyReputation",
        "company": "KuaiGong International",
        "reputation": 400000
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "KuaiGong International"
      }
    ]
  },
  "Fulcrum Secret Technologies": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "employedBy",
        "company": "Fulcrum Technologies"
      },
      {
        "type": "companyReputation",
        "company": "Fulcrum Technologies",
        "reputation": 400000
      },
      {
        "type": "backdoorInstalled",
        "server": "fulcrumassets"
      }
    ],
    "rumorReqs": [
      {
        "type": "employedBy",
        "company": "Fulcrum Technologies"
      }
    ]
  },
  "BitRunners": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "backdoorInstalled",
        "server": "run4theh111z"
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "19dfj3l1nd.msg"
      }
    ]
  },
  "The Black Hand": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "backdoorInstalled",
        "server": "I.I.I.I"
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "j3.msg"
      }
    ]
  },
  "NiteSec": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "backdoorInstalled",
        "server": "avmnite-02h"
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "nitesec-test.msg"
      }
    ]
  },
  "CyberSec": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "backdoorInstalled",
        "server": "CSEC"
      }
    ],
    "rumorReqs": [
      {
        "type": "file",
        "file": "csec-test.msg"
      }
    ]
  },
  "Aevum": {
    "enemies": [
      "Chongqing",
      "New Tokyo",
      "Ishima",
      "Volhaven"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Aevum"
      },
      {
        "type": "money",
        "money": 40000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Aevum"
      },
      {
        "type": "money",
        "money": 20000000
      }
    ]
  },
  "Chongqing": {
    "enemies": [
      "Sector-12",
      "Aevum",
      "Volhaven"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Chongqing"
      },
      {
        "type": "money",
        "money": 20000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Chongqing"
      },
      {
        "type": "money",
        "money": 10000000
      }
    ]
  },
  "Ishima": {
    "enemies": [
      "Sector-12",
      "Aevum",
      "Volhaven"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Ishima"
      },
      {
        "type": "money",
        "money": 30000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Ishima"
      },
      {
        "type": "money",
        "money": 15000000
      }
    ]
  },
  "New Tokyo": {
    "enemies": [
      "Sector-12",
      "Aevum",
      "Volhaven"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "New Tokyo"
      },
      {
        "type": "money",
        "money": 20000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "New Tokyo"
      },
      {
        "type": "money",
        "money": 10000000
      }
    ]
  },
  "Sector-12": {
    "enemies": [
      "Chongqing",
      "New Tokyo",
      "Ishima",
      "Volhaven"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Sector-12"
      },
      {
        "type": "money",
        "money": 15000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Sector-12"
      },
      {
        "type": "money",
        "money": 7500000
      }
    ]
  },
  "Volhaven": {
    "enemies": [
      "Chongqing",
      "Sector-12",
      "New Tokyo",
      "Aevum",
      "Ishima"
    ],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Volhaven"
      },
      {
        "type": "money",
        "money": 50000000
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Volhaven"
      },
      {
        "type": "money",
        "money": 25000000
      }
    ]
  },
  "Speakers for the Dead": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "Central Intelligence Agency"
        }
      },
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "National Security Agency"
        }
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 100
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 300
        }
      },
      {
        "type": "numPeopleKilled",
        "numPeopleKilled": 30
      },
      {
        "type": "karma",
        "karma": -45
      }
    ],
    "rumorReqs": [
      {
        "type": "karma",
        "karma": -45
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 50
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 150
        }
      },
      {
        "type": "numPeopleKilled",
        "numPeopleKilled": 5
      }
    ]
  },
  "The Dark Army": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "city",
        "city": "Chongqing"
      },
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "Central Intelligence Agency"
        }
      },
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "National Security Agency"
        }
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 300
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 300
        }
      },
      {
        "type": "numPeopleKilled",
        "numPeopleKilled": 5
      },
      {
        "type": "karma",
        "karma": -45
      }
    ],
    "rumorReqs": [
      {
        "type": "city",
        "city": "Chongqing"
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 150
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 150
        }
      },
      {
        "type": "numPeopleKilled",
        "numPeopleKilled": 1
      },
      {
        "type": "karma",
        "karma": -45
      }
    ]
  },
  "The Syndicate": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Aevum"
          },
          {
            "type": "city",
            "city": "Sector-12"
          }
        ]
      },
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "Central Intelligence Agency"
        }
      },
      {
        "type": "not",
        "condition": {
          "type": "employedBy",
          "company": "National Security Agency"
        }
      },
      {
        "type": "money",
        "money": 10000000
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 200
        }
      },
      {
        "type": "skills",
        "skills": {
          "strength": 200
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 200
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 200
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 200
        }
      },
      {
        "type": "karma",
        "karma": -90
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Aevum"
          },
          {
            "type": "city",
            "city": "Sector-12"
          }
        ]
      },
      {
        "type": "skills",
        "skills": {
          "strength": 100
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 100
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 100
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 100
        }
      },
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "karma",
            "karma": -90
          },
          {
            "type": "file",
            "file": "sector-12-crime.lit"
          }
        ]
      }
    ]
  },
  "Silhouette": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": true,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "jobTitle",
            "jobTitle": "Chief Technology Officer"
          },
          {
            "type": "jobTitle",
            "jobTitle": "Chief Financial Officer"
          },
          {
            "type": "jobTitle",
            "jobTitle": "Chief Executive Officer"
          }
        ]
      },
      {
        "type": "money",
        "money": 15000000
      },
      {
        "type": "karma",
        "karma": -22
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "jobTitle",
            "jobTitle": "Chief Technology Officer"
          },
          {
            "type": "jobTitle",
            "jobTitle": "Chief Financial Officer"
          },
          {
            "type": "jobTitle",
            "jobTitle": "Chief Executive Officer"
          }
        ]
      }
    ]
  },
  "Tetrads": {
    "enemies": [],
    "offerHackingWork": false,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Chongqing"
          },
          {
            "type": "city",
            "city": "New Tokyo"
          },
          {
            "type": "city",
            "city": "Ishima"
          }
        ]
      },
      {
        "type": "skills",
        "skills": {
          "strength": 75
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 75
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 75
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 75
        }
      },
      {
        "type": "karma",
        "karma": -18
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Chongqing"
          },
          {
            "type": "city",
            "city": "New Tokyo"
          },
          {
            "type": "city",
            "city": "Ishima"
          }
        ]
      },
      {
        "type": "skills",
        "skills": {
          "strength": 50
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 50
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 50
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 50
        }
      },
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "karma",
            "karma": -18
          },
          {
            "type": "file",
            "file": "new-triads.lit"
          }
        ]
      }
    ]
  },
  "Slum Snakes": {
    "enemies": [],
    "offerHackingWork": false,
    "offerFieldWork": true,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "skills",
        "skills": {
          "strength": 30
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 30
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 30
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 30
        }
      },
      {
        "type": "money",
        "money": 1000000
      },
      {
        "type": "karma",
        "karma": -9
      }
    ],
    "rumorReqs": [
      {
        "type": "skills",
        "skills": {
          "strength": 10
        }
      },
      {
        "type": "skills",
        "skills": {
          "defense": 10
        }
      },
      {
        "type": "skills",
        "skills": {
          "dexterity": 10
        }
      },
      {
        "type": "skills",
        "skills": {
          "agility": 10
        }
      },
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "karma",
            "karma": -1
          },
          {
            "type": "file",
            "file": "sector-12-crime.lit"
          }
        ]
      }
    ]
  },
  "Netburners": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "skills",
        "skills": {
          "hacking": 80
        }
      },
      {
        "type": "hacknetRAM",
        "hacknetRAM": 8
      },
      {
        "type": "hacknetCores",
        "hacknetCores": 4
      },
      {
        "type": "hacknetLevels",
        "hacknetLevels": 100
      }
    ],
    "rumorReqs": [
      {
        "type": "hacknetLevels",
        "hacknetLevels": 50
      }
    ]
  },
  "Tian Di Hui": {
    "enemies": [],
    "offerHackingWork": true,
    "offerFieldWork": false,
    "offerSecurityWork": true,
    "special": false,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Chongqing"
          },
          {
            "type": "city",
            "city": "New Tokyo"
          },
          {
            "type": "city",
            "city": "Ishima"
          }
        ]
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 50
        }
      },
      {
        "type": "money",
        "money": 1000000
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "city",
            "city": "Chongqing"
          },
          {
            "type": "city",
            "city": "New Tokyo"
          },
          {
            "type": "city",
            "city": "Ishima"
          }
        ]
      },
      {
        "type": "skills",
        "skills": {
          "hacking": 25
        }
      },
      {
        "type": "money",
        "money": 500000
      }
    ]
  },
  "Bladeburners": {
    "enemies": [],
    "offerHackingWork": false,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": true,
    "keepOnInstall": false,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "someCondition",
            "conditions": [
              {
                "type": "bitNodeN",
                "bitNodeN": 6
              },
              {
                "type": "sourceFile",
                "sourceFile": 6
              }
            ]
          },
          {
            "type": "someCondition",
            "conditions": [
              {
                "type": "bitNodeN",
                "bitNodeN": 7
              },
              {
                "type": "sourceFile",
                "sourceFile": 7
              }
            ]
          }
        ]
      },
      {
        "type": "bladeburnerRank",
        "bladeburnerRank": 25
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "someCondition",
            "conditions": [
              {
                "type": "bitNodeN",
                "bitNodeN": 6
              },
              {
                "type": "sourceFile",
                "sourceFile": 6
              }
            ]
          },
          {
            "type": "someCondition",
            "conditions": [
              {
                "type": "bitNodeN",
                "bitNodeN": 7
              },
              {
                "type": "sourceFile",
                "sourceFile": 7
              }
            ]
          }
        ]
      },
      {
        "type": "not",
        "condition": {
          "type": "bitNodeN",
          "bitNodeN": 8
        }
      }
    ]
  },
  "Church of the Machine God": {
    "enemies": [],
    "offerHackingWork": false,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": true,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "bitNodeN",
            "bitNodeN": 13
          },
          {
            "type": "sourceFile",
            "sourceFile": 13
          }
        ]
      },
      {
        "type": "numAugmentations",
        "numAugmentations": 0
      },
      {
        "type": "location",
        "location": "Church of the Machine God"
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": [
          {
            "type": "bitNodeN",
            "bitNodeN": 13
          },
          {
            "type": "sourceFile",
            "sourceFile": 13
          }
        ]
      },
      {
        "type": "numAugmentations",
        "numAugmentations": 0
      }
    ]
  },
  "Shadows of Anarchy": {
    "enemies": [],
    "offerHackingWork": false,
    "offerFieldWork": false,
    "offerSecurityWork": false,
    "special": true,
    "keepOnInstall": true,
    "inviteReqs": [
      {
        "type": "numInfiltrations",
        "numInfiltrations": 1
      }
    ],
    "rumorReqs": [
      {
        "type": "someCondition",
        "conditions": []
      }
    ]
  }
};
