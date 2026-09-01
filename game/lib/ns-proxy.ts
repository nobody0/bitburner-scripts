import type { NS, RunOptions } from "@ns";
import {
  launchExec,
  temporaryRunOptions,
  waitExecReady,
  type ExecLaunchEntity,
  type ScriptLaunch,
} from "./launch-shared.ts";
import { nsMainGlobal, type ProxyLaunch } from "./ns-proxy-shared.ts";
import { RESIDENT_BASE_GB } from "../../shared/ram/broker.ts";
import { realmSleep } from "./wake.ts";

/** The ns proxy: a RAM dodge you can call like a function.
 *
 * Bitburner charges a script's RAM by the ns members its SOURCE references,
 * and it charges by member NAME across the whole bundle regardless of the
 * receiver — a local called `exec`, even `RegExp.prototype.exec`, bills the
 * full 1.3 GB (see game/dnet/attempt.ts). main.js is one bundle holding the
 * controller, every feature driver and every probe, so a single dotted ns
 * member anywhere under game/lib/** is charged to home.
 *
 * So the call surface is a STRING PATH, and the string is the only mention of
 * the member anywhere in the bundle:
 *
 *     const server = await nsp("getServer", "n00dles");
 *     await nsp("singularity.joinFaction", faction);
 *     const time = await nsp("formulas.hacking.hackTime", server, player);
 *
 * The path is fully typed — `AutoPath` autocompletes it against NS and infers
 * both the argument list and the return type — so a wrong path is a compile
 * error rather than a stub the game kills at runtime.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L405-L440
 *
 * The work happens in a RESIDENT (lib/ns-resident.js): one process exec'd with
 * a flat `ramOverride` that publishes its own `ns` and parks. Calls run against
 * that object, so they are billed to its allocation. A function's cost is
 * charged ONCE per running script, so the resident pays for each distinct
 * member on first use and every later call to it is free — which is the whole
 * economy: the price and the call are the same fact and cannot drift apart.
 *
 * Ported from bitburner-2024, servers/home/scripts/nsProxy.ts, with the
 * per-instance handshake, bounded retry, call serialisation and drain-before-
 * recycle that the original leaves to its callers. Replaces the dodger
 * (see spec/ns-proxy.md).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L29 */

// ---------------------------------------------------------------------------
// Typed dotted paths into NS.
//
// Lifted from the reference implementation, which took it from the ts-toolbelt
// "autocomplete a dotted key path" trick. It is what turns a bare string into a
// checked call: `AutoPath` offers every legal continuation of a partial path,
// and `GetPath` recovers the function type at the end of a complete one.
// ---------------------------------------------------------------------------

type _StringKeys<T> = keyof T extends infer K ? (K extends keyof T ? K : never) : never;
type __StringKeys<T, K> =
  | `${K & string}`
  | ([T] extends [readonly (infer _U)[]]
    ? number extends T["length"]
      ? number extends K ? `${bigint}` : `${K & number}`
      : never
    : number extends K ? `${bigint}` : `${K & number}`);
type StringKeys<T> = __StringKeys<T, _StringKeys<T>>;

type NonHomomorphicKeyof<T> = keyof T extends infer K ? Extract<K, keyof T> : never;
type GetStringKey<T, K extends StringKeys<T>> = {
  [K2 in NonHomomorphicKeyof<T>]: K extends __StringKeys<T, K2> ? T[K2] : never;
}[NonHomomorphicKeyof<T>];

export type AutoPath<O, P extends string, V = unknown> =
  (P & `${string}.` extends never ? P : P & `${string}.`) extends infer Q
    ? Q extends `${infer A}.${infer B}`
      ? A extends StringKeys<O> ? `${A}.${AutoPath<GetStringKey<O, A>, B, V>}` : never
      : Q extends StringKeys<O>
        ? | (GetStringKey<O, Q> extends V ? Exclude<P, `${string}.`> : never)
          | (StringKeys<GetStringKey<O, Q>> extends never ? never : `${Q}.`)
        : StringKeys<O> | (Q extends "" ? (`${bigint}` extends StringKeys<O> ? "[index]" : never) : never)
    : never;

export type GetPath<O, P extends string> =
  P extends `${infer A}.${infer B}`
    ? A extends StringKeys<O> ? GetPath<GetStringKey<O, A>, B> : never
    : P extends StringKeys<O> ? GetStringKey<O, P> : never;

