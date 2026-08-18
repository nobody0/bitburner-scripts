import "./style.css";

type Cell = "." | "X" | "O" | "#";
type Route = { entryPhase: number; waits: number; power: number; turns: number; enter: boolean };
type Game = { phase: number; seed: number; route: Route };
type Enemy = { key: string; name: string; multiplier: number; komi?: number };
type Manifest = { schema: number; phases: number; shardSize: number; enemies: Enemy[] };
type Node = {
  id: number; phase: number; round: number; credit: number; board: Cell[]; passes: number;
  action: number; actionClass: number; successors: number[];
};
type Policy = { name: string; nodes: Map<number, Node>; root: Node };
type PolicyIndex = Record<string, { name: string; root: number }[]>;

const app = document.querySelector<HTMLDivElement>("#app")!;
const DATA_BASE = (import.meta.env.VITE_DATA_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/data";

const esc = (value: unknown) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const state = {
  manifest: undefined as Manifest | undefined,
  enemy: "netburners",
  seed: 3,
  routes: undefined as Route[] | undefined,
  policies: [] as Policy[],
  policy: 0,
  path: [] as number[],
  loading: true,
  error: "",
  revealed: false,
  tab: (location.hash === "#how-it-works" ? "theory" : "explorer") as "explorer" | "theory",
};

const routeCache = new Map<string, Route[]>();
const shardCache = new Map<string, { index: PolicyIndex; nodes: Map<number, Node> }>();
const gameCache = new WeakMap<Route[], Game[]>();

function gamesForRoutes(routes?: Route[]) {
  if (!routes) return [];
  const cached = gameCache.get(routes);
  if (cached) return cached;
  const byPhase = new Map<number, Game>();
  routes.forEach((route, seed) => {
    const current = byPhase.get(route.entryPhase);
    // The route is only the representative used to open this game. Prefer the
    // shortest route; slider spacing is calculated separately from its waits.
    if (!current || route.waits < current.route.waits || (route.waits === current.route.waits && seed < current.seed)) {
      byPhase.set(route.entryPhase, { phase: route.entryPhase, seed, route });
    }
  });
  const games = [...byPhase.values()].sort((left, right) => left.phase - right.phase);
  gameCache.set(routes, games);
  return games;
}

function gameIndexForSeed(games: Game[], routes: Route[] | undefined, seed: number) {
  const phase = routes?.[seed]?.entryPhase ?? seed;
  const index = games.findIndex((game) => game.phase === phase);
  return index < 0 ? 0 : index;
}

function phaseDistanceFromPrevious(games: Game[], index: number) {
  if (games.length < 2) return 0;
  const phases = state.manifest?.phases ?? 150_000;
  const current = games[index]?.phase ?? 0;
  const previous = games[(index + games.length - 1) % games.length]?.phase ?? current;
  return (current - previous + phases) % phases;
}

function phaseDisplay(seed: number, route: Route | undefined, distanceFromPrevious: number) {
  const entryPhase = route?.entryPhase ?? seed;
  const offsetLabel = distanceFromPrevious ? ` <span class="phase-offset">(+${distanceFromPrevious.toLocaleString("en-US")})</span>` : "";
  return {
    html: `${entryPhase.toLocaleString("en-US")}<small>${offsetLabel} / ${((state.manifest?.phases ?? 150_000) - 1).toLocaleString("en-US")}</small>`,
    valueText: distanceFromPrevious
      ? `Phase ${entryPhase.toLocaleString("en-US")}, ${distanceFromPrevious.toLocaleString("en-US")} phase${distanceFromPrevious === 1 ? "" : "s"} after the previous playable game`
      : `Phase ${seed.toLocaleString("en-US")}`,
  };
}

function phaseRangePercent(index: number, lastIndex: number) {
  return lastIndex > 0 ? index / lastIndex * 100 : 0;
}

async function gunzip(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  if (!("DecompressionStream" in window)) throw new Error("This browser cannot open compressed playbook data.");
  const stream = response.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeRoutes(bytes: Uint8Array): Route[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const routes: Route[] = [];
  for (let offset = 0; offset + 9 <= bytes.length; offset += 9) {
    routes.push({
      entryPhase: view.getUint8(offset) | (view.getUint16(offset + 1, true) << 8),
      waits: view.getUint16(offset + 3, true),
      power: view.getUint8(offset + 5),
      turns: view.getUint16(offset + 6, true),
      enter: view.getUint8(offset + 8) === 1,
    });
  }
  return routes;
}

function unpackBoard(value: bigint): Cell[] {
  const cells: Cell[] = [];
  const values: Cell[] = [".", "X", "O", "#"];
  for (let index = 0; index < 25; index++) cells.push(values[Number((value >> BigInt(index * 2)) & 3n)]!);
  return cells;
}

function decodeNodes(bytes: Uint8Array): Map<number, Node> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const nodes = new Map<number, Node>();
  let offset = 4;
  for (let index = 0; index < count; index++) {
    const id = view.getUint32(offset, true);
    const successorCount = view.getUint16(offset + 22, true);
    const successors: number[] = [];
    for (let edge = 0; edge < successorCount; edge++) successors.push(view.getUint32(offset + 26 + edge * 4, true));
    nodes.set(id, {
      id, phase: view.getUint32(offset + 4, true), board: unpackBoard(view.getBigUint64(offset + 8, true)),
      round: view.getUint8(offset + 16), credit: view.getUint8(offset + 17),
      passes: view.getUint8(offset + 18), action: view.getUint8(offset + 19),
      actionClass: view.getUint8(offset + 20), successors,
    });
    offset += 26 + successorCount * 4;
  }
  return nodes;
}

async function loadRoutes(key: string) {
  const cached = routeCache.get(key);
  if (cached) return cached;
  const routes = decodeRoutes(await gunzip(await fetch(`${DATA_BASE}/${key}/routes.bin`)));
  routeCache.set(key, routes);
  return routes;
}

async function loadPolicies(key: string, phase: number): Promise<Policy[]> {
  const manifest = state.manifest!;
  const shard = Math.floor(phase / manifest.shardSize);
  const stem = `policies-${String(shard).padStart(3, "0")}`;
  const cacheKey = `${key}/${stem}`;
  let data = shardCache.get(cacheKey);
  if (!data) {
    const [indexResponse, bytesResponse] = await Promise.all([
      fetch(`${DATA_BASE}/${key}/${stem}.json`), fetch(`${DATA_BASE}/${key}/${stem}.bin`),
    ]);
    if (!indexResponse.ok) throw new Error("This phase has no certificate shard.");
    data = { index: await indexResponse.json() as PolicyIndex, nodes: decodeNodes(await gunzip(bytesResponse)) };
    shardCache.set(cacheKey, data);
  }
  const entries = data.index[String(phase)] ?? [];
  return entries.map((entry) => {
    const root = data!.nodes.get(entry.root);
    if (!root) throw new Error(`Certificate ${entry.name} has no root`);
    return { name: entry.name, nodes: data!.nodes, root };
  });
}

function actionLabel(action: number) {
  if (action < 25) return `Play ${String.fromCharCode(65 + Math.floor(action / 5))}${action % 5 + 1}`;
  if (action === 25) return "Pass";
  if (action === 26) return "Align clock";
  if (action === 27) return "Next board";
  return "Game complete";
}

function actionPoint(action: number): [number, number] | undefined {
  return action < 25 ? [Math.floor(action / 5), action % 5] : undefined;
}

const neighbors = (point: number) => {
  const x = Math.floor(point / 5), y = point % 5;
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    .filter(([nx, ny]) => nx! >= 0 && nx! < 5 && ny! >= 0 && ny! < 5)
    .map(([nx, ny]) => nx! * 5 + ny!);
};

function group(board: Cell[], start: number) {
  const colour = board[start];
  const result = new Set<number>(), open = [start];
  while (open.length) {
    const point = open.pop()!;
    if (result.has(point) || board[point] !== colour) continue;
    result.add(point);
    for (const next of neighbors(point)) open.push(next);
  }
  return result;
}

function liberties(board: Cell[], stones: Set<number>) {
  const result = new Set<number>();
  for (const stone of stones) for (const next of neighbors(stone)) if (board[next] === ".") result.add(next);
  return result;
}

function playBlack(board: Cell[], action: number): Cell[] {
  const point = actionPoint(action);
  if (!point) return [...board];
  const index = point[0] * 5 + point[1];
  const next = [...board];
  if (next[index] !== ".") return next;
  next[index] = "X";
  for (const neighbor of neighbors(index)) {
    if (next[neighbor] !== "O") continue;
    const stones = group(next, neighbor);
    if (liberties(next, stones).size === 0) for (const stone of stones) next[stone] = ".";
  }
  return next;
}

function enemyReply(parent: Node, child: Node) {
  const afterBlack = playBlack(parent.board, parent.action);
  const point = enemyPoint(afterBlack, child);
  if (child.passes > parent.passes || point < 0) return "White passes";
  return `White ${String.fromCharCode(65 + Math.floor(point / 5))}${point % 5 + 1}`;
}

function enemyPoint(afterBlack: Cell[], child: Node) {
  return child.board.findIndex((cell, index) => cell === "O" && afterBlack[index] !== "O");
}

function successorNodes(node: Node, policy: Policy) {
  return node.successors.map((id) => policy.nodes.get(id)).filter((item): item is Node => Boolean(item))
    .sort((left, right) => {
      const leftDelta = (left.phase - node.phase + 150_000) % 150_000;
      const rightDelta = (right.phase - node.phase + 150_000) % 150_000;
      return leftDelta - rightDelta || left.id - right.id;
    });
}

function timingLabel(parent: Node, child: Node, siblings: Node[]) {
  const phases = [...new Set(siblings.map((node) => node.phase))].sort((a, b) => a - b);
  if (phases.length < 2) return "expected timing";
  const position = phases.indexOf(child.phase);
  return position === 0 ? "expected timing" : position === 1 ? "late timing" : `+${position} timing`;
}

function phaseStep(parent: Node, child: Node) {
  const delta = (child.phase - parent.phase + 150_000) % 150_000;
  return delta === 0 ? "same phase" : `n+${delta}`;
}

function placementTiming(parent: Node, child: Node, siblings: Node[]) {
  const timing = timingLabel(parent, child, siblings);
  return timing === "expected timing" ? "on time" : timing.replace(" timing", "");
}

function activeKomi() {
  return state.manifest?.enemies.find((enemy) => enemy.key === state.enemy)?.komi ?? 5.5;
}

function score(board: Cell[]) {
  let black = board.filter((cell) => cell === "X").length;
  let white = board.filter((cell) => cell === "O").length;
  const seen = new Set<number>();
  for (let start = 0; start < 25; start++) {
    if (board[start] !== "." || seen.has(start)) continue;
    const region = new Set<number>(), borders = new Set<Cell>(), open = [start];
    while (open.length) {
      const point = open.pop()!;
      if (seen.has(point) || board[point] !== ".") continue;
      seen.add(point); region.add(point);
      for (const next of neighbors(point)) {
        if (board[next] === ".") open.push(next);
        else borders.add(board[next]!);
      }
    }
    if (region.size <= 22 && borders.size === 1) {
      if (borders.has("X")) black += region.size;
      if (borders.has("O")) white += region.size;
    }
  }
  return { black, white: white + activeKomi() };
}

function territory(board: Cell[]) { return score(board).black; }

function libertyHtml(board: Cell[], index: number) {
  const x = Math.floor(index / 5), y = index % 5;
  const directions = [
    ["left", x - 1, y], ["right", x + 1, y], ["up", x, y + 1], ["down", x, y - 1],
  ] as const;
  return directions
    .filter(([, nx, ny]) => nx >= 0 && nx < 5 && ny >= 0 && ny < 5 && board[nx * 5 + ny] === ".")
    .map(([direction]) => `<i class="liberty ${direction}"></i>`).join("");
}

function boardHtml(node: Node, policy: Policy) {
  const point = actionPoint(node.action);
  const successors = successorNodes(node, policy);
  const afterBlack = playBlack(node.board, node.action);
  const previous = state.path.length > 1 ? policy.nodes.get(state.path[state.path.length - 2]!) : undefined;
  const previousMove = previous ? enemyPoint(playBlack(previous.board, previous.action), node) : -1;
  const replies = [...new Map(successors.map((child) => {
    const reply = enemyPoint(afterBlack, child);
    return [reply, { reply, child }];
  })).values()];
  const displayBoard = state.revealed && replies.length === 1 ? replies[0]!.child.board : state.revealed ? afterBlack : node.board;
  const currentScore = score(displayBoard);
  const markedMove = state.revealed && replies.length === 1 ? replies[0]!.reply : previousMove;
  const replyMarkers = state.revealed && replies.length > 1 ? replies.map(({ reply, child }, index) => {
    if (reply < 0) return "";
    const x = Math.floor(reply / 5), y = reply % 5;
    const label = enemyReply(node, child);
    return `<span class="response-preview" data-white-reply="${reply}" style="--x:${x};--y:${4 - y};--slot:${index}" aria-label="Predicted ${enemyReply(node, child)}"><b>${label}</b></span>`;
  }).join("") : "";
  const placementGroups = new Map<number, Node[]>();
  const nonPlacementSuccessors: Node[] = [];
  if (state.revealed) {
    for (const child of successors) {
      if (!actionPoint(child.action)) {
        nonPlacementSuccessors.push(child);
        continue;
      }
      const group = placementGroups.get(child.action) ?? [];
      group.push(child);
      placementGroups.set(child.action, group);
    }
  }
  const responseText = (children: Node[]) => {
    const labels = [...new Set(children.map((child) => enemyReply(node, child)))];
    if (labels.length === 1) {
      return labels[0] === "White passes" ? "White passed" : labels[0]!.replace("White ", "White played ");
    }
    return `White may ${labels.map((label) => label === "White passes" ? "pass" : `play ${label.replace("White ", "")}`).join(" or ")}`;
  };
  const previewAttributes = (children: Node[]) => {
    const replyPoints = [...new Set(children.map((child) => enemyPoint(afterBlack, child)).filter((reply) => reply >= 0))];
    return `data-preview-replies="${replyPoints.join(",")}" data-white-summary="${esc(responseText(children))}"`;
  };
  const placementLabel = (action: number, children: Node[]) => {
    const timings = [...new Set(children.map((child) => placementTiming(node, child, successors)))];
    const steps = [...new Set(children.map((child) => phaseStep(node, child)))];
    const phases = [...new Set(children.map((child) => child.phase))].sort((a, b) => a - b);
    const phaseLabel = phases.length === 1
      ? `phase ${phases[0]!.toLocaleString("en-US")}`
      : `phases ${phases.map((phase) => phase.toLocaleString("en-US")).join(" / ")}`;
    return `<strong>${actionLabel(action).replace("Play ", "")}</strong><b>${children.length > 1 ? "same move" : timings[0]}</b><small>${steps.join(" / ")}</small><em>${phaseLabel}</em>`;
  };
  const nextPlacements = [...placementGroups.entries()].map(([action, children]) => {
    const nextPoint = actionPoint(action)!;
    const [x, y] = nextPoint;
    const child = children[0]!;
    const timings = [...new Set(children.map((item) => placementTiming(node, item, successors)))].join(" or ");
    const phases = children.map((item) => item.phase.toLocaleString("en-US")).join(" or ");
    return `<button type="button" class="phase-placement${children.length > 1 ? " merged" : ""}" style="--x:${x};--y:${4 - y}" data-play-successor="${child.id}" ${previewAttributes(children)} aria-label="${actionLabel(action)}, ${timings}, phase ${phases}"><i class="placement-ring"></i><span class="placement-label">${placementLabel(action, children)}</span></button>`;
  }).join("");
  return `<div class="board-wrap"><div class="board" role="group" aria-label="5 by 5 Go board and possible replies">
    ${displayBoard.map((cell, index) => {
      const x = Math.floor(index / 5), y = index % 5;
      const suggested = !state.revealed && point?.[0] === x && point?.[1] === y;
      return `<div class="point ${cell === "#" ? "wall" : ""} ${index === markedMove ? "previous" : ""}" style="--x:${x};--y:${4 - y}" title="${String.fromCharCode(65 + x)}${y + 1}">
        ${cell === "X" || cell === "O" ? `<span class="stone ${cell === "X" ? "black" : "white"}">${libertyHtml(displayBoard, index)}</span>` : ""}
        ${suggested ? `<button type="button" class="suggested-stone" data-reveal aria-label="${actionLabel(node.action)} at phase ${node.phase}"><b>phase ${node.phase}</b><small>click to play</small></button>` : ""}
      </div>`;
    }).join("")}
    ${replyMarkers}
    ${nextPlacements}
  </div>
  <div class="board-score"><span>Score:</span><b>Black: ${currentScore.black}</b><b>White: ${currentScore.white}</b></div>
  ${!state.revealed && !point && node.action !== 28 ? `<button class="confirm-move" data-reveal>${actionLabel(node.action)} · phase ${node.phase}</button>` : ""}
  ${state.revealed && successors.length ? `<div class="reply-forecast"><span data-reply-forecast data-default-text="${esc(replies.length === 1 ? responseText([replies[0]!.child]) : "Hover or focus a move to preview White’s response")}">${replies.length === 1 ? responseText([replies[0]!.child]) : "Hover or focus a move to preview White’s response"}</span><small>${placementGroups.size ? "Choose the glowing Black placement." : "Choose the labelled action."}</small></div>${nonPlacementSuccessors.length ? `<div class="board-replies" aria-label="Next Black action">${nonPlacementSuccessors.map((child) => `<button data-play-successor="${child.id}" ${previewAttributes([child])}><span>${placementTiming(node, child, successors)} · ${phaseStep(node, child)}</span><b>${actionLabel(child.action)}</b><small>phase ${child.phase}</small></button>`).join("")}</div>` : ""}` : ""}
  </div>`;
}

function branchHtml(node: Node, policy: Policy) {
  const successors = successorNodes(node, policy);
  if (node.action === 28) {
    const enemy = state.manifest!.enemies.find((item) => item.key === state.enemy)!;
    const power = territory(node.board) * enemy.multiplier;
    return `<div class="terminal"><span class="terminal-dot"></span><div><strong>Certified win complete</strong><p>${power.toFixed(power % 1 ? 1 : 0)} Power earned on this branch.</p></div></div>`;
  }
  if (!state.revealed) {
    return `<div class="turn-status"><div><span>BLACK · YOU</span><strong>${actionLabel(node.action)}</strong></div><div class="pending"><span>WHITE · AI</span><strong>Waiting for Black</strong></div></div>`;
  }
  const replyNames = [...new Set(successors.map((child) => enemyReply(node, child)))];
  return `<div class="turn-status"><div><span>BLACK · YOU</span><strong>${actionLabel(node.action)}</strong></div><div><span>WHITE · AI</span><strong>${replyNames.join(" / ")}</strong></div><div><span>NEXT BLACK MOVE</span><strong>Choose on the board</strong></div></div>`;
}

function openingPoint(policy: Policy) {
  const named = policy.name.match(/-h(\d+)$/);
  if (named) return Number(named[1]);
  return policy.root.board.findIndex((cell) => cell === "O");
}

function openingLabel(policy: Policy) {
  const point = openingPoint(policy);
  return point >= 0 ? `${String.fromCharCode(65 + Math.floor(point / 5))}${point % 5 + 1}` : esc(policy.name);
}

function openingCard(policy: Policy, index: number) {
  const selected = index === state.policy;
  return `<button class="opening-card ${selected ? "active" : ""}" data-policy="${index}" aria-label="Initial White block at ${openingLabel(policy)}">
    <span class="opening-board">${Array.from({ length: 25 }, (_, slot) => {
      const cell = policy.root.board[(slot % 5) * 5 + (4 - Math.floor(slot / 5))];
      return `<i class="${cell === "O" ? "white" : cell === "#" ? "wall" : ""}"></i>`;
    }).join("")}</span>
    <strong>White ${openingLabel(policy)}</strong>
  </button>`;
}

function openingGateHtml() {
  return `<section class="opening-gate">
    <div><span class="eyebrow">Illuminati opening</span><h2>Where is the initial White block?</h2><p>Select the board shown in IPvGO.</p></div>
    <div class="opening-grid">${state.policies.map(openingCard).join("")}</div>
  </section>`;
}

function theoryHtml() {
  const bits = Array.from({ length: 25 }, (_, index) =>
    `<i class="v${index % 4}">${["00", "01", "10", "11"][index % 4]}</i>`).join("");
  return `<main class="theory-page">
    <section class="theory-hero">
      <div><span class="eyebrow">how it was made</span><h1>search → certificate → shader</h1></div>
      <p>Search every White reply. Keep only lines that always win. Pack them for exact lookup.</p>
    </section>

    <section class="theory-facts" aria-label="Playbook scale">
      <div><strong>150,000</strong><span>clock phases</span></div><div><strong>5 × 5</strong><span>board</span></div>
      <div><strong>∀ replies</strong><span>must still win</span></div><div><strong>6</strong><span>opponents</span></div>
    </section>

    <section class="theory-intro">
      <span class="section-number">01</span><div><span class="eyebrow">the central idea</span><h2>A strategy is an AND/OR proof</h2></div>
    </section>
    <section class="logic-lab">
      <article class="logic-card"><span class="logic-label">OR · black picks one</span><div class="logic-node dark">Black to play</div><div class="logic-branches"><span class="rejected">A2</span><span class="selected">C3</span><span class="rejected">Pass</span></div><p>One move that beats every reply is enough.</p></article>
      <div class="logic-join"><span>then</span></div>
      <article class="logic-card"><span class="logic-label">AND · white tries all</span><div class="logic-node light">White responds</div><div class="logic-branches"><span>on time</span><span>late</span><span>defense tie</span></div><p>One losing reply rejects the move.</p></article>
    </section>

    <section class="state-anatomy">
      <div class="anatomy-copy"><span class="section-number">02</span><span class="eyebrow">game state</span><h2>The board is not enough</h2><p>Timing, history, and passes change the winning move, so the state stores them.</p></div>
      <div class="state-tuple"><span><i>01</i><b>board</b><small>25 cells</small></span><span><i>02</i><b>phase</b><small>WHRNG position</small></span><span><i>03</i><b>history</b><small>superko</small></span><span><i>04</i><b>passes</b><small>end condition</small></span><span><i>05</i><b>credit</b><small>alignment</small></span></div>
      <code class="tuple-code">S = (board, phase, history, passes, alignment)</code>
    </section>

    <section class="timing-section">
      <div class="timing-head"><div><span class="section-number">03</span><span class="eyebrow">150,000 phases</span><h2>Timing is branch-exact</h2></div><p>The game clock advances in 200&nbsp;ms ticks. White seeds its RNG after exactly one full-cycle wait — always n + 1 — so the reply is fixed the moment Black dispatches. Every later AI wait (option checks, fallback selection, stone placement) is another full tick, so the reply arrives at n + 1 + waits, typically +2 to +5 depending on the branch we already predicted. Sub-tick drift can add one more tick; the certificate proves both arrivals. An aligned line targets the later edge: arrive early, sleep one phase — an overshoot can never be undone.</p></div>
      <div class="phase-ruler"><div class="phase-track"></div><div class="phase-point start"><b>n</b><span>dispatch</span></div><div class="phase-point predicted"><b>n + w</b><span>branch-exact reply</span></div><div class="phase-point late"><b>n + w + 1</b><span>late</span></div><div class="phase-window"><span>prove both</span></div></div>
    </section>

    <section class="pipeline-section">
      <div class="pipeline-head"><span class="section-number">04</span><div><span class="eyebrow">the build pipeline</span><h2>search → evidence → runtime</h2></div></div>
      <div class="pipeline">
        <article><span>1</span><b>Generate</b><p>Recreate the opening at an exact phase.</p></article><article><span>2</span><b>Search</b><p>Explore Black actions against all modeled White outcomes.</p></article>
        <article><span>3</span><b>Prove</b><p>Propagate wins backward, then keep searching until no other winning line can beat the certified power per turn.</p></article><article><span>4</span><b>Replay</b><p>Validate each exported certificate independently.</p></article>
        <article><span>5</span><b>Route</b><p>Enter now or pass to the best certified root.</p></article><article><span>6</span><b>Pack</b><p>Encode exact nodes, edges, and all 150,000 roots.</p></article>
      </div>
    </section>

    <section class="certificate-section">
      <div class="certificate-copy"><span class="section-number">05</span><span class="eyebrow">certificates</span><h2>Every route replays</h2><p>Each node stores Black's move and every reachable successor. Only replay-validated wins ship.</p><div class="quality-formula"><span>route quality</span><strong>guaranteed Power</strong><i>÷</i><strong>worst-case turns</strong></div></div>
      <div class="certificate-code"><div><span>state</span><span>phase</span><span>action</span><span>successors</span></div><div><b>0</b><em>3351</em><strong>C3</strong><small>9, 10</small></div><div><b>10</b><em>3353</em><strong>B4</strong><small>678, 716</small></div><div><b>716</b><em>3355</em><strong>B2</strong><small>706, 717</small></div><div><b>704</b><em>—</em><strong>terminal</strong><small>WIN</small></div></div>
    </section>

    <section class="packing-section">
      <div class="packing-visual" aria-hidden="true"><div class="bit-board">${bits}</div><span>2 bits / cell</span><div class="pack-arrow">→</div><div class="packed-block"><i></i><i></i><i></i><i></i><b>.bin</b></div></div>
      <div class="packing-copy"><span class="section-number">06</span><span class="eyebrow">packing</span><h2>50 bits per board</h2><p>2 bits per cell. Duplicate states share nodes. This site serves gzipped 1,000-phase shards; the in-game script packs the same states behind a collision-checked 32-bit state hash, deflated into one readable file.</p></div>
    </section>

    <section class="shader-section">
      <div class="shader-head"><span class="section-number">07</span><div><span class="eyebrow">runtime</span><h2>Lookup first, shader second</h2></div><p>An exact state match plays the certified action; an early arrival on an aligned line resolves to a one-phase sleep entry, never a miss. The standalone demo forfeits and logs on any real mismatch; the combined runtime instead hands unknown boards to the V9 net.</p></div>
      <div class="runtime-flow"><div class="runtime-input"><span>exact state</span><b>lookup</b></div><div class="runtime-split"><i></i><i></i></div><div class="runtime-path certified"><span>HIT</span><b>certified action</b><small>replay-validated</small></div><div class="runtime-path fallback"><span>MISS</span><b>V9 actor</b><small>learned fallback</small></div><div class="runtime-arrow">→</div><div class="shader-chip"><span>WebGPU</span><b>WGSL</b><small>row-q8 model → f32 in VRAM</small></div></div>
      <div class="shader-details"><div><b>forecast the enemy</b><p>the proofs' WHRNG model, encoded as 31 floats per board</p></div><div><b>train + compress</b><p>teacher + certified games; row-q8 checkpoint (torch)</p></div><div><b>gate</b><p>WebGPU arena vs the vendored game AI</p></div><pre><code>// The enemy is deterministic given the clock. The same WHRNG
