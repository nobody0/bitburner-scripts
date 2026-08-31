import type { NS } from "@ns";
import {
  parseSyncControl,
  SYNC_CONTROL_FILE,
} from "../shared/deployment.ts";
import { MAIN_SCRIPT_GB } from "./lib/ram.ts";

export const MAIN_SCRIPT = "main.js";

function launchMain(ns: NS): void {
  ns.spawn(MAIN_SCRIPT, {
    threads: 1,
    ramOverride: MAIN_SCRIPT_GB,
    spawnDelay: 0,
    temporary: true,
    preventDuplicates: true,
  });
}

export function planKillOrder(hosts: readonly string[], home: string): string[] {
  const unique = [...new Set(hosts)];
  return [...unique.filter((host) => host !== home), home];
}

async function activateStaged(ns: NS, control: { id: string; hosts: string[] }): Promise<void> {
  for (const host of planKillOrder(control.hosts, "home")) ns.killall(host, true);
  await ns.write(SYNC_CONTROL_FILE, "", "w");
  launchMain(ns);
}

/** Autoexec and deployment coordinator. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const initialControl = parseSyncControl(ns.read(SYNC_CONTROL_FILE));
  if (initialControl) {
    await activateStaged(ns, initialControl);
    return;
  }
  if (ns.args.length !== 0) throw new Error(`start.js accepts no arguments: ${JSON.stringify(ns.args)}`);
  launchMain(ns);
}
