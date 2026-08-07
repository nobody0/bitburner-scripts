import type { NS } from "@ns";

/** Self-contained early-game worker (2.4 GB static). Deployed to every rooted
 * server by start.js with the target as its argument. Deliberately dumb: the
 * classic sec/money threshold loop, all threads on one op. This is the
 * PLACEHOLDER income engine until the targeting/dispatch phase
 * (spec/targeting.md) replaces it with puppeted ramOverride workers. */
export async function main(ns: NS): Promise<void> {
  const target = String(ns.args[0] ?? "n00dles");
  for (;;) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    if (security > minSecurity + 5) await ns.weaken(target);
    else if (money < 0.75 * maxMoney) await ns.grow(target);
    else await ns.hack(target);
  }
}
