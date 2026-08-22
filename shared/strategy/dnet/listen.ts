/** Whether a `heartbleed` is worth making, and how many lines it will find.
 *
 * Bleeding is the cheapest credential source in the feature — it owes nothing to
 * any of the 24 minigames — but it is not free: 0.6 GB, and a full
 * authentication time and a half. Two separate mistakes waste that, and this
 * module exists to refuse both:
 *
 * 1. **Bleeding a host that has not written anything yet.** Logs are not
 *    produced on a timer; they are BACK-FILLED the moment someone reads them
 *    (`populateServerLogsWithNoise`, `packetSniffing.ts:128-153`), with
 *    `missingLogs = floor(msSinceLastLog / (logTrafficInterval * 1000))`. So the
 *    line count is not observable through any ns member — and does not need to
 *    be, because it is exactly predictable from a fact `getServerDetails`
 *    already hands us.
 *
 * 2. **Bleeding a host whose lines cannot say anything we want.** The noise
 *    generator is an ordered if-chain of eight branches, and which of them can
 *    carry value depends entirely on what we already know. A host whose password
 *    we hold, whose neighbours we hold, whose topology is fresh and against which
 *    nothing is being solved can only produce spam and heartbeats.
 *
 * ## The branches, in the order upstream evaluates them
 *
 * Each is an independent `Math.random()` tested in sequence, so a later branch
 * only fires when every earlier one missed. `getLogNoise`,
 * `packetSniffing.ts:155-191`:
 *
 * | # | chance | line | worth reading when |
 * |---|---|---|---|
 * | 1 | 0.20 | a spam phrase | never |
 * | 2 | `0.05 / (difficulty + 1)` | `Connecting to <n>:<password>` — a NEIGHBOUR's password in cleartext | we lack a neighbour's credential |
 * | 3 | 0.05 | `[sending transaction details to <n>.]` — one edge | our adjacency is stale |
 * | 4 | 0.10 | which characters of the LAST attempt were correctly placed | a solve is in flight here |
 * | 5 | 0.10 | two characters contained in THIS host's password | we lack this host's credential |
 * | 6 | 0.05 | `--<password>--`, a random MOVABLE host's password, unattributed | see below |
 * | 7 | `0.7 - difficulty * 0.01`, `OpenWebAccessPoint` only | 30% its own password, else a neighbour's | we lack either |
 * | 8 | otherwise | heartbeat | never |
 *
 * **Branch 6 is net-wide, and that makes it MORE useful rather than less.** Any
 * host can leak any movable host's password, so a host whose own neighbourhood
 * we have completely cracked is not worthless — it is a listening post on the
 * rest of the net, running a 5%-per-line lottery on every movable server still
 * closed to us.
 *
 * The tempting mistake is to discount it as "we will pick that up from whatever
 * we were bleeding anyway". That argument fails in exactly the state where it
 * matters: once the local neighbourhood is fully owned, every OTHER branch
 * scores zero, so we would bleed nothing at all — and collect nothing — while
 * the frontier elsewhere is still full of hosts we cannot open. So branch 6 is
 * counted, gated on a NET-WIDE fact rather than a per-host one, and the only
 * thing that finally makes a host silent is having cracked the entire net.
 *
 * Its one cost is that the password arrives unattributed. That is what
 * `looseCandidates` below is for: a bare password plus the length and format
 * facts we already hold is usually enough to name the handful of hosts it could
 * belong to.
 *
 * ## The two scaling laws point in opposite directions
 *
 * `logTrafficInterval = 1 + 30 * 0.9^difficulty` seconds, so a DEEP host is
 * chatty (2.3 s at difficulty 30) and a shallow one is quiet (31 s at 0). But
 * branch 2 — the neighbour credential, the single most useful line — scales as
 * `1 / (difficulty + 1)`, so it is 30x rarer on that same deep host.
 *
 * The consequence is worth stating plainly, because it is not the intuition:
 * **deep hosts are where you go to crack the host you are standing next to;
 * shallow hosts are where you go to harvest its neighbours.** And an
 * `OpenWebAccessPoint` at any depth outranks both, because branch 7 fires up to
 * 70% of the time and leaks a real password either way.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/models/packetSniffing.ts:14, 128-153, 155-191, 199-211
 *   src/DarkNet/models/DarknetServerOptions.ts:87 (logTrafficInterval) */

/** `MAX_LOG_LINES` (`packetSniffing.ts:14`). The ring is capped, so waiting
 * longer than `200 * logTrafficInterval` banks nothing further. */
export const MAX_LOG_LINES = 200;

/** `1 + 30 * 0.9 ** difficulty`, in SECONDS. Exposed directly by
 * `getServerDetails`, so this is only for hosts we have not surveyed. */
