import type { SimProcess } from "./process.ts";
import type { SimServer } from "../core/effects.ts";
import type { DarknetSystem } from "../features/dnet.ts";

export interface DnetNsOptions {
  system: DarknetSystem;
  process: SimProcess;
  /** Suspend on the virtual clock, exactly as netscriptDelay does. Injected so
   *  this module does not reach into the ns host. */
  delay: (ms: number, functionName: string) => Promise<void>;
  /** Player charisma and intelligence, for the transcribed timing formula. */
  skills: () => { charisma: number; intelligence: number };
  /** The VIRTUAL clock. `populateLogs` back-fills from elapsed time, so reading
   *  the wall clock here would make log volume depend on how long the simulator
   *  itself took to run. */
  nowMs: () => number;
  /** The B00ts of Perseus multiplies authentication time by 0.8. */
  hasBoots: () => boolean;
  /** activeSourceFileLvl(15) — the auth discount is gated on > 2, not on 2. */
  sf15Level: () => number;
  servers: Map<string, SimServer>;
}

/** v3.0.1 `src/NetscriptFunctions/Darknet.ts`, restricted to the members the
 * controller and its agents actually call. Everything else is absent, so the
 * root namespace's unknown-member proxy reports it and throws rather than
 * answering.
 *
 * The access gate is faithful and load-bearing: 19 of the 22 real members call
 * `expectDarknetAccess`, which throws *"You do not have access to the dnet
 * api"*. Without that, buying DarkscapeNavigator.exe would have no observable
 * effect and the purchase could not be tested at all.
 *
 * Deliberately still absent, and still throwing: `setStasisLink`,
 * `memoryReallocation`, `phishingAttack`, `induceServerMigration`,
 * `promoteStock`, `unleashStormSeed`, `labreport`, `labradar`. None is on the
 * deploy path, and while `setStasisLink` is unmodelled
 * `getStasisLinkedServers()` returning `[]` is LITERALLY TRUE rather than a
 * stub — which is the difference between a gap and a fabrication. */
