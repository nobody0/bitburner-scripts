import type { Clock } from "../clock.ts";
import type { SimServer } from "../core/effects.ts";

/** The process table: pids, per-host RAM accounting, and atExit.
 *
 * Modelled on bitburner-src/src/NetscriptWorker.ts and killWorkerScript.ts
 * @ v3.0.1. Two properties matter and both are load-bearing for the dispatcher:
 *
 * 1. exec's bookkeeping is SYNCHRONOUS — the pid exists, RAM is deducted and
 *    ns.ps sees the process before exec returns. Only main() is deferred.
 * 2. kill runs atExit callbacks synchronously in the killer's stack, BEFORE
 *    the killed script's own rejection propagates, and frees RAM immediately.
 *    game/worker/worker.ts depends on exactly this: it registers atExit before
 *    awaiting its op, so a kill still reports the completion and releases the
 *    dispatcher's reservation. */

/** Bitburner's cancellation marker. game/start.ts and game/lib/dodge.ts both
 * sniff for a `pid` property to tell a kill apart from a real crash. */
export class ScriptDeath {
  readonly pid: number;
  readonly message: string;

  constructor(pid: number) {
    this.pid = pid;
    this.message = `script ${pid} was killed`;
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
    for (const process of [...this.#processes.values()]) {
      if (process.host !== host || process.pid === exceptPid) continue;
      this.#stop(process, true);
      killed++;
    }
    return killed;
  }

  /** prestigeWorkerScripts: kill every process on every host. */
  killAll(): number {
    let killed = 0;
    for (const process of [...this.#processes.values()]) {
      this.#stop(process, true);
      killed++;
    }
    return killed;
  }

  /** main() returned or threw: same teardown as a kill, minus the cancellation. */
  finish(pid: number): void {
    const process = this.#processes.get(pid);
    if (process) this.#stop(process, false);
  }

  /** stopAndCleanUpWorkerScript: cancel the pending delay, reject the script's
   * await, run atExit, then release RAM. */
  #stop(process: SimProcess, cancelled: boolean): void {
    if (process.killed) return;
    process.killed = true;

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

    const server = this.#servers.get(process.host);
    if (server) server.ramUsed = Math.max(0, Math.round((server.ramUsed - process.ramGb) * 100) / 100);
    this.#processes.delete(process.pid);
  }
}
