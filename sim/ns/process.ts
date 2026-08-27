import type { Clock } from "../clock.ts";
import type { SimServer } from "../core/effects.ts";

/** The process table: pids, per-host RAM accounting, and atExit.
 *
 * Modelled on bitburner-src/src/NetscriptWorker.ts and killWorkerScript.ts
 * @ v3.0.1. Three properties matter and each is load-bearing for a consumer:
 *
 * 1. exec's bookkeeping is SYNCHRONOUS — the pid exists, RAM is deducted and
 *    ns.ps sees the process before exec returns. Only main() is deferred.
 * 2. kill runs atExit callbacks synchronously in the killer's stack, BEFORE
 *    the killed script's own rejection propagates. game/worker/worker.ts
 *    depends on exactly this: it registers atExit before awaiting its op, so a
 *    kill still reports the completion and releases the dispatcher's
 *    reservation.
 * 3. During those callbacks the process is still ALIVE to ns — the lock is
 *    released, `killed` not yet set — and an ns.spawn there finalizes the
 *    teardown re-entrantly so its spawnDelay:0 launch fits in the freed RAM.
 *    game/dnet/agent.ts's atExit-respawn hook depends on exactly this;
 *    sim/tests/process-atexit.test.ts pins it against the engine. */

/** Bitburner's cancellation marker: a named Error with the killed pid. */
export class ScriptDeath extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`script ${pid} was killed`);
    this.name = "ScriptDeath";
    this.pid = pid;
  }
}

export interface SimProcess {
  pid: number;
  filename: string;
  host: string;
  args: (string | number | boolean)[];
  threads: number;
  temporary: boolean;
  /** Total RAM held on the host (ramOverride is per THREAD, like the game). */
  ramGb: number;
  atExit: Map<string, () => void>;
  killed: boolean;
  /** True while #stop is running this process's atExit handlers. The engine's
   * equivalent window is stopFlag still false with runningFn cleared: every ns
   * function is callable, and a re-entrant kill (ns.spawn's kill-the-caller)
   * must finalize the teardown — free the RAM — so the spawnDelay:0 launch that
   * follows it fits. */
  stopping?: boolean;
  /** Running-script accounting used by getTotalScriptIncome/ExpGain. The game
   * reports each live script's lifetime average, not a global historical
   * average. */
  onlineMoneyMade: number;
  onlineExpGained: number;
  onlineRunningTimeSeconds: number;
  parentPid?: number;
  /** Clock id of the netscriptDelay this process is currently blocked in. */
  delay?: number;
  delayReject?: (err: unknown) => void;
  /** Netscript function currently suspended in netscriptDelay. */
  runningFn?: string;
}

export interface ProcessInfo {
  filename: string;
  threads: number;
  args: (string | number | boolean)[];
  pid: number;
  temporary: boolean;
}

export interface StartSpec {
  filename: string;
  host: string;
  args: (string | number | boolean)[];
  threads: number;
  ramPerThreadGb: number;
  temporary: boolean;
  parentPid?: number;
}

export class ProcessTable {
  readonly #processes = new Map<number, SimProcess>();
  readonly #servers: Map<string, SimServer>;
  readonly #clock: Clock;
  #nextPid = 1;

  constructor(servers: Map<string, SimServer>, clock: Clock) {
    this.#servers = servers;
    this.#clock = clock;
  }

  get size(): number {
    return this.#processes.size;
  }

  get(pid: number): SimProcess | undefined {
    return this.#processes.get(pid);
  }

  /** Reserve RAM and register the process. Returns undefined when the host is
   * unknown or out of RAM — the caller turns that into exec's `0` pid. */
  start(spec: StartSpec): SimProcess | undefined {
    const server = this.#servers.get(spec.host);
    if (!server?.hasAdminRights) return undefined;
    const ramGb = spec.ramPerThreadGb * spec.threads;
    // roundToTwo, as the game does, so float drift cannot make a host look full.
    const used = Math.round((server.ramUsed + ramGb) * 100) / 100;
    if (used > server.maxRam) return undefined;
    server.ramUsed = used;

    const process: SimProcess = {
      pid: this.#nextPid++,
      filename: spec.filename,
      host: spec.host,
      args: spec.args,
      threads: spec.threads,
      temporary: spec.temporary,
      ramGb,
      atExit: new Map(),
      killed: false,
      onlineMoneyMade: 0,
      onlineExpGained: 0,
      onlineRunningTimeSeconds: 0.01,
      ...(spec.parentPid !== undefined ? { parentPid: spec.parentPid } : {}),
    };
    this.#processes.set(process.pid, process);
    return process;
  }

  ps(host: string): ProcessInfo[] {
    const out: ProcessInfo[] = [];
    for (const process of this.#processes.values()) {
      if (process.host !== host) continue;
      out.push({
        filename: process.filename,
        threads: process.threads,
        args: [...process.args],
        pid: process.pid,
        temporary: process.temporary,
      });
    }
    return out;
  }

