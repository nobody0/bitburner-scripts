import type { NS } from "@ns";
import { handoffLaunch, temporaryRunOptions } from "./launch-shared.ts";
import { nsMainGlobal, type ProxyLaunch } from "./ns-proxy-shared.ts";
import { RESIDENT_BASE_GB } from "../../shared/ram/broker.ts";
import { realmSleep } from "./wake.ts";

/** The ns proxy: a RAM dodge you can call like a function.
 *
 * Bitburner charges a script's RAM by the ns members its SOURCE references,
 * and it charges by member NAME across the whole bundle regardless of the
 * receiver — a local called `exec`, even `RegExp.prototype.exec`, bills the
 * full 1.3 GB (see game/dnet/attempt.ts). start.js is one bundle holding the
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
export type NsProxy = <P extends string, F = GetPath<NS, P>>(
  path: AutoPath<NS, P>,
  ...args: NsArgs<F>
) => Promise<NsResult<F>>;

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
const MAX_BUDGET_GB = 64;

/** `exec` returns 0 for a transient condition as readily as a permanent one —
 * the target host can be momentarily full because a process has not been
 * reaped yet. So the retry is UNBOUNDED: the first attempts yield a bare
 * macrotask to win the reap race, then the delay escalates to a 1 s ceiling.
 * A resident that cannot exec means its reservation is violated; throwing
 * would trade a visible stall for a dead controller, so slowness is reported
 * instead — `proxy.slow` events and one tprint per incident. */
const FAST_RETRIES = 10;
const RETRY_CEILING_MS = 1_000;
const SLOW_AFTER_MS = 1_000;
const SLOW_REEMIT_MS = [10_000, 60_000];
const SLOW_PERIOD_MS = 60_000;
const WARN_AFTER_MS = 30_000;

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
export type ProxyPlacer = (minGb: number, preferredGb: number) => ProxyPlacement | undefined;

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
  if (!held) throw new Error("nsMain is not published; game/start.ts must set it before any proxy call");
  return held;
};

/** Price one dotted path. `getFunctionRamCost` is itself FREE (0 GB) and it
 * already folds in the singularity 16/4/1 multiplier, so this is correct at
 * every SF4 level and inside BN4 without the caller knowing which it is in.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507 */
export function priceCall(path: string): number {
  try {
    return nsMain().getFunctionRamCost(path);
  } catch {
    return UNKNOWN_CALL_GB;
  }
}

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

  async #invoke(path: string, args: unknown[]): Promise<unknown> {
    // `exec` is the one member start.js owns statically (1.3 GB, paid once).
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
          this.#preferredGb = Math.min(workingSetGb, MAX_BUDGET_GB);
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
  async free(): Promise<void> {
    await this.#killProcess();
    this.#placement?.release();
    this.#placement = undefined;
  }

  /** Exec one resident into an ALREADY-HELD placement and complete the
   * handshake. Returns its pid, or 0 if the engine refused. */
  async #launch(placement: ProxyPlacement): Promise<number> {
    let published!: (ns: NS) => void;
    // BOXED, never `resolve(ns)` directly — see the placement loop below.
    const ready = new Promise<{ ns: NS }>((resolve) => {
      published = (residentNs) => resolve({ ns: residentNs });
    });
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    let gone!: () => void;
    const exited = new Promise<void>((resolve) => { gone = resolve; });

    const descriptor: ProxyLaunch = { kind: "ns-proxy", publish: published, stop: stopped, gone };
    const pid = await handoffLaunch(
      descriptor,
      (launchId) => nsMain().exec(
        nsResidentScript(),
        placement.host,
        temporaryRunOptions({ ramOverride: placement.gb }),
        launchId,
      ),
    );
    if (pid === 0) return 0;
    this.#ns = (await ready).ns;
    this.#placement = placement;
    this.#pid = pid;
    this.#budgetGb = placement.gb - RESIDENT_BASE_GB;
    this.#stop = stop;
    this.#exited = exited;
    return pid;
  }

  /** Kill the resident and stand a new one up, retrying until it lands.
   *
   * ONE acquisition rule governs the whole loop: never let go of a reservation
   * without holding the next one. A respawn that released its placement and
   * then asked for one again lost the race to the dispatcher, which packed the
   * host in between — measured on a live run, the main resident ended up back
   * on home permanently while foodnstuff read as 0 free. Recycles are
   * frequent, so that race is not rare.
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

    for (;;) {
      attempts++;
      const held = this.#placement;
      const reusable = held !== undefined && minGb <= held.gb && preferredGb <= held.gb;
      const next = reusable ? held : this.#place(minGb, preferredGb);

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
        next.release();
        if (next === held) this.#placement = undefined;
        proxyEventSink?.("proxy.undersized", { label: this.#label, grantedGb: next.gb, minGb });
      }

      const waitMs = Date.now() - startedAt;
      if (waitMs >= nextSlowAt) {
        proxyEventSink?.("proxy.slow", { label: this.#label, minGb, preferredGb, attempts, waitMs });
        slowEmits++;
        nextSlowAt = slowEmits <= SLOW_REEMIT_MS.length
          ? SLOW_REEMIT_MS[slowEmits - 1]
          : nextSlowAt + SLOW_PERIOD_MS;
      }
      if (waitMs >= WARN_AFTER_MS && incident !== "" && !warnedIncidents.has(incident)) {
        warnedIncidents.add(incident);
        nsMain().tprint(
          `WARNING: ns resident ${this.#label} cannot exec (needs ${minGb}GB) — retrying; ` +
            `is ${nsResidentScript()} synced, and is the RAM free?`,
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
