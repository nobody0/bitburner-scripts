import type { NS } from "@ns";
import {
  parseSyncControl,
  syncControl,
  SYNC_CONTROL_FILE,
} from "../shared/deployment.ts";
import { MAIN_SCRIPT_GB, START_SCRIPT_GB } from "./lib/ram.ts";

export const MAIN_SCRIPT = "main.js";
const SYNC_ARG = "--sync";
const CONTROL_POLL_MS = 100;

function launchMain(ns: NS, afterSync = false): void {
  ns.spawn(MAIN_SCRIPT, {
    threads: 1,
    ramOverride: MAIN_SCRIPT_GB,
    spawnDelay: 0,
    temporary: true,
    preventDuplicates: true,
  }, ...(afterSync ? [SYNC_ARG] : []));
}

export function planKillOrder(hosts: readonly string[], home: string): string[] {
  const unique = [...new Set(hosts)];
  return [...unique.filter((host) => host !== home), home];
}

/** Autoexec and deployment coordinator. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  if (ns.args.length === 0) {
    launchMain(ns);
    return;
  }
  if (ns.args.length !== 1 || ns.args[0] !== SYNC_ARG) {
    throw new Error(`start.js accepts only ${SYNC_ARG}; received ${JSON.stringify(ns.args)}`);
  }

  const home = "home";
  let activeId: string | undefined;
  for (;;) {
    const control = parseSyncControl(ns.read(SYNC_CONTROL_FILE));
    if (control?.phase === "prepare" && control.id !== activeId) {
      activeId = control.id;
      for (const host of planKillOrder(control.hosts, home)) ns.killall(host, true);
      await ns.write(SYNC_CONTROL_FILE, syncControl({
        id: activeId,
        phase: "ready",
      }), "w");
    } else if (control?.phase === "commit" && control.id === activeId) {
      launchMain(ns, true);
      return;
    }
    await ns.sleep(CONTROL_POLL_MS);
  }
}