  kill(pid: number): boolean {
    const process = this.#processes.get(pid);
    if (!process) return false;
    this.#stop(process, true);
    return true;
  }

  killall(host: string, exceptPid?: number): number {
    let killed = 0;
    // Upstream killServerScripts iterates the live running-script maps. Keep
    // this live too: an atExit callback that inserts another process must be
    // observable to the same teardown, which is the restart-loop hazard the
    // agent lifecycle is designed around.
    for (const process of this.#processes.values()) {
      if (process.host !== host || process.pid === exceptPid) continue;
      this.#stop(process, true);
      killed++;
    }
    return killed;
  }

  values(): IterableIterator<SimProcess> {
    return this.#processes.values();
  }

  /** Prestige.resetPidCounter. Safe only after every process has been killed. */
  resetPidCounter(): void {
    if (this.#processes.size !== 0) throw new Error("cannot reset pid counter while scripts are running");
    this.#nextPid = 1;
  }

  /** updateOnlineScriptTimes, called from the 200 ms engine cycle. */
  updateOnlineTimes(cycles: number): void {
    const seconds = cycles * 0.2;
    for (const process of this.#processes.values()) process.onlineRunningTimeSeconds += seconds;
  }

  /** prestigeWorkerScripts: kill every process on every host. The harness's
   * terminal teardown may pass false because no script continuation will be
   * observed after the virtual realm is dismantled. */
  killAll(cancelled = true): number {
    let killed = 0;
    // Sweep in ROUNDS: each round snapshots the table (preserving the
    // upstream one-pass kill order), and a process an atExit handler started
    // mid-teardown (worker respawn chains, dnet handoffs) is caught by the
    // next round. A single snapshot left such a late arrival alive — prestige
    // then threw on resetPidCounter, the install callback never relaunched,
    // and the run sat dead to the horizon. Measured on bn1-speedrun seed 2.
    while (this.#processes.size > 0) {
      if (killed > 100_000) throw new Error("killAll cannot drain: atExit handlers keep spawning processes");
      for (const process of [...this.#processes.values()]) {
        this.#stop(process, cancelled);
        killed++;
      }
    }
    return killed;
  }

  /** main() returned or threw: same teardown as a kill, minus the cancellation. */
  finish(pid: number): void {
    const process = this.#processes.get(pid);
    if (process) this.#stop(process, false);
  }

  /** stopAndCleanUpWorkerScript: cancel the pending delay, reject the script's
   * await, run atExit, then release RAM.
   *
   * The ORDER mirrors the engine and every clause is load-bearing:
   * - The delay lock (`runningFn`) is cleared and `killed` stays FALSE while the
   *   atExit handlers run, so ns is fully callable inside them — the engine sets
   *   `runningFn = ""` before the callback loop and `stopFlag = true` after it.
   * - A handler that calls ns.spawn re-enters kill; the `stopping` branch
   *   finalizes the teardown there and then, freeing this process's RAM so the
   *   spawnDelay:0 launch that follows fits in the vacated allocation — the
   *   engine's `if (ws.stopFlag) return` fall-through does the same.
   * - #stop is fully synchronous, so the ScriptDeath rejection of a cancelled
   *   await (a microtask) is always delivered AFTER the atExit handlers ran. */
  #stop(process: SimProcess, cancelled: boolean): void {
    if (process.killed) return;
    if (process.stopping) {
      // Re-entrant kill from inside an atExit handler (ns.spawn kills its own
      // caller). Finalize now; the outer #stop's trailing #finalize no-ops.
      this.#finalize(process);
      return;
    }
    process.stopping = true;

    if (process.delay !== undefined) {
      this.#clock.cancel(process.delay);
      process.delay = undefined;
    }
    if (cancelled) process.delayReject?.(new ScriptDeath(process.pid));
    process.delayReject = undefined;
    process.runningFn = undefined;

    // Cleared before iterating: calling exit from inside atExit would recurse.
    const handlers = [...process.atExit.values()];
    process.atExit.clear();
    for (const handler of handlers) {
      try {
        handler();
      } catch {
        /* an atExit that throws must not strand the RAM */
      }
    }

    this.#finalize(process);
  }

  /** The idempotent tail of a teardown: mark dead, settle earnings, free RAM,
   * drop from the table. Reached once per process — either from #stop's tail or
   * early via a re-entrant kill out of an atExit handler. */
  #finalize(process: SimProcess): void {
    if (process.killed) return;
    process.killed = true;

    // NetscriptWorker transfers a terminating child's earnings to its live
    // parent, including when the child was killed.
    const parent = process.parentPid === undefined ? undefined : this.#processes.get(process.parentPid);
    if (parent && !parent.killed) {
      parent.onlineMoneyMade += process.onlineMoneyMade;
      parent.onlineExpGained += process.onlineExpGained;
    }

    const server = this.#servers.get(process.host);
    if (server) server.ramUsed = Math.max(0, Math.round((server.ramUsed - process.ramGb) * 100) / 100);
    this.#processes.delete(process.pid);
  }
}
