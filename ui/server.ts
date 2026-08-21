import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, type WebSocket as RfaSocket } from "ws";
import { TELEMETRY_PORT, type WireMessage } from "../shared/telemetry/schema.ts";
import { loadConfig } from "../tools/config.ts";
import { RfaSession } from "../tools/rfa-session.ts";
import { runSync, syncOptionsFrom, type SyncOptions } from "../tools/sync.ts";
import { RunStore } from "./store.ts";
import type { ArtifactMetadata, RunCatalogEntry } from "../shared/run-catalog.ts";

/** Telemetry hub: one Bun.serve hosting
 *  - ws /ingest — game scripts and sim runs push WireMessages in
 *  - ws /live   — browser viewers get a snapshot, then live fan-out
 *  - HTTP /     — the viewer app; /app.js — its bundle; /runs, /runs/:file —
 *                 stored JSONL replays
 *  - POST /sim  — launch a simulation (bun sim/run.ts) from the dashboard
 *  - POST /sync — build and push the game scripts (JSON body: SyncOptions)
 *
 * plus a second WebSocket listener on the Remote File API port. The hub owns
 * that port for its whole lifetime and the game stays connected to it: a
 * port that is only open during a sync forces the game's auto-reconnect to
 * fail every interval in between, spamming its console and toasting an error
 * cycle after every push. A held-open RFA connection costs nothing — the game
 * only ever answers requests — and makes syncs immediate. */

const modulePath = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));
const RUNS_DIR = modulePath("../runs");
/** Pinned runs live here and are never swept. Without somewhere to put them,
 * every A/B comparison evaporates after the retention window — which is the
 * one thing a simulation run exists to survive. */
const PINNED_DIR = path.join(RUNS_DIR, "pinned");
const PUBLIC_DIR = modulePath("./public");
const APP_DIR = modulePath("./app");
const APP_ENTRY = path.join(APP_DIR, "main.ts");
const REPO_ROOT = modulePath("..");
const RETENTION_MS = 24 * 3_600_000;
const SWEEP_EVERY_MS = 3_600_000;

type SocketData = { role: "ingest"; store?: RunStore } | { role: "live" };

/** Keyed by run id. Closed runs stay here (live=false) until the sweep, so a
 * reconnecting client reattaches to its store instead of truncating the file. */
const runs = new Map<string, RunStore>();
const viewers = new Set<Bun.ServerWebSocket<SocketData>>();
let simBusy = false;
let syncBusy = false;

function metadataFor(dir: string, name: string, prefix: string): RunCatalogEntry {
  const file = prefix + name;
  const full = path.join(dir, name);
  const size = Bun.file(full).size;
  try {
    const metadata = JSON.parse(readFileSync(`${full}.meta.json`, "utf8")) as ArtifactMetadata;
    return {
      ...metadata,
      file,
      size,
      pinned: prefix !== "",
      live: false,
      durationMs: metadata.firstT === null || metadata.lastT === null ? 0 : Math.max(0, metadata.lastT - metadata.firstT),
    };
  } catch {
    const match = /^(\d+)-(game|sim)-/.exec(name);
    const createdAt = match ? Number(match[1]) : statSync(full).birthtimeMs;
    const src = match?.[2] === "game" ? "game" : "sim";
    return {
      version: 1,
      file,
      hello: { run: file, src, script: src === "game" ? "start.js" : "sim", startedAt: createdAt },
      emitters: [file],
      records: 0,
      firstT: null,
      lastT: null,
      createdAt,
      updatedAt: statSync(full).mtimeMs,
      live: false,
      pinned: prefix !== "",
      size,
      legacy: true,
      durationMs: 0,
    };
  }
}

function listIn(dir: string, prefix: string): RunCatalogEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names.map((name) => metadataFor(dir, name, prefix));
}

function listRunFiles(): RunCatalogEntry[] {
  return [...listIn(PINNED_DIR, "pinned/"), ...listIn(RUNS_DIR, "")].sort((a, b) =>
    path.basename(b.file).localeCompare(path.basename(a.file)),
  );
}

interface LegacyEdgeRecord {
  t: number;
  run?: string;
  src?: "game" | "sim";
}

/** Read a bounded edge of a legacy log. Historical directories can contain
 * tens of gigabytes, so startup must not rescan entire JSONL files merely to
 * discover their duration. A partial oversized row is ignored safely. */