/** Arguments and result of a member, ACROSS ITS OVERLOADS.
 *
 * A conditional type matching a single call signature recovers only the LAST
 * overload, which silently breaks the overloaded members: `NS.kill` is
 * `kill(pid: number)` and `kill(filename: string, host?, ...args)`, so the
 * naive form types `call("kill", pid)` as an error. Matching four call
 * signatures at once and unioning what they infer covers every overloaded
 * member in the NS surface. A member with ONE signature infers the same tuple
 * four times and the union collapses to it, so nothing is loosened for the
 * ordinary case — this is strictly a repair. */
type NsArgs<F> =
  F extends { (...a: infer A1): unknown; (...a: infer A2): unknown; (...a: infer A3): unknown; (...a: infer A4): unknown }
    ? A1 | A2 | A3 | A4
    : F extends { (...a: infer A1): unknown; (...a: infer A2): unknown; (...a: infer A3): unknown } ? A1 | A2 | A3
      : F extends { (...a: infer A1): unknown; (...a: infer A2): unknown } ? A1 | A2
        : F extends (...a: infer A1) => unknown ? A1 : never;

type NsResult<F> =
  F extends { (...a: never[]): infer R1; (...a: never[]): infer R2; (...a: never[]): infer R3; (...a: never[]): infer R4 }
    ? Awaited<R1 | R2 | R3 | R4>
    : F extends { (...a: never[]): infer R1; (...a: never[]): infer R2; (...a: never[]): infer R3 } ? Awaited<R1 | R2 | R3>
      : F extends { (...a: never[]): infer R1; (...a: never[]): infer R2 } ? Awaited<R1 | R2>
        : F extends (...a: never[]) => infer R1 ? Awaited<R1> : never;

/** Call one ns function by dotted path on a resident. Awaiting the result
 * flattens the engine's own promise, so `await nsp("hack", host)` is a number
 * exactly as `await ns.hack(host)` would be. */
export interface NsProxyLease {
  <P extends string, F = GetPath<NS, P>>(
    path: AutoPath<NS, P>,
    ...args: NsArgs<F>
  ): Promise<NsResult<F>>;

  /** Launch through this exact leased resident and publish the PID handover
   * before the engine may resume the compiled child. Only valid when `exec`
   * was included in the enclosing `guaranteeFit` declaration. */
  launchExec<T extends ScriptLaunch, R = void>(
    descriptor: T,
    script: string,
    host: string,
    options: RunOptions,
    bind?: (entity: ExecLaunchEntity<T, R>) => void,
  ): ExecLaunchEntity<T, R> | undefined;
}

/** The ordinary proxy call surface plus an atomic, resident-bound lease.
 *
 * `exec` normally routes through `nsMain`, because that bundle has already paid
 * for it. A lease is the deliberate exception: some APIs grant authority to
 * the CALLING PID, so a follow-up `exec` must run through that exact resident.
 * `guaranteeFit` prices the declared union before the callback begins and then
 * prevents any other proxy call or recycle from interleaving with it. */
