import {
  NONE,
  card,
  collapsible,
  dataTable,
  definitions,
  dot,
  filters,
  hint,
  meter,
  note,
  outcome,
  search,
  shownOf,
  table,
  tiles,
  waiting,
  waitingPanel,
  type Status,
} from "../lib/dom.ts";
import { html, raw, type Markup } from "../lib/html.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import { codeName } from "../../../shared/strategy/dnet/courier.ts";
import { modelEntry, type PasswordFacts } from "../../../shared/strategy/dnet/models.ts";
import { solverFor } from "../../../shared/strategy/dnet/solvers/index.ts";
import { reclaimForecast } from "../../../shared/strategy/dnet/farm.ts";
import { PHISH_CACHE_COOLDOWN_MS, STORM_COOLDOWN_MS } from "../../../shared/strategy/dnet/rates.ts";
import { LAB_LADDER, isLabyrinth } from "../../../shared/strategy/dnet/rates.ts";
import { fieldGroup, type ExpiryOpts } from "../../../shared/strategy/dnet/host.ts";
import type { DarknetKnownHost, DarknetLabWalker, DarknetState } from "../../../shared/telemetry/topics/dnet.ts";
import { AUTH_LABEL, factLife, isStale, matches, mapOptions, netLegend, netMap, ramBuckets } from "./dnet-map.ts";
import { labEtaMs, labExplored, labMaze, labMazeLegend, labPriorFor, walkerEtaMs } from "./dnet-lab.ts";
import type { Tab } from "./index.ts";

/** The Darknet panel.
 *
 * The feature's own rule (spec/dnet.md) is that a fact past its expiry is SHOWN
 * but excluded from decisions. This panel is where that stops being an internal
 * discipline and becomes something an operator can act on: the map draws what we
 * believe, the fading says how much, and the detail card shows the age behind
 * every single fact behind a box.
 *
 * The digest carries only what cannot be derived — an observation time per fact,
 * and a `modelId`. Everything else on this page is computed HERE from the same
 * shared modules the controller uses, which is why `expiryMs` and `modelEntry`
 * are imported rather than having their answers shipped per host per tick.
 *
 * The second job used to be "why have we not attacked this", and it is not any
 * more. `shared/strategy/dnet/solvers/` implements nineteen solvers and the five
 * dictionary models are walked by `planAttempt`, so twenty-three of the
 * twenty-four are openable — and `models.ts:describeModel` DERIVES `status` from
 * `solverFor()` and deletes the `blocked` note the moment a solver exists, which
 * is what stops the registry claiming a reason that stopped being true.
 *
 * So the password surface splits in two. For the twenty-three, the question is
 * SOLVE PROGRESS — what is running, how far through its budget, which phase, and
 * what the last response code was. For the labyrinth, which is a maze walked by
 * a process rather than a password, and for any model id the game invents that
 * we have not transcribed, the old job survives unchanged: hand over the raw
 * material rather than hide a blank behind a shrug. */

/** How many rows the server table shows before saying it truncated. The MAP
 * never truncates; a table is where a limit belongs. */
const TABLE_LIMIT = 60;

/** How often the darknet driver publishes, and how far past that the digest has
 * stopped being a current reading.
 *
 * Every other age on this page is measured against `knowledge.at` — the digest
 * IS the clock, which is right for fact-versus-observation arithmetic and blind
 * to the digest's own lag: a driver that stops publishing freezes every one of
 * those ages at whatever it last said, and nothing on the page could contradict
 * it. The cadence is the driver's own `everyMs` — 5s (game/lib/features/dnet.ts)
 * — restated here because it is not on the wire, and it is the number the tile's
 * sub-line prints at the operator, so a stand-in would be a false statement
 * about the producer. The MUTATION clock is the wrong scale for this — ~6s at
 * depth 5, so a two-mutation threshold would paint the tile red on almost every
 * healthy frame and teach the reader to ignore it.
 *
 * The stale mark is a MULTIPLE of that period rather than three ticks: at 5s a
 * three-tick threshold is 15s, and the digest record shares the 1 Hz publish
 * with every other topic and rides one serially-awaited feature pass, so a busy
 * frame or a slow fold jitters past 15s on a perfectly healthy run. Six periods
 * is half a minute of complete silence — no longer jitter, and still an order of
 * magnitude sooner than the 90s this used to wait. */
const DIGEST_PUBLISH_MS = 5_000;
const DIGEST_STALE_MS = 6 * DIGEST_PUBLISH_MS;

/** The RAM a resident needs, for the two places this panel judges room for one.
 *
 * Mirrors `coverage()`'s own `agentRamGb` default (shared/strategy/dnet/
 * host.ts rather than `DEFAULT_SPREAD_LIMITS.agentRamGb`, and the
 * difference is load-bearing: every caller of `coverage()` passes three
 * arguments, so the `plantable` count this panel prints two cards away is
 * counted against that default, while the planner refuses on 5.4 GB (resident
 * plus prober). Painting the `free` column against the planner's figure would
 * make the panel contradict its own count.
 *
 * It was written out twice — the filter and the colouring — which is how the two
 * could drift apart from each other and from `plantable` silently. One name and
 * a tooltip that quotes it is as far as this side of the process boundary
 * reaches; real parity needs the budget on the wire or one shared constant, and
 * neither exists yet. */
const AGENT_RAM_GB = 2.6;

/** How long a walk may be quiet before this panel stops calling its pace an
 * estimate.
 *
 * The producer's own kill window for a long-lived job is LONG_JOB_BEAT_MS =
 * 30_000 (game/dnet/shared.ts): past it the controller has already given up on the
 * job, so a digest still carrying the walker means home's copy is stale rather
 * than the walk being slow — `home.lab` is deliberately never blanked, so the
 * last snapshot of a dead controller's walk can sit on this card indefinitely.
 * `ui/app` imports nothing from `game/`, so the number is restated rather than
 * reached for. Doubled, because a move on a deep rung is a whole
 * authentication and the eta tile would otherwise flap between a figure and a
 * dash on a healthy slow walk. */
const WALK_STALE_MS = 2 * 30_000;

/** `1 radar` rather than `1 radars`. The walk's counters start at one and stay
 * small for a while, so the ungrammatical case is the one a reader sees first. */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A host's row, as something other than a raw number.
 *
 * `-1` reaches the panel from three different places and means something
 * different in each: it is darkweb's REAL depth, it is what every labyrinth
 * reports (all eight are constructed at `depth: -1` and the renderer pins them
 * to `getNetDepth() + 0.5`), and it is what `getDepth` answers when the lookup
 * fails. `layoutNet` already separates the three by identity rather than by
 * depth for exactly this reason; a table printing `-1` in all three cases puts
 * the shop, the goal and an unplaced rumour on the same row. */
function depthLabel(host: DarknetKnownHost): string {
  if (host.isDarkweb === true || host.hostname === "darkweb") return "shop";
  if (isLabyrinth(host.hostname, host.modelId)) return "lab";
  return host.depth === undefined || host.depth < 0 ? NONE : String(host.depth);
}

/** Why a planner declined, rendered the one way.
 *
 * Spread and farm both carry `{refused, examples}`. Keeping this loop here
 * makes their rendering consistent without putting UI vocabulary in shared code.
 *
 * Sorted by count, and one example per reason: a reason with no example is a
 * number nobody can act on, and a row per host is a wall. */
function refusals(
  refused: Record<string, number>,
  examples: readonly { why: string; detail: string }[],
  empty: Markup,
  context: Markup = "",
  headings: [Markup, Markup, Markup] = ["refused", "n", "why"],
): string {
  return (context ? note(context) : "") + table(
    headings,
    Object.entries(refused)
      .sort((a, b) => b[1] - a[1])
      .map(([why, n]) => [esc(why), String(n), esc(examples.find((e) => e.why === why)?.detail ?? "")]),
    { empty, left: [0, 2], wrap: [2] },
  );
}

/** The published password facts, in the shape the shared modules expect.
 *
 * The digest ships these five and the panel reassembles them, rather than the
 * controller shipping every derived answer per host per tick — the same trade
 * that has `modelEntry` looked up here rather than sent. */
function passwordFacts(h: DarknetKnownHost): PasswordFacts {
  return {
    ...(h.passwordLength !== undefined ? { passwordLength: h.passwordLength } : {}),
    ...(h.passwordFormat !== undefined ? { passwordFormat: h.passwordFormat } : {}),
    ...(h.passwordHint !== undefined ? { passwordHint: h.passwordHint } : {}),
    ...(h.data !== undefined ? { data: h.data } : {}),
    ...(h.difficulty !== undefined ? { difficulty: h.difficulty } : {}),
  };
}

/** What grinding this host's owner-blocked RAM open would cost.
 *
 * Derived rather than published: `reclaimForecast` is a pure function of
 * `difficulty`, `blockedRam` and charisma, all of which already travel. Until
 * now it only reached a reader as prose buried inside a farm refusal, so the
 * question "is this block worth grinding" had no number attached to it on the
 * one screen that shows the block.
 *
 * A call that frees less than `RECLAIM_MIN_PER_CALL_GB` frees literally nothing
 * once the engine rounds it, which is a stall rather than a slow grind — and
 * those want different responses, so they are named differently. */