function legacyEdge(full: string, size: number, fromEnd: boolean): LegacyEdgeRecord | undefined {
  const bytes = Math.min(size, 256_000);
  if (bytes <= 0) return;
  const buffer = Buffer.allocUnsafe(bytes);
  const fd = openSync(full, "r");
  try {
    readSync(fd, buffer, 0, bytes, fromEnd ? size - bytes : 0);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  if (fromEnd) lines.reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<LegacyEdgeRecord>;
      if (typeof value.t !== "number" || !Number.isFinite(value.t)) continue;
      return {
        t: value.t,
        ...(typeof value.run === "string" ? { run: value.run } : {}),
        ...(value.src === "game" || value.src === "sim" ? { src: value.src } : {}),
      };
    } catch {
      // The first line of a tail window, or last line of a live file, can be partial.
    }
  }
  return;
}

/** Give pre-lineage JSONL files enough catalog data to remain useful. The
 * generated sidecar makes every later list operation constant-time. Legacy
 * files stay ungrouped because ancestry cannot be reconstructed safely. */
function backfillLegacyMetadataIn(dir: string, prefix: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return;
  }

  for (const name of names) {
    const full = path.join(dir, name);
    const sidecar = `${full}.meta.json`;
    const stats = statSync(full);
    if (existsSync(sidecar)) continue;
    const first = legacyEdge(full, stats.size, false);
    const last = legacyEdge(full, stats.size, true);
    const firstT = first?.t ?? null;
    const lastT = last?.t ?? firstT;
    const emitter = first?.run ?? last?.run ?? prefix + name;
    const source = first?.src ?? last?.src ?? (name.includes("-game-") ? "game" : "sim");
    const match = /^(\d+)-(?:game|sim)-/.exec(name);
    const createdAt = match ? Number(match[1]) : stats.birthtimeMs;
    const metadata: ArtifactMetadata = {
      version: 1,
      file: prefix + name,
      hello: {
        run: emitter,
        src: source,
        script: source === "game" ? "start.js" : "sim",
        startedAt: createdAt,
      },
      emitters: [emitter],
      records: 0,
      firstT,
      lastT,
      createdAt,
      updatedAt: stats.mtimeMs,
      live: false,
      pinned: prefix !== "",
      size: stats.size,
      legacy: true,
    };
    writeFileSync(sidecar, JSON.stringify(metadata, null, 2) + "\n");
    console.log(`indexed legacy run: ${prefix}${name}`);
  }
}

function backfillLegacyMetadata(): void {
  backfillLegacyMetadataIn(RUNS_DIR, "");
  backfillLegacyMetadataIn(PINNED_DIR, "pinned/");
}

/** Resolve a client-supplied run name to a path inside runs/, pinned or not.
 * basename() on the last segment keeps ".." out of it. */
function runPath(name: string): string {
  const pinned = name.startsWith("pinned/");
  return path.join(pinned ? PINNED_DIR : RUNS_DIR, path.basename(name));
}

/** Delete run files older than the retention window and prune dead stores. */
function sweep(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const { file, pinned } of listRunFiles()) {
    if (pinned) continue;
    const full = path.join(RUNS_DIR, file);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        try { unlinkSync(`${full}.meta.json`); } catch { /* legacy file */ }
        console.log(`swept ${file}`);
      }
    } catch {
      /* raced with a writer; next sweep gets it */
    }
  }
  for (const [id, store] of runs) {
    if (!store.live && (store.closedAt ?? 0) < cutoff) runs.delete(id);
  }
}

/** Above this, a stored run is served compacted rather than whole.
 *
 * The viewer used to fetch the entire JSONL, split it and JSON.parse every
 * line. Real runs reach 126 MB, which is minutes of blocked main thread for a
 * panel that only ever shows the last-write-wins state plus a short event
 * feed. Small runs still load whole, because only they can be scrubbed. */
const COMPACT_OVER_BYTES = 8_000_000;
/** Discrete records kept by a compaction, newest-first-wins. */
const COMPACT_TAIL = 2_000;

/** Fold a stored run down to what a panel needs: one record per state key
 * (last write wins) plus a bounded tail of discrete records.
 *
 * Streamed line by line — the whole point is never to hold the file in memory,
 * so this must not grow with run length. */
