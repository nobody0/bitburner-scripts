import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { TELEMETRY_PORT, type WireMessage } from "../shared/telemetry/schema.ts";
import { RunStore } from "./store.ts";

/** Telemetry hub: one Bun.serve hosting
 *  - ws /ingest — game scripts and sim runs push WireMessages in
 *  - ws /live   — browser viewers get a snapshot, then live fan-out
 *  - HTTP /     — the viewer app; /app.js — its bundle; /runs, /runs/:file —
 *                 stored JSONL replays
 *  - POST /sim  — launch a simulation (bun sim/run.ts) from the dashboard */

const RUNS_DIR = new URL("../runs", import.meta.url).pathname;
/** Pinned runs live here and are never swept. Without somewhere to put them,
 * every A/B comparison evaporates after the retention window — which is the
 * one thing a simulation run exists to survive. */
const PINNED_DIR = path.join(RUNS_DIR, "pinned");
const PUBLIC_DIR = new URL("./public", import.meta.url).pathname;
const APP_DIR = new URL("./app", import.meta.url).pathname;
const APP_ENTRY = path.join(APP_DIR, "main.ts");
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const RETENTION_MS = 24 * 3_600_000;
const SWEEP_EVERY_MS = 3_600_000;

type SocketData = { role: "ingest"; store?: RunStore } | { role: "live" };

/** Keyed by run id. Closed runs stay here (live=false) until the sweep, so a
 * reconnecting client reattaches to its store instead of truncating the file. */
const runs = new Map<string, RunStore>();
const viewers = new Set<Bun.ServerWebSocket<SocketData>>();
let simBusy = false;

function listIn(dir: string, prefix: string): { file: string; size: number; pinned: boolean }[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names.map((name) => ({
    file: prefix + name,
    size: Bun.file(path.join(dir, name)).size,
    pinned: prefix !== "",
  }));
}

function listRunFiles(): { file: string; size: number; pinned: boolean }[] {
  return [...listIn(PINNED_DIR, "pinned/"), ...listIn(RUNS_DIR, "")].sort((a, b) =>
    path.basename(b.file).localeCompare(path.basename(a.file)),
  );
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
      tail: r.ring.slice(-1_000),
    })),
    stored: listRunFiles(),
    simBusy,
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
  renameSync(from, path.join(PINNED_DIR, path.basename(name)));
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

/** The game and the sim both dial TELEMETRY_PORT, so this is only for running
 * a second hub alongside a live one (a scratch instance, or a test). */
const PORT = Number(process.env["UI_PORT"] ?? TELEMETRY_PORT);

const server = Bun.serve<SocketData, never>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ingest" && srv.upgrade(req, { data: { role: "ingest" } as SocketData })) return;
    if (url.pathname === "/live" && srv.upgrade(req, { data: { role: "live" } as SocketData })) return;

    if (url.pathname === "/sim" && req.method === "POST") {
      return req.json().then(launchSim).catch(() => Response.json({ error: "bad JSON" }, { status: 400 }));
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
      const file = Bun.file(runPath(name));
      return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
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
        const existing = runs.get(message.hello.run);
        if (existing) {
          existing.reattach();
          ws.data.store = existing;
          console.log(`run reattached: ${existing.id}`);
        } else {
          ws.data.store = new RunStore(RUNS_DIR, message.hello);
          runs.set(message.hello.run, ws.data.store);
          console.log(`run started: ${message.hello.src}/${message.hello.script} (${message.hello.run})`);
        }
        broadcast({ type: "run-started", run: ws.data.store.summary() });
        return;
      }
      const store = ws.data.store ?? (message.records[0] && runs.get(message.records[0].run));
      if (!store) return;
      store.append(message.records);
      broadcast({ type: "records", run: store.id, records: message.records });
    },
    close(ws) {
      if (ws.data.role === "live") {
        viewers.delete(ws);
        return;
      }
      const store = ws.data.store;
      if (store) {
        store.close();
        console.log(`run ended: ${store.id} (${store.recordCount} records -> ${store.file})`);
        broadcast({ type: "run-ended", run: store.summary(), stored: listRunFiles() });
      }
    },
  },
});

sweep();
setInterval(sweep, SWEEP_EVERY_MS);

console.log(`telemetry hub on http://127.0.0.1:${server.port} (ws /ingest, /live; POST /sim; retention ${RETENTION_MS / 3_600_000}h)`);
