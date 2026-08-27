import { deriveCapabilities } from "../../shared/features/unlock.ts";
import { initState } from "../../game/lib/state.ts";
import type { ProbeContext } from "../../game/lib/probes/index.ts";

/** Build a `ProbeContext` whose `nsp` is a path -> implementation table.
 *
 * A probe body no longer declares what it calls; it awaits `ctx.nsp(path, ...)`
 * and the resident prices whatever arrives. So a fixture is that table, and an
 * unlisted path THROWS — which is exactly what the game does for an API this
 * BitNode does not offer. A test therefore only names the calls it is about,
 * and any guard the probe is supposed to have around the rest is exercised for
 * free rather than papered over by a permissive stub. */
export function probeCtx(
  impls: Record<string, (...args: never[]) => unknown>,
  options: {
    factionNames?: Record<string, string>;
    player?: unknown;
    servers?: Record<string, unknown>;
    bitNode?: number;
  } = {},
): ProbeContext {
  return {
    player: options.player ?? { factions: [], jobs: {} },
    servers: options.servers ?? {},
    caps: deriveCapabilities({ bitNode: options.bitNode ?? 4 }),
    state: initState(),
    enums: { FactionName: options.factionNames ?? {} },
    nsp: async (path: string, ...args: unknown[]) => {
      const impl = impls[path];
      if (!impl) throw new Error(`no fixture for ns.${path}`);
      return impl(...(args as never[]));
    },
  } as unknown as ProbeContext;
}
