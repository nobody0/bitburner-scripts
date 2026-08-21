import type { SimProcess } from "./process.ts";
import type { DarknetSystem } from "../features/dnet.ts";

export interface DnetNsOptions {
  system: DarknetSystem;
  process: SimProcess;
}

/** v3.0.1 `src/NetscriptFunctions/Darknet.ts`, restricted to the members the
 * controller actually calls. Everything else is absent, so the root namespace's
 * unknown-member proxy reports it and throws rather than answering.
 *
 * The access gate is faithful and load-bearing: 19 of the 22 real members call
 * `expectDarknetAccess`, which throws *"You do not have access to the dnet
 * api"*. Without that, buying DarkscapeNavigator.exe would have no observable
 * effect and the purchase could not be tested at all. */
export function makeDnet(options: DnetNsOptions): Record<string, unknown> {
  const { system, process } = options;

  const requireAccess = (): void => {
    if (system.hasAccess()) return;
    throw new Error(
      'You do not have access to the dnet api. Purchase "DarkscapeNavigator.exe" through your TOR router to unlock it.',
    );
  };

  return {
    // Not access-gated upstream — it just cannot see anything until a darknet
    // exists. Source: NetscriptFunctions/Darknet.ts:314.
    probe: (): string[] => system.probeFrom(process.host),

    getServerDetails: (rawHost?: unknown) => {
      requireAccess();
      const hostname = rawHost === undefined ? process.host : String(rawHost);
      const record = system.record(hostname);
      if (!record) throw new Error(`${hostname} is not a darknet server.`);
      if (!record.online) {
        // Upstream answers with a dummy object rather than throwing, and the
        // only field that describes anything is isOnline.
        return { ...record, isOnline: false, hasSession: false, isConnectedToCurrentServer: false };
      }
      return {
        isConnectedToCurrentServer: system.probeFrom(process.host).includes(hostname),
        hasSession: false,
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
