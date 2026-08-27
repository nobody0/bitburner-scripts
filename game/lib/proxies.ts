import { createNsProxy, type NsProxy, type NsProxyHandle, type ProxyPlacer } from "./ns-proxy.ts";
import type { ResidentAsk } from "../../shared/ram/broker.ts";

/** The run's two ns residents, reachable from anywhere without threading a
 * handle through every signature.
 *
 * They live on `globalThis` rather than in module scope because the darknet
 * controller is a SEPARATE bundle: it would otherwise get its own copy of this
 * module and its own residents, paying twice for the same reads. All scripts
 * share one JS realm, so one pair of residents serves the whole automation —
 * the same property the launch handoff already rests on.
 *
 * Why two:
 *
 * - `nsp` is everything. Reads, feature actions, the fleet sweep.
 * - `nspLong` is for calls that AWAIT for a long time — a backdoor walk, a Go
 *   turn, grafting, `workForFaction`. Bitburner allows one Netscript call per
 *   script at a time, so a minutes-long await on `nsp` would hold every read
 *   in the automation behind it. It is only a choice of resident: the two
 *   surfaces are identical.
 *
 * Both are LAZY — nothing is exec'd until the first call — and both size
 * themselves to the fleet (see game/lib/ns-proxy.ts). */
interface ProxyGlobals {
  ns_proxy?: NsProxyHandle;
  ns_proxy_long?: NsProxyHandle;
}

type ProxyGlobalThis = typeof globalThis & ProxyGlobals;

const realm = (): ProxyGlobalThis => globalThis as ProxyGlobalThis;

/** Budget to ask for. `nsp` asks for foodnstuff's whole 16 GB (14.4 GB
 * dynamic), which fits every routine call. `nspLong` is small on purpose — it
 * exists to keep one long await off `nsp` — and grows on demand if its errand
 * is dear. Neither is a ceiling: a call priced above the budget raises it, and
 * a resident that recycles raises its own ask to the working set it was using. */
const NSP_BUDGET_GB = 14.4;
const NSP_LONG_BUDGET_GB = 2.4;

/** `start.js`'s ENTIRE static cost: 1.6 GB base plus `ns.exec`, and nothing
 * else in the whole bundle is billable. That is the point of the ns proxy, and
 * `tests/ram-budget.test.ts` asserts the member list exhaustively.
 *
 * It must equal the numeric literal in `game/start.ts`'s `ns.ramOverride(...)`,
 * which cannot import this: the static analyser reads that literal before the
 * script is launched, so it has to be written out. The test pins the two
 * together. */
export const START_SCRIPT_GB = 2.9;

/** A fresh game's home RAM. */
const FRESH_HOME_GB = 8;

/** What home can hand a resident before anything else is rooted, WITHOUT
 * looking — by arithmetic rather than measurement, because measuring it would
 * itself need a resident. Everything the bootstrap does fits inside it several
 * times over: `nuke` 0.05, `scp` 0.6, `hasRootAccess` 0.05,
 * `getServerMaxRam` 0.05. */
export const HOME_BOOTSTRAP_EXECUTABLE_GB = FRESH_HOME_GB - START_SCRIPT_GB;

/** Home, blind, capped at what a fresh game is guaranteed to have. This is the
 * placer both residents boot with; `bootstrapResidentHost` replaces it the
 * moment there is somewhere better to stand. */
const homeBootstrapPlacer: ProxyPlacer = (minGb, preferredGb) => {
  if (minGb > HOME_BOOTSTRAP_EXECUTABLE_GB) return undefined;
  return {
    host: "home",
    gb: Math.min(preferredGb, HOME_BOOTSTRAP_EXECUTABLE_GB),
    release: () => {},
  };
};

/** Stand the residents on one named host of known capacity. Used between the
 * bootstrap and the controller's fleet-wide placer. */
export function fixedHostPlacer(host: string, capacityGb: number): ProxyPlacer {
  return (minGb, preferredGb) => {
    if (minGb > capacityGb) return undefined;
    return { host, gb: Math.min(preferredGb, capacityGb), release: () => {} };
  };
}

