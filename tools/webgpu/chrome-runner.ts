/** Run a bundled test entry inside headless Chrome and return its result.
 *
 * Chrome headless executes WGSL through Dawn on Metal — the same WebGPU
 * implementation family as Bitburner's Electron — so this is the closest
 * off-game execution environment for the deployed compute shader. The entry
 * module must assign a promise of a JSON-serializable value to
 * `globalThis.__goWebGpuResult`.
 *
 * No dependencies beyond the repo toolchain: esbuild bundles the entry into a
 * single inline script (file:// pages cannot load module scripts), and bun's
 * built-in WebSocket speaks the DevTools protocol.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";
import * as esbuild from "esbuild";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** The first installed Chrome/Chromium, or undefined. The caller turns an
 * absent browser into an explicit WebGPU-gate failure. */
export async function chromeBinaryPath(): Promise<string | undefined> {
  for (const candidate of CHROME_CANDIDATES) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

async function chromeBinary(): Promise<string> {
  const binary = await chromeBinaryPath();
  if (!binary) throw new Error("no Chrome/Chromium binary found for the WebGPU harness");
  return binary;
}

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

function connectCdp(url: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    socket.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
        });
      },
      close() {
        socket.close();
      },
    });
    socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message: string };
        result?: Record<string, unknown>;
      };
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    };
  });
}

async function captureStderr(
  chrome: Subprocess<"ignore", "ignore", "pipe">,
  chunks: string[],
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = chrome.stderr.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      chunks.push(decoder.decode(value));
      if (chunks.length > 40) chunks.shift();
    }
  } catch {
    // Process teardown closes the pipe while this diagnostic reader is live.
  }
}

/** Chrome writes this two-line rendezvous file only after the browser process
 * is accepting CDP connections. Polling it keeps the deadline real: awaiting
 * a quiet stderr pipe can otherwise block forever before checking the clock. */
async function devtoolsUrl(
  chrome: Subprocess<"ignore", "ignore", "pipe">,
  profileDir: string,
  stderr: string[],
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const portFile = Bun.file(join(profileDir, "DevToolsActivePort"));
    if (await portFile.exists()) {
      const [port, path] = (await portFile.text()).trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    if (chrome.exitCode !== null) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Chrome did not create DevToolsActivePort within 20s (exit ${chrome.exitCode ?? "running"}):\n`
      + stderr.join("").slice(-2_000),
  );
}

export interface ChromeWebGpuRun {
  result: unknown;
}

export async function runInHeadlessChrome(entryPath: string, timeoutMs = 300_000): Promise<ChromeWebGpuRun> {
  const bundle = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    define: { "import.meta.main": "false" },
    write: false,
    target: "chrome120",
  });
  // The bundle is fully materialized above. Do not leave esbuild's service
  // child keeping a one-shot gate or Bun test process alive afterward.
  esbuild.stop();
  const scratch = mkdtempSync(join(tmpdir(), "go-webgpu-"));
  const pagePath = join(scratch, "harness.html");
  const profileDir = join(scratch, "profile");
  writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>go webgpu harness</title>\n<script>${bundle.outputFiles[0]!.text}</script>`);

  const chrome = spawn({
    cmd: [
      await chromeBinary(),
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--use-angle=metal",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPU",
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr: string[] = [];
  void captureStderr(chrome, stderr);
  let cdp: CdpConnection | undefined;
  try {
    const browser = await connectCdp(await devtoolsUrl(chrome, profileDir, stderr));
    const created = await browser.send("Target.createTarget", { url: `file://${pagePath}` });
    const attached = await browser.send("Target.attachToTarget", {
      targetId: created["targetId"],
      flatten: true,
    });
    const sessionId = attached["sessionId"] as string;
    cdp = browser;
    await browser.send("Runtime.enable", {}, sessionId);
    // Target.createTarget resolves before the document has parsed the inline
    // bundle. Evaluating too early would resolve `undefined` against the
    // initial empty document and report a harness-shaped result with no data,
    // so wait for the entry to publish its promise first.
    const readyBy = Date.now() + 30_000;
    while (Date.now() < readyBy) {
      const probe = await browser.send("Runtime.evaluate", {
        expression: "typeof globalThis.__goWebGpuResult",
        returnByValue: true,
      }, sessionId);
      if ((probe["result"] as { value?: unknown } | undefined)?.value === "object") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const evaluated = await Promise.race([
      browser.send("Runtime.evaluate", {
        expression: "globalThis.__goWebGpuResult",
        awaitPromise: true,
        returnByValue: true,
      }, sessionId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`WebGPU harness timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    const wrapper = evaluated["result"] as { value?: unknown; description?: string } | undefined;
    const exception = evaluated["exceptionDetails"] as { exception?: { description?: string } } | undefined;
    if (exception) {
      throw new Error(`harness threw: ${exception.exception?.description ?? JSON.stringify(exception)}`);
    }
    return { result: wrapper?.value };
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    await chrome.exited.catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}
