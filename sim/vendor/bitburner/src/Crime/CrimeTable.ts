// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Crime/Crime.ts, src/Crime/Crimes.ts) — DO NOT EDIT
export interface VendoredCrime {
  type: string;
  timeMs: number;
  money: number;
  difficulty: number;
  /** POSITIVE here; the game SUBTRACTS it, so karma goes down. */
  karma: number;
  kills: number;
  /** Success-chance weights, per skill. */
  weights: Record<string, number>;
  /** Experience granted on success, per skill. */
  exp: Record<string, number>;
}

export const CRIME_TABLE: Record<string, VendoredCrime> = {
  "Shoplift": {
    "type": "Shoplift",
    "timeMs": 2000,
    "money": 15000,
    "difficulty": 0.05,
    "karma": 0.1,
    "kills": 0,
    "weights": {
      "hacking": 0,
      "strength": 0,
      "defense": 0,
      "dexterity": 1,
      "agility": 1,
      "charisma": 0
    },
    "exp": {
      "hacking": 0,
      "strength": 0,
      "defense": 0,
      "dexterity": 2,
      "agility": 2,
      "charisma": 0,
      "intelligence": 0
    }
  },
  "Rob Store": {
    "type": "Rob Store",
    "timeMs": 60000,
    "money": 400000,
    "difficulty": 0.2,
    "karma": 0.5,
    "kills": 0,
    "weights": {
      "hacking": 0.5,
      "strength": 0,
      "defense": 0,
      "dexterity": 2,
      "agility": 1,
      "charisma": 0
    },
    "exp": {
      "hacking": 30,
      "strength": 0,
      "defense": 0,
      "dexterity": 45,
      "agility": 45,
      "charisma": 0,
      "intelligence": 0.375
    }
  },
  "Mug": {
    "type": "Mug",
    "timeMs": 4000,
    "money": 36000,
    "difficulty": 0.2,
    "karma": 0.25,
    "kills": 0,
    "weights": {
      "hacking": 0,
      "strength": 1.5,
      "defense": 0.5,
      "dexterity": 1.5,
      "agility": 0.5,
      "charisma": 0
    },
    "exp": {
      "hacking": 0,
      "strength": 3,
      "defense": 3,
      "dexterity": 3,
      "agility": 3,
      "charisma": 0,
      "intelligence": 0
    }
  },
  "Larceny": {
    "type": "Larceny",
    "timeMs": 90000,
    "money": 800000,
    "difficulty": 0.3333333333333333,
    "karma": 1.5,
    "kills": 0,
    "weights": {
      "hacking": 0.5,
      "strength": 0,
      "defense": 0,
      "dexterity": 1,
      "agility": 1,
      "charisma": 0
    },
    "exp": {
      "hacking": 45,
      "strength": 0,
      "defense": 0,
      "dexterity": 60,
      "agility": 60,
      "charisma": 0,
      "intelligence": 0.75
    }
  },
  "Deal Drugs": {
    "type": "Deal Drugs",
    "timeMs": 10000,
    "money": 120000,
    "difficulty": 1,
    "karma": 0.5,
    "kills": 0,
    "weights": {
      "hacking": 0,
      "strength": 0,
      "defense": 0,
      "dexterity": 2,
      "agility": 1,
      "charisma": 3
    },
    "exp": {
      "hacking": 0,
      "strength": 0,
      "defense": 0,
      "dexterity": 5,
      "agility": 5,
      "charisma": 10,
      "intelligence": 0
    }
  },
  "Bond Forgery": {
    "type": "Bond Forgery",
    "timeMs": 300000,
    "money": 4500000,
    "difficulty": 0.5,
    "karma": 0.1,
    "kills": 0,
    "weights": {
      "hacking": 0.05,
      "strength": 0,
      "defense": 0,
      "dexterity": 1.25,
      "agility": 0,
      "charisma": 0
    },
    "exp": {
      "hacking": 100,
      "strength": 0,
      "defense": 0,
      "dexterity": 150,
      "agility": 0,
      "charisma": 15,
      "intelligence": 3
    }
  },
  "Traffick Arms": {
    "type": "Traffick Arms",
    "timeMs": 40000,
    "money": 600000,
    "difficulty": 2,
    "karma": 1,
    "kills": 0,
    "weights": {
      "hacking": 0,
      "strength": 1,
      "defense": 1,
      "dexterity": 1,
      "agility": 1,
      "charisma": 1
    },
    "exp": {
      "hacking": 0,
      "strength": 20,
      "defense": 20,
      "dexterity": 20,
      "agility": 20,
      "charisma": 40,
      "intelligence": 0
    }
  },
  "Homicide": {
    "type": "Homicide",
    "timeMs": 3000,
    "money": 45000,
    "difficulty": 1,
    "karma": 3,
    "kills": 1,
    "weights": {
      "hacking": 0,
      "strength": 2,
      "defense": 2,
      "dexterity": 0.5,
      "agility": 0.5,
      "charisma": 0
    },
    "exp": {
      "hacking": 0,
      "strength": 2,
      "defense": 2,
      "dexterity": 2,
      "agility": 2,
      "charisma": 0,
      "intelligence": 0
    }
  },
  "Grand Theft Auto": {
    "type": "Grand Theft Auto",
    "timeMs": 80000,
    "money": 1600000,
    "difficulty": 8,
    "karma": 5,
    "kills": 0,
    "weights": {
      "hacking": 1,
      "strength": 1,
      "defense": 0,
      "dexterity": 4,
      "agility": 2,
      "charisma": 2
    },
    "exp": {
      "hacking": 0,
      "strength": 20,
      "defense": 20,
      "dexterity": 20,
      "agility": 80,
      "charisma": 40,
      "intelligence": 0.8
    }
  },
  "Kidnap": {
    "type": "Kidnap",
    "timeMs": 120000,
    "money": 3600000,
    "difficulty": 5,
    "karma": 6,
    "kills": 0,
    "weights": {
      "hacking": 0,
      "strength": 1,
      "defense": 0,
      "dexterity": 1,
      "agility": 1,
      "charisma": 1
    },
    "exp": {
      "hacking": 0,
      "strength": 80,
      "defense": 80,
      "dexterity": 80,
      "agility": 80,
      "charisma": 80,
      "intelligence": 1.3
    }
  },
  "Assassination": {
    "type": "Assassination",
    "timeMs": 300000,
    "money": 12000000,
    "difficulty": 8,
    "karma": 10,
    "kills": 1,
    "weights": {
      "hacking": 0,
      "strength": 1,
      "defense": 0,
      "dexterity": 2,
      "agility": 1,
      "charisma": 0
    },
    "exp": {
      "hacking": 0,
      "strength": 300,
      "defense": 300,
      "dexterity": 300,
      "agility": 300,
      "charisma": 0,
      "intelligence": 3.25
    }
  },
  "Heist": {
    "type": "Heist",
    "timeMs": 600000,
    "money": 120000000,
    "difficulty": 18,
    "karma": 15,
    "kills": 0,
    "weights": {
      "hacking": 1,
      "strength": 1,
      "defense": 1,
      "dexterity": 1,
      "agility": 1,
      "charisma": 1
    },
    "exp": {
      "hacking": 450,
      "strength": 450,
      "defense": 450,
      "dexterity": 450,
      "agility": 450,
      "charisma": 450,
      "intelligence": 6.5
    }
  }
};