async function compactRun(file: string): Promise<Response> {
  const state = new Map<string, LogRecordish>();
  const tail: LogRecordish[] = [];
  let records = 0;
  let t0: number | null = null;
  let lastT = 0;
  let pending = "";

  const decoder = new TextDecoder();
  const consume = (line: string): void => {
    if (!line) return;
    let record: LogRecordish;
    try {
      record = JSON.parse(line) as LogRecordish;
    } catch {
      return; // a live run's last line can be a partial write
    }
    records++;
    if (t0 === null) t0 = record.t;
    lastT = record.t;
    if (record.kind === "state" && typeof record.key === "string") {
      state.set(record.key, record);
      return;
    }
    tail.push(record);
    if (tail.length > COMPACT_TAIL) tail.splice(0, tail.length - COMPACT_TAIL);
  };

  for await (const chunk of Bun.file(file).stream()) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    // Split once per chunk and keep the trailing fragment. Repeatedly slicing
    // the head off `pending` instead would be quadratic in lines-per-chunk —
    // invisible on a run whose records are megabytes each, and pathological on
    // a sim run with a million small ones.
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  consume(pending);

  return Response.json({
    compacted: true,
    records,
    t0,
    lastT,
    // Emitters restart across handoffs, so seq is only meaningful within run.
    entries: [...state.values(), ...tail].sort((a, b) => a.t - b.t || a.run.localeCompare(b.run) || a.seq - b.seq),
  });
}

interface LogRecordish {
  seq: number;
  t: number;
  run: string;
  kind: string;
  key?: string;
}

/** Viewer bundle. `ui/app/` is TypeScript so the tab renderers typecheck
 * against StateMap, but the viewer keeps its no-build-step feel: Bun's own
 * bundler runs in this process and rebuilds whenever a source file changes.
 * A browser refresh is the whole dev loop, exactly as before. */
let appCache: { mtime: number; body: string } | undefined;

function appSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? appSourceMtime(full) : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

async function appBundle(): Promise<Response> {
  // shared/ is in the graph too, so its mtime matters for the cache key.
  const mtime = Math.max(appSourceMtime(APP_DIR), appSourceMtime(path.join(REPO_ROOT, "shared")));
  if (!appCache || appCache.mtime !== mtime) {
    const result = await Bun.build({
      entrypoints: [APP_ENTRY],
      target: "browser",
      format: "esm",
      sourcemap: "inline",
    });
    if (!result.success) {
      const message = result.logs.map((log) => String(log)).join("\n");
      console.error(`app bundle failed:\n${message}`);
      // Surface the failure in the page instead of serving a stale bundle.
      return new Response(`document.body.textContent = ${JSON.stringify(`app build failed:\n${message}`)};`, {
        headers: { "content-type": "text/javascript" },
      });
    }
    appCache = { mtime, body: await result.outputs[0]!.text() };
  }
  return new Response(appCache.body, {
    headers: { "content-type": "text/javascript", "cache-control": "no-store" },
  });
}

function broadcast(payload: unknown): void {
  // Records arrive in batches around the clock; with no browser open,
  // serializing them for nobody is the hub's single largest steady-state cost.
  if (viewers.size === 0) return;
  const text = JSON.stringify(payload);
  for (const viewer of viewers) viewer.send(text);
}

function liveRunList(): RunStore[] {
  return [...runs.values()].filter((r) => r.live);
}

function snapshotFor(): unknown {
  return {
    type: "snapshot",
    runs: liveRunList().map((r) => ({
      ...r.summary(),
      state: [...r.state.values()],
      tail: r.tail(),
    })),
    stored: listRunFiles(),
    // Advertised rather than duplicated in the client: the viewer decides
    // whole-vs-compacted from the file size it already has in `stored`.
    compactOverBytes: COMPACT_OVER_BYTES,
    simBusy,
    syncBusy,
    rfaConnected: rfa !== undefined,
  };
}

const SIM_ARG = /^[\w.,:+~-]+$/;

/** Move a stored run out of the retention sweep's reach. */
function pinRun(name: string): Response {
  if (!name || name.startsWith("pinned/")) {
    return Response.json({ error: "nothing to pin" }, { status: 400 });
  }
  const from = path.join(RUNS_DIR, path.basename(name));
  if (Bun.file(from).size === 0) return Response.json({ error: "no such run" }, { status: 404 });
  mkdirSync(PINNED_DIR, { recursive: true });
  const to = path.join(PINNED_DIR, path.basename(name));
  renameSync(from, to);
  try { renameSync(`${from}.meta.json`, `${to}.meta.json`); } catch { /* legacy file */ }
  broadcast({ type: "runs-changed", stored: listRunFiles() });
  return Response.json({ pinned: `pinned/${path.basename(name)}` });
}

