import type { NS } from "@ns";
import type { ScriptLaunch } from "./launch-shared.ts";

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
