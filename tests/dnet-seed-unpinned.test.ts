import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/** The two darknet actions home performs ITSELF, and where they are allowed
 * to run.
 *
 * `ns.exec` evaluates its direct-connection requirement BEFORE the darkweb
 * early-out, so a launcher that is not home — the one host holding the TOR
 * edge — `scp`s happily and then gets a silent 0 back from `exec`. The driver
 * issues the seed out of `start.js` on home, so the requirement is satisfied
 * by construction.
 *
 * This file is a SOURCE test because the property is a property of the source:
 * nothing observable at runtime distinguishes a seed launched from home from
 * one launched elsewhere until the day it lands somewhere without TOR and the
 * beachhead silently never seeds. */
const driver = await readFile(new URL("../game/lib/features/dnet.ts", import.meta.url), "utf8");

/** The driver with its prose stripped. The negative assertions below are about
 * what the driver CALLS, and a comment naming a member is not a call. */
const code = driver.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the darknet home driver's own actions", () => {
  test("neither the seed nor the backdoor rents a host any more", () => {
    // Neither operation should reintroduce broker placement or home pinning.
    expect(code).not.toContain("featureTask");
    expect(code).not.toContain("pinHost");
  });

  test("the seed execs from home's own ns and proxies only what the bundle does not own", () => {
    // `exec` is the one member start.js has already paid for statically
    // (1.3 GB, see game/lib/ns-proxy-shared.ts), and `ctx.ns` on the home
    // driver IS that script's ns — so this both costs nothing and is the one
    // `ns` in the realm that can reach `darkweb`. It is also SYNCHRONOUS,
    // which `handoffLaunch` requires: the descriptor is published and the pid
    // read back inside a single engine turn.
    expect(driver).toContain("ctx.ns.exec(");
    expect(code).not.toContain('["exec"](');
    // `scp` is not the bundle's, so it goes through a resident. It is
    // distance-free — it never needed the pin and does not need home.
    expect(driver).toContain('await ctx.nspLong("scp",');
    expect(code).not.toContain('["scp"](');
  });

  test("the backdoor walk runs on the LONG resident", () => {
    // A hop-by-hop `singularity.connect` route plus `installBackdoor` is
    // minutes of awaited call. Bitburner allows one Netscript call per script
    // at a time, so putting it on `nsp` would hold every read in the whole
    // automation behind one backdoor.
    expect(driver).toContain('await ctx.nspLong("singularity.connect", "home")');
    expect(driver).toContain('await ctx.nspLong("singularity.installBackdoor")');
    expect(code).not.toContain('ctx.nsp("singularity.');
  });

  test("the walk never reaches for ns.scan", () => {
    // `ns.scan` omits darknet servers outright, so the BFS the HACKING
    // backdoor uses cannot find a route out here at all. The route comes from
    // the controller's folded adjacency, which is the only place it exists —
    // and a `scan` creeping back in would look like it worked while quietly
    // finding nothing.
    expect(code).not.toContain('"scan"');
    expect(code).not.toContain("ctx.ns.scan");
  });
});
