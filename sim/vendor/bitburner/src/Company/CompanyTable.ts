// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Company/data/JobTracks.ts, src/Company/data/CompanyPositionsMetadata.ts, src/Company/data/CompaniesMetadata.ts) — DO NOT EDIT
export interface VendoredCompanyPosition {
  name: string; field: string; nextPosition: string | null; isStartingJob: boolean; isPartTime: boolean;
  baseSalary: number; repMultiplier: number; requiredSkills: Record<string, number>; requiredReputation: number;
  effectiveness: Record<string, number>; expGain: Record<string, number>;
}
export interface VendoredCompany {
  name: string; positions: string[]; expMultiplier: number; salaryMultiplier: number; jobStatReqOffset: number; relatedFaction?: string;
}
export interface VendoredCompanyTable {
  jobTracks: Record<string, string[]>; positions: Record<string, VendoredCompanyPosition>; companies: Record<string, VendoredCompany>;
}

export const COMPANY_TABLE: VendoredCompanyTable = {
  "jobTracks": {
    "Software": [
      "Software Engineering Intern",
      "Junior Software Engineer",
      "Senior Software Engineer",
      "Lead Software Developer",
      "Head of Software",
      "Head of Engineering",
      "Vice President of Technology",
      "Chief Technology Officer"
    ],
    "Software Consultant": [
      "Software Consultant",
      "Senior Software Consultant"
    ],
    "IT": [
      "IT Intern",
      "IT Analyst",
      "IT Manager",
      "Systems Administrator"
    ],
    "Security Engineer": [
      "Security Engineer"
    ],
    "Network Engineer": [
      "Network Engineer",
      "Network Administrator"
    ],
    "Business": [
      "Business Intern",
      "Business Analyst",
      "Business Manager",
      "Operations Manager",
      "Chief Financial Officer",
      "Chief Executive Officer"
    ],
    "Business Consultant": [
      "Business Consultant",
      "Senior Business Consultant"
    ],
    "Security": [
      "Security Guard",
      "Security Officer",
      "Security Supervisor",
      "Head of Security"
    ],
    "Agent": [
      "Field Agent",
      "Secret Agent",
      "Special Operative"
    ],
    "Employee": [
      "Employee"
    ],
    "Part-time Employee": [
      "Part-time Employee"
    ],
    "Waiter": [
      "Waiter"
    ],
    "Part-time Waiter": [
      "Part-time Waiter"
    ]
  },
  "positions": {
    "Software Engineering Intern": {
      "name": "Software Engineering Intern",
      "field": "Software",
      "nextPosition": "Junior Software Engineer",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 33,
      "repMultiplier": 0.9,
      "requiredSkills": {
        "hacking": 1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 85,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.05,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.02
      }
    },
    "Junior Software Engineer": {
      "name": "Junior Software Engineer",
      "field": "Software",
      "nextPosition": "Senior Software Engineer",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 80,
      "repMultiplier": 1.1,
      "requiredSkills": {
        "hacking": 51,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 8000,
      "effectiveness": {
        "hacking": 85,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.05
      }
    },
    "Senior Software Engineer": {
      "name": "Senior Software Engineer",
      "field": "Software",
      "nextPosition": "Lead Software Developer",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 165,
      "repMultiplier": 1.3,
      "requiredSkills": {
        "hacking": 251,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 51
      },
      "requiredReputation": 40000,
      "effectiveness": {
        "hacking": 80,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.4,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.08
      }
    },
    "Lead Software Developer": {
      "name": "Lead Software Developer",
      "field": "Software",
      "nextPosition": "Head of Software",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 500,
      "repMultiplier": 1.5,
      "requiredSkills": {
        "hacking": 401,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 151
      },
      "requiredReputation": 200000,
      "effectiveness": {
        "hacking": 75,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 25
      },
      "expGain": {
        "hacking": 0.8,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.1
      }
    },
    "Head of Software": {
      "name": "Head of Software",
      "field": "Software",
      "nextPosition": "Head of Engineering",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 800,
      "repMultiplier": 1.6,
      "requiredSkills": {
        "hacking": 501,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 251
      },
      "requiredReputation": 400000,
      "effectiveness": {
        "hacking": 75,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 25
      },
      "expGain": {
        "hacking": 1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.5
      }
    },
    "Head of Engineering": {
      "name": "Head of Engineering",
      "field": "Software",
      "nextPosition": "Vice President of Technology",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 1650,
      "repMultiplier": 1.6,
      "requiredSkills": {
        "hacking": 501,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 251
      },
      "requiredReputation": 800000,
      "effectiveness": {
        "hacking": 75,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 25
      },
      "expGain": {
        "hacking": 1.1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.5
      }
    },
    "Vice President of Technology": {
      "name": "Vice President of Technology",
      "field": "Software",
      "nextPosition": "Chief Technology Officer",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 2310,
      "repMultiplier": 1.75,
      "requiredSkills": {
        "hacking": 601,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 401
      },
      "requiredReputation": 1600000,
      "effectiveness": {
        "hacking": 70,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 30
      },
      "expGain": {
        "hacking": 1.2,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.6
      }
    },
    "Chief Technology Officer": {
      "name": "Chief Technology Officer",
      "field": "Software",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 2640,
      "repMultiplier": 2,
      "requiredSkills": {
        "hacking": 751,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 501
      },
      "requiredReputation": 3200000,
      "effectiveness": {
        "hacking": 65,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 35
      },
      "expGain": {
        "hacking": 1.5,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 1
      }
    },
    "IT Intern": {
      "name": "IT Intern",
      "field": "IT",
      "nextPosition": "IT Analyst",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 26,
      "repMultiplier": 0.9,
      "requiredSkills": {
        "hacking": 1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 90,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 10
      },
      "expGain": {
        "hacking": 0.04,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.01
      }
    },
    "IT Analyst": {
      "name": "IT Analyst",
      "field": "IT",
      "nextPosition": "IT Manager",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 66,
      "repMultiplier": 1.1,
      "requiredSkills": {
        "hacking": 26,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 7000,
      "effectiveness": {
        "hacking": 85,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.08,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.02
      }
    },
    "IT Manager": {
      "name": "IT Manager",
      "field": "IT",
      "nextPosition": "Systems Administrator",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 132,
      "repMultiplier": 1.3,
      "requiredSkills": {
        "hacking": 151,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 51
      },
      "requiredReputation": 35000,
      "effectiveness": {
        "hacking": 80,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.3,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.1
      }
    },
    "Systems Administrator": {
      "name": "Systems Administrator",
      "field": "IT",
      "nextPosition": "Head of Engineering",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 410,
      "repMultiplier": 1.4,
      "requiredSkills": {
        "hacking": 251,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 76
      },
      "requiredReputation": 175000,
      "effectiveness": {
        "hacking": 80,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.5,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.2
      }
    },
    "Security Engineer": {
      "name": "Security Engineer",
      "field": "Security Engineer",
      "nextPosition": "Head of Engineering",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 121,
      "repMultiplier": 1.2,
      "requiredSkills": {
        "hacking": 151,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 26
      },
      "requiredReputation": 35000,
      "effectiveness": {
        "hacking": 85,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.4,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.05
      }
    },
    "Network Engineer": {
      "name": "Network Engineer",
      "field": "Network Engineer",
      "nextPosition": "Network Administrator",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 121,
      "repMultiplier": 1.2,
      "requiredSkills": {
        "hacking": 151,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 26
      },
      "requiredReputation": 35000,
      "effectiveness": {
        "hacking": 85,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.4,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.05
      }
    },
    "Network Administrator": {
      "name": "Network Administrator",
      "field": "Network Engineer",
      "nextPosition": "Head of Engineering",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 410,
      "repMultiplier": 1.3,
      "requiredSkills": {
        "hacking": 251,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 76
      },
      "requiredReputation": 175000,
      "effectiveness": {
        "hacking": 80,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.5,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.1
      }
    },
    "Business Intern": {
      "name": "Business Intern",
      "field": "Business",
      "nextPosition": "Business Analyst",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 46,
      "repMultiplier": 0.9,
      "requiredSkills": {
        "hacking": 1,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 1
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 10,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 90
      },
      "expGain": {
        "hacking": 0.01,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.08
      }
    },
    "Business Analyst": {
      "name": "Business Analyst",
      "field": "Business",
      "nextPosition": "Business Manager",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 100,
      "repMultiplier": 1.1,
      "requiredSkills": {
        "hacking": 6,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 51
      },
      "requiredReputation": 8000,
      "effectiveness": {
        "hacking": 15,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 85
      },
      "expGain": {
        "hacking": 0.02,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.15
      }
    },
    "Business Manager": {
      "name": "Business Manager",
      "field": "Business",
      "nextPosition": "Operations Manager",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 200,
      "repMultiplier": 1.3,
      "requiredSkills": {
        "hacking": 51,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 101
      },
      "requiredReputation": 40000,
      "effectiveness": {
        "hacking": 15,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 85
      },
      "expGain": {
        "hacking": 0.02,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.3
      }
    },
    "Operations Manager": {
      "name": "Operations Manager",
      "field": "Business",
      "nextPosition": "Chief Financial Officer",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 660,
      "repMultiplier": 1.5,
      "requiredSkills": {
        "hacking": 51,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 226
      },
      "requiredReputation": 200000,
      "effectiveness": {
        "hacking": 15,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 85
      },
      "expGain": {
        "hacking": 0.02,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.4
      }
    },
    "Chief Financial Officer": {
      "name": "Chief Financial Officer",
      "field": "Business",
      "nextPosition": "Chief Executive Officer",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 1950,
      "repMultiplier": 1.6,
      "requiredSkills": {
        "hacking": 76,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 501
      },
      "requiredReputation": 800000,
      "effectiveness": {
        "hacking": 10,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 90
      },
      "expGain": {
        "hacking": 0.05,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 1
      }
    },
    "Chief Executive Officer": {
      "name": "Chief Executive Officer",
      "field": "Business",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 3900,
      "repMultiplier": 1.75,
      "requiredSkills": {
        "hacking": 101,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 751
      },
      "requiredReputation": 3200000,
      "effectiveness": {
        "hacking": 10,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 90
      },
      "expGain": {
        "hacking": 0.05,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 1.5
      }
    },
    "Security Guard": {
      "name": "Security Guard",
      "field": "Security",
      "nextPosition": "Security Officer",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 50,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 0,
        "strength": 51,
        "defense": 51,
        "dexterity": 51,
        "agility": 51,
        "charisma": 1
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 5,
        "strength": 20,
        "defense": 20,
        "dexterity": 20,
        "agility": 20,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.01,
        "strength": 0.04,
        "defense": 0.04,
        "dexterity": 0.04,
        "agility": 0.04,
        "charisma": 0.02
      }
    },
    "Security Officer": {
      "name": "Security Officer",
      "field": "Security",
      "nextPosition": "Security Supervisor",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 195,
      "repMultiplier": 1.1,
      "requiredSkills": {
        "hacking": 26,
        "strength": 151,
        "defense": 151,
        "dexterity": 151,
        "agility": 151,
        "charisma": 51
      },
      "requiredReputation": 8000,
      "effectiveness": {
        "hacking": 10,
        "strength": 20,
        "defense": 20,
        "dexterity": 20,
        "agility": 20,
        "charisma": 10
      },
      "expGain": {
        "hacking": 0.02,
        "strength": 0.1,
        "defense": 0.1,
        "dexterity": 0.1,
        "agility": 0.1,
        "charisma": 0.05
      }
    },
    "Security Supervisor": {
      "name": "Security Supervisor",
      "field": "Security",
      "nextPosition": "Head of Security",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 660,
      "repMultiplier": 1.25,
      "requiredSkills": {
        "hacking": 26,
        "strength": 251,
        "defense": 251,
        "dexterity": 251,
        "agility": 251,
        "charisma": 101
      },
      "requiredReputation": 36000,
      "effectiveness": {
        "hacking": 10,
        "strength": 15,
        "defense": 15,
        "dexterity": 15,
        "agility": 15,
        "charisma": 30
      },
      "expGain": {
        "hacking": 0.02,
        "strength": 0.12,
        "defense": 0.12,
        "dexterity": 0.12,
        "agility": 0.12,
        "charisma": 0.1
      }
    },
    "Head of Security": {
      "name": "Head of Security",
      "field": "Security",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 1320,
      "repMultiplier": 1.4,
      "requiredSkills": {
        "hacking": 51,
        "strength": 501,
        "defense": 501,
        "dexterity": 501,
        "agility": 501,
        "charisma": 151
      },
      "requiredReputation": 144000,
      "effectiveness": {
        "hacking": 10,
        "strength": 15,
        "defense": 15,
        "dexterity": 15,
        "agility": 15,
        "charisma": 30
      },
      "expGain": {
        "hacking": 0.05,
        "strength": 0.15,
        "defense": 0.15,
        "dexterity": 0.15,
        "agility": 0.15,
        "charisma": 0.15
      }
    },
    "Field Agent": {
      "name": "Field Agent",
      "field": "Agent",
      "nextPosition": "Secret Agent",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 330,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 101,
        "strength": 101,
        "defense": 101,
        "dexterity": 101,
        "agility": 101,
        "charisma": 101
      },
      "requiredReputation": 8000,
      "effectiveness": {
        "hacking": 10,
        "strength": 15,
        "defense": 15,
        "dexterity": 20,
        "agility": 20,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.04,
        "strength": 0.08,
        "defense": 0.08,
        "dexterity": 0.08,
        "agility": 0.08,
        "charisma": 0.05
      }
    },
    "Secret Agent": {
      "name": "Secret Agent",
      "field": "Agent",
      "nextPosition": "Special Operative",
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 990,
      "repMultiplier": 1.25,
      "requiredSkills": {
        "hacking": 201,
        "strength": 251,
        "defense": 251,
        "dexterity": 251,
        "agility": 251,
        "charisma": 201
      },
      "requiredReputation": 32000,
      "effectiveness": {
        "hacking": 15,
        "strength": 15,
        "defense": 15,
        "dexterity": 20,
        "agility": 20,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.1,
        "strength": 0.15,
        "defense": 0.15,
        "dexterity": 0.15,
        "agility": 0.15,
        "charisma": 0.1
      }
    },
    "Special Operative": {
      "name": "Special Operative",
      "field": "Agent",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 2000,
      "repMultiplier": 1.5,
      "requiredSkills": {
        "hacking": 251,
        "strength": 501,
        "defense": 501,
        "dexterity": 501,
        "agility": 501,
        "charisma": 251
      },
      "requiredReputation": 162000,
      "effectiveness": {
        "hacking": 15,
        "strength": 15,
        "defense": 15,
        "dexterity": 20,
        "agility": 20,
        "charisma": 15
      },
      "expGain": {
        "hacking": 0.15,
        "strength": 0.2,
        "defense": 0.2,
        "dexterity": 0.2,
        "agility": 0.2,
        "charisma": 0.15
      }
    },
    "Waiter": {
      "name": "Waiter",
      "field": "Waiter",
      "nextPosition": null,
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 22,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 0,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 0,
        "strength": 10,
        "defense": 0,
        "dexterity": 10,
        "agility": 10,
        "charisma": 70
      },
      "expGain": {
        "hacking": 0,
        "strength": 0.02,
        "defense": 0.02,
        "dexterity": 0.02,
        "agility": 0.02,
        "charisma": 0.05
      }
    },
    "Employee": {
      "name": "Employee",
      "field": "Employee",
      "nextPosition": null,
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 22,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 0,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 0,
        "strength": 10,
        "defense": 0,
        "dexterity": 10,
        "agility": 10,
        "charisma": 70
      },
      "expGain": {
        "hacking": 0,
        "strength": 0.02,
        "defense": 0.02,
        "dexterity": 0.02,
        "agility": 0.02,
        "charisma": 0.04
      }
    },
    "Software Consultant": {
      "name": "Software Consultant",
      "field": "Software Consultant",
      "nextPosition": "Senior Software Consultant",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 66,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 51,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 80,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 20
      },
      "expGain": {
        "hacking": 0.08,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.03
      }
    },
    "Senior Software Consultant": {
      "name": "Senior Software Consultant",
      "field": "Software Consultant",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 132,
      "repMultiplier": 1.2,
      "requiredSkills": {
        "hacking": 251,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 51
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 75,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 25
      },
      "expGain": {
        "hacking": 0.25,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.06
      }
    },
    "Business Consultant": {
      "name": "Business Consultant",
      "field": "Business Consultant",
      "nextPosition": "Senior Business Consultant",
      "isStartingJob": true,
      "isPartTime": false,
      "baseSalary": 66,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 6,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 51
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 20,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 80
      },
      "expGain": {
        "hacking": 0.015,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.15
      }
    },
    "Senior Business Consultant": {
      "name": "Senior Business Consultant",
      "field": "Business Consultant",
      "nextPosition": null,
      "isStartingJob": false,
      "isPartTime": false,
      "baseSalary": 525,
      "repMultiplier": 1.2,
      "requiredSkills": {
        "hacking": 51,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 226
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 15,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 85
      },
      "expGain": {
        "hacking": 0.015,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0.3
      }
    },
    "Part-time Waiter": {
      "name": "Part-time Waiter",
      "field": "Waiter",
      "nextPosition": null,
      "isStartingJob": true,
      "isPartTime": true,
      "baseSalary": 20,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 0,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 0,
        "strength": 10,
        "defense": 0,
        "dexterity": 10,
        "agility": 10,
        "charisma": 70
      },
      "expGain": {
        "hacking": 0,
        "strength": 0.0075,
        "defense": 0.0075,
        "dexterity": 0.0075,
        "agility": 0.0075,
        "charisma": 0.04
      }
    },
    "Part-time Employee": {
      "name": "Part-time Employee",
      "field": "Employee",
      "nextPosition": null,
      "isStartingJob": true,
      "isPartTime": true,
      "baseSalary": 20,
      "repMultiplier": 1,
      "requiredSkills": {
        "hacking": 0,
        "strength": 0,
        "defense": 0,
        "dexterity": 0,
        "agility": 0,
        "charisma": 0
      },
      "requiredReputation": 0,
      "effectiveness": {
        "hacking": 0,
        "strength": 10,
        "defense": 0,
        "dexterity": 10,
        "agility": 10,
        "charisma": 70
      },
      "expGain": {
        "hacking": 0,
        "strength": 0.0075,
        "defense": 0.0075,
        "dexterity": 0.0075,
        "agility": 0.0075,
        "charisma": 0.03
      }
    }
  },
  "companies": {
    "ECorp": {
      "name": "ECorp",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 3,
      "salaryMultiplier": 3,
      "jobStatReqOffset": 249,
      "relatedFaction": "ECorp"
    },
    "MegaCorp": {
      "name": "MegaCorp",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 3,
      "salaryMultiplier": 3,
      "jobStatReqOffset": 249,
      "relatedFaction": "MegaCorp"
    },
    "Bachman & Associates": {
      "name": "Bachman & Associates",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.6,
      "salaryMultiplier": 2.6,
      "jobStatReqOffset": 224,
      "relatedFaction": "Bachman & Associates"
    },
    "Blade Industries": {
      "name": "Blade Industries",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.75,
      "salaryMultiplier": 2.75,
      "jobStatReqOffset": 224,
      "relatedFaction": "Blade Industries"
    },
    "NWO": {
      "name": "NWO",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.75,
      "salaryMultiplier": 2.75,
      "jobStatReqOffset": 249,
      "relatedFaction": "NWO"
    },
    "Clarke Incorporated": {
      "name": "Clarke Incorporated",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.25,
      "salaryMultiplier": 2.25,
      "jobStatReqOffset": 224,
      "relatedFaction": "Clarke Incorporated"
    },
    "OmniTek Incorporated": {
      "name": "OmniTek Incorporated",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.25,
      "salaryMultiplier": 2.25,
      "jobStatReqOffset": 224,
      "relatedFaction": "OmniTek Incorporated"
    },
    "Four Sigma": {
      "name": "Four Sigma",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.5,
      "salaryMultiplier": 2.5,
      "jobStatReqOffset": 224,
      "relatedFaction": "Four Sigma"
    },
    "KuaiGong International": {
      "name": "KuaiGong International",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 2.2,
      "salaryMultiplier": 2.2,
      "jobStatReqOffset": 224,
      "relatedFaction": "KuaiGong International"
    },
    "Fulcrum Technologies": {
      "name": "Fulcrum Technologies",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer"
      ],
      "expMultiplier": 2,
      "salaryMultiplier": 2,
      "jobStatReqOffset": 224,
      "relatedFaction": "Fulcrum Secret Technologies"
    },
    "Storm Technologies": {
      "name": "Storm Technologies",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Software Consultant",
        "Senior Software Consultant",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer"
      ],
      "expMultiplier": 1.8,
      "salaryMultiplier": 1.8,
      "jobStatReqOffset": 199
    },
    "DefComm": {
      "name": "DefComm",
      "positions": [
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Software Consultant",
        "Senior Software Consultant",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.75,
      "salaryMultiplier": 1.75,
      "jobStatReqOffset": 199
    },
    "Helios Labs": {
      "name": "Helios Labs",
      "positions": [
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Software Consultant",
        "Senior Software Consultant",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.8,
      "salaryMultiplier": 1.8,
      "jobStatReqOffset": 199
    },
    "VitaLife": {
      "name": "VitaLife",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 1.8,
      "salaryMultiplier": 1.8,
      "jobStatReqOffset": 199
    },
    "Icarus Microsystems": {
      "name": "Icarus Microsystems",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 1.9,
      "salaryMultiplier": 1.9,
      "jobStatReqOffset": 199
    },
    "Universal Energy": {
      "name": "Universal Energy",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 2,
      "salaryMultiplier": 2,
      "jobStatReqOffset": 199
    },
    "Galactic Cybersystems": {
      "name": "Galactic Cybersystems",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 1.9,
      "salaryMultiplier": 1.9,
      "jobStatReqOffset": 199
    },
    "AeroCorp": {
      "name": "AeroCorp",
      "positions": [
        "Operations Manager",
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.7,
      "salaryMultiplier": 1.7,
      "jobStatReqOffset": 199
    },
    "Omnia Cybersystems": {
      "name": "Omnia Cybersystems",
      "positions": [
        "Operations Manager",
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.7,
      "salaryMultiplier": 1.7,
      "jobStatReqOffset": 199
    },
    "Solaris Space Systems": {
      "name": "Solaris Space Systems",
      "positions": [
        "Operations Manager",
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.7,
      "salaryMultiplier": 1.7,
      "jobStatReqOffset": 199
    },
    "DeltaOne": {
      "name": "DeltaOne",
      "positions": [
        "Operations Manager",
        "Chief Executive Officer",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Business Consultant",
        "Senior Business Consultant"
      ],
      "expMultiplier": 1.6,
      "salaryMultiplier": 1.6,
      "jobStatReqOffset": 199
    },
    "Global Pharmaceuticals": {
      "name": "Global Pharmaceuticals",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 1.8,
      "salaryMultiplier": 1.8,
      "jobStatReqOffset": 224
    },
    "Nova Medical": {
      "name": "Nova Medical",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Software Consultant",
        "Senior Software Consultant",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 1.75,
      "salaryMultiplier": 1.75,
      "jobStatReqOffset": 199
    },
    "Central Intelligence Agency": {
      "name": "Central Intelligence Agency",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Field Agent",
        "Secret Agent",
        "Special Operative"
      ],
      "expMultiplier": 2,
      "salaryMultiplier": 2,
      "jobStatReqOffset": 149
    },
    "National Security Agency": {
      "name": "National Security Agency",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Field Agent",
        "Secret Agent",
        "Special Operative"
      ],
      "expMultiplier": 2,
      "salaryMultiplier": 2,
      "jobStatReqOffset": 149
    },
    "Watchdog Security": {
      "name": "Watchdog Security",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Network Engineer",
        "Network Administrator",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Field Agent",
        "Secret Agent",
        "Special Operative",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 1.5,
      "salaryMultiplier": 1.5,
      "jobStatReqOffset": 124
    },
    "LexoCorp": {
      "name": "LexoCorp",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Software Consultant",
        "Senior Software Consultant",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Chief Financial Officer",
        "Chief Executive Officer",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 1.4,
      "salaryMultiplier": 1.4,
      "jobStatReqOffset": 99
    },
    "Rho Construction": {
      "name": "Rho Construction",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager"
      ],
      "expMultiplier": 1.3,
      "salaryMultiplier": 1.3,
      "jobStatReqOffset": 49
    },
    "Alpha Enterprises": {
      "name": "Alpha Enterprises",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Business Intern",
        "Business Analyst",
        "Business Manager",
        "Operations Manager",
        "Software Consultant",
        "Senior Software Consultant"
      ],
      "expMultiplier": 1.5,
      "salaryMultiplier": 1.5,
      "jobStatReqOffset": 99
    },
    "Aevum Police Headquarters": {
      "name": "Aevum Police Headquarters",
      "positions": [
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security",
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer"
      ],
      "expMultiplier": 1.3,
      "salaryMultiplier": 1.3,
      "jobStatReqOffset": 99
    },
    "SysCore Securities": {
      "name": "SysCore Securities",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer"
      ],
      "expMultiplier": 1.3,
      "salaryMultiplier": 1.3,
      "jobStatReqOffset": 124
    },
    "CompuTek": {
      "name": "CompuTek",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer"
      ],
      "expMultiplier": 1.2,
      "salaryMultiplier": 1.2,
      "jobStatReqOffset": 74
    },
    "NetLink Technologies": {
      "name": "NetLink Technologies",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer"
      ],
      "expMultiplier": 1.2,
      "salaryMultiplier": 1.2,
      "jobStatReqOffset": 99
    },
    "Carmichael Security": {
      "name": "Carmichael Security",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator",
        "Network Engineer",
        "Network Administrator",
        "Security Engineer",
        "Software Consultant",
        "Senior Software Consultant",
        "Field Agent",
        "Secret Agent",
        "Special Operative",
        "Security Guard",
        "Security Officer",
        "Security Supervisor",
        "Head of Security"
      ],
      "expMultiplier": 1.2,
      "salaryMultiplier": 1.2,
      "jobStatReqOffset": 74
    },
    "FoodNStuff": {
      "name": "FoodNStuff",
      "positions": [
        "Employee",
        "Part-time Employee"
      ],
      "expMultiplier": 1,
      "salaryMultiplier": 1,
      "jobStatReqOffset": 0
    },
    "Joe's Guns": {
      "name": "Joe's Guns",
      "positions": [
        "Employee",
        "Part-time Employee"
      ],
      "expMultiplier": 1,
      "salaryMultiplier": 1,
      "jobStatReqOffset": 0
    },
    "Omega Software": {
      "name": "Omega Software",
      "positions": [
        "Software Engineering Intern",
        "Junior Software Engineer",
        "Senior Software Engineer",
        "Lead Software Developer",
        "Head of Software",
        "Head of Engineering",
        "Vice President of Technology",
        "Chief Technology Officer",
        "Software Consultant",
        "Senior Software Consultant",
        "IT Intern",
        "IT Analyst",
        "IT Manager",
        "Systems Administrator"
      ],
      "expMultiplier": 1.1,
      "salaryMultiplier": 1.1,
      "jobStatReqOffset": 49
    },
    "Noodle Bar": {
      "name": "Noodle Bar",
      "positions": [
        "Waiter",
        "Part-time Waiter"
      ],
      "expMultiplier": 1,
      "salaryMultiplier": 1,
      "jobStatReqOffset": 0
    }
  }
};
