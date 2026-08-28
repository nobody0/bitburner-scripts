import type { NS } from "@ns";
import type { ScriptLaunch } from "./launch-shared.ts";
import type { NsProxy, NsProxyHandle } from "./ns-proxy.ts";

/** Rendezvous between the proxy (caller) and one resident process.
 *
 * Nothing here serializes. Every Bitburner script is an ES module in ONE
 * browser realm, so the resident's `ns` is handed over as a live reference and
 * every proxied call is an ordinary in-realm function call — results, thrown
 * errors and pending promises all cross unchanged. Type-only module: nothing
 * here exists at runtime.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export interface ProxyLaunch extends ScriptLaunch {
  readonly kind: "ns-proxy";
  /** The resident hands its own live `ns` up. Called once, before it parks. */
  readonly publish: (ns: NS) => void;
  /** Resolves when the proxy wants this resident to exit cleanly. A plain JS
   * promise on purpose: awaiting it is NOT a Netscript call, so it leaves
   * `env.runningFn` clear and the lent `ns` callable. See game/dnet/prober.ts. */
  readonly stop: Promise<void>;
  /** The resident's `atExit`: it is gone and the engine has returned its RAM.
   * Fires for a kill as readily as a clean exit, which is what makes it safe
   * to wait on before re-execing onto the same host. */
  readonly gone: () => void;
}

/** `nsMain` is the long-lived script's own `ns` — `start.js` on home, which
 * never returns (game/start.ts). It is the one `ns` in the realm that has
 * statically paid for `exec` (1.3 GB), so every launch the proxy makes and
 * every proxied `exec` routes through it and costs the bundle nothing more. */
export interface NsProxyGlobals {
  nsMain?: NS;
}

export type NsProxyGlobalThis = typeof globalThis & NsProxyGlobals;

export const nsMainGlobal = (): NsProxyGlobalThis => globalThis as NsProxyGlobalThis;

/** The run's two ns residents, reachable from anywhere without threading a
 * handle through every signature.
 *
 * They live on `globalThis` rather than in module scope because the darknet
 * controller is a SEPARATE bundle: it would otherwise get its own copy and its
 * own residents, paying twice for the same reads. All scripts share one JS
 * realm, so one pair serves the whole automation.
 *
 * The CALL surface lives here, apart from the factory in `ns-proxy.ts`, for
 * the same bundling reason: `ns-proxy.ts` names `exec` to launch a resident,
 * and Bitburner's analyser charges a member by NAME anywhere in a bundle. A
 * caller that only wants to MAKE calls must not drag the launcher in with it —
 * the darknet controller is allocated 1.6 GB and is forbidden `exec` outright.
 * This module is type-only at runtime apart from these accessors. */
export interface ProxyGlobals {
  ns_proxy?: NsProxyHandle;
  ns_proxy_long?: NsProxyHandle;
}

export type ProxyGlobalThis = typeof globalThis & ProxyGlobals;

export const proxyRealm = (): ProxyGlobalThis => globalThis as ProxyGlobalThis;

export function proxyHandle(slot: keyof ProxyGlobals): NsProxyHandle {
  const held = proxyRealm()[slot];
  if (!held) throw new Error(`${slot} is not initialised; game/start.ts must call initProxies()`);
  return held;
}

/** Forward every call to whichever handle is published RIGHT NOW.
 *
 * Resolving the handle per call, rather than handing one out, is what makes it
 * safe to hold `nsp` in a local or pass it down: a cold boot retires the
 * handles and `initProxies` publishes new ones, so anything that had captured
 * a `.call` would go on talking to a retired resident. */
const forward = (slot: keyof ProxyGlobals): NsProxy => {
  const call = ((path: string, ...args: unknown[]) =>
    (proxyHandle(slot).call as (p: string, ...a: unknown[]) => Promise<unknown>)(path, ...args)) as NsProxy;
  call.guaranteeFit = (paths, use) => proxyHandle(slot).call.guaranteeFit(paths, use);
  return call;
};

/** The general-purpose surface. */
export const nsp: NsProxy = forward("ns_proxy");

/** The surface for one long-running await. */
export const nspLong: NsProxy = forward("ns_proxy_long");