function reclaimRow(host: DarknetKnownHost, charisma: number | undefined): string {
  if (!host.blockedRam || charisma === undefined) return "";
  const forecast = reclaimForecast(
    { difficulty: host.difficulty, blockedRam: host.blockedRam },
    charisma,
  );
  if (forecast === undefined) return "";
  if (forecast.perCallGb <= 0) {
    return `<p class="bad">${fmtRam(host.blockedRam)} blocked, and a call frees nothing at this charisma`
      + ` — the grind is stalled, not slow</p>`;
  }
  return `<p class="muted">${fmtRam(host.blockedRam)} blocked · ${fmtRam(forecast.perCallGb)} per call`
    + ` · clear in ${Number.isFinite(forecast.clearMs) ? fmtTime(forecast.clearMs) : "never"}</p>`;
}

/** Whether we can open this model, decided ONCE.
 *
 * The detail card and the password surface used to write this decision
 * separately, with different wording, so the same host could be described two
 * ways on one screen. It is a pure function of the model id — `describeModel`
 * derives `status` from the solver registry — so it belongs in one place and is
 * looked up rather than shipped per host per tick.
 *
 * An unrecognised id is `bad` rather than merely unknown: it is a game update or
 * a hole in `models.ts`, `unknownModels` is counting it, and a generic fallback
 * here would hide both. */
function solverStatus(modelId: string | undefined): { status: Status; label: Markup } {
  const entry = modelEntry(modelId);
  if (!entry) return { status: "bad", label: `<span class="bad">unrecognised model id</span>` };
  if (entry.blocked !== undefined) {
    return { status: "wait", label: `<span class="muted">${esc(entry.blocked)}</span>` };
  }
  return { status: "good", label: `<span class="good">implemented</span>` };
}

function factRows(host: DarknetKnownHost, now: number, expiry: ExpiryOpts): [Markup, Markup][] {
  const rows: [Markup, Markup][] = [];
  for (const key of Object.keys(host.facts)) {
    const age = factLife(host, key, now, expiry);
    if (!age) continue;
    // Infinity is the identity class, or a host the mutation clock cannot touch.
    // Rendering either as "0s left" would be exactly backwards.
    const life = age.expiresInMs === Infinity
      ? `<span class="muted">never expires</span>`
      : age.stale
        ? `<span class="bad">stale</span>`
        : `<span class="good">${fmtTime(age.expiresInMs)} left</span>`;
    rows.push([
      hint(key, `${fieldGroup(key) ?? "unknown"} fact`),
      `<span class="${age.stale ? "muted" : ""}">${fmtTime(age.ageMs)} ago</span> · ${life}`,
    ]);
  }
  return rows;
}

/** The host the whole panel is about, resolved ONCE.
 *
 * The map rings this name, both host tables chip-highlight it and the detail
 * card describes it, so all three have to be handed the same one. The card used
 * to run its own fallback chain instead, which meant that until the operator
 * clicked something the panel rendered a full card for a host nothing on the
 * 240-box map identified — and after an explicit selection left the digest the
 * ring vanished while the card silently swapped subject.
 *
 * The default is DARKWEB, the map's own root, and deliberately not the
 * best-ranked stasis candidate: `plan.ranked` is re-scored against a topology
 * that mutates every ~6s, so ringing it would walk the white box around the map
 * with no operator action — the shimmer the digest is depth-sorted to avoid —
 * and would assert a selection nobody made, next to a Decision card that
 * refuses to highlight a ranked row for that same reason. Now that the ring is
 * DERIVED, its default has to be stable. */
/** A "select this host" button, worded once.
 *
 * Four places offer one — the neighbour strip, the lost-reachable table and both
 * host tables — and before this they disagreed twice over: two of them painted
 * the selection with `.sel` and two never marked it at all, so clicking a host
 * in one table left the same host looking unselected in another. And `.sel` is a
 * background colour, which is the channel a screen reader cannot see.
 *
 * `aria-current`, not the `aria-pressed` that `filters()` emits: these are not
 * toggles. Pressing one does not turn anything on, it moves a single selection —
 * exactly what `aria-current` describes, and pressing the selected one again is
 * a no-op rather than a release. */
function hostChip(name: string, selected: string): string {
  const on = name === selected;
  return (
    `<button class="chip pick${on ? " sel" : ""}"${on ? ` aria-current="true"` : ""}` +
    ` data-view-key="dnet.sel" data-view-value="${esc(name)}">${esc(name)}</button>`
  );
}

function effectiveSel(hosts: readonly DarknetKnownHost[], picked: string): string {
  if (hosts.some((host) => host.hostname === picked)) return picked;
  return (hosts.find((host) => host.isDarkweb) ?? hosts[0])?.hostname ?? "";
}

function detailCard(
  d: DarknetState,
  hosts: readonly DarknetKnownHost[],
  selected: string,
  /** An explicit selection that is no longer in the digest, when there is one.
   *  Re-pointing an operator's choice in silence is the more misleading half of
   *  the fallback, so the card says whose card it is NOT. */
  lost: string,
  now: number,
  expiry: ExpiryOpts,
): string {
  // Resolved by `effectiveSel` before the map was drawn, so this is a lookup
  // rather than a second chain that could pick a different host from the ring.
  const host = hosts.find((entry) => entry.hostname === selected);
  if (!host) return card("Host", note("no host selected"));

  const ram = ramBuckets(host);
  const summary = tiles([
    { label: "depth", value: depthLabel(host) },
    {
      label: "RAM",
      value: ram === undefined ? NONE : `${fmtRam(ram.total)} total`,
      sub: ram === undefined
        ? undefined
        : ram.used === undefined || ram.unused === undefined
          ? `${fmtRam(ram.blocked)} blocked`
          : `${fmtRam(ram.blocked)} blocked · ${fmtRam(ram.used)} used · ${fmtRam(ram.unused)} unused`,
    },
    {
      label: "charisma",
      value: host.requiredCharisma === undefined ? NONE : fmtNum(host.requiredCharisma, 0),
      sub: d.charisma !== undefined ? `have ${fmtNum(d.charisma, 0)}` : undefined,
    },
    { label: "state", value: host.authState === undefined ? NONE : AUTH_LABEL[host.authState] },
  ]);

  // The password model, and — when we have not attacked it — exactly why not.
  // This is the panel's most useful block: it is the difference between "we did
  // nothing here" and "here is the oracle, and here is what writing the solver
  // would take".
  const modelRows: [Markup, Markup][] = [];
  if (host.modelId) {
    // Looked up from the registry rather than shipped: every field below is a
    // pure function of the model id, and a deep net has 220 hosts.
    const entry = modelEntry(host.modelId);
    modelRows.push(["model", `${esc(host.modelId)}${entry ? ` <span class="muted">(${esc(entry.name)})</span>` : ""}`]);
    if (entry) modelRows.push(["feedback", esc(entry.feedback)]);
    if (host.passwordLength !== undefined) {
      modelRows.push(["password", `${host.passwordLength} × ${esc(host.passwordFormat ?? "?")}`]);
    }
    if (host.passwordHint) modelRows.push([hint("hint", "shown by getServerDetails, free"), esc(host.passwordHint)]);
    if (host.data) modelRows.push(["data", esc(host.data)]);
    if (host.difficulty !== undefined) modelRows.push(["difficulty", fmtNum(host.difficulty, 0)]);
    if (host.logTrafficInterval !== undefined) {
      modelRows.push([
        hint("log traffic", "how often the server writes a line of its own — and how often it leaks"),
        fmtTime(host.logTrafficInterval * 1000),
      ]);
    }
    if (entry) {
      modelRows.push([hint("oracle", "what a wrong guess tells you, and where it appears"), esc(entry.oracle)]);
      modelRows.push(["read via", esc(entry.via)]);
    }
    // One decision, one wording — see `solverStatus`.
    const opens = solverStatus(host.modelId);
    modelRows.push([dot(opens.status, "can we open this model at all"), opens.label]);
  }

  const attempt = host.attempt;
  const attemptRows: [Markup, Markup][] = [];
  if (attempt) {
    attemptRows.push(["status", esc(attempt.status)]);
    attemptRows.push(["candidates tried", String(attempt.tried)]);
    attemptRows.push([
      hint("probes", "deliberate failures spent to make the oracle appear at all"),
      String(attempt.probes),
    ]);
    if (attempt.lastCode !== undefined) {
      // The code and its AGE together. A code on its own does not say whether
      // the conversation is live or was abandoned an hour ago, and those want
      // opposite things from an operator.
      attemptRows.push([
        "last code",
        `${attempt.lastCode} ${esc(codeName(attempt.lastCode))}`
        + (attempt.lastAt !== undefined ? ` <span class="muted">· ${fmtTime(now - attempt.lastAt)} ago</span>` : ""),
      ]);
    }
    if (attempt.modelId !== undefined && host.modelId !== undefined && attempt.modelId !== host.modelId) {
      // The ledger was built against a different model, which means the host
      // was replaced under it. Every count above is about a password that no
      // longer exists — see the `goneAt` branch in the fold.
      attemptRows.push([
        "ledger model",
        `<span class="bad">${esc(attempt.modelId)} — stale, the host was replaced</span>`,
      ]);
    }
  }

  const neighbours = (host.neighbours ?? []).length > 0
    ? `<div class="chips">`
      + (host.neighbours ?? [])
        .map((name) => hostChip(name, selected))
        .join("")
      + `</div>`
    : note("no adjacency known — this host is a rumour until an agent stands next to it");

  return card(
    // raw(), because `card` escapes a plain string title and the hostname is
    // already escaped here.
    raw(esc(host.hostname)),
    (lost === "" ? "" : note(`${lost} has left the digest — forgotten, or past the KNOWLEDGE_MAX_HOSTS cap`))
    + summary
    + (host.credentialKnown ? `<p class="good">credential held</p>` : "")
    + (host.agent
      ? host.agent.alive
        ? `<p class="good">resident standing here`
          + `${host.agent.active ? ` — running ${esc(host.agent.active)}` : ""}`
          + `${host.agent.pending ? `, ${host.agent.pending} queued` : ""}</p>`
        : `<p class="bad">resident lost — last beat ${fmtTime(now - host.agent.lastBeatAt)} ago</p>`
      : "")
    + (host.goneAt !== undefined ? `<p class="bad">gone — its identity facts were dropped with it</p>` : "")
    // A cache dies with its host, so an unopened one is a standing offer with an
    // expiry date on it. `.d.cache` is called out because it is the only kind
    // that can hand back a coding contract.
    + ((host.caches ?? []).length > 0
      ? `<p class="good">${host.caches!.length} unopened `
        + `cache${host.caches!.length === 1 ? "" : "s"}: ${esc(host.caches!.join(", "))}`
        + `${host.caches!.some((f) => f.endsWith(".d.cache")) ? " — a .d.cache can carry a contract" : ""}</p>`
      : "")
    + reclaimRow(host, d.charisma)
    + (modelRows.length > 0 ? definitions(modelRows) : note("no password model observed"))
    + (attemptRows.length > 0 ? collapsible("dnet.attempt", "attempts", definitions(attemptRows), true) : "")
    + collapsible("dnet.facts", "facts, with age", definitions(factRows(host, now, expiry)), true)
    + collapsible("dnet.neigh", "neighbours", neighbours, false),
  );
}