interface SimRequest {
  goal?: string;
  goals?: string[];
  seeds?: string;
  horizon?: string;
  label?: string;
  profile?: string;
  save?: string;
  driver?: string;
}

async function launchSim(body: SimRequest): Promise<Response> {
  if (simBusy) return Response.json({ error: "a simulation is already running" }, { status: 409 });
  const goals = body.goals ?? (body.goal ? [body.goal] : []);
  const args: string[] = [];
  if (body.profile) args.push("--profile", body.profile);
  if (body.save) args.push("--save", body.save);
  if (body.driver) args.push("--driver", body.driver);
  for (const goal of goals) args.push("--goal", goal);
  if (body.seeds) args.push(/\.\.|,/.test(body.seeds) ? "--seeds" : "--seed", body.seeds);
  if (body.horizon) args.push("--horizon", body.horizon);
  if (body.label) args.push("--label", body.label);
  // A profile carries its own goals, so either is a complete request.
  if (goals.length === 0 && !body.profile) {
    return Response.json({ error: "a goal or a profile is required" }, { status: 400 });
  }
  if (!args.every((a) => a.startsWith("--") || SIM_ARG.test(a))) {
    return Response.json({ error: "invalid characters in arguments" }, { status: 400 });
  }

  simBusy = true;
  broadcast({ type: "sim-status", busy: true });
  const proc = Bun.spawn(["bun", "run", "sim/run.ts", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    simBusy = false;
    console.log(`sim finished (exit ${code})\n${out}${err}`);
    broadcast({ type: "sim-finished", code, output: (out + err).slice(-4_000), stored: listRunFiles() });
  })();
  return Response.json({ started: true, args });
}

/** Build and push over the hub's persistent Remote File API connection — the
 * same runSync the `bun run sync` CLI uses (the CLI in fact routes through
 * this endpoint while the hub is up, carrying its flags in the POST body).
 * The response resolves when the sync is done and carries {code, output};
 * progress and completion are also broadcast to /live viewers. */
async function launchSync(options: SyncOptions): Promise<Response> {
  if (syncBusy) return Response.json({ error: "a sync is already running" }, { status: 409 });
  const session = rfa?.session;
  if (!session) {
    return Response.json(
      { error: `Bitburner is not connected — enable the Remote API (port ${RFA_PORT}) in the game options` },
      { status: 503 },
    );
  }

  syncBusy = true;
  broadcast({ type: "sync-status", busy: true });
  const lines: string[] = [];
  let code = 0;
  try {
    await runSync(session, config, options, (line) => {
      lines.push(line);
      console.log(line);
    });
  } catch (error) {
    code = 1;
    lines.push(String(error));
    console.error("sync failed:", error);
  }
  syncBusy = false;
  const output = lines.join("\n").slice(-4_000);
  console.log(`sync finished (exit ${code})`);
  broadcast({ type: "sync-finished", code, output });
  return Response.json({ code, output });
}

/** The game and the sim both dial TELEMETRY_PORT, so this is only for running
 * a second hub alongside a live one (a scratch instance, or a test). Same for
 * RFA_PORT, which otherwise comes from bitburner.config.json. */
const PORT = Number(process.env["UI_PORT"] ?? TELEMETRY_PORT);

// runSync builds with repo-relative entry paths, so the hub must run from the
// repo root regardless of where it was launched.
process.chdir(REPO_ROOT);
const config = await loadConfig(path.join(REPO_ROOT, "bitburner.config.json"));
const RFA_PORT = Number(process.env["RFA_PORT"] ?? config.port);

/** The game's live Remote File API connection, replaced on reconnect. */
let rfa: { session: RfaSession; socket: RfaSocket } | undefined;

const rfaServer = new WebSocketServer({ host: config.host, port: RFA_PORT });
rfaServer.on("connection", (socket: RfaSocket) => {
  // A page reload gives the game a fresh socket; the newest connection wins.
  rfa?.session.dispose(new Error("replaced by a newer Bitburner connection"));
  rfa?.socket.close();
  rfa = { session: new RfaSession(socket), socket };
  console.log(`Bitburner connected on ws://${config.host}:${RFA_PORT}`);
  broadcast({ type: "rfa-status", connected: true });
  socket.on("close", () => {
    if (rfa?.socket !== socket) return;
    rfa = undefined;
    console.log("Bitburner disconnected");
    broadcast({ type: "rfa-status", connected: false });
  });
});
rfaServer.on("error", (error: Error) => {
  // Most likely EADDRINUSE from a fallback CLI sync; the hub still serves.
  console.error(`Remote File API listener failed on port ${RFA_PORT}:`, error.message);
});