// forecast the proofs use — smart flag, seeded rolls, branch
// priorities, komi — is uploaded per board and conditions
// every residual block of the net.
@group(0) @binding(5) var&lt;storage,read&gt; behaviors:array&lt;f32&gt;;

<span>fn</span> behaviorCondition(board:u32,output:u32)-&gt;f32{
  let row=(params.block*CHANNELS+output)*BEHAVIOR;
  var condition=weightAt(COND_B+params.block*CHANNELS+output);
  for(var feature=0u;feature&lt;BEHAVIOR;feature++){
    condition+=weightAt(COND_W+row+feature)
      *behaviors[board*BEHAVIOR+feature];}
  return condition;
}</code></pre></div>
    </section>

    <section class="closing-strip download-strip"><span>standalone proof</span><b>The whole playbook ships as one readable .js: dodge to a certified phase, reset the board, follow the certificate, forfeit loudly on any mismatch. It exists to prove the playbook wins entirely on its own before any surrounding complexity.</b><a class="download" href="${DATA_BASE}/downloads/bruteforcego.js" download="bruteforcego.js">↓ bruteforcego.js</a></section>

    <section class="closing-strip download-strip"><span>combined proof</span><b>The combined build packs the stripped playbook next to the deployed model itself: an entry is removed only where the production neural decision reproduces its certified action exactly at both proven dispatch ticks, so no certified line is interrupted (3.87 → 3.61 MB). Certified move when the line is known, full production neural decision on any miss, never a forfeit. One script, no worker, no other game features — the mechanism proof for the production integration. Over 3,072 fresh games it wins 99.8% overall and 98.6% against Illuminati, where the model alone wins 71.1%. <a class="source-link" href="https://github.com/nobody0/bitburner-scripts/blob/main/tools/combined-standalone/main.ts" target="_blank" rel="noopener">driver source on GitHub</a></b><a class="download" href="${DATA_BASE}/downloads/combinedgo.js" download="combinedgo.js">↓ combinedgo.js</a></section>

    <section class="closing-strip"><span>runtime rule</span><b>exact match → playbook · miss → shader</b><button data-tab="explorer">open playbook</button></section>
  </main>`;
}

function topbarHtml() {
  return `<header class="topbar">
    <button class="brand" data-tab="explorer" aria-label="IPvGO Playbook home"><span class="brand-mark">⌗</span><span>ipvgo playbook</span></button>
    <nav class="site-tabs" role="tablist" aria-label="Playbook sections">
      <button role="tab" data-tab="explorer" aria-selected="${state.tab === "explorer"}" class="${state.tab === "explorer" ? "active" : ""}"><i>⌕</i> playbook</button>
      <button role="tab" data-tab="theory" aria-selected="${state.tab === "theory"}" class="${state.tab === "theory" ? "active" : ""}"><i>?</i> how it was made</button>
    </nav>
    <div class="topbar-actions">
      <a class="header-download" href="${DATA_BASE}/downloads/bruteforcego.js" download="bruteforcego.js" aria-label="Download bruteforcego.js standalone Bitburner script"><span>↓</span> bruteforcego.js</a>
      <a class="header-download" href="${DATA_BASE}/downloads/combinedgo.js" download="combinedgo.js" aria-label="Download combinedgo.js combined playbook and neural Bitburner script"><span>↓</span> combinedgo.js</a>
      <a class="header-source" href="https://github.com/nobody0/bitburner-scripts/blob/main/tools/combined-standalone/main.ts" target="_blank" rel="noopener" aria-label="Read the combined driver source on GitHub"><span>&lt;/&gt;</span> source</a>
      <div class="proof"><span></span> certificate online</div>
    </div>
  </header>`;
}

function render() {
  if (!state.manifest) {
    app.innerHTML = state.error
      ? `<main class="loading"><section class="card-state error"><strong>playbook unavailable</strong><p>${esc(state.error)}</p></section></main>`
      : `<main class="loading"><span></span><p>loading playbook…</p></main>`;
    return;
  }
  if (state.tab === "theory") {
    app.innerHTML = `<div class="shell">${topbarHtml()}${theoryHtml()}<footer><span>exact search · replay-validated · webgpu fallback</span></footer></div>`;
    bind();
    return;
  }
  const route = state.routes?.[state.seed];
  const games = gamesForRoutes(state.routes);
  const gameIndex = gameIndexForSeed(games, state.routes, state.seed);
  const lastGameIndex = Math.max(0, games.length - 1);
  const policy = state.policies[state.policy];
  const currentId = state.path.at(-1) ?? 0;
  const node = policy?.nodes.get(currentId) ?? policy?.root;
  const enemy = state.manifest.enemies.find((item) => item.key === state.enemy)!;
  const earnedPower = route ? route.power * enemy.multiplier : 0;
  const rate = route ? earnedPower / Math.max(1, route.turns) : 0;
  const needsOpening = state.enemy === "illuminati" && state.policy < 0 && state.policies.length > 0;
  const displayedPhase = phaseDisplay(state.seed, route, phaseDistanceFromPrevious(games, gameIndex));
  const sliderValueText = `${displayedPhase.valueText}; game ${(gameIndex + 1).toLocaleString("en-US")} of ${games.length.toLocaleString("en-US")}`;

  app.innerHTML = `<div class="shell">
    ${topbarHtml()}

    <main class="explorer-page">
      <section class="explorer-tools">
        <div class="subnet-title"><span>Subnet owner:</span><strong>${esc(enemy.name)}</strong></div>
        <div class="enemy-control"><label for="enemy">Change subnet</label><select id="enemy">${state.manifest.enemies.map((enemy) => `<option value="${esc(enemy.key)}" ${enemy.key === state.enemy ? "selected" : ""}>${esc(enemy.name)}</option>`).join("")}</select></div>
        ${state.enemy === "illuminati" && state.policy >= 0 && state.policies[state.policy] ? `<button id="change-opening" class="change-opening">White starts at ${openingLabel(state.policies[state.policy]!)}</button>` : ""}
      </section>
      <section class="seed-panel">
        <div class="seed-heading">
          <div><span class="eyebrow">Playable phase</span><h1>${displayedPhase.html}</h1></div>
          <div class="seed-actions"><button id="seed-minus" aria-label="Previous game">−</button><button id="seed-plus" aria-label="Next game">+</button></div>
        </div>
        <input id="seed" type="range" min="0" max="${lastGameIndex}" value="${gameIndex}" style="--value:${phaseRangePercent(gameIndex, lastGameIndex)}%" aria-label="Playable game" aria-valuetext="${esc(sliderValueText)}" ${games.length ? "" : "disabled"} />
        <div class="range-labels"><span>phase ${games[0]?.phase.toLocaleString("en-US") ?? "—"}</span><span>${games.length.toLocaleString("en-US")} distinct games</span><span>phase ${games.at(-1)?.phase.toLocaleString("en-US") ?? "—"}</span></div>
      </section>

      ${state.loading ? `<section class="card-state"><span class="spinner"></span><p>loading route…</p></section>` : state.error ? `<section class="card-state error"><strong>route unavailable</strong><p>${esc(state.error)}</p></section>` : needsOpening ? openingGateHtml() : route && node ? `
      <section class="metrics">
        <article class="metric primary"><span>power / turn</span><strong>${rate.toFixed(3)}</strong><small>guaranteed</small></article>
        <article class="metric"><span>power</span><strong>${earnedPower.toFixed(earnedPower % 1 ? 1 : 0)}</strong><small>minimum</small></article>
        <article class="metric"><span>turns</span><strong>${route.turns}</strong><small>${route.waits ? `${route.waits} pass${route.waits === 1 ? "" : "es"} first` : "play now"}</small></article>
      </section>

      <section class="workspace">
        <article class="board-card">
          <div class="card-head"><div><span class="eyebrow">Round ${node.round}</span><h2>${actionLabel(node.action)}</h2></div><span class="phase-pill">phase ${node.phase || "—"}</span></div>
          ${boardHtml(node, policy)}
          <div class="legend"><span><i class="mini black"></i>You</span><span><i class="mini white"></i>Opponent</span><span><i class="mini blocked"></i>Blocked</span></div>
        </article>

        <article class="branch-card-shell">
          <div class="card-head"><div><span class="eyebrow">Turn ${node.round + 1}</span><h2>Current line</h2></div><span class="phase-pill">phase ${node.phase}</span></div>
          <div class="path">${state.path.map((id, index) => `<button data-path="${index}" class="${index === state.path.length - 1 ? "active" : ""}">${index === 0 ? "Start" : index}</button>${index < state.path.length - 1 ? "<i>›</i>" : ""}`).join("")}</div>
          ${branchHtml(node, policy)}
          <p class="branch-help">${state.revealed ? "Use the placement labelled for the phase you see." : actionPoint(node.action) ? "Click the Black placement on the board." : "Use the action below the board."}</p>
        </article>
      </section>

      ${state.enemy !== "illuminati" && state.policies.length > 1 ? `<section class="opening-variants"><div><span class="eyebrow">Opening</span><h2>Choose your starting board</h2></div><div>${state.policies.map((item, index) => `<button data-policy="${index}" class="${index === state.policy ? "active" : ""}">${esc(item.name.replace(/^\d+-?/, "Opening "))}</button>`).join("")}</div></section>` : ""}
      ` : ""}
    </main>
    <footer><span>150,000 phases · verified routes</span><span>power/turn = min power ÷ max turns</span></footer>
  </div>`;

  bind();
}

function bind() {
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    state.tab = button.dataset.tab === "theory" ? "theory" : "explorer";
    history.replaceState(null, "", state.tab === "theory" ? "#how-it-works" : location.pathname + location.search);
    scrollTo({ top: 0, behavior: "smooth" });
    render();
  }));
  document.querySelector(".site-tabs")?.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    state.tab = state.tab === "explorer" ? "theory" : "explorer";
    render();
    document.querySelector<HTMLElement>(`.site-tabs [data-tab="${state.tab}"]`)?.focus();
  });
  document.querySelector<HTMLSelectElement>("#enemy")?.addEventListener("change", (event) => changeEnemy((event.target as HTMLSelectElement).value));
  document.querySelector("#change-opening")?.addEventListener("click", () => {
    state.policy = -1; state.path = []; state.revealed = false; render();
  });
  const slider = document.querySelector<HTMLInputElement>("#seed");
  const games = gamesForRoutes(state.routes);
  slider?.addEventListener("input", () => {
    const index = Number(slider.value);
    const game = games[index];
    if (!game) return;
    state.seed = game.seed;
    const displayedPhase = phaseDisplay(game.seed, game.route, phaseDistanceFromPrevious(games, index));
    const heading = document.querySelector(".seed-heading h1");
    if (heading) heading.innerHTML = displayedPhase.html;
    slider.setAttribute("aria-valuetext", `${displayedPhase.valueText}; game ${(index + 1).toLocaleString("en-US")} of ${games.length.toLocaleString("en-US")}`);
    slider.style.setProperty("--value", `${phaseRangePercent(index, games.length - 1)}%`);
  });
  slider?.addEventListener("change", () => {
    const game = games[Number(slider.value)];
    if (game) void loadSeed(game.seed);
  });
  document.querySelector("#seed-minus")?.addEventListener("click", () => {
    if (!games.length) return;
    const index = gameIndexForSeed(games, state.routes, state.seed);
    void loadSeed(games[(index + games.length - 1) % games.length]!.seed);
  });
  document.querySelector("#seed-plus")?.addEventListener("click", () => {
    if (!games.length) return;
    const index = gameIndexForSeed(games, state.routes, state.seed);
    void loadSeed(games[(index + 1) % games.length]!.seed);
  });
  document.querySelectorAll<HTMLElement>("[data-play-successor]").forEach((button) => button.addEventListener("click", () => {
    state.path.push(Number(button.dataset.playSuccessor)); state.revealed = true; render();
  }));
  const clearReplyPreview = () => {
    document.querySelectorAll(".response-preview.active").forEach((marker) => marker.classList.remove("active"));
    const forecast = document.querySelector<HTMLElement>("[data-reply-forecast]");
    if (forecast) forecast.textContent = forecast.dataset.defaultText ?? "";
  };
  document.querySelectorAll<HTMLElement>("[data-preview-replies]").forEach((option) => {
    const showReplyPreview = () => {
      clearReplyPreview();
      for (const reply of option.dataset.previewReplies?.split(",").filter(Boolean) ?? []) {
        document.querySelector(`[data-white-reply="${reply}"]`)?.classList.add("active");
      }
      const forecast = document.querySelector<HTMLElement>("[data-reply-forecast]");
      if (forecast && option.dataset.whiteSummary) forecast.textContent = option.dataset.whiteSummary;
    };
    option.addEventListener("pointerenter", showReplyPreview);
    option.addEventListener("pointerleave", clearReplyPreview);
    option.addEventListener("focus", showReplyPreview);
    option.addEventListener("blur", clearReplyPreview);
  });
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((button) => button.addEventListener("click", () => {
    state.revealed = true; render();
  }));
  document.querySelectorAll<HTMLElement>("[data-path]").forEach((button) => button.addEventListener("click", () => {
    state.path = state.path.slice(0, Number(button.dataset.path) + 1); state.revealed = false; render();
  }));
  document.querySelectorAll<HTMLElement>("[data-policy]").forEach((button) => button.addEventListener("click", () => {
    state.policy = Number(button.dataset.policy); state.path = [state.policies[state.policy]!.root.id]; state.revealed = false; render();
  }));
}

/** Monotone token so a slow response can never overwrite a newer request's
 * state — bump at each user-initiated load, check after each await. */
let requestToken = 0;

async function loadSeed(seed: number) {
  const token = ++requestToken;
  const requestedSeed = Math.max(0, Math.min((state.manifest?.phases ?? 150_000) - 1, seed));
  const games = gamesForRoutes(state.routes);
  const game = games[gameIndexForSeed(games, state.routes, requestedSeed)];
  state.seed = game?.seed ?? requestedSeed;
  state.loading = true; state.error = ""; render();
  try {
    const route = state.routes?.[state.seed];
    if (!route) throw new Error("The route table is unavailable.");
    const policies = await loadPolicies(state.enemy, route.entryPhase);
    if (token !== requestToken) return;
    if (!policies.length) throw new Error(`No certificate was found for entry phase ${route.entryPhase}.`);
    state.policies = policies;
    state.policy = state.enemy === "illuminati" ? -1 : 0;
    state.path = state.policy < 0 ? [] : [policies[0]!.root.id]; state.revealed = false;
  } catch (error) {
    if (token !== requestToken) return;
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === requestToken) { state.loading = false; render(); }
  }
}

async function changeEnemy(key: string) {
  const token = ++requestToken;
  state.enemy = key; state.policy = key === "illuminati" ? -1 : 0;
  state.path = []; state.revealed = false; state.loading = true; state.error = ""; state.policies = []; state.routes = undefined; render();
  try {
    const routes = await loadRoutes(key);
    if (token !== requestToken) return;
    state.routes = routes;
    await loadSeed(state.seed);
  } catch (error) {
    if (token !== requestToken) return;
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false; render();
  }
}

async function start() {
  render();
  try {
    const response = await fetch(`${DATA_BASE}/manifest.json`);
    if (!response.ok) throw new Error("Playbook data has not been prepared. Run the data preparation step first.");
    state.manifest = await response.json() as Manifest;
    state.routes = await loadRoutes(state.enemy);
    await loadSeed(state.seed);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false; render();
  }
}

void start();