export function makeDnet(options: DnetNsOptions): Record<string, unknown> {
  const { system, process, delay, skills, hasBoots, sf15Level, servers } = options;

  const requireAccess = (): void => {
    if (system.hasAccess()) return;
    throw new Error(
      'You do not have access to the dnet api. Purchase "DarkscapeNavigator.exe" through your TOR router to unlock it.',
    );
  };

  /** Response codes, from DarkNet/Enums.ts. */
  const OK = 200;
  const DIRECT_CONNECTION_REQUIRED = 351;
  const AUTH_FAILURE = 401;
  const NOT_ENOUGH_CHARISMA = 451;
  const SERVICE_UNAVAILABLE = 503;

  /** `calculateAuthenticationTime`, transcribed.
   *
   * The `2G_cellular` term is included from the start and is not optional: it is
   * the only leak a timing attack can climb, and omitting it would not fail
   * loudly — a strategy would measure a flat curve and conclude the model is
   * uncrackable, which is precisely the "blends measured and invented behaviour"
   * failure AGENTS.md forbids.
   * Source: src/DarkNet/effects/effects.ts:60-89 */
  const authTimeMs = (hostname: string, threads: number, correctChars: number): number => {
    const host = system.record(hostname);
    if (!host) return 100;
    const { charisma, intelligence } = skills();
    const skillFactor = (5 * host.requiredCharismaSkill + (host.difficulty + 1) * 100) / (charisma + 150);
    const threadsFactor = 1 / (1 + 0.2 * (threads - 1));
    const underleveled = charisma <= host.requiredCharismaSkill && host.depth > 1
      ? 1.5 + (host.requiredCharismaSkill + 50) / (charisma + 50)
      : 1;
    const bootsFactor = hasBoots() ? 0.8 : 1;
    // The docs attribute the discount to SF15.2; the code tests level > 2.
    // Code wins.
    const sf15Factor = sf15Level() > 2 ? 0.8 : 1;
    const base = 850 * skillFactor * underleveled * bootsFactor * sf15Factor * threadsFactor;
    const intelligenceBonus = 1 + (Math.pow(intelligence, 0.8) * 0.25) / 600;
    return base / intelligenceBonus
      + (host.modelId === "2G_cellular" ? correctChars : 0) * 50 * threadsFactor;
  };

  /** `checkDarknetServer`, in upstream's exact check ORDER.
   *
   * The order is load-bearing and counter-intuitive: `requireDirectConnection`
   * is evaluated BEFORE the self/darkweb early-out, so the early-out skips the
   * admin-rights and session checks and NOT the connection check. That is why
   * `ns.exec` onto `darkweb` works only from `home`, which holds the TOR edge,
   * while `ns.scp` — which passes no connection requirement — works from
   * anywhere.
   * Source: src/DarkNet/effects/offlineServerHandling.ts:39-124 */
  const check = (
    hostname: string,
    opts: {
      requireAdminRights?: boolean;
      requireSession?: boolean;
      requireDirectConnection?: boolean;
      backdoorBypasses?: boolean;
      allowNonDarknet?: boolean;
    },
  ): { success: true; code: number } | { success: false; code: number; message: string } => {
    const server = servers.get(hostname);
    if (!server) {
      // Servers going offline is timing-sensitive and outside the player's
      // control, so upstream refuses rather than throwing here.
      return { success: false, code: SERVICE_UNAVAILABLE, message: "Service Unavailable" };
    }
    if (server.simKind !== "DarknetServer") {
      if (opts.allowNonDarknet) return { success: true, code: OK };
      throw new Error(`${hostname} is not a darknet server.`);
    }
    requireAccess();
    if (
      opts.requireDirectConnection
      && !system.isDirectConnected(process.host, hostname)
      && !(opts.backdoorBypasses && server.backdoorInstalled)
    ) {
      return { success: false, code: DIRECT_CONNECTION_REQUIRED, message: "Direct Connection Required" };
    }
    // "We always are authed to ourselves and DarkWeb. Early-out past the last
    // checks." — and note what it does NOT skip, above.
    if (process.host === hostname || hostname === "darkweb") return { success: true, code: OK };
    if (opts.requireAdminRights && !server.hasAdminRights) {
      return { success: false, code: AUTH_FAILURE, message: "Unauthorized" };
    }
    if (opts.requireSession && !system.isAuthenticated(hostname, process.pid, process.host)) {
      return { success: false, code: AUTH_FAILURE, message: "Unauthorized" };
    }
    return { success: true, code: OK };
  };

  return {
    // Not access-gated upstream — it just cannot see anything until a darknet
    // exists. Source: NetscriptFunctions/Darknet.ts:314.
    probe: (returnByIP?: unknown): string[] => {
      const names = system.probeFrom(process.host);
      // Upstream shuffles this "to avoid clues to the network structure".
      // We do NOT: lodash's shuffle consumes a variable number of draws, and
      // taking those from the shared stream would let topology perturb stock
      // prices. Declared in DNET_ASSUMPTIONS.
      if (returnByIP !== true) return names;
      return names.map((name) => servers.get(name)?.ip ?? name);
    },

    getServerDetails: (rawHost?: unknown) => {
      requireAccess();
      const hostname = rawHost === undefined ? process.host : String(rawHost);
      const record = system.record(hostname);
      if (!record) throw new Error(`${hostname} is not a darknet server.`);
      if (!record.online) {
        // Upstream answers with a DUMMY object rather than throwing, and the
        // only field that describes anything is isOnline.
        return {
          isConnectedToCurrentServer: false,
          hasSession: false,
          modelId: "",
          passwordHint: "",
          data: "",
          logTrafficInterval: -1,
          passwordLength: -1,
          passwordFormat: "numeric",
          blockedRam: 0,
          difficulty: 0,
          depth: -1,
          requiredCharismaSkill: 0,
          isStationary: false,
          isOnline: false,
        };
      }
      return {
        isConnectedToCurrentServer: system.isDirectConnected(process.host, hostname),
        hasSession: system.isAuthenticated(hostname, process.pid, process.host),
        modelId: record.modelId,
        passwordHint: record.passwordHint,
        data: record.data,
        logTrafficInterval: record.logTrafficInterval,
        passwordLength: record.passwordLength,
        passwordFormat: record.passwordFormat,
        blockedRam: record.blockedRam,
        difficulty: record.difficulty,
        depth: record.depth,
        requiredCharismaSkill: record.requiredCharismaSkill,
        isStationary: record.isStationary,
        isOnline: true,
      };
    },

    /** Grants a session to the CALLING PID and to nothing else. */
    authenticate: async (rawHost: unknown, rawPassword: unknown, rawExtra?: unknown) => {
      const hostname = String(rawHost);
      const password = String(rawPassword);
      const additional = rawExtra === undefined ? 0 : Number(rawExtra);
      if (additional < 0) throw new Error(`authenticate: additionalMsec must be non-negative`);
      // No password is ever this long; upstream throws rather than letting a
      // buggy script build ever-longer attempts.
      if (password.length > 100) throw new Error(`authenticate: "password" is too long.`);

      const gate = check(hostname, { requireDirectConnection: true });
      if (!gate.success) {
        // Every failure path is a REAL 100ms delay upstream, not an immediate
        // resolve. Without it an agent polling a dead host spins at frame rate.
        await delay(100, "dnet.authenticate");
        return { success: false, code: gate.code, message: gate.message };
      }
      const correct = system.sharedChars(hostname, password);
      await delay(authTimeMs(hostname, process.threads, correct) + additional, "dnet.authenticate");

      // Re-check AFTER the delay: a host that moved or died mid-flight answers
      // 351 or 503, not 401. That is BN15's actual hazard, and the reason the
      // mutation clock has to be modelled for this to mean anything.
      const after = check(hostname, { requireDirectConnection: true });
      if (!after.success) return { success: false, code: after.code, message: after.message };

      const verdict = system.checkPassword(hostname, password);
      system.logAttempt(hostname, password, verdict.ok ? OK : AUTH_FAILURE, verdict.message, verdict.data, options.nowMs());
      if (!verdict.ok) return { success: false, code: AUTH_FAILURE, message: "Unauthorized" };
      system.addSession(hostname, process.pid);
      return { success: true, code: OK, message: "Success" };
    },

    /** Re-open a session at ANY distance, with the password.
     *
     * 0.05 GB, no delay, and no direct-connection requirement — it needs only
     * that the host is already rooted, which `authenticate` did once. That is
     * what makes the darknet's spawn chain affordable: a session belongs to the
     * PID that won it and `spawn` ends the PID, so every link that needs one
     * would otherwise have to pay 0.4 GB and seconds of `authenticate` again.
     * Source: src/NetscriptFunctions/Darknet.ts:179-215 */
    connectToSession: (rawHost: unknown, rawPassword: unknown) => {
      const hostname = String(rawHost);
      const password = String(rawPassword);
      if (password.length > 100) throw new Error(`connectToSession: "password" is too long.`);
      const gate = check(hostname, { requireAdminRights: true });
      if (!gate.success) return { success: false, code: gate.code, message: gate.message };
      const record = system.record(hostname);
      if (!record || record.password !== password) {
        return { success: false, code: AUTH_FAILURE, message: "Unauthorized" };
      }
      system.addSession(hostname, process.pid);
      return { success: true, code: OK, message: "Success" };
    },

    /** Scrape the log ring. Needs a direct connection and charisma, but NO
     * session — which is what lets a 2.55 GB surveyor do it. */
    heartbleed: async (rawHost: unknown, rawOptions?: unknown) => {
      const hostname = rawHost === undefined ? process.host : String(rawHost);
      const opts = (rawOptions ?? {}) as { peek?: boolean; logsToCapture?: number; additionalMsec?: number };
      const peek = opts.peek === true;
      const count = opts.logsToCapture === undefined ? 1 : Number(opts.logsToCapture);
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`heartbleed: "options.logsToCapture" must be a positive integer`);
      }
      const gate = check(hostname, { requireDirectConnection: true });
      if (!gate.success) {
        await delay(100, "dnet.heartbleed");
        return { success: false, code: gate.code, message: gate.message, logs: [] };
      }
      const record = system.record(hostname);
      if (record && skills().charisma < record.requiredCharismaSkill) {
        await delay(100, "dnet.heartbleed");
        return { success: false, code: NOT_ENOUGH_CHARISMA, message: "Not Enough Charisma", logs: [] };
      }
      // Formulas.ts:492-498 — heartbleed time is authentication time x 1.5.
      await delay(authTimeMs(hostname, process.threads, 0) * 1.5 + (opts.additionalMsec ?? 0), "dnet.heartbleed");
      const after = check(hostname, { requireDirectConnection: true });
      if (!after.success) return { success: false, code: after.code, message: after.message, logs: [] };
      return {
        success: true,
        code: OK,
        message: "Success",
        logs: system.captureLogs(hostname, count, peek, options.nowMs()),
      };
    },

    /** The map's own clock, 0 GB. A bare promise, not a per-process timer: it is
     * not cancellable and two waiters both wake, both of which an agent parked
     * on it depends on. */
    nextMutation: (): Promise<void> => {
      requireAccess();
      return system.nextMutation();
    },

    getDepth: (rawHost?: unknown): number => {
      requireAccess();
      const record = system.record(rawHost === undefined ? process.host : String(rawHost));
      return record?.online ? record.depth : -1;
    },

    getBlockedRam: (rawHost?: unknown): number => {
      requireAccess();
      const record = system.record(rawHost === undefined ? process.host : String(rawHost));
      return record?.online ? record.blockedRam : 0;
    },

    getServerRequiredCharismaLevel: (rawHost?: unknown): number => {
      requireAccess();
      const record = system.record(rawHost === undefined ? process.host : String(rawHost));
      return record?.online ? record.requiredCharismaSkill : -1;
    },

    // The one member with NO access gate and no checkDarknetServer at all —
    // pure `instanceof` upstream.
    isDarknetServer: (rawHost?: unknown): boolean => {
      const hostname = rawHost === undefined ? process.host : String(rawHost);
      return servers.get(hostname)?.simKind === "DarknetServer";
    },

    getStasisLinkLimit: (): number => system.stasisLinkLimit(),

    getStasisLinkedServers: (): string[] => {
      requireAccess();
      return system.stasisLinkedServers();
    },

    getDarknetInstability: () => {
      requireAccess();
      return system.instability();
    },

    openCache: (rawFilename: unknown, _suppressToast?: unknown) => {
      requireAccess();
      // Upstream opens a cache on the CURRENT server only — the filename is a
      // local path, not a host-qualified one.
      return system.openCache(process.host, String(rawFilename));
    },
  };
}