export function logTrafficInterval(difficulty: number): number {
  return 1 + 30 * 0.9 ** difficulty;
}

/** How many lines the back-fill will mint, given how long since we last looked.
 *
 * Conservative by construction: the engine advances its own `lastLogTime` by
 * whole intervals, and we measure from our own last bleed, which is never later
 * than that. So this under-counts rather than over-counts, and under-counting
 * only ever costs us a bleed we could have made. */
export function expectedNewLines(intervalSec: number, sinceMs: number): number {
  if (!(intervalSec > 0) || !(sinceMs > 0)) return 0;
  return Math.min(Math.floor(sinceMs / (intervalSec * 1000)), MAX_LOG_LINES);
}

/** What we know about a host, for the purpose of deciding whether to listen. */
export interface ListenTarget {
  hostname: string;
  difficulty?: number;
  /** Straight from `getServerDetails`; falls back to the formula. */
  logTrafficIntervalSec?: number;
  modelId?: string;
  /** We hold this host's password. */
  hasCredential: boolean;
  /** Neighbours we believe it has, and how many of those we cannot open. */
  uncrackedNeighbours: number;
  /** Our adjacency for it has expired. */
  topologyStale: boolean;
  /** A password solve is part-way through against this host, so its ring holds
   *  our own attempt records — the ONLY channel a model's feedback ever uses. */
  solveInFlight: boolean;
  /** When we last read this ring. */
  lastBleedAt?: number;
}

/** Facts about the NET, not about one host. Branch 6 depends only on these. */
export interface ListenContext {
  /** Any movable darknet server whose password we do not hold. While this is
   *  true, every host in the net is worth listening to for branch 6 alone. */
  netHasUncrackedMovable: boolean;
  /** `heartbleed` is the one charisma-gated call. */
  charismaOk?: boolean;
}

export type ListenRefusal = "no-new-lines" | "nothing-to-learn" | "charisma";

export interface ListenVerdict {
  /** Worth a call right now. */
  worth: boolean;
  lines: number;
  /** Expected lines that could carry something we do not already have. Ranking
   *  key: it is what separates a chatty host with nothing to say from a quiet
   *  one holding a credential. */
  value: number;
  why: string;
  refusal?: ListenRefusal;
}

/** The chance a single line lands on a branch we care about.
 *
 * Modelled as the ordered chain upstream actually evaluates, because the
 * ordering matters: the 20% spam branch swallows a fifth of every line before
 * anything else is considered, and branch 7 is reached only when the six before
 * it all miss. Getting this wrong in the optimistic direction would have us
 * bleeding hosts that cannot pay. */
export function valuablePerLine(target: ListenTarget, context?: ListenContext): number {
  const difficulty = target.difficulty ?? 0;
  let remaining = 1;
  let value = 0;

  // 1. spam — pure loss, but it consumes the draw.
  remaining *= 1 - 0.2;

  // 2. a neighbour's plaintext password.
  const neighbourLeak = 0.05 / (difficulty + 1);
  if (target.uncrackedNeighbours > 0) value += remaining * neighbourLeak;
  remaining *= 1 - neighbourLeak;

  // 3. one topology edge.
  if (target.topologyStale) value += remaining * 0.05;
  remaining *= 1 - 0.05;

  // 4. which characters of the last attempt were placed correctly. Upstream
  //    only emits this when an auth record exists, which is exactly when a
  //    solve is running.
  if (target.solveInFlight) value += remaining * 0.1;
  remaining *= 1 - 0.1;

  // 5. two characters of this host's own password.
  if (!target.hasCredential) value += remaining * 0.1;
  remaining *= 1 - 0.1;

  // 6. a random movable host's password, unattributed. Counted whenever ANY
  //    movable host is still closed to us, because this branch does not care
  //    whose logs it is written in — which is what turns a fully-cracked host
  //    into a listening post on the rest of the net.
  if (context?.netHasUncrackedMovable ?? false) value += remaining * 0.05;
  remaining *= 1 - 0.05;

  // 7. the packet sniffer, which is in a class of its own.
  if (target.modelId === "OpenWebAccessPoint") {
    const chance = Math.max(0, 0.7 - difficulty * 0.01);
    // 30% of its draws leak its own password, the rest a neighbour's.
    const own = target.hasCredential ? 0 : 0.3;
    const neighbour = target.uncrackedNeighbours > 0 ? 0.7 : 0;
    value += remaining * chance * (own + neighbour);
  }

  return value;
}

/** Should we spend a `heartbleed` on this host right now?
 *
 * Two independent gates, and they refuse for different reasons that must not
 * read alike: `no-new-lines` clears itself by waiting, while `nothing-to-learn`
 * clears only when the world changes — a neighbour goes stale, a solve starts,
 * or we lose a credential. */