/** The beachhead and its crew: whether the controller is standing, where every
 * resident is, what each is doing, and where they die. This is the card that
 * answers "is the thing running at all" — which out there is a real question,
 * because the coordinator lives on a host that reboots. */
function crewCard(
  d: DarknetState,
  hosts: readonly DarknetKnownHost[],
  now: number,
  /** The digest-age caveat, or "" while the topic is publishing. Every "alive"
   *  and every beat below was decided controller-side at publish time, so the
   *  panel must not re-derive liveness here — that would have it contradict the
   *  controller. What it can do is say as of WHEN the answer was true. */
  digestNote: string,
  /** So the roster's own host buttons mark the selection the rest of the tab
   *  is showing; see `hostChip`. */
  selected: string,
): string {
  const knowledge = d.knowledge;
  const controller = knowledge?.controller;
  const queue = knowledge?.queue;
  const residents = hosts
    .filter((host) => host.agent !== undefined)
    .map((host) => ({ hostname: host.hostname, agent: host.agent! }));

  const summary = tiles([
    {
      label: "controller",
      value: controller ? (controller.alive ? "alive" : "silent") : NONE,
      // WHERE it is standing, not only whether it is: the controller lives on a
      // host that reboots, and "silent" plus a hostname is a place to look.
      sub: controller
        ? `${controller.host}${controller.pid !== undefined ? ` pid ${controller.pid}` : ""}`
          + ` · beat ${controller.lastBeatAt > 0 ? `${fmtTime(now - controller.lastBeatAt)} ago` : NONE}`
          + ` · ${controller.seedAttempts} seeds`
        : undefined,
    },
    {
      label: "residents",
      value: knowledge ? String(knowledge.agents.live) : NONE,
      sub: knowledge
        ? `${knowledge.agents.seenEver} seen · ${knowledge.agents.lostSinceBoot} lost`
        : undefined,
    },
    {
      label: hint("in flight", "jobs the residents are running right now, and what is queued behind them"),
      value: queue ? String(queue.active) : NONE,
      sub: queue
        ? `${queue.pending} queued${
          Object.keys(queue.byKind).length > 0
            ? ` · ${Object.entries(queue.byKind).map(([kind, n]) => `${kind}×${n}`).join(" ")}`
            : ""
        }`
        : undefined,
    },
  ]);

  // Newest beat first is the right default for "is the thing running at all",
  // but with a cap of sixteen it hid exactly the rows this card exists to show:
  // the dropped tail is always the stalest beats, which is every resident that
  // died, so the `N lost` figure in the tile above had no rows behind it. The
  // cap is now the tab's own, and the chips keep the lost reachable inside it
  // rather than flipping the default and truncating the crew doing the work.
  const crewShow = view("dnet.crewshow", "all");
  const lost = residents.filter((r) => !r.agent.alive);
  const shown = crewShow === "lost" ? lost : residents;
  const crewFilters = filters("dnet.crewshow", [
    { value: "all", label: "all", badge: String(residents.length) },
    { value: "lost", label: "lost", badge: String(lost.length) },
  ], "all");

  const roster = dataTable(
    "dnet.crew",
    shown,
    [
      {
        id: "host",
        label: "host",
        left: true,
        cell: (r) => hostChip(r.hostname, selected),
        sort: (r) => r.hostname,
      },
      {
        id: "beat",
        label: "beat",
        cell: (r) =>
          `<span class="${r.agent.alive ? "" : "bad"}">${fmtTime(now - r.agent.lastBeatAt)} ago</span>`,
        sort: (r) => -r.agent.lastBeatAt,
      },
      { id: "job", label: "job", left: true, cell: (r) => (r.agent.active ? esc(r.agent.active) : NONE), sort: (r) => r.agent.active ?? "" },
      { id: "queued", label: "queued", cell: (r) => String(r.agent.pending ?? 0), sort: (r) => r.agent.pending ?? 0 },
      {
        id: "free",
        label: "job capacity",
        cell: (r) => (r.agent.freeGb === undefined ? NONE : fmtRam(r.agent.freeGb)),
        sort: (r) => r.agent.freeGb ?? -1,
      },
      { id: "done", label: "done", cell: (r) => String(r.agent.completed ?? 0), sort: (r) => r.agent.completed ?? 0 },
      {
        id: "failed",
        label: "failed",
        cell: (r) => {
          const failed = r.agent.failed ?? 0;
          const markup = `<span class="${failed > 0 ? "bad" : ""}">${failed}</span>`;
          // The reason rides the count as a tooltip: a count with no reason is a
          // number nobody can act on, and a column of 200-char strings is worse.
          return r.agent.lastError ? `<span title="${esc(r.agent.lastError)}">${markup}</span>` : markup;
        },
        sort: (r) => r.agent.failed ?? 0,
      },
    ],
    {
      defaultSort: { key: "beat", dir: 1 },
      // Chosen by the FILTER, not by the table: "no resident is standing
      // anywhere yet" under the `lost` chip is a lie about a perfectly healthy
      // net. `dataTable` only knows that the list it was handed is empty.
      empty: crewShow === "lost" ? "no resident has been lost yet" : "no resident is standing anywhere yet",
      limit: TABLE_LIMIT,
    },
  );

  return card("Beachhead", summary + digestNote + crewFilters + roster);
}