/** Create the residents if this realm has none. Idempotent: a build handoff
 * re-enters here with the previous instance's handles still published, and
 * adopting them keeps the running residents instead of orphaning their RAM. */
export function initProxies(): void {
  const held = realm();
  held.ns_proxy ??= createNsProxy({ label: "nsp", budgetGb: NSP_BUDGET_GB, place: homeBootstrapPlacer });
  held.ns_proxy_long ??= createNsProxy({ label: "nspLong", budgetGb: NSP_LONG_BUDGET_GB, place: homeBootstrapPlacer });
}

function handle(slot: keyof ProxyGlobals): NsProxyHandle {
  const held = realm()[slot];
  if (!held) throw new Error(`${slot} is not initialised; game/start.ts must call initProxies()`);
  return held;
}

/** Forward every call to whichever handle is published RIGHT NOW.
 *
 * Resolving the handle per call, rather than handing one out, is what makes it
 * safe to hold `nsp` in a local or pass it down: a cold boot retires the
 * handles and `initProxies` publishes new ones, so anything that had captured
 * a `.call` would go on talking to a retired resident. */
const forward = (slot: keyof ProxyGlobals): NsProxy =>
  ((path: string, ...args: unknown[]) =>
    (handle(slot).call as (p: string, ...a: unknown[]) => Promise<unknown>)(path, ...args)) as NsProxy;

/** The general-purpose surface. */
export const nsp: NsProxy = forward("ns_proxy");

/** The surface for one long-running await. */
export const nspLong: NsProxy = forward("ns_proxy_long");

/** What each resident holds and what it will next ask for, so the arena can
 * reserve room for it (shared/ram/broker.ts).
 *
 * Reported for BOTH handles whether or not a process is running: a resident
 * that has not started yet still names the size it will want, and a resident
 * whose grow-respawn cannot find room is precisely the case the reserve has to
 * cover — it is spinning on `proxy.slow` with nothing to show for itself but
 * this number. */
export function residentAsks(): ResidentAsk[] {
  const held = realm();
  const asks: ResidentAsk[] = [];
  for (const handle of [held.ns_proxy, held.ns_proxy_long]) {
    if (!handle) continue;
    const host = handle.host();
    asks.push({ ...(host !== undefined ? { host } : {}), gb: handle.grantedGb(), wantGb: handle.wantedGb() });
  }
  return asks;
}

/** Hand both residents the controller's broker-backed placer, replacing the
 * home-sized fallback they boot with. */
export function setProxyPlacer(place: ProxyPlacer): void {
  handle("ns_proxy").setPlacer(place);
  handle("ns_proxy_long").setPlacer(place);
}

/** Kill both residents WITHOUT retiring their handles, so the next call
 * respawns them wherever the current placer points. This is how a resident
 * moves host: set the placer, then recycle. */
export async function recycleResidents(): Promise<void> {
  const held = realm();
  await held.ns_proxy?.free();
  await held.ns_proxy_long?.free();
}

/** Kill both residents and release their RAM. A controller that exits without
 * this leaves them running for the rest of the run, and its successor cannot
 * see them to reap them. */
export async function disposeProxies(): Promise<void> {
  const held = realm();
  await held.ns_proxy?.free();
  await held.ns_proxy_long?.free();
  held.ns_proxy = undefined;
  held.ns_proxy_long = undefined;
}

/** Every resident currently running, so a fleet-wide kill sweep can spare
 * them. A resident killed mid-call leaves its awaited promise unresolved and
 * the caller HANGS rather than stalling. Residents are lazy, so this is empty
 * until the first proxied call and short for the rest of the run. */
export function proxyResidents(): { pid: number; host: string }[] {
  const held = realm();
  const standing: { pid: number; host: string }[] = [];
  for (const handle of [held.ns_proxy, held.ns_proxy_long]) {
    const pid = handle?.pid();
    const host = handle?.host();
    if (pid !== undefined && host !== undefined) standing.push({ pid, host });
  }
  return standing;
}