export function shouldListen(target: ListenTarget, now: number, context?: ListenContext): ListenVerdict {
  if (!(context?.charismaOk ?? true)) {
    return {
      worth: false,
      lines: 0,
      value: 0,
      why: "heartbleed is the one charisma-gated call, and this host is above us",
      refusal: "charisma",
    };
  }
  const interval = target.logTrafficIntervalSec ?? logTrafficInterval(target.difficulty ?? 0);
  const lines = expectedNewLines(interval, now - (target.lastBleedAt ?? 0));
  const perLine = valuablePerLine(target, context);

  if (lines < 1) {
    return {
      worth: false,
      lines,
      value: 0,
      why: `writes a line every ${interval.toFixed(1)}s and has not written one since we last looked`,
      refusal: "no-new-lines",
    };
  }
  if (perLine <= 0) {
    return {
      worth: false,
      lines,
      value: 0,
      why: "we hold its password and its neighbours', its adjacency is fresh, nothing is being solved here,"
        + " and there is no movable host left anywhere in the net for it to leak — every line it can write"
        + " is spam or a heartbeat",
      refusal: "nothing-to-learn",
    };
  }
  return {
    worth: true,
    lines,
    value: lines * perLine,
    why: `${lines} new line${lines === 1 ? "" : "s"} at ${(perLine * 100).toFixed(1)}% useful each`,
  };
}

/** Rank the hosts worth listening to, best first.
 *
 * Ordering by expected useful lines rather than by depth or by age, because the
 * two scaling laws pull in opposite directions and neither alone is a proxy for
 * value. */
export function rankListening(
  targets: readonly ListenTarget[],
  now: number,
  context?: ListenContext,
): ListenVerdict[] {
  return targets
    .map((target) => ({ target, verdict: shouldListen(target, now, context) }))
    .filter((entry) => entry.verdict.worth)
    .sort((a, b) => b.verdict.value - a.verdict.value
      || (a.target.hostname < b.target.hostname ? -1 : 1))
    .map((entry) => entry.verdict);
}

// --- what to do with a password that did not say whose it was ---------------

/** A host a loose password might belong to. */
export interface LooseTarget {
  hostname: string;
  /** Identity facts, so they do not expire while the guess is in flight. */
  passwordLength?: number;
  passwordFormat?: string;
  hasCredential: boolean;
  isStationary?: boolean;
  gone?: boolean;
}

export interface LooseGuess {
  hostname: string;
  password: string;
  reason: string;
}

/** Which hosts an unattributed password could open.
 *
 * Branch 6 hands over a real, current password with no hostname attached, and
 * `harvestLogs` has been collecting these into `loose` all along without anyone
 * ever spending them. A bare string looks useless; it is not, because two
 * identity facts we already hold narrow it hard:
 *
 * - **Length.** `passwordLength` comes free from `getServerDetails` and never
 *   expires — it is an identity fact, replaced only when the host is.
 * - **Format.** Likewise, and a numeric password never contains a letter.
 *
 * Between them a leaked string usually names a handful of candidates out of the
 * whole net, and each candidate costs one `authenticate` — which has no penalty
 * for being wrong. So this is close to free money.
 *
 * The source is `getAllMovableDarknetServers`, so a STATIONARY host can never be
 * the owner: `darkweb` and the labyrinth are excluded at the source, and
 * offering them would waste an attempt on a host whose password we are not even
 * looking for.
 *
 * Ordered shortest-format-match first and then by name, so the same leak
 * produces the same plan twice. */
export function looseCandidates(
  loose: readonly string[],
  hosts: readonly LooseTarget[],
  formatOf: (password: string) => string,
): LooseGuess[] {
  const out: LooseGuess[] = [];
  const seen = new Set<string>();
  for (const password of loose) {
    const format = formatOf(password);
    const matches = hosts.filter((host) => {
      if (host.gone || host.hasCredential) return false;
      // Never a stationary host: the leak is drawn from the movable pool.
      if (host.isStationary) return false;
      if (host.passwordLength !== undefined && host.passwordLength !== password.length) return false;
      if (host.passwordFormat !== undefined && host.passwordFormat !== format) return false;
      return true;
    });
    for (const host of matches) {
      const dedupe = `${host.hostname}\u0000${password}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        hostname: host.hostname,
        password,
        reason: `a log leaked an unattributed ${password.length}-character ${format} password`
          + ` and ${host.hostname} matches both facts`,
      });
    }
  }
  return out.sort((a, b) =>
    a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : a.password < b.password ? -1 : 1);
}