export const dnetTab: Tab = {
  id: "dnet",
  render(state: ProjectedState) {
    const d = state.topics.dnet;
    // ONE representation. Home's own one-hop probe folds into the same knowledge
    // an agent feeds, so there is no second shape to render before the first
    // report lands — only a map that starts at `darkweb` and grows.
    // A titled card rather than a bare paragraph: this is the same empty state
    // as `lockedPanel()` for the same feature, and it lands in the same
    // two-track grid, so the two have to look like each other.
    if (!d?.knowledge) return waitingPanel("Darknet", "the darknet probe");

    const knowledge = d.knowledge;
    const hosts: DarknetKnownHost[] = knowledge.hosts;
    // The clock every age on this page is measured against. `bitNode` matters:
    // the net churns half as fast outside BN15, and a panel using a different
    // figure from the controller would call a fact stale that the decision was
    // still acting on. `stasisLinked` needs no set here — it arrives already
    // decided, as a per-host boolean.
    const now = knowledge.at;
    // The RUN's clock, beside the digest's own — the one thing that makes the
    // digest's age observable at all. It is the newest RECORD stamp and
    // deliberately not `Date.now()`: records are stamped by the emitter, so a
    // replay and a SIMULATED run (virtual time under `sim/realm/timers.ts`,
    // streamed live into the hub with `live === true`) are in the same clock
    // domain as `knowledge.at` while the viewer's wall clock is not — against
    // it a sim run would report a fabricated lag of days, on the one run type
    // this whole tab is A/B-read on. Floored at the digest stamp, because the
    // digest record can be the newest thing the viewer holds and "-40ms ago" is
    // the kind of detail that makes a reader distrust the page.
    //
    // `nowFor` deliberately NOT used, and it is the one panel that abstains:
    // this figure is what makes the darknet's OWN silence visible against every
    // other topic still publishing, so its ceiling has to be the newest record
    // and never wall time — which for a live game run `nowFor` folds in.
    const runNow = Math.max(state.lastT, knowledge.at);
    const digestLagMs = runNow - now;
    // Stated ONCE, and only when it matters: past a few publish intervals every
    // "alive", every beat and every countdown on this page is a statement about
    // a moment that has passed, and the cards that carry those say so rather
    // than each re-deriving liveness from a clock the controller never saw.
    const digestNote = digestLagMs > DIGEST_STALE_MS
      ? note(`the darknet topic stopped publishing ${fmtTime(digestLagMs)} ago — every reading below is as of then`)
      : "";
    // `netDepth` matters here twice. Every expiry below is derived from the
    // mutation clock, which is `30_000 / netDepth` — so leaving it out would put
    // the panel on the `DEFAULT_NET_DEPTH` fallback (5) while the driver ran on
    // the real depth, and the two would disagree about what is still believable.
    // It is also what lets the map draw the rows we have NOT reached; failing
    // the topic, the layout infers it from any labyrinth we have seen.
    // `backdoored` is the one `ExpiryOpts` input the digest does not carry, and
    // it is a SWITCH rather than a scale: `mutationBudget` branches on
    // `backdoored > 0` (rates.ts), which lifts `deleted` and `restarted` and
    // lowers everything else. So with one backdoor installed the panel and the
    // driver disagree in BOTH directions — position and topology expire ~11%
    // sooner here, resource facts ~35% later — and closing that needs the count
    // the tick itself used (`home.backdoored.size`) on the wire. Not guessed
    // here: a fabricated switch would be a second wrong answer rather than the
    // absence of one.
    const expiry: ExpiryOpts = {
      bitNode: state.topics.progression?.bitNode,
      ...(d.netDepth !== undefined ? { netDepth: d.netDepth } : {}),
    };

    const options = mapOptions(now, expiry, d.netDepth, d.spread?.why);
    // The ring, both table chips and the detail card, all off ONE name — see
    // `effectiveSel`. `dnet.sel` stays the operator's override; this only fills
    // in the default and drops a selection the digest no longer carries.
    const picked = view("dnet.sel");
    options.selected = effectiveSel(hosts, picked);
    const matched = options.query ? hosts.filter((host) => matches(host, options.query)) : hosts;

    // The three probe-only readings. They arrive from the PRICED PROBE and the
    // driver tick does not carry them, so a run whose first tick lands before
    // its first probe has a `knowledge` and none of these — which is exactly
    // the shape the panel used to throw on.
    const linked = d.stasisLinked;
    const instability = d.instability;

    const summary = tiles([
      {
        // QUALIFIED, and it has to stay qualified: the Knowledge card carries
        // the controller's uncapped census under the same words, and past the
        // digest cap the two are different populations with no wording to
        // separate them. This tile counts the rows the page actually draws —
        // the map below it and the `all` filter badge are the same rows — so it
        // is named after them, and the census keeps the word "known".
        label: hint("hosts on the map", "non-gone hosts in the published digest; the full census is in the Knowledge card"),
        // Counted OVER THE ROWS WE HAVE, not `hosts.length - gone`: the digest
        // caps `hosts` at KNOWLEDGE_MAX_HOSTS while `gone` is counted over every
        // host the controller holds (`publish.ts`), so subtracting one from the
        // other mixes two populations — it under-reports as soon as the cap
        // bites and goes NEGATIVE once more hosts are gone than the cap carries.
        value: String(knowledge.hosts.filter((entry) => entry.goneAt === undefined).length),
        // The digest caps at KNOWLEDGE_MAX_HOSTS, and a capped count that says
        // nothing about the cap is a smaller net than the one we are flying.
        // `totalHosts` counts gone hosts too — a third population — so the sub
        // says "seen" rather than letting it read as a total of this tile.
        sub: knowledge.truncated && knowledge.totalHosts !== undefined
          ? `of ${knowledge.totalHosts} seen — digest capped`
          : undefined,
      },
      {
        // The digest's OWN age. Every other age on this page is measured
        // against `knowledge.at`, so a driver that stops publishing froze all
        // of them at whatever they last said and nothing here could contradict
        // it: the map drew no fade, the crew card reported a fresh beat for a
        // resident nobody has heard from, and a countdown counted no further.
        label: hint("digest", "when the darknet driver last published; every other age on this page is measured against that stamp"),
        value: digestLagMs > DIGEST_STALE_MS
          ? html`<span class="bad">${fmtTime(digestLagMs)} ago</span>`
          : digestLagMs < 1_000 ? "now" : `${fmtTime(digestLagMs)} ago`,
        sub: `driver publishes every ${fmtTime(DIGEST_PUBLISH_MS)}`,
      },
      // -1 is getDepth's "no idea", not a depth. Rendering it would put the
      // sentinel on screen next to real rows.
      { label: "max depth", value: d.maxDepth >= 0 ? String(d.maxDepth) : NONE },
      {
        label: "cracked",
        value: String(d.coverage?.cracked ?? 0),
        sub: d.coverage?.plantable !== undefined ? `${d.coverage.plantable} plantable` : undefined,
      },
      {
        label: "agents",
        value: String(knowledge.agents.live),
        // The gap between agents seen and agents still reporting IS agent
        // mortality, and out there that is the loss that actually matters.
        sub: knowledge.agents.lostSinceBoot > 0 ? `${knowledge.agents.lostSinceBoot} lost` : undefined,
      },
      {
        label: "stasis links",
        value: linked === undefined || d.stasisLinkLimit === undefined
          ? NONE
          : `${linked.length} / ${d.stasisLinkLimit}`,
        sub: linked === undefined ? "awaiting the probe" : undefined,
      },
      {
        label: hint("mutation", "how often the net rearranges itself"),
        value: d.mutationIntervalMs === undefined ? NONE : fmtTime(d.mutationIntervalMs),
        sub: knowledge.mutationsSeen !== undefined ? `${knowledge.mutationsSeen} seen` : undefined,
      },
      {
        label: "auth duration",
        value: instability === undefined ? NONE : `x${fmtNum(instability.authenticationDurationMultiplier, 2)}`,
        sub: instability === undefined ? "awaiting the probe" : undefined,
      },
      {
        label: "timeout chance",
        value: instability === undefined ? NONE : fmtPct(instability.authenticationTimeoutChance),
      },
    ]);

    const controls =
      `<div class="netcontrols">`
      + search("dnet.q", "search host, model, hint")
      + filters("dnet.zoom", [
        { value: "40", label: "40%" },
        { value: "60", label: "60%" },
        { value: "80", label: "80%" },
        { value: "100", label: "100%" },
      ], "100")
      + filters("dnet.edges", [
        {
          value: "tree",
          label: "near",
          // Laterals are the only HARD evidence the column inference has, so
          // hiding them by default made a correctly-constrained row look
          // arbitrary. This drops only the long back edges.
          title: "parent links and same-row links; hides the long ones",
        },
        { value: "all", label: "all links" },
        { value: "none", label: "no links", title: "contradictory links are still drawn" },
      ], "tree")
      + `</div>`
      // Search HIGHLIGHTS rather than removes, the way the in-game search box
      // does: the shape of the net is the point, and filtering it away to seven
      // boxes destroys the thing you came to look at.
      + (options.query ? note(`${matched.length} of ${hosts.length} match — non-matches dimmed, not removed`) : "");

    const showFilter = view("dnet.show", "all");
    const tableHosts = hosts.filter((host) => {
      if (options.query && !matches(host, options.query)) return false;
      switch (showFilter) {
        case "cracked": return host.credentialKnown === true;
        case "locked": return host.authState === "auth-required";
        case "roomy": return (host.usableRam ?? 0) >= AGENT_RAM_GB;
        case "stale": return isStale(host, now, expiry);
        case "gone": return host.goneAt !== undefined;
        default: return true;
      }
    });
    const ramValue = (host: DarknetKnownHost, key: "total" | "blocked" | "used" | "unused"): number | undefined =>
      ramBuckets(host)?.[key];
    const ramCell = (host: DarknetKnownHost, key: "total" | "blocked" | "used" | "unused"): string => {
      const value = ramValue(host, key);
      return value === undefined ? NONE : fmtRam(value);
    };

    const servers = dataTable(
      "dnet.servers",
      tableHosts,
      [
        {
          id: "host",
          label: "host",
          left: true,
          // The accessible route to selection: a real button, unlike the SVG
          // group, which cannot be activated from the keyboard.
          cell: (h) => hostChip(h.hostname, options.selected),
          sort: (h) => h.hostname,
        },
        {
          id: "depth",
          label: "depth",
          cell: (h) => depthLabel(h),
          // `-1` means three different things (see `depthLabel`), so the sort
          // has to separate them the way the map does rather than lump them:
          // darkweb is the ROOT and belongs at the top, the labyrinths sit below
          // every placed host, and a row we cannot place sorts last of all —
          // sending darkweb to the bottom with the unplaced put the shop out of
          // the table's own row limit on a deep net.
          sort: (h) => {
            if (h.isDarkweb === true || h.hostname === "darkweb") return -1;
            if (isLabyrinth(h.hostname, h.modelId)) return 998;
            return h.depth === undefined || h.depth < 0 ? 999 : h.depth;
          },
        },
        { id: "model", label: "model", left: true, cell: (h) => (h.modelId ? esc(h.modelId) : NONE), sort: (h) => h.modelId ?? "" },
        { id: "total", label: "total RAM", cell: (h) => ramCell(h, "total"), sort: (h) => ramValue(h, "total") ?? -1 },
        { id: "blocked", label: "blocked", cell: (h) => ramCell(h, "blocked"), sort: (h) => ramValue(h, "blocked") ?? -1 },
        { id: "used", label: "used", cell: (h) => ramCell(h, "used"), sort: (h) => ramValue(h, "used") ?? -1 },
        { id: "unused", label: "unused", cell: (h) => ramCell(h, "unused"), sort: (h) => ramValue(h, "unused") ?? -1 },
        {
          id: "charisma",
          label: "charisma",
          cell: (h) => (h.requiredCharisma === undefined ? NONE : fmtNum(h.requiredCharisma, 0)),
          sort: (h) => h.requiredCharisma ?? -1,
        },
        {
          id: "seen",
          label: "seen",
          cell: (h) => (h.lastSeenAt > 0 ? fmtTime(now - h.lastSeenAt) : NONE),
          sort: (h) => -h.lastSeenAt,
        },
        {
          id: "state",
          label: "state",
          // The auth state comes from AUTH_LABEL rather than being enumerated
          // again here. It was enumerated twice, and the copy in this column was
          // the one missing `offline` — so a host that answered "I am not there"
          // rendered as a blank. Everything below AUTH_LABEL is ADDITIVE and
          // independent of it, which is why those stay a list.
          cell: (h) => {
            const auth = h.authState === undefined
              ? ""
              : `<span class="${h.authState === "session" || h.authState === "authenticated" ? "good" : "muted"}">`
                + `${esc(AUTH_LABEL[h.authState])}</span>`;
            return [
              auth,
              h.goneAt !== undefined ? `<span class="bad">gone</span>` : "",
              h.stasisLinked ? `<span class="good">pinned</span>` : "",
              h.isStationary ? `<span class="muted">fixed</span>` : "",
              isStale(h, now, expiry) ? `<span class="muted">stale</span>` : "",
            ].filter(Boolean).join(" ") || NONE;
          },
          sort: (h) => h.authState ?? "",
        },
      ],
      { defaultSort: { key: "depth", dir: 1 }, empty: "nothing observed yet", limit: TABLE_LIMIT },
    );

    // --- the password surface, in two halves --------------------------------
    //
    // It used to be one table whose last column was "why untouched". With
    // nineteen solvers written and the five dictionary models walked by
    // `planAttempt`, that column is now a column of "implemented" — it answers a
    // question nobody is asking any more. What an operator wants for those
    // twenty-three is HOW FAR: which are running, how much of the budget is
    // spent, and what the host last said. The genuinely unopenable remainder —
    // the labyrinth, and any model id the game invents that we have not
    // transcribed — still wants the raw material, so it keeps its own table.
    const attempted = hosts.filter((h) => h.modelId !== undefined);

    /** Ordered candidates for a dictionary model, so the table can say n of N.
     *  Derived from the id and the published password facts exactly as the
     *  oracle and the model name are — the count is a pure function of both. */
    const candidateTotal = (h: DarknetKnownHost): number | undefined =>
      modelEntry(h.modelId)?.candidates?.(passwordFacts(h)).length;

    /** A feedback solver's budget for this host.
     *  Derived, not shipped: `Solver.budget(facts)` is a pure function of the
     *  password facts the digest already carries, exactly like the model's name
     *  and its oracle. */
    const solverBudget = (h: DarknetKnownHost): number | undefined =>
      solverFor(h.modelId)?.budget(passwordFacts(h));

    /** One number both progress shapes sort on, so the column orders sensibly
     *  whichever kind of attack a host is under. */
    const solveFraction = (h: DarknetKnownHost): number => {
      const solve = h.attempt?.solve;
      const budget = solverBudget(h);
      if (solve !== undefined && budget !== undefined && budget > 0) return solve.spent / budget;
      const total = candidateTotal(h);
      return total ? (h.attempt?.tried ?? 0) / total : -1;
    };

    // Solved first, then whatever is moving, then the untouched — the order an
    // operator scans in.
    const STATUS_RANK: Record<string, number> = { solved: 0, failed: 1, unattempted: 2, "unknown-model": 3 };

    const solveProgress = dataTable(
      "dnet.solveprog",
      attempted,
      [
        {
          id: "host",
          label: "host",
          left: true,
          cell: (h) => hostChip(h.hostname, options.selected),
          sort: (h) => h.hostname,
        },
        { id: "model", label: "model", left: true, cell: (h) => esc(h.modelId ?? ""), sort: (h) => h.modelId ?? "" },
        {
          id: "status",
          label: "status",
          left: true,
          cell: (h) => {
            const opens = solverStatus(h.modelId);
            const status = h.attempt?.status ?? "unattempted";
            // The registry's verdict and the ledger's are different facts — one
            // says whether we CAN open this model, the other how the last try
            // went — so the dot reports the LEDGER. Showing the registry's
            // "implemented" as a green dot beside the word "failed" was the
            // panel telling an operator two different things in one cell.
            const mark: Status = status === "solved"
              ? "good"
              // Failure is the normal case out there: a wrong guess is not
              // punished, and the conversation continues.
              : status === "failed"
                ? "wait"
                : status === "unknown-model"
                  ? "bad"
                  : opens.status === "good" ? "ready" : opens.status;
            return `${dot(mark, opens.status === "good" ? "a solver exists for this model" : "no solver")} ${esc(status)}`;
          },
          sort: (h) => STATUS_RANK[h.attempt?.status ?? "unattempted"] ?? 9,
        },
        {
          id: "progress",
          label: "progress",
          cell: (h) => {
            // A feedback solver measures itself in attempts against a budget; a
            // dictionary measures itself in candidates ruled out. They are not
            // the same denominator, so neither is forced into the other's.
            const solve = h.attempt?.solve;
            const budget = solverBudget(h);
            if (solve !== undefined && budget !== undefined && budget > 0) {
              return meter(Math.min(1, solve.spent / budget), `${solve.spent}/${budget}`);
            }
            const tried = h.attempt?.tried ?? 0;
            const total = candidateTotal(h);
            if (total === undefined || total === 0) return tried > 0 ? String(tried) : NONE;
            return meter(Math.min(1, tried / total), `${tried}/${total}`);
          },
          sort: (h) => solveFraction(h),
        },
        {
          id: "phase",
          label: "phase",
          left: true,
          // Solver-defined, and the one field that says WHAT the conversation is
          // doing rather than how much of it is left.
          cell: (h) => (h.attempt?.solve?.phase ? esc(h.attempt.solve.phase) : NONE),
          sort: (h) => h.attempt?.solve?.phase ?? "",
        },
        {
          id: "probes",
          // `dataTable` escapes its labels as text, so the explanation lives in
          // the detail card's own `probes` row rather than as a hint here.
          label: "probes",
          cell: (h) => String(h.attempt?.probes ?? 0),
          sort: (h) => h.attempt?.probes ?? 0,
        },
        {
          id: "code",
          label: "last code",
          left: true,
          cell: (h) =>
            h.attempt?.lastCode === undefined
              ? NONE
              : `${h.attempt.lastCode} ${esc(codeName(h.attempt.lastCode))}`,
          sort: (h) => h.attempt?.lastCode ?? -1,
        },
        {
          id: "ago",
          // A code with no age is a number nobody can act on: it does not say
          // whether the conversation is live or was abandoned an hour ago.
          label: "ago",
          cell: (h) => (h.attempt?.lastAt === undefined ? NONE : fmtTime(now - h.attempt.lastAt)),
          sort: (h) => -(h.attempt?.lastAt ?? 0),
        },
      ],
      { defaultSort: { key: "status", dir: 1 }, empty: "nothing has been attempted yet", limit: TABLE_LIMIT },
    );

    // The remainder: everything the registry cannot open. `entry.blocked` is
    // deleted the moment a solver is written, so this list empties itself.
    const unsolved = attempted.filter((h) => solverStatus(h.modelId).status !== "good");
    const unsolvedSurface = table(
      [
        "host",
        hint("model", "similar models share vulnerabilities; the list is undocumented upstream"),
        "password",
        "hint",
        "data",
        hint("oracle", "what a wrong guess tells you, and where it appears — what a solver is written against"),
        "blocked on",
      ],
      unsolved.map((h) => [
        esc(h.hostname),
        esc(h.modelId ?? ""),
        h.passwordLength === undefined ? NONE : `${h.passwordLength} × ${esc(h.passwordFormat ?? "?")}`,
        h.passwordHint ? esc(h.passwordHint) : NONE,
        h.data ? esc(h.data) : NONE,
        esc(modelEntry(h.modelId)?.oracle ?? ""),
        solverStatus(h.modelId).label,
      ]),
      {
        empty: "every model we have seen has a solver",
        left: [0, 1, 3, 4, 5, 6],
        wrap: [3, 4, 5, 6],
      },
    );

    const plan = d.plan;
    const decision = plan
      ? tiles([
        { label: "charisma gate", value: plan.charismaNeeded === undefined ? "clear" : fmtNum(plan.charismaNeeded, 0) },
        { label: "topology", value: d.topologyComplete ? "complete" : "partial" },
      ])
        // Ranked, not SELECTED. Spending a link is not something home can do —
        // `setStasisLink` pins the calling host — so there is no chosen row to
        // highlight, and pretending otherwise was the panel's half of a decision
        // nothing carried out.
        + table(
          ["host", "depth", "servers kept reachable"],
          plan.ranked.map((entry) => [esc(entry.hostname), String(entry.depth), String(entry.unlocks)]),
          { empty: "no stasis candidates; the map is still partial", left: [0] },
        )
        + (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first darknet decision");

    // What agents delivered, and how healthy the delivery is. `known` only moves
    // when a report is drained, so a host an agent saw and never delivered is an
    // agent that died first — see spec/dnet.md.
    const cover = d.coverage;
    const reach = cover
      ? definitions([
        // The CENSUS, uncapped — the header tile counts the digest's rows, and
        // the two are different populations past KNOWLEDGE_MAX_HOSTS. Kept as
        // `cover.known` because the next row uses it as a denominator, so both
        // have to stay over the same population.
        ["hosts known (census)", String(cover.known)],
        ["adjacency known", `${cover.adjacencyKnown} / ${cover.known}`],
        ["believed fresh", meter(cover.freshFraction, fmtPct(cover.freshFraction))],
        ["gone", String(cover.gone)],
        ...(cover.cracked !== undefined ? [["cracked", String(cover.cracked)] as [Markup, Markup]] : []),
        ...(cover.plantable !== undefined
          ? [[hint("plantable", "cracked AND with believable room for an agent"), String(cover.plantable)] as [Markup, Markup]]
          : []),
      ])
      : note("no agent report has been folded yet");

    // Every darknet call answers with a code, so a refusal is always
    // attributable rather than a blank.
    const codes = Object.entries(d.codes ?? {})
      .sort((a, b) => b[1] - a[1])
      // A table cell is a RAW slot (lib/dom.ts): the key is a wire string, not
      // a number, so it is escaped like every other Record key in this file.
      .map(([code, count]) => [esc(code), esc(codeName(Number(code))), String(count)]);

    // Why the net is not growing. `planSpread` names every refusal and nothing
    // rendered them, so a planner that had run out of reachable hosts looked
    // exactly like one that had stopped working — and the caps that were removed
    // in favour of these six would have been unobservable either way.
    const spread = d.spread;
    const spreadCard = spread
      ? card(
        "Spreading",
        definitions([
          [hint("planted", "plants the last derivation admitted; every reachable neighbour is a candidate"), String(spread.planted)],
        ])
        + refusals(spread.refused, spread.examples, "nothing refused; every reachable host has an agent"),
      )
      : "";

    // What the residents are DOING with the hosts they hold, once those hosts
    // have stopped teaching us anything. A strict ladder admits one rung per
    // host, so the refusals are not noise — they are the rest of the sentence:
    // "phishing, because there is no cache and no block worth grinding".
    const farming = d.farm;
    const farmCard = farming
      ? card(
        "Farming",
        definitions([
          // The caption sits on the ROW rather than over the card because
          // neither of these lists is homogeneous: `admitted` is what the LAST
          // derivation admitted, while `karma` below it is cumulative for the
          // run and the phish window under that is live engine state. A block
          // caption would mislabel two of the three. `kind` is not `esc`-ed —
          // `hint()` takes a TEXT slot and escapes it for us.
          ...Object.entries(farming.admitted)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, n]) => [hint(kind, "tasks the last derivation admitted"), String(n)] as [Markup, Markup]),
          ...(farming.cacheHunter !== undefined
            ? [[
              hint("cache hunter", "one .d.cache every three minutes for the WHOLE net, and the roll scales with threads — so the threads go to one deep resident rather than being spread thin"),
              esc(farming.cacheHunter),
            ] as [Markup, Markup]]
            : []),
          [
            hint("expected cash", "forward phishing cash from the admitted fleet; cache rewards are excluded"),
            `${fmtMoney(farming.expectedMoneyPerSec)}/s`,
          ],
          [
            hint("expected charisma", "exact expected charisma XP from admitted phishing and promotion tasks"),
            `${fmtNum(farming.expectedCharismaExpPerSec)}/s`,
          ],
          ...(d.karmaLoss !== undefined
            ? [[
              hint("karma", "karma only ever moves down and survives an install, so a cache is free progress toward the gang's -54000"),
              String(Math.round(d.karmaLoss)),
            ] as [Markup, Markup]]
            : []),
          // The one piece of engine state no ns member exposes, so our own
          // sightings are the only evidence there is. Whether the window is open
          // decides whether a phish can pay a cache at all — every call while it
          // is shut falls straight through to the money branch.
          ...(farming.lastPhishCacheAt !== undefined
            ? [[
              hint("phish window", "one .d.cache every three minutes for the WHOLE net; while it is shut every call falls through to money"),
              (() => {
                // Against the RUN clock, not the digest's: this is an absolute
                // engine window rather than the age of an observation, so on
                // `now` it only ever moved when the digest moved — a
                // three-minute countdown in thirty-second jumps, frozen for
                // good the moment the driver stopped.
                const left = PHISH_CACHE_COOLDOWN_MS - (runNow - farming.lastPhishCacheAt!);
                return left <= 0
                  ? `<span class="good">open</span>`
                  : `<span class="muted">shut — ${fmtTime(left)} left</span>`;
              })(),
            ] as [Markup, Markup]]
            : []),
        ])
        + refusals(
          farming.refused,
          farming.examples,
          "every resident took the top rung of the ladder",
          "latest planner pass; these are host counts, not failures or lifetime totals. One host can skip several ladder steps.",
          ["ladder step skipped", "hosts", "why"],
        ),
      )
      : "";

    // Since-install counters, updated only when a farm call settles. No probe
    // exists for this card: it is folded from results the agents already hold.
    // Promotion is deliberately not converted to dollars—the call changes
    // volatility and neither the game nor the strategy can attribute realized
    // stock P&L to one batch.
    const profit = d.profit;
    const profitCard = profit
      ? card(
        "Returns",
        definitions([
          [
            hint("observed cash", "phishing + cache cash at the display precision returned by the API; collected without an extra getPlayer call"),
            fmtMoney(profit.phishCash + profit.cacheCash),
          ],
          [
            "phishing",
            `${profit.phishSuccesses} successful / ${profit.phishAttempts} attempts · ${fmtMoney(profit.phishCash)} · ${profit.phishCachesCreated} caches`,
          ],
          [
            "caches",
            `${profit.cachesOpened} opened · ${fmtMoney(profit.cacheCash)} · ${fmtNum(profit.cacheShares, 0)} shares`,
          ],
          [
            hint("phish cache funnel", "created .d.cache files, opened .d.cache files, then exact .cct files observed after open"),
            `${profit.phishCachesCreated} created; ${profit.phishCachesOpened} opened; ${profit.cacheContractsCreated} CCT files`,
          ],
          [
            hint("data files", "post-cache files read through the general darknet clue parser and then removed"),
            `${profit.cacheDataFilesRead} read; ${profit.cacheDataFilesParsed} parsed`,
          ],
          [
            hint("stock promotion", "successful propaganda batches and their threads; raises volatility but has no honest direct-cash attribution"),
            `${profit.promotionBatches} successful / ${profit.promotionAttempts} attempts · ${fmtNum(profit.promotionThreads, 0)} threads`,
          ],
        ])
        + (Object.keys(profit.cacheRewards).length > 0
          ? table(
            ["cache reward", "n"],
            Object.entries(profit.cacheRewards)
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([reward, count]) => [esc(reward), String(count)]),
            { left: [0] },
          )
          : "")
        + (Object.keys(profit.promotionSymbols).length > 0
          ? note(`promoted ${Object.entries(profit.promotionSymbols)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([symbol, count]) => `${esc(symbol)} ×${count}`)
            .join(" · ")}`)
          : ""),
      )
      : "";

    // --- the labyrinth -------------------------------------------------------
    //
    // The feature's whole point, and until now the only part of it with no
    // readout: a walk holds a host for hours and the panel could say nothing
    // about it beyond "active: walk" on a resident row. Three things are worth
    // knowing while one is running and none of them were visible — how far it
    // has got, when it expects to arrive, and whether a mutation can take it.
    //
    // Almost everything here is DERIVED from the hostname rather than sent:
    // `labStage` gives the rung and the charisma gate, `labPrior` turns that
    // into the produced maze size, the seams and the exit candidates. The one
    // thing no formula supplies is what the walkers have SEEN, and that is the
    // one thing `d.lab` carries.
    //
    // Most runs never reach a lab at all, so every branch below degrades: no
    // sighting draws no card, a sighting with no walk draws the ladder and the
    // reason we are not walking, and a walk draws the maze.
    const labCache = d.labCache;
    const lab = d.lab;
    const seenLabs = hosts.filter((h) => isLabyrinth(h.hostname, h.modelId));
    const currentDepth = d.netDepth;
    const rung = currentDepth === undefined
      ? undefined
      : LAB_LADDER.findIndex((entry) => entry.depth === currentDepth);
    const stage = rung !== undefined && rung >= 0 ? LAB_LADDER[rung] : undefined;
    // The lab this card is about: the one being walked, else the deepest one we
    // have laid eyes on, else the rung the net's depth implies.
    const labHost = lab?.host ?? seenLabs[seenLabs.length - 1]?.hostname ?? stage?.hostname;
    // Whether this maze is already behind us. A credential for a lab host can
    // only have come from reaching the exit — the engine refuses the lab's own
    // password on purpose — so it is a stronger statement than any refusal.
    const labSolved = labHost !== undefined
      && seenLabs.some((h) => h.hostname === labHost && h.credentialKnown === true);
    // Why we are not walking, straight from the planner that declined. These
    // used to be reachable only by hunting through the Deliberate card's
    // refusal table, which meant the answer to "why has the maze not started"
    // lived in a different card from the maze.
    const labRefusals = (d.hold?.examples ?? []).filter((entry) => entry.host === labHost);
    const walkers = lab?.walkers ?? [];
    // Empty for a grid that does not match its own dimensions — a shape change
    // between a running controller and a rebuilt panel. The legend follows the
    // maze rather than the digest, so a card that could not draw one does not
    // caption it either.
    const maze = lab === undefined ? "" : labMaze(lab, labPriorFor(lab));
    // And it does not QUOTE numbers off that grid either. `labExplored` reads
    // the same string at the same stride and treats every out-of-range cell as
    // unknown, so a grid the renderer refused used to print a confident
    // "mapped 0%" and "0 of N wall slots resolved" beside a deliberately blank
    // maze. The maze's own emptiness IS the shape test; comparing the lengths
    // again here would be a second copy of it, free to drift from the first.
    const explored = lab !== undefined && maze !== "" ? labExplored(lab) : undefined;
    const etaMs = lab ? labEtaMs(lab) : undefined;
    // Whether the picture has stopped moving. `home.lab` is intentionally never
    // blanked — the card would flicker between a map and an empty state — so
    // once the controller dies with its host the digest keeps shipping the last
    // walker snapshot, and the beat is the only thing that can say so.
    const walkStalled = walkers.length > 0 && walkers.every((walker) => now - walker.beatAt > WALK_STALE_MS);

    /** One walker, as a line rather than a table row: the numbers matter less
     *  than which of the two we cannot afford to lose.
     *
     *  `startedAt` and `beatAt` travel on every walker and reached nothing but
     *  `walkerEtaMs`' arithmetic, which is why a walk holding a host for hours
     *  could not say how long it had been running — and why a walk that stopped
     *  beating kept printing the same estimate. Both halves of that quotient are
     *  stamps, so when they freeze the figure does too. */
    const walkerLine = (walker: DarknetLabWalker): string => {
      const beatAge = Math.max(0, now - walker.beatAt);
      const stalled = beatAge > WALK_STALE_MS;
      const eta = stalled ? undefined : walkerEtaMs(walker);
      const role = "finisher";
      return `<div class="labwalker">`
        + `<span class="who ${role}">${dot(walker.pinned ? "good" : "wait", walker.pinned
          ? "stasis-pinned: a mutation cannot move or delete this host"
          : "not pinned: a mutation can take this walker, and its position dies with the PID")}`
        + ` ${esc(role)}</span>`
        + `<span class="muted">on ${esc(walker.from)}${walker.at ? ` at ${esc(walker.at)}` : ""}</span>`
        + `<span class="num">${plural(walker.moves, "move")}`
        + (walker.walls > 0 ? ` · ${plural(walker.walls, "wall")}` : "")
        + (walker.radars > 0 ? ` · ${plural(walker.radars, "radar")}` : "")
        + `</span>`
        + `<span class="num">for ${fmtTime(Math.max(0, now - walker.startedAt))}</span>`
        // The status class sits on a span of its OWN: `.labwalker .num` is
        // specificity (0,2,0) and would beat `.bad` at (0,1,0), so a `num bad`
        // would silently render muted. And the line says STALLED rather than
        // dropping the estimate, so the card explains why the number went away.
        + (stalled
          ? `<span class="bad" title="the controller gives up on a long-lived job after 30s of silence, so a walker still on this card is a frozen snapshot rather than a slow walk">`
            + `beat ${fmtTime(beatAge)} ago — stalled</span>`
          : `<span class="num">beat ${fmtTime(beatAge)} ago</span>`
            + (eta !== undefined ? `<span class="num">~${fmtTime(eta)} left</span>` : ""))
        + `</div>`;
    };

    const labCard = labCache !== undefined || seenLabs.length > 0 || stage !== undefined || lab !== undefined
      ? card(
        "Labyrinth",
        tiles([
          {
            label: "rung",
            value: stage === undefined ? NONE : `${(rung ?? 0) + 1} / ${LAB_LADDER.length}`,
            sub: labHost,
          },
          {
            label: hint("charisma gate", "the movement handler gates on charisma and nothing else — below it every move answers 451"),
            // Written out rather than through `fmtNum`, which switches to
            // scientific notation at a thousand. These are exact registry
            // thresholds a reader compares against their own charisma, and
            // `2.500e3` beside `have 2.740e3` obscures the one comparison the
            // tile exists to make.
            value: stage === undefined ? NONE : String(stage.cha),
            sub: d.charisma !== undefined ? `have ${Math.round(d.charisma)}` : undefined,
          },
          // The two tiles that only mean something while a walk is running swap
          // in for the two that only mean something before one starts.
          ...(lab !== undefined
            ? [
              {
                label: hint("mapped", "wall slots the walkers have resolved, out of the ones the generator actually decides"),
                // The dash is reachable for the first time here, and on its own
                // it would read as "no walk yet" — a different and wrong claim —
                // so the shape fact goes in the sub the size already occupies.
                value: explored === undefined ? NONE : fmtPct(explored.fraction),
                sub: explored === undefined
                  ? `grid does not match ${lab.width} x ${lab.height}`
                  : `${lab.width} x ${lab.height}`,
              },
              {
                label: hint(
                  "eta",
                  "the planner's own plan cost, calibrated for its optimism (median 1.31x, quartiles 0.97-1.81) and"
                  + " priced at this walk's own measured pace — so threads, charisma and The B00ts are already in it",
                ),
                // Suppressed rather than restated once the walkers stop
                // beating: the pace is `beatAt - startedAt` over `attempts`, so
                // a frozen walker prints the same "~14m left" forever on the
                // panel's lead card. The MAP stays either way — a map does not
                // go stale, a pace does.
                value: walkStalled || etaMs === undefined ? NONE : fmtTime(etaMs),
                sub: walkStalled
                  ? "no walker is beating"
                  : walkers.length > 1 ? `soonest of ${walkers.length}` : undefined,
              },
            ]
            : [
              { label: "net depth", value: currentDepth === undefined ? NONE : String(currentDepth) },
              { label: "labs seen", value: String(seenLabs.length) },
            ]),
        ])
        // --- what is actually happening --------------------------------------
        + (labSolved
          ? note(raw(`<span class="good">this maze is finished</span> — the exit was reached and ${esc(labHost ?? "the lab")} is rooted`))
          : walkers.length > 0
            ? `<div class="labwalkers">${walkers.map(walkerLine).join("")}</div>`
            : lab !== undefined
              // A map with nobody on it: the walk died with its host and the
              // controller has not re-filed one yet. Worth saying out loud, because
              // the map still being there is exactly what makes it recoverable.
              ? note("no walker is in the maze right now — the map below outlives them, so the next one resumes from it")
              : "")
        // --- the maze --------------------------------------------------------
        + (maze === "" ? "" : maze + labMazeLegend())
        + (lab !== undefined
          ? definitions([
            [
              hint("exit", "the endpoint is [w-2, h-2] less a 0/2/4 jitter on each axis, so nine cells on the deep rungs"),
              lab.exitKnown
                ? `<span class="good">${esc(lab.candidates[0] ?? "found")}</span>`
                // The COUNT is the fact worth reading at a glance — nine pairs
                // of coordinates is a wall of text in a narrow column — so the
                // list appears only once it is short enough to be a shortlist.
                : `<span class="muted">${plural(lab.candidates.length, "candidate")} left`
                  + (lab.candidates.length <= 3 ? ` — ${esc(lab.candidates.join(", "))}` : "")
                  + `</span>`,
            ],
            ...(explored !== undefined
              ? [[
                hint("shared map", "the field survives the PID-bound walker, so a replacement keeps discoveries but not position"),
                `${explored.known} of ${explored.total} wall slots resolved`,
              ] as [Markup, Markup]]
              : []),
          ])
          : "")
        // --- why not, when not -----------------------------------------------
        //
        // The refusals for THIS host, in the card the question is asked in.
        + (!labSolved && walkers.length === 0 && labRefusals.length > 0
          ? table(
            ["not walking", "why"],
            labRefusals.map((entry) => [esc(entry.why), esc(entry.detail)]),
            { left: [0, 1], wrap: [1] },
          )
          : "")
        // --- the deferred cache ----------------------------------------------
        //
        // Opening one queues an augmentation DIRECTLY, and the generic price
        // multiplier is 1.9 ^ (queued non-SoA) charged against everything bought
        // afterwards — so it is the one cache that waits, and "can it be opened
        // yet" is a decision home makes rather than a status the net reports.
        + (labCache !== undefined
          ? definitions([
            [
              hint(
                "deferred cache",
                "getLabReward queues an augmentation directly, and the price multiplier is 1.9 ^ queued —"
                + " so it waits for the last purchase of an install cycle",
              ),
              `${dot(labCache.openable ? "ready" : "wait")} ${esc(labCache.filename)}`
              + ` <span class="muted">on ${esc(labCache.host)}</span>`,
            ],
            [
              "openable",
              labCache.openable
                ? `<span class="good">yes — home has cleared the last purchase</span>`
                : `<span class="muted">held; opening it now would multiply the rest of the cycle's bill</span>`,
            ],
          ])
          : note("no labyrinth cache is waiting"))
        // The ladder is reference data — a static registry table of the charisma
        // ramp — so it folds away behind the live walk rather than pushing it
        // off the bottom of the card.
        + collapsible(
          "dnet.ladder",
          "the ladder — eight rungs, 300 to 4000 charisma",
          table(
            ["lab", "net depth", "charisma", "seen"],
            LAB_LADDER.map((entry, index) => [
              index === rung ? `<span class="good">${esc(entry.hostname)}</span>` : esc(entry.hostname),
              String(entry.depth),
              // Coloured against what we actually have, so the ladder reads as a
              // plan rather than a table of constants.
              d.charisma === undefined
                ? String(entry.cha)
                : `<span class="${d.charisma >= entry.cha ? "good" : "muted"}">${entry.cha}</span>`,
              seenLabs.some((h) => h.hostname === entry.hostname) ? `<span class="good">yes</span>` : NONE,
            ]),
            { left: [0] },
          ),
          false,
        ),
      )
      : "";

    // --- the deliberate three ------------------------------------------------
    //
    // Spreading and cracking are unbounded: an attempt costs only time and a
    // wrong guess is not even punished, so their planners mostly say yes. These
    // do not. A stasis link is one of at most four slots in the whole run, an
    // induced migration is a long charge that can lose the host outright, and a
    // backdoor is a two-slot recycler for harvested low-RAM hosts. "Why not" is
    // the usual answer here, which is why the refusals
    // get as much room as the actions.
    const hold = d.hold;
    const backdoors = hold?.backdoors;
    const holdCard = hold
      ? card(
        "Deliberate",
        definitions([
          [
            hint("pinned", "setStasisLink pins the CALLING host, so spending a link needs a resident standing on it"),
            linked === undefined || d.stasisLinkLimit === undefined
              ? NONE
              : `${linked.length} / ${d.stasisLinkLimit}`
              + (linked.length > 0 ? ` <span class="muted">· ${esc(linked.join(", "))}</span>` : ""),
          ],
          // Per-derivation, and captioned per row for the same reason as the
          // Farming list: `pinned` above it is live stasis state, not a count of
          // anything this tick admitted.
          ...Object.entries(hold.admitted)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, n]) => [hint(kind, "actions the last derivation admitted"), String(n)] as [Markup, Markup]),
        ])
        + refusals(hold.refused, hold.examples, "nothing was declined")
        + (backdoors
          ? collapsible(
            "dnet.backdoors",
            "backdoors — installed from HOME",
            // No longer advice: home walks its terminal out along the folded
            // adjacency and installs these itself, because
            // `singularity.installBackdoor` acts on the terminal's current
            // server and only home has a terminal. The policy keeps exactly two
            // on fully harvested low-RAM hosts: restart merely clears one, while
            // deletion lets a later addition mint two fresh cache opportunities.
            note(
              "installed from home's terminal along the folded adjacency, because ns.scan cannot see the darknet;"
              + " two harvested low-RAM hosts are recycled, and a stale hop refuses the whole route rather than stranding"
              + " the terminal out there",
            )
            + (backdoors.install.length > 0
              ? definitions([["would install", esc(backdoors.install.join(", "))]])
              : "")
            + refusals(backdoors.refused, backdoors.examples, "nothing was declined"),
            false,
          )
          : ""),
      )
      : "";

    // --- the storm -----------------------------------------------------------
    //
    // The refusal names ARE the status display: with everything prepared, the
    // one open gate says exactly what the storm is waiting for —
    // "phish-window-open" means it fires behind the next .d.cache. The stamps
    // travel; the intervals are constants.
    const stormReport = d.storm;
    const stormCard = stormReport
      ? card(
        "Storm",
        definitions([
          [
            hint("seed", "STORM_SEED.exe — drops from a cleared RAM block (15% roll), fires only from the host holding it"),
            stormReport.seedHost !== undefined
              ? esc(stormReport.seedHost)
              + (stormReport.seedSeenAt !== undefined
                ? ` <span class="muted">· seen ${Math.round((now - stormReport.seedSeenAt) / 1000)}s ago</span>`
                : "")
              : NONE,
          ],
          ...(stormReport.seedHunt === true
            ? [[
              hint("seed hunt", "the reclaim clear budget is lifted: every block ground to zero is a seed roll"),
              "grinding blocks for rolls",
            ] as [Markup, Markup]]
            : []),
          ...(stormReport.firedAt !== undefined
            ? [[
              hint("last storm", "the engine mints no seed for 30 minutes after a storm; the clock is our own stamp"),
              // The cooldown is the engine's own thirty minutes, so it is
              // measured against the run clock for the same reason as the phish
              // window above; the seed SIGHTING a few rows up stays on `now`,
              // because that one is the age of an observation.
              `${Math.round((runNow - stormReport.firedAt) / 60_000)}m ago · `
              + (runNow - stormReport.firedAt < STORM_COOLDOWN_MS
                ? `seed eligible in ${Math.ceil((STORM_COOLDOWN_MS - (runNow - stormReport.firedAt)) / 60_000)}m`
                : "a new seed can mint"),
            ] as [Markup, Markup]]
            : []),
          ...(stormReport.admitted > 0 ? [["fire", "admitted this derivation"] as [Markup, Markup]] : []),
        ])
        + refusals(stormReport.refused, stormReport.examples, "every gate is green"),
      )
      : "";

    // Two readings of the same question: has the game moved out from under our
    // transcription? One counts model ids we do not know, the other counts log
    // lines we cannot parse. They are the same class of event, so they share a
    // card — and both are things to hear about rather than swallow.
    const unknown = knowledge?.unknownModels;
    const drift = d.grammar;
    const hasUnknown = unknown !== undefined && Object.keys(unknown).length > 0;
    const hasDrift = drift !== undefined && drift.unrecognised > 0;
    const unknownCard = hasUnknown || hasDrift
      ? card(
        "Drift",
        (hasUnknown
          ? note("the game produced a model id our transcription does not know — a game update, or a hole in shared/strategy/dnet/models.ts")
            + table(["model", "seen"], Object.entries(unknown!).map(([id, n]) => [esc(id), String(n)]), { left: [0] })
          : "")
        + (hasDrift
          ? definitions([[
            hint("unparsed log lines", "our grammar has fallen behind the game's — see shared/strategy/dnet/oracle.ts"),
            String(drift!.unrecognised),
          ]])
          // SHAPES, not lines. An unparsed line is one we failed to read, and
          // the noise generator writes cleartext passwords into log lines, so
          // the examples would be the passwords we missed. Digits and letters
          // are collapsed; the structure is what a fix is written against.
          + table(
            [hint("shape", "digits are #, letters are a — the line itself never leaves the game"), "seen"],
            Object.entries(drift!.shapes)
              .sort((a, b) => b[1] - a[1])
              .map(([shape, n]) => [esc(shape), String(n)]),
            { empty: "no shape recorded", left: [0], wrap: [0] },
          )
          : ""),
      )
      : "";

    return (
      // The map spans both columns: it is eight boxes wide by construction, the
      // game's own NET_WIDTH, and does not fit a half-width column at any zoom
      // that leaves the hostnames readable.
      `<div class="col span">`
      + card("Darknet", summary + controls + netMap(hosts, options) + netLegend())
      + `</div>`
      + `<div class="col wide">`
      + card(
        "Servers",
        filters("dnet.show", [
          { value: "all", label: "all", badge: String(hosts.length) },
          { value: "cracked", label: "cracked" },
          { value: "locked", label: "auth required" },
          { value: "roomy", label: "has RAM", title: `free RAM >= one resident (${fmtRam(AGENT_RAM_GB)})` },
          { value: "stale", label: "stale" },
          { value: "gone", label: "gone" },
        ], "all")
        + servers
        // The DIGEST's own cap, which is a different truncation from the
        // table's: `dataTable` says when IT dropped rows, and this says when the
        // publisher did. Without it a 220-host reading of a 400-host net looked
        // like the whole net.
        + (knowledge.truncated && knowledge.totalHosts !== undefined
          ? shownOf(knowledge.hosts.length, knowledge.totalHosts, "the digest caps at KNOWLEDGE_MAX_HOSTS")
          : "")
        + collapsible("dnet.solve", "solve progress, every host", solveProgress, false)
        + collapsible("dnet.unsolved", "unsolved surface — hint, data, oracle", unsolvedSurface, false),
      )
      + card("Decision", decision)
      + `</div>`
      + `<div class="col">`
      // The labyrinth FIRST, and only when there is one. It is what the whole
      // feature is for — it deepens the net, it pays the augmentations, and a
      // walk is the longest-running thing the darknet ever does — so once a lab
      // exists it outranks the drill-downs below it. Every run before the first
      // sighting draws no card at all, so this reorders nothing until there is
      // something to reorder.
      + labCard
      + detailCard(d, hosts, options.selected, picked === options.selected ? "" : picked, now, expiry)
      + crewCard(d, hosts, now, digestNote, options.selected)
      + card("Knowledge", reach)
      // The one count on this tab that is NOT per-derivation, said in the
      // header: the planner rollups above are what the last derivation
      // admitted, and reading these as the same unit is off by the whole run.
      + card("Response codes", table(
        ["code", "meaning", hint("n", "cumulative since this install; the count resets when the generation changes")],
        codes,
        { empty: "no darknet call has answered yet", left: [0, 1] },
      ))
      + holdCard
      + spreadCard
      + profitCard
      + farmCard
      + stormCard
      + unknownCard
      + `</div>`
    );
  },
};