/** The gate `scp` and `exec` need, exported so `api.ts` applies the same rules
 * the dnet namespace does rather than a second copy of them. */
export function darknetGate(
  system: DarknetSystem,
  servers: Map<string, SimServer>,
  process: SimProcess,
  hostname: string,
  opts: { requireDirectConnection?: boolean; backdoorBypasses?: boolean },
): { allowed: boolean; code: number } {
  const server = servers.get(hostname);
  if (!server) return { allowed: false, code: 503 };
  // Ordinary servers are unaffected: upstream returns success before any of the
  // darknet checks when allowNonDarknet is set, and ProcessTable.start still
  // enforces admin rights the usual way.
  if (server.simKind !== "DarknetServer") return { allowed: true, code: 200 };
  // Upstream's `expectDarknetAccess` THROWS rather than refusing, and it throws
  // from inside exec/scp — so a script that reaches a darknet host without
  // access dies there. Refusing quietly would let a BitNode without SF15 look
  // like one where the darknet is merely full.
  if (!system.hasAccess()) {
    throw new Error(
      'You do not have access to the dnet api. Purchase "DarkscapeNavigator.exe" through your TOR router to unlock it.',
    );
  }
  if (
    opts.requireDirectConnection
    && !system.isDirectConnected(process.host, hostname)
    && !(opts.backdoorBypasses && server.backdoorInstalled)
  ) {
    return { allowed: false, code: 351 };
  }
  if (process.host === hostname || hostname === "darkweb") return { allowed: true, code: 200 };
  if (!server.hasAdminRights) return { allowed: false, code: 401 };
  if (!system.isAuthenticated(hostname, process.pid, process.host)) return { allowed: false, code: 401 };
  return { allowed: true, code: 200 };
}
