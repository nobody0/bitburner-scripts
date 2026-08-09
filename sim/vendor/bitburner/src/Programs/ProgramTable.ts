// Vendored from bitburner-src v3.0.1 by tools/vendor.ts (extractDataTable:
// src/Programs/Programs.ts, src/DarkWeb/DarkWebItems.ts) — DO NOT EDIT
export interface VendoredProgram {
  name: string;
  level: number;
  baseTimeMs: number;
  purchaseCost: number;
}

export const PROGRAM_TABLE: Record<string, VendoredProgram> = {
  "BruteSSH.exe": {
    "name": "BruteSSH.exe",
    "level": 50,
    "baseTimeMs": 600000,
    "purchaseCost": 500000
  },
  "FTPCrack.exe": {
    "name": "FTPCrack.exe",
    "level": 100,
    "baseTimeMs": 1800000,
    "purchaseCost": 1500000
  },
  "relaySMTP.exe": {
    "name": "relaySMTP.exe",
    "level": 250,
    "baseTimeMs": 7200000,
    "purchaseCost": 5000000
  },
  "HTTPWorm.exe": {
    "name": "HTTPWorm.exe",
    "level": 500,
    "baseTimeMs": 14400000,
    "purchaseCost": 30000000
  },
  "SQLInject.exe": {
    "name": "SQLInject.exe",
    "level": 750,
    "baseTimeMs": 28800000,
    "purchaseCost": 250000000
  }
};
