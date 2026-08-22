import type { SimProcess } from "./process.ts";
import type { SimServer } from "../core/effects.ts";
import {
  promoteStockCharges,
  promoteStockCharismaExp,
  promoteStockWaitMs,
  type DarknetSystem,
} from "../features/dnet.ts";
import { phishWaitMs, reclaimWaitMs, stasisWaitMs } from "../../shared/strategy/dnet/rates.ts";
import { SymbolToStockMap } from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import { Stock } from "../vendor/bitburner/src/StockMarket/Stock.ts";

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
  /** `Player.mults.charisma_exp`, and `Player.gainCharismaExp` — which adds raw
   *  experience and recomputes the skill. Only `promoteStock` needs them; every
   *  other member reads charisma through `skills()`. */
  charismaExpMult: () => number;
  gainCharismaExp: (amount: number) => void;
}

/** Exact formula surface shared by authenticate and ns.formulas.dnet. */
export function calculateDnetAuthenticateTime(
  options: Pick<DnetNsOptions, "system" | "skills" | "hasBoots" | "sf15Level">,
  details: {
    modelId: string;
    difficulty: number;
    depth: number;
    requiredCharismaSkill: number;
  },
  threads = 1,
  correctChars = 0,
): number {
  const { charisma, intelligence } = options.skills();
  const skillFactor = (5 * details.requiredCharismaSkill + (details.difficulty + 1) * 100) / (charisma + 150);
  const threadsFactor = 1 / (1 + 0.2 * (threads - 1));
  const underleveled = charisma <= details.requiredCharismaSkill && details.depth > 1
    ? 1.5 + (details.requiredCharismaSkill + 50) / (charisma + 50)
    : 1;
  const bootsFactor = options.hasBoots() ? 0.8 : 1;
  const backdoorFactor = options.system.instability().authenticationDurationMultiplier;
  const sf15Factor = options.sf15Level() > 2 ? 0.8 : 1;
  const base = 850 * skillFactor * backdoorFactor * underleveled * bootsFactor * sf15Factor * threadsFactor;
  const intelligenceBonus = 1 + (Math.pow(intelligence, 0.8) * 0.25) / 600;
  return base / intelligenceBonus
    + (details.modelId === "2G_cellular" ? correctChars : 0) * 50 * threadsFactor;
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
 * Deliberately still absent, and still throwing: `labreport` — it answers the
 * same walls the free render already carries, and nothing deploys it.
 * `labradar` IS modelled, because the walker pays for one whenever a single
 * render can decide the exit or scout a seam's door candidates.
 * `unleashStormSeed` left that list the day the storm became the deploy path's
 * cache engine — modelled rather than the rule relaxed, exactly as the
 * enforcing test's comment prescribes.
 *
 * `setStasisLink` IS modelled, and modelling it is what makes
 * `getStasisLinkedServers()` a reading rather than a constant: the link pins the
 * calling host against move, delete and restart, so it changes the pool every
 * mutation branch draws from. */
export function makeDnet(options: DnetNsOptions): Record<string, unknown> {
  const { system, process, delay, skills, servers } = options;

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
  const REQUEST_TIMEOUT = 408;
  const NOT_ENOUGH_CHARISMA = 451;
  const NO_BLOCK_RAM = 454;
  const SERVICE_UNAVAILABLE = 503;

  /** `calculateAuthenticationTime`, shared with `formulas.dnet`. */
  const authTimeMs = (hostname: string, threads: number, correctChars: number): number => {
    const host = system.record(hostname);
    return host ? calculateDnetAuthenticateTime(options, host, threads, correctChars) : 100;
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
      // The delay upstream calls `networkDelay`, and it is not only a wait: it
      // is what the `2G_cellular` arm reports back as its `data`, so the same
      // number has to reach checkPassword.
      const networkDelay = authTimeMs(hostname, process.threads, correct) + additional;
      await delay(networkDelay, "dnet.authenticate");

      // Re-check AFTER the delay: a host that moved or died mid-flight answers
      // 351 or 503, not 401. That is BN15's actual hazard, and the reason the
      // mutation clock has to be modelled for this to mean anything.
      const after = check(hostname, { requireDirectConnection: true });
      if (!after.success) return { success: false, code: after.code, message: after.message };

      // The timeout roll sits exactly here upstream: AFTER the delay and BEFORE
      // the model is ever consulted, so a 408 writes no log line and teaches
      // nothing. It is exactly 0 until the run holds three backdoors, which is
      // why it was unreachable before they were modelled.
      if (system.timesOut()) {
        return { success: false, code: REQUEST_TIMEOUT, message: "Request Timeout" };
      }
      const verdict = system.checkPassword(hostname, password, networkDelay, process.pid);
      const code = verdict.code ?? (verdict.ok ? OK : AUTH_FAILURE);
      system.logAttempt(hostname, password, code, verdict, options.nowMs());
      // The exit's own grant, then the ordinary per-attempt one. BOTH, because
      // upstream's `getAuthResult` calls `handleSuccessfulAuth` after
      // `handleLabyrinthPassword` has already paid the 32-thread bonus — and by
      // then the lab is rooted, so the second grant is the fifth-rate one.
      if (verdict.charismaExp) options.gainCharismaExp(options.charismaExpMult() * verdict.charismaExp);
      // EVERY attempt pays charisma, failures included. Leaving this out made
      // iterative solving look like pure cost in the simulator while being the
      // feature's main early charisma source in the game.
      options.gainCharismaExp(
        options.charismaExpMult() * system.attemptCharismaExp(hostname, process.threads, verdict.ok),
      );
      if (!verdict.ok) {
        // Only the labyrinth's message and data are forwarded: every other
        // model answers a GENERIC failure and hides its response in the log
        // ring, which is the whole reason `attempt` carries `heartbleed`.
        return system.isLab(hostname)
          ? { success: false, code, message: verdict.message, data: verdict.data }
          : { success: false, code, message: "Unauthorized" };
      }
      system.addSession(hostname, process.pid);
      return system.isLab(hostname)
        ? { success: true, code: OK, message: verdict.message, data: verdict.data }
        : { success: true, code: OK, message: "Success" };
    },

    /** The labyrinth's paid eye: radius 3, player AND exit shown, one full
     * authentication delay, and NO charisma — upstream delays and renders
     * without ever reaching `getAuthResult`. Needs the current lab to exist
     * and a direct connection to it; both refusals are riddle-worded successes
     * of `false` with no code, exactly as upstream answers them.
     * Source: src/NetscriptFunctions/Darknet.ts:671-704 */
    labradar: async () => {
      requireAccess();
      const stage = system.currentLab();
      if (!stage || !system.record(stage.hostname)) {
        return { success: false, message: "You feel blind..." };
      }
      if (!system.isDirectConnected(process.host, stage.hostname)) {
        return { success: false, message: "You feel disconnected..." };
      }
      await delay(authTimeMs(stage.hostname, process.threads, 0), "dnet.labradar");
      return system.labRadar(process.pid);
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

    /** Takes NO host: it pins the CALLING script's own server.
     *
     * That signature is the whole reason spending a link needs a job standing
     * on the host being pinned — home can never spend one, however good a
     * candidate it has picked. `453 StasisLinkLimitReached` when the global
     * limit is already spent. */
    setStasisLink: async (rawShould?: unknown) => {
      requireAccess();
      const shouldLink = rawShould === undefined ? true : Boolean(rawShould);
      // `getSetStasisLinkDuration`, not a token wait: 30 s at charisma 0 down to
      // 3 s at 9000. It is half of what makes a pin expensive — the job costs
      // 12 GB AND holds its host — and a flat 100 ms reported pinning as free in
      // time while the game charges half a `JOB_TIMEOUT_MS` for it.
      await delay(stasisWaitMs(skills().charisma), "dnet.setStasisLink");
      const code = system.setStasisLink(process.host, shouldLink);
      return code === 200
        ? { success: true, code: OK, message: shouldLink ? "Stasis link applied" : "Stasis link removed" }
        : {
          success: false,
          code,
          message: code === 453 ? "Stasis link limit reached" : "Service Unavailable",
        };
    },

    /** Push a NEIGHBOUR toward a new position, one charge at a time.
     *
     * The only call in the feature that refuses its own host, and upstream
     * checks that AFTER the server check and BEFORE the six-second wait
     * (`Darknet.ts:412-443`). Six seconds is hardcoded: no skill shortens it,
     * which is what makes a migration a project of hundreds of calls.
     *
     * Both checks run twice, once before the wait and once after, and
     * `preventUseOnStationaryServers` is what stops darkweb and the labyrinth
     * being pushed at all. */
    induceServerMigration: async (rawHost: unknown) => {
      const hostname = String(rawHost);
      const gate = check(hostname, { requireDirectConnection: true });
      if (!gate.success) {
        await delay(100, "dnet.induceServerMigration");
        return { success: false, code: gate.code, message: gate.message };
      }
      const record = system.record(hostname);
      if (record?.isStationary === true) {
        throw new Error(`${hostname} is a stationary server and cannot be moved.`);
      }
      if (hostname === process.host) {
        await delay(100, "dnet.induceServerMigration");
        return {
          success: false,
          code: DIRECT_CONNECTION_REQUIRED,
          message: "Cannot induce migration on a script's own server."
            + " induceServerMigration must target a neighboring connected server.",
        };
      }
      await delay(6000, "dnet.induceServerMigration");
      const after = check(hostname, { requireDirectConnection: true });
      if (!after.success) return { success: false, code: after.code, message: after.message };
      const charged = system.chargeMigration(hostname, process.threads, skills().charisma);
      options.gainCharismaExp(options.charismaExpMult() * charged.charismaExp);
      return {
        success: true,
        code: OK,
        message: charged.deleted
          ? `${hostname} could not be placed and was removed from the network.`
          : `Migration prep is now at ${(charged.newCharge * 100).toFixed(2)}%.`,
      };
    },

    getDarknetInstability: () => {
      requireAccess();
      return system.instability();
    },

    /** Free RAM the server's owner is sitting on.
     *
     * The check options are `requireDirectConnection` AND `requireAdminRights`,
     * and the ORDER is what makes this the cheapest action in the feature: the
     * connection requirement is evaluated first, self is trivially directly
     * connected, and the self early-out then returns BEFORE the admin-rights
     * check is ever reached. So a resident grinds its own host's block open with
     * no credential at all, while the same call against a neighbour needs one.
     *
     * The block is re-checked twice, once before the wait and once after, and
     * the whole server check runs again after the wait too — a host that moved
     * or died mid-grind answers 351 or 503 rather than freeing anything.
     * Source: src/NetscriptFunctions/Darknet.ts:509-561 */
    memoryReallocation: async (rawHost?: unknown) => {
      const hostname = rawHost === undefined ? process.host : String(rawHost);
      const gate = check(hostname, { requireDirectConnection: true, requireAdminRights: true });
      if (!gate.success) {
        await delay(100, "dnet.memoryReallocation");
        return { success: false, code: gate.code, message: gate.message };
      }
      const before = system.record(hostname);
      if (!before || before.blockedRam <= 0) {
        await delay(100, "dnet.memoryReallocation");
        return { success: false, code: NO_BLOCK_RAM, message: "No Block RAM" };
      }
      await delay(reclaimWaitMs(skills().charisma), "dnet.memoryReallocation");
      const after = check(hostname, { requireDirectConnection: true, requireAdminRights: true });
      if (!after.success) {
        await delay(100, "dnet.memoryReallocation");
        return { success: false, code: after.code, message: after.message };
      }
      const record = system.record(hostname);
      if (!record || record.blockedRam <= 0) {
        return { success: false, code: NO_BLOCK_RAM, message: "No Block RAM" };
      }
      const freed = system.reallocateRam(hostname, process.threads, skills().charisma, options.nowMs());
      if (!freed) return { success: false, code: SERVICE_UNAVAILABLE, message: "Service Unavailable" };
      options.gainCharismaExp(options.charismaExpMult() * freed.charismaExp);
      return {
        success: true,
        code: OK,
        message: `Liberated ${freed.freed} of RAM from the server owner's processes.`,
      };
    },

    /** Charisma every call, money by depth, and a `.d.cache` behind a
     * three-minute NET-WIDE cooldown.
     *
     * Runs on the CALLING host and takes no target: `expectRunningOnDarknetServer`
     * is the only gate besides access, and both are evaluated BEFORE the wait —
     * so a script on an ordinary server throws rather than waiting ten seconds to
     * be told no.
     * Source: src/NetscriptFunctions/Darknet.ts:611-619 */
    phishingAttack: async () => {
      if (servers.get(process.host)?.simKind !== "DarknetServer") {
        throw new Error(
          `This API can only be used on a darknet server, but it was called by ${process.filename} ` +
            `(PID: ${process.pid}) on ${process.host}.`,
        );
      }
      requireAccess();
      await delay(phishWaitMs(skills().charisma), "dnet.phishingAttack");
      const outcome = system.phish(process.host, process.threads, skills().charisma, options.nowMs());
      options.gainCharismaExp(options.charismaExpMult() * outcome.charismaExp);
      return { success: outcome.success, code: outcome.code, message: outcome.message };
    },

    /** Fires `STORM_SEED.exe` off the CALLING host — synchronous, unlike the
     * other destructive members, and 404 rather than a throw when the seed is
     * absent. The system consumes the seed and stamps its clock BEFORE the
     * lock check, upstream's own hazard: a second fire mid-burst burns the
     * seed for nothing. Source: src/NetscriptFunctions/Darknet.ts:4650-4659,
     * src/DarkNet/effects/webstorm.ts:25-79 */
    unleashStormSeed: () => {
      requireAccess();
      return system.unleashStormSeed(process.host, options.nowMs());
    },

    openCache: (rawFilename: unknown, _suppressToast?: unknown) => {
      requireAccess();
      // Upstream opens a cache on the CURRENT server only — the filename is a
      // local path, not a host-qualified one.
      return system.openCache(process.host, String(rawFilename));
    },

    /** Propaganda: raises a symbol's VOLATILITY, never its forecast, and earns
     * nothing directly. The charges land in the darknet's own state and the
     * vendored price engine reads them through the market adapter, so the boost
     * moves the real tick rather than a parallel estimate of it.
     *
     * Upstream's ordering is reproduced: the symbol, the darknet-server check and
     * the access check all run BEFORE the wait, and the charges and charisma
     * experience are both priced by charisma as it stands AFTER it — so a call
     * that raises charisma mid-wait pays the new rate, and each call makes the
     * next one bigger.
     * Source: src/NetscriptFunctions/Darknet.ts:582-609 @ 3162fd2 */
    promoteStock: async (rawSymbol: unknown) => {
      const symbol = String(rawSymbol);
      // Not TIX-gated upstream: `getStockFromSymbol` only checks the symbol
      // exists, so propaganda is spreadable before the market can be traded.
      if (!(SymbolToStockMap[symbol] instanceof Stock)) {
        throw new Error(`Invalid stock symbol: '${symbol}'`);
      }
      // `expectRunningOnDarknetServer`: the same `instanceof` the isDarknetServer
      // member answers with, asked of the CALLING host.
      if (servers.get(process.host)?.simKind !== "DarknetServer") {
        throw new Error(
          `This API can only be used on a darknet server, but it was called by ${process.filename} ` +
            `(PID: ${process.pid}) on ${process.host}.`,
        );
      }
      requireAccess();

      await delay(promoteStockWaitMs(skills().charisma), "dnet.promoteStock");

      const threads = process.threads;
      system.addStockPromotion(symbol, promoteStockCharges(threads, skills().charisma));
      options.gainCharismaExp(
        promoteStockCharismaExp(threads, skills().charisma, options.charismaExpMult()),
      );
      return { success: true, code: OK, message: "Success" };
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