mkdirSync(RUNS_DIR, { recursive: true });
backfillLegacyMetadata();

const server = Bun.serve<SocketData, never>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ingest" && srv.upgrade(req, { data: { role: "ingest" } as SocketData })) return;
    if (url.pathname === "/live" && srv.upgrade(req, { data: { role: "live" } as SocketData })) return;

    if (url.pathname === "/sim" && req.method === "POST") {
      return req.json().then(launchSim).catch(() => Response.json({ error: "bad JSON" }, { status: 400 }));
    }
    if (url.pathname === "/sync" && req.method === "POST") {
      // An empty body (the dashboard button) means default options.
      return req
        .json()
        .catch(() => ({}))
        .then((body) => launchSync(syncOptionsFrom(body)));
    }
    if (url.pathname === "/app.js") return appBundle();
    if (url.pathname === "/runs") return Response.json(listRunFiles());
    if (url.pathname === "/profiles") {
      return import("../sim/profiles.ts").then((mod) =>
        Response.json(mod.PROFILES.map((p) => ({ id: p.id, description: p.description }))),
      );
    }
    if (url.pathname === "/saves") {
      return import("../tools/save-io.ts")
        .then((mod) => Response.json(mod.readIndex().saves))
        .catch(() => Response.json([]));
    }
    if (url.pathname === "/pin" && req.method === "POST") {
      return req
        .json()
        .then((body: { file?: string }) => pinRun(body.file ?? ""))
        .catch(() => Response.json({ error: "bad JSON" }, { status: 400 }));
    }
    if (url.pathname.startsWith("/runs/")) {
      const name = decodeURIComponent(url.pathname.slice("/runs/".length));
      const full = runPath(name);
      const file = Bun.file(full);
      if (file.size === 0) return new Response("not found", { status: 404 });
      // The viewer asks for whichever form it can use: whole when the run is
      // small enough to scrub, compacted when it is not.
      if (url.searchParams.get("compact") === "1") return compactRun(full);
      return new Response(file);
    }

    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(path.join(PUBLIC_DIR, path.normalize(asset)));
    return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.role === "live") {
        viewers.add(ws);
        ws.send(JSON.stringify(snapshotFor()));
      }
    },
    message(ws, raw) {
      if (ws.data.role !== "ingest") return;
      let message: WireMessage;
      try {
        message = JSON.parse(String(raw)) as WireMessage;
      } catch {
        return;
      }
      if ("hello" in message) {
        const artifactId = message.hello.identity?.install.id ?? message.hello.run;
        const existing = runs.get(artifactId);
        if (existing) {
          existing.attach(message.hello);
          ws.data.store = existing;
          console.log(`run reattached: ${existing.id}`);
        } else {
          const resume = message.hello.identity
            ? listRunFiles().find((entry) => !entry.pinned && entry.identity?.install.id === artifactId)
            : undefined;
          ws.data.store = new RunStore(RUNS_DIR, message.hello, resume);
          runs.set(artifactId, ws.data.store);
          console.log(`run started: ${message.hello.src}/${message.hello.script} (${message.hello.run})`);
        }
        broadcast({ type: "run-started", run: ws.data.store.summary() });
        return;
      }
      const store = ws.data.store ?? (message.records[0] && runs.get(message.records[0].run));
      if (!store) return;
      const accepted = store.append(message.records);
      if (accepted.length > 0) broadcast({ type: "records", run: store.id, records: accepted });
    },
    close(ws) {
      if (ws.data.role === "live") {
        viewers.delete(ws);
        return;
      }
      const store = ws.data.store;
      if (store) {
        const closing = store.detach();
        if (closing) void closing.then(() => {
          console.log(`run ended: ${store.id} (${store.recordCount} records -> ${store.file})`);
          broadcast({ type: "run-ended", run: store.summary(), stored: listRunFiles() });
        }).catch((error) => console.error(`failed to close run ${store.id}:`, error));
      }
    },
  },
});

sweep();
setInterval(sweep, SWEEP_EVERY_MS);

console.log(
  `telemetry hub on http://127.0.0.1:${server.port} (ws /ingest, /live; POST /sim, /sync; retention ${RETENTION_MS / 3_600_000}h); Remote File API on ws://${config.host}:${RFA_PORT}`,
);
