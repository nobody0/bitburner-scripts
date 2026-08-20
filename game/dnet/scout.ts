import type { NS } from "@ns";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import {
  REPORT_VERSION,
  encodeReport,
  type DnetReport,
  type ReportHost,
} from "../../shared/strategy/dnet/courier.ts";
import { parseMissionArgs } from "../../shared/strategy/dnet/mission.ts";
import { initTelemetry } from "../lib/telemetry.ts";

/** The darknet scout: one look around, one report, exit.
 *
 * It runs ON a darknet host because there is no other way to see the darknet.
 * `ns.dnet.probe()` returns only the hosts directly connected to the calling
 * script's own server, and `ns.scan` excludes the darknet entirely, so the map
 * can only be assembled from scripts standing in different places. `darkweb` is
 * the entry point: it is rooted, stationary, password-free and always
 * authenticated, so this script can be placed there with no credential at all.
 * See spec/dnet.md.
 *
 * It is deliberately tiny and one-shot. A long-lived agent would have to survive
 * the mutation clock — its host can be restarted or deleted out from under it at
 * any tick — and re-launching a 2.6 GB script is cheaper than making it durable.
 *
 * Two things it must not do, and the reasons are structural rather than stylistic:
 *
 * - **It never reads the page realm.** Not because the realm is forbidden — ports
 *   are a sanctioned engine mechanic and just as fast — but because it has no
 *   need to: everything it knows, it observed itself, and everything it says goes
 *   out through a port and its own socket. Its identity arrives in `ns.args`.
 * - **It holds no session and needs none.** probe, getServerDetails and
 *   heartbleed require only a direct connection (plus charisma, for heartbleed),
 *   so the scout stays at 2.6 GB and out of the credential problem entirely.
 *
 * RAM: base 1.6 + probe 0.2 + getServerDetails 0.1 + heartbleed 0.6 +
 * getHostname 0.05 = 2.55 GB, pinned by tests/ram-budget.test.ts. tryWritePort
 * is 0 GB, which is why the report needs neither a file nor an scp.
 *
 * Nothing launches it automatically yet — the controller cannot exec into the
 * darknet until the simulator models it, or BN15 runs would diverge. Until then
 * it is launched by hand, from a script already sitting on a darknet host:
 *
 *     run dnet/scout.js <missionId> <generation> <identityJson> <port> <charisma>
 *
 * `port` should be 1 (DNET_REPORT_PORT), which is what the controller drains,
 * and `generation` must be `<bitNode>:<lastAugReset>` or the fold will correctly
 * discard the report as coming from a world this run no longer shares. */

/** Hosts inspected in one pass. A scout is a snapshot, not a survey: the net
 * mutates every few seconds, so a long pass reports a world that no longer
 * agrees with itself. */
const MAX_HOSTS = 12;

export async function main(ns: NS): Promise<void> {
  // A scout can run many times a minute; telemetry is its record, not the
  // engine's per-call log.
  ns.disableLog("ALL");

  const mission = parseMissionArgs(ns.args);
  // Wrong argument shape: exit quietly rather than crashing into the game log.
  // Nothing else can have happened yet, so there is nothing to report.
  if (!mission) return;

  let identity: ArtifactIdentity | undefined;
  try {
    identity = JSON.parse(mission.identity) as ArtifactIdentity;
  } catch {
    /* Unreadable identity only costs us telemetry, never the report. */
  }

  const agentHost = ns.getHostname();
  const codes: Record<string, number> = {};
  const note = (code: number): void => {
    codes[String(code)] = (codes[String(code)] ?? 0) + 1;
  };

  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    // Send-only, so it can never become a back-channel, and a --perf build
    // removes it entirely. The scout still works: the report goes by port.
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const hosts: ReportHost[] = [];
  const logs: string[] = [];

  // Everything below is ACQUISITION and runs in every build. Only the sends are
  // wrapped, per the telemetry rule in AGENTS.md.
  const neighbours = ns.dnet.probe();
  for (const host of neighbours.slice(0, MAX_HOSTS)) {
    const details = ns.dnet.getServerDetails(host);
    if (!details.isOnline) {
      // Absence is an observation. Reporting it is what lets home forget a host
      // instead of keeping a map of a world that no longer contains it.
      hosts.push({ hostname: host, present: false });
      note(503);
      continue;
    }
    hosts.push({
      hostname: host,
      present: true,
      depth: details.depth,
      blockedRam: details.blockedRam,
      requiredCharisma: details.requiredCharismaSkill,
      difficulty: details.difficulty,
      isStationary: details.isStationary,
      modelId: details.modelId,
      passwordLength: details.passwordLength,
      passwordFormat: details.passwordFormat,
      passwordHint: details.passwordHint,
      data: details.data,
      logTrafficInterval: details.logTrafficInterval,
    });

    // Logs are the game's own feedback channel for authentication, and the only
    // hard requirement is charisma — no session needed. Refusing below the gate
    // ourselves turns a guaranteed 451 into a call we never make.
    if (mission.charisma < details.requiredCharismaSkill) {
      note(451);
      continue;
    }
    const bleed = await ns.dnet.heartbleed(host, { peek: true });
    note(bleed.code);
    if (bleed.success) logs.push(...bleed.logs);
  }

  // This scout's own view of the net, keyed per host. Last-write-wins per key,
  // so many scouts can report without clobbering each other or the controller's
  // topic. It is OBSERVED, never `known`: the driver decides only on what the
  // port delivered, and the gap between the two is how agent losses become
  // visible. See spec/dnet.md.
  TELEMETRY: if (__TELEMETRY__ && tel) {
    tel.mirror(`dnet.observed:${agentHost}`, {
      agentHost,
      at: Date.now(),
      missionId: mission.missionId,
      hosts,
      codes,
      logs: logs.slice(0, 8),
    });
    tel.event("dnet.agent.report", { agentHost, missionId: mission.missionId, hosts: hosts.length });
  }

  const report: DnetReport = {
    v: REPORT_VERSION,
    missionId: mission.missionId,
    generation: mission.generation,
    agentHost,
    phase: "final",
    at: Date.now(),
    hosts,
    codes,
    logs,
  };
  // tryWritePort rather than writePort: a full port means the controller is not
  // draining, and silently pushing the oldest report off the queue would lose
  // an observation without saying so.
  if (!ns.tryWritePort(mission.port, encodeReport(report))) {
    TELEMETRY: if (__TELEMETRY__ && tel) {
      tel.event("dnet.report.undeliverable", { agentHost, missionId: mission.missionId, port: mission.port });
    }
  }

  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}