export interface NsProxy extends NsProxyLease {
  guaranteeFit<T>(
    paths: readonly string[],
    use: (resident: NsProxyLease) => T | Promise<T>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Costs and retry
// ---------------------------------------------------------------------------

/** Headroom over the priced cost. The game compares DYNAMIC usage against the
 * allocation and kills the script on overrun, so an exact fit is a coin flip:
 * a rounding difference between our sum and the engine's is fatal. Half a
 * gigabyte is cheap next to losing the resident mid-call. */
const PRICE_MARGIN_GB = 0.5;

/** Conservative v3.0.1 fallback for a name the runtime cannot price: the
 * largest ordinary API cost is SF4-level-1 SingularityFn3, 5 * 16 = 80 GB. A
 * renamed API must not price as free — under-allocation kills the resident,
 * while this merely makes it respawn larger.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L82-L95 */
export const UNKNOWN_CALL_GB = 80;

/** Ceiling on what a resident will ASK for as it learns its working set. A
 * resident is standing RAM the batcher does not get, so the appetite has to
 * stop somewhere; past this, recycling is the cheaper trade. It bounds only
 * the ask — one call priced above it still raises the floor and places,
 * because that call cannot run any other way. */
export const MAX_ASK_GB = 64;

/** `exec` returns 0 for a transient condition as readily as a permanent one —
 * the target host can be momentarily full because a process has not been
 * reaped yet. So the retry is UNBOUNDED: the first attempts yield a bare
 * macrotask to win the reap race, then the delay escalates to a 1 s ceiling.
 * A resident that cannot exec means its reservation is violated; throwing
 * would trade a visible stall for a dead controller, so slowness is reported
 * instead — `proxy.slow` events and one tprint per incident.
 *
 * This stays true of a REFUSED EXEC specifically. `IMPOSSIBLE_AFTER_MS` below
 * is a bound on an unplaceable FLOOR — the fleet never offering a big enough
 * block — and deliberately does not apply once an adequate block has been
 * offered, because then RAM demonstrably is not the problem and the condition
 * really is transient (an unsynced resident script, a host mid-reap). */
const FAST_RETRIES = 10;
const RETRY_CEILING_MS = 1_000;
const SLOW_AFTER_MS = 1_000;
const SLOW_REEMIT_MS = [10_000, 60_000];
const SLOW_PERIOD_MS = 60_000;
const WARN_AFTER_MS = 30_000;
/** How long a placer may keep offering nothing, or too-small blocks, before
 * the FLOOR is declared impossible. Comfortably past `WARN_AFTER_MS`, so the
 * warning is still the first thing an operator sees, and past any plausible
 * burst of farm pressure: the fleet frees a hack block every weaken cycle, so
 * a minute of unbroken refusal is a structural answer rather than a busy
 * moment. It bounds the PLACEMENT only — see `FAST_RETRIES` for why a refused
 * `exec` is a different question and stays unbounded. */
const IMPOSSIBLE_AFTER_MS = 60_000;

/** How long a clean shutdown waits for the resident's own atExit before giving
 * up and re-execing anyway. The engine frees a dead process's RAM one tick
 * after the handler runs, so this is pure slack around a one-tick event. */
const EXIT_TIMEOUT_MS = 2_000;

export function nsResidentScript(): string {
  return "lib/ns-resident.js";
}

/** Telemetry escape hatch: this module has no `tel`, so the controller
 * installs a sink at boot (inside a TELEMETRY label, so a --perf build never
 * sets one) and clears it on dispose. Behaviour is identical either way. */
export type ProxyEventSink = (name: string, data: Record<string, unknown>) => void;
let proxyEventSink: ProxyEventSink | undefined;
export function setProxyEventSink(sink: ProxyEventSink | undefined): void {
  proxyEventSink = sink;
}
/** One tprint per (label, host, gb) incident; cleared when that exec succeeds. */
const warnedIncidents = new Set<string>();

/** Where a resident may run, how big it was allowed to be, and the lease that
 * keeps the farm off it. The controller supplies a broker-backed placer; until
 * it does, residents fall back to home, which is what the boot path needs
 * before anything is rooted.
 *
 * The placer is asked for a RANGE, not a size, and answers with what it
 * granted. That is what makes the resident track the fleet on its own: at cold
 * boot the only host is home's small reserve, and as n00dles and then
 * foodnstuff root, the next respawn is simply granted more. `minGb` is the
 * floor the pending call needs — a placement below it is worse than none,
 * because the resident would be killed mid-call for overrunning. */
export interface ProxyPlacement {
  host: string;
  /** Executable GB actually granted: base plus the budget the resident may spend. */
  gb: number;
  release(): void;
}
/** `label` names the resident that is ASKING. A placer which holds room back
 * for the residents that have yet to land needs it to tell itself apart from
 * its siblings — see `placeResident` in game/lib/controller.ts. */
export type ProxyPlacer = (minGb: number, preferredGb: number, label?: string) => ProxyPlacement | undefined;

export interface NsProxyOptions {
  /** Names this proxy in telemetry and in the warning it prints. */
  label: string;
  /** Budget to ask for. The placer may grant less (nothing is rooted yet) or
   * be asked for more (one call priced above it); neither is an error. */
  budgetGb: number;
  /** Required: there is no sensible default. Where a resident may stand is a
   * policy question, and every caller has an answer — see game/lib/proxies.ts. */
  place: ProxyPlacer;
}

export interface NsProxyHandle {
  /** The call surface. Hand THIS to feature code, not the handle. */
  readonly call: NsProxy;
  /** Swap in the broker once the controller has a heap to lease from. */
  setPlacer(place: ProxyPlacer): void;
  /** Current resident host, for telemetry and tests. */
  host(): string | undefined;
  /** Current resident pid, or undefined while none is running. A fleet-wide
   * kill sweep must spare it: killing a resident mid-call leaves the awaited
   * promise unresolved, which hangs the caller rather than stalling it. */
  pid(): number | undefined;
  /** Executable GB this resident currently holds: base plus granted budget,
   * or 0 before its first placement. */
  grantedGb(): number;
  /** Executable GB its next respawn will ask for. The arena reserves this so a
   * resident whose working set has outgrown its host has somewhere to grow
   * into; without it a grow-respawn spins on `proxy.slow` for ever once the
   * farm has packed the fleet. */
  wantedGb(): number;
  /** Kill the resident and release its placement. Idempotent. */
  free(): Promise<void>;
}

const nsMain = (): NS => {
  const held = nsMainGlobal().nsMain;
  if (!held) throw new Error("nsMain is not published; game/main.ts must set it before any proxy call");
  return held;
};

/** Price one dotted path. `getFunctionRamCost` is itself FREE (0 GB) and it
 * already folds in the singularity 16/4/1 multiplier, so this is correct at
 * every SF4 level and inside BN4 without the caller knowing which it is in.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507 */
export function priceCall(path: string): number {
  return priceOf(path).gb;
}

/** A price plus whether the runtime actually gave it.
 *
 * The distinction is load-bearing, and its absence wedged a whole run. A
 * GUESS may inform what a resident asks for, but it must never become a hard
 * floor: `UNKNOWN_CALL_GB` is 80, so two unpriceable paths in one
 * `guaranteeFit` union demanded a 162.1 GB contiguous block that no host in
 * the fleet could ever serve, `#respawn` refused every 65.6 GB grant it was
 * offered, and the controller behind it never ran again. The calls in question
 * really cost 0.05 and 1.3 GB.
 *
 * `getFunctionRamCost` throws for a name the runtime does not know — a renamed
 * API, the genuine case this fallback exists for — and also whenever
 * `nsMain()` is momentarily unpublished, which is transient and says nothing
 * about the call at all. Neither is evidence that the call is enormous. */
export function priceOf(path: string): { gb: number; known: boolean } {
  try {
    return { gb: nsMain().getFunctionRamCost(path), known: true };
  } catch {
    return { gb: UNKNOWN_CALL_GB, known: false };
  }
}

/** The largest budget a resident may DEMAND on the strength of a guessed
 * price. A real price above this still raises the floor -- that call cannot
 * run any other way -- but a guess has no such standing, so it is held to what
 * a resident can actually be granted. Under-allocating risks the engine
 * killing the resident mid-call, which is loud and recoverable; the
 * alternative is a silent permanent halt.
 *
 * In the same units as `#preferredGb` and `#respawn`'s `needGb`: the resident
 * BUDGET, exclusive of `RESIDENT_BASE_GB`, which `#respawn` adds on to form
 * `minGb`. Adding the base here too would demand a block 1.6 GB larger than
 * the ceiling the ask is bounded by, which is the one thing this must not do. */
const GUESSED_FLOOR_CEILING_GB = MAX_ASK_GB;

function resolvePath(ns: NS, path: string): (...args: unknown[]) => unknown {
  let current: unknown = ns;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") break;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "function") throw new Error(`ns.${path} is not a function`);
  // Captured UNBOUND, exactly as the engine hands it out: ns members are
  // closures over their own worker script, so the receiver is irrelevant and
  // memoising the function itself is what makes a repeat call free.
  return current as (...args: unknown[]) => unknown;
}

class Resident {
  readonly #label: string;
  #place: ProxyPlacer;
  /** What the placer granted this resident: what it may actually spend. */
  #budgetGb = 0;
  /** What to ask for. Only ever rises, when a call is priced above it. */
  #preferredGb: number;
  #ns: NS | undefined;
  #placement: ProxyPlacement | undefined;
  #paid = new Map<string, (...args: unknown[]) => unknown>();
  #paidGb = 0;
  #pid: number | undefined;
  #stop: (() => void) | undefined;
  #exited: Promise<void> | undefined;
  /** Serialises calls on this resident. Bitburner allows ONE Netscript call
   * per script at a time: while an awaited call holds `env.runningFn`, every
   * other call on the same `ns` throws CONCURRENCY ERROR. Synchronous calls
   * settle within their own turn, so for them this chain costs a microtask;
   * a long await deliberately holds the resident for its whole flight, which
   * is why minutes-long errands get a resident of their own. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: NsProxyOptions) {
    this.#label = options.label;
    this.#preferredGb = options.budgetGb;
    this.#place = options.place;
  }

  setPlacer(place: ProxyPlacer): void {
    this.#place = place;
  }

  host(): string | undefined {
    return this.#placement?.host;
  }

  pid(): number | undefined {
    return this.#pid;
  }

  grantedGb(): number {
    return this.#placement ? RESIDENT_BASE_GB + this.#budgetGb : 0;
  }

  wantedGb(): number {
    return RESIDENT_BASE_GB + this.#preferredGb;
  }

  call(path: string, args: unknown[]): Promise<unknown> {
    const turn = this.#tail.then(() => this.#invoke(path, args));
    // Keep the chain alive across a rejection: one failed call must not wedge
    // every later one behind an unhandled rejection.
    this.#tail = turn.catch(() => {});
    return turn;
  }

  guaranteeFit<T>(
    paths: readonly string[],
    use: (resident: NsProxyLease) => T | Promise<T>,
  ): Promise<T> {
    const turn = this.#tail.then(() => this.#guaranteeFit(paths, use));
    this.#tail = turn.catch(() => {});
    return turn;
  }

  /** Price a whole authority-sensitive sequence BEFORE its first call, then
   * expose only those prepaid members against this exact resident. Since the
   * callback itself occupies `#tail`, ordinary calls queue behind it rather
   * than filling the resident or forcing a recycle between its steps. */
  async #guaranteeFit<T>(
    paths: readonly string[],
    use: (resident: NsProxyLease) => T | Promise<T>,
  ): Promise<T> {
    const declared = [...new Set(paths)];
    if (declared.length === 0) throw new Error("nsp.guaranteeFit requires at least one declared path");
    const priced = new Map(declared.map((path) => [path, priceOf(path)]));
    const costs = new Map([...priced].map(([path, price]) => [path, price.gb]));
    const declaredGb = [...costs.values()].reduce((sum, cost) => sum + cost, 0);
    // THE ASK MUST COVER THE DEMAND. This union capped what it ASKED for at
    // MAX_ASK_GB while demanding the uncapped sum, so the arena reserved 65.6 GB
    // for a respawn that would accept nothing under 162.1 GB and the two could
    // never meet. A union is also where a guessed price does the most damage,
    // because `UNKNOWN_CALL_GB` is summed once PER unpriceable member: two
    // unknown names alone out-demand every host in an early fleet, and on
    // leg-bn4.1 that silently ended the run. A partly-guessed union is
    // therefore held to what a resident can actually be granted; a fully
    // priced one keeps its floor, however large, because those calls genuinely
    // cannot run in less -- and the ask below rises to match it.
    // Only the GUESSED part of the sum may be clamped away. The measured part
    // is evidence: a union of a real 80 GB SF4-level-1 singularity read and one
    // renamed name must still be granted the 80 GB, or the engine kills the
    // resident mid-call on a demand it could in fact have met.
    const knownGb = [...priced.values()].reduce((sum, price) => sum + (price.known ? price.gb : 0), 0);
    const anyGuessed = [...priced.values()].some((price) => !price.known);
    const floorGb = anyGuessed
      ? Math.max(
        knownGb + PRICE_MARGIN_GB,
        Math.min(declaredGb + PRICE_MARGIN_GB, GUESSED_FLOOR_CEILING_GB),
      )
      : declaredGb + PRICE_MARGIN_GB;
    const missingGb = declared.reduce(
      (sum, path) => sum + (this.#ns !== undefined && this.#paid.has(path) ? 0 : costs.get(path)!),
      0,
    );

    if (!this.#ns || this.#paidGb + missingGb > this.#budgetGb) {
      const reason = !this.#ns ? "cold" : declaredGb + PRICE_MARGIN_GB > this.#budgetGb ? "grow" : "full";
      if (this.#ns) {
        proxyEventSink?.("proxy.recycle", {
          label: this.#label,
          path: declared.join("+"),
          reason,
          paidGb: this.#paidGb,
        });
        const workingSetGb = this.#paidGb + missingGb + PRICE_MARGIN_GB;
        if (workingSetGb > this.#preferredGb) {
          this.#preferredGb = Math.min(workingSetGb, MAX_ASK_GB);
        }
      }
      // MAX_ASK_GB bounds appetite, not a floor this sequence cannot run
      // without: the arena reserves the ask, so an ask below the floor is a
      // reservation that can never satisfy the respawn it exists for.
      if (floorGb > this.#preferredGb) this.#preferredGb = floorGb;
      await this.#respawn(reason, floorGb);
    }

    // A placer may grant less than the preferred working set, but never less
    // than the declared union passed as `needGb` above.
    for (const path of declared) {
      if (this.#paid.has(path)) continue;
      this.#paid.set(path, resolvePath(this.#ns!, path));
      this.#paidGb += costs.get(path)!;
    }

    const allowed = new Set(declared);
    let memberFailed = false;
    const leased = (async (path: string, ...args: unknown[]) => {
      if (!allowed.has(path)) {
        throw new Error(`nsp.guaranteeFit call to undeclared ns.${path}`);
      }
      const fn = this.#paid.get(path);
      if (fn === undefined) throw new Error(`nsp.guaranteeFit did not pay for ns.${path}`);
      try {
        return await fn(...args);
      } catch (error) {
        memberFailed = true;
        throw error;
      }
    }) as NsProxyLease;
    leased.launchExec = <T extends ScriptLaunch, R = void>(
      descriptor: T,
      script: string,
      host: string,
      options: RunOptions,
      bind?: (entity: ExecLaunchEntity<T, R>) => void,
    ): ExecLaunchEntity<T, R> | undefined => {
      if (!allowed.has("exec")) {
        throw new Error("nsp.guaranteeFit launch requires declared ns.exec");
      }
      const fn = this.#paid.get("exec");
      if (fn === undefined) throw new Error("nsp.guaranteeFit did not pay for ns.exec");
      return launchExec(
        descriptor,
        () => {
          try {
            return fn(script, host, options) as number;
          } catch (error) {
            // Same poisoning rule as an ordinary leased call: a member that
            // THREW was a resident killed outside the proxy, and the cached
            // `#ns`/`#paid` bound to it must be cleared before the caller
            // retries — otherwise every later lease reuses the dead one.
            memberFailed = true;
            throw error;
          }
        },
        bind,
      );
    };
    try {
      return await use(leased);
    } catch (error) {
      // A call through a process killed outside the proxy may throw instead of
      // settling. Clear that exact resident before the caller retries its whole
      // authority sequence; otherwise the next lease would reuse a dead `ns`.
      // Callback errors and undeclared-path errors do not poison the resident.
      if (memberFailed) await this.#killProcess();
      throw error;
    }
  }

  async #invoke(path: string, args: unknown[]): Promise<unknown> {
    // `exec` is the one member main.js owns statically (1.3 GB, paid once).
    // Routing it through nsMain keeps it off every resident's budget, and home
    // is also the only host holding the TOR edge to `darkweb` — which is what
    // retires the dodger's `pinHost`.
    if (path === "exec") return (nsMain().exec as (...a: unknown[]) => unknown)(...args);

    const memo = this.#ns ? this.#paid.get(path) : undefined;
    if (memo) return memo(...args);

    const costGb = priceCall(path);
    // The floor this one call needs to survive. A call priced above the whole
    // budget is not a special case and needs no second "sized proxy" API — it
    // simply raises the floor, and the placer finds a host that fits. The
    // pre-SF4-level-3 singularity reads (48-80 GB) and destroyW0r1dD43m0n
    // arrive here and nowhere else.
    // One call raises BOTH the floor and the ask, so the arena reserves exactly
    // what the respawn will demand and the two can never disagree.
    const needGb = costGb + PRICE_MARGIN_GB;
    if (needGb > this.#preferredGb) this.#preferredGb = needGb;
    if (!this.#ns || this.#paidGb + costGb > this.#budgetGb) {
      const reason = !this.#ns ? "cold" : needGb > this.#budgetGb ? "grow" : "full";
      if (this.#ns) {
        proxyEventSink?.("proxy.recycle", { label: this.#label, path, reason, paidGb: this.#paidGb });
        // LEARN THE WORKING SET. A recycle means the members actually in use
        // did not fit together, and a fixed budget then thrashes: the memo is
        // cleared on every respawn, so a round-robin over N members that
        // overflow costs one process per call for ever. (The augmentation
        // sweep is exactly this — repReq, price, stats, prereq per candidate.)
        // The dodger bounded each step's working set by hand, with
        // `SteppedProbe`; the resident instead raises what it ASKS for to what
        // it was using, and the placer clamps that to what the fleet can
        // actually spare. So it converges on a size that stops recycling
        // wherever the RAM exists, and simply keeps recycling where it does
        // not — never worse than a fixed budget, and much better once the
        // fleet grows.
        const workingSetGb = this.#paidGb + costGb + PRICE_MARGIN_GB;
        if (workingSetGb > this.#preferredGb) {
          this.#preferredGb = Math.min(workingSetGb, MAX_ASK_GB);
        }
      }
      await this.#respawn(reason, needGb);
    }

    const fn = resolvePath(this.#ns!, path);
    this.#paid.set(path, fn);
    this.#paidGb += costGb;
    return fn(...args);
  }

  /** Kill the resident process and wait until the engine has actually returned
   * its RAM, WITHOUT giving up its placement. Without that wait the
   * immediately following exec races its own corpse for the host. */
  async #killProcess(): Promise<void> {
    const stop = this.#stop;
    const exited = this.#exited;
    this.#ns = undefined;
    this.#paid.clear();
    this.#paidGb = 0;
    this.#stop = undefined;
    this.#exited = undefined;
    this.#pid = undefined;
    if (!stop) return;
    stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited ?? Promise.resolve(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_TIMEOUT_MS); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Kill the resident and hand its host back. */
  free(): Promise<void> {
    // A recycle requested during `guaranteeFit` must wait for the authority
    // sequence to finish. Killing the resident between connectToSession and
    // exec would invalidate the PID-bound session the lease exists to protect.
    const turn = this.#tail.then(async () => {
      await this.#killProcess();
      this.#placement?.release();
      this.#placement = undefined;
    });
    this.#tail = turn.catch(() => {});
    return turn;
  }

  /** Exec one resident into an ALREADY-HELD placement and complete the
   * handshake. Returns its pid, or 0 if the engine refused. */
  async #launch(placement: ProxyPlacement): Promise<number> {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });

    const descriptor: ProxyLaunch = { kind: "ns-proxy", stop: stopped };
    const launch = launchExec<ProxyLaunch, NS>(
      descriptor,
      () => nsMain().exec(
        nsResidentScript(),
        placement.host,
        temporaryRunOptions({ ramOverride: placement.gb }),
      ),
    );
    if (launch === undefined) return 0;
    const ready = await waitExecReady(launch, (pid) => nsMain()["isRunning"](pid));
    if (ready.status === "gone") return 0;
    this.#ns = ready.value;
    this.#placement = placement;
    this.#pid = launch.pid;
    this.#budgetGb = placement.gb - RESIDENT_BASE_GB;
    this.#stop = stop;
    this.#exited = launch.exited.promise.then(() => {});
    return launch.pid;
  }

  /** Kill the resident and stand a new one up, retrying until it lands.
   *
   * ONE acquisition rule governs the whole loop: never let go of a reservation
   * without holding the next one. Releasing first permits the dispatcher to
   * consume the host before the replacement reserves it.
   *
   * So the held reservation is REUSED whenever it still fits and we are not
   * trying to grow, and otherwise the replacement is taken while the old one
   * is still keeping the dispatcher off. */
  async #respawn(reason: string, needGb: number): Promise<void> {
    const minGb = Math.round((RESIDENT_BASE_GB + needGb) * 100) / 100;
    const preferredGb = Math.round((RESIDENT_BASE_GB + this.#preferredGb) * 100) / 100;
    const startedAt = Date.now();
    let nextSlowAt = SLOW_AFTER_MS;
    let slowEmits = 0;
    let attempts = 0;
    let incident = "";
    /** Largest block the placer has actually offered this respawn. Zero while
     * it has offered nothing at all, which is ordinary fleet pressure rather
     * than an impossible demand. */
    let bestOfferGb = 0;

    for (;;) {
      attempts++;
      const held = this.#placement;
      const reusable = held !== undefined && minGb <= held.gb && preferredGb <= held.gb;
      const next = reusable ? held : this.#place(minGb, preferredGb, this.#label);

      if (next !== undefined && next.gb + 1e-9 >= minGb) {
        incident = `${this.#label}:${next.host}:${next.gb}`;
        await this.#killProcess();
        if (next !== held) {
          this.#placement = undefined;
          held?.release();
        }
        const pid = await this.#launch(next);
        if (pid !== 0) {
          if (slowEmits > 0) {
            proxyEventSink?.("proxy.recovered", {
              label: this.#label, host: next.host, gb: next.gb, attempts, waitMs: Date.now() - startedAt,
            });
          }
          warnedIncidents.delete(incident);
          proxyEventSink?.("proxy.spawn", { label: this.#label, host: next.host, gb: next.gb, reason, pid });
          return;
        }
        // The engine refused the exec. Hand the reservation back so the next
        // attempt sees the host's real free RAM instead of leaking one lease
        // per try.
        next.release();
        this.#placement = undefined;
      } else if (next !== undefined) {
        // A grant below the floor would be killed mid-call for overrunning.
        if (next.gb > bestOfferGb) bestOfferGb = next.gb;
        next.release();
        if (next === held) this.#placement = undefined;
        proxyEventSink?.("proxy.undersized", { label: this.#label, grantedGb: next.gb, minGb });
      }

      const waitMs = Date.now() - startedAt;
      // IMPOSSIBLE, NOT MERELY SLOW. A minute of unbroken refusal — whether the
      // placer offers nothing at all or keeps offering a block too small — is a
      // structural answer, not a busy moment: the farm frees a hack block every
      // weaken cycle. This loop had no other exit. Left unbounded it takes the whole
      // controller with it: `#tail` serializes every queued call behind the
      // respawn, so one impossible floor silently ends the run while the
      // engine keeps cycling and the workers keep earning. Fail loudly
      // instead; a call that throws is a fault a feature can report, and the
      // resident stays usable for everyone else.
      //
      // ONLY the floor. `incident` is assigned exactly when an adequate block
      // WAS obtained and the engine then refused the exec — a resident script
      // that is not synced yet, or a host mid-reap. RAM is not the answer
      // there, the error below would blame it anyway (`bestOfferGb` counts
      // undersized offers only), and `FAST_RETRIES` says that case must keep
      // retrying. So it is excluded.
      if (waitMs >= IMPOSSIBLE_AFTER_MS && incident === "") {
        proxyEventSink?.("proxy.impossible", {
          label: this.#label, minGb, bestOfferGb, preferredGb, attempts, waitMs,
        });
        throw new Error(
          `ns resident ${this.#label} needs ${minGb}GB and the fleet's best offer in`
          + ` ${Math.round(waitMs / 1000)}s was ${bestOfferGb}GB`,
        );
      }
      if (waitMs >= nextSlowAt) {
        proxyEventSink?.("proxy.slow", { label: this.#label, minGb, preferredGb, attempts, waitMs });
        slowEmits++;
        nextSlowAt = slowEmits <= SLOW_REEMIT_MS.length
          ? SLOW_REEMIT_MS[slowEmits - 1]
          : nextSlowAt + SLOW_PERIOD_MS;
      }
      // `incident` is assigned only after a placement is obtained. Name the
      // permanently unplaced case explicitly instead of suppressing its warning.
      const label = incident !== "" ? incident : `${this.#label}:unplaced:${minGb}`;
      if (waitMs >= WARN_AFTER_MS && !warnedIncidents.has(label)) {
        warnedIncidents.add(label);
        nsMain().tprint(
          incident !== ""
            ? `WARNING: ns resident ${this.#label} cannot exec (needs ${minGb}GB) — retrying; `
              + `is ${nsResidentScript()} synced, and is the RAM free?`
            : `WARNING: ns resident ${this.#label} cannot be PLACED at all (needs ${minGb}GB) — `
              + "retrying; no host in the fleet has that much free.",
        );
      }
      // Yield to the game's scheduler so a pending reap can free the RAM;
      // escalate once the fast window is spent so a long stall stays cheap,
      // but never sleep past the next report deadline.
      await realmSleep(
        attempts <= FAST_RETRIES
          ? 0
          : Math.min(
            50 * Math.pow(2, Math.min(attempts - FAST_RETRIES, 10)),
            RETRY_CEILING_MS,
            Math.max(1, nextSlowAt - waitMs),
          ),
      );
    }
  }
}

/** Create a proxy. The resident is spawned lazily, on the first call, so a
 * proxy may be constructed before anything is rooted and before the broker
 * exists — which is exactly the boot path's situation. */
export function createNsProxy(options: NsProxyOptions): NsProxyHandle {
  const resident = new Resident(options);
  const call = ((path: string, ...args: unknown[]) => resident.call(path, args)) as NsProxy;
  call.guaranteeFit = (paths, use) => resident.guaranteeFit(paths, use);
  return {
    call,
    setPlacer: (place) => resident.setPlacer(place),
    host: () => resident.host(),
    pid: () => resident.pid(),
    grantedGb: () => resident.grantedGb(),
    wantedGb: () => resident.wantedGb(),
    free: () => resident.free(),
  };
}
