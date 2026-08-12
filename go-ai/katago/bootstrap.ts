import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KATAGO_COMMIT, KATAGO_MODELS } from "./advisor.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const goAiRoot = resolve(import.meta.dir, "..");
const checkout = join(goAiRoot, ".deps/KataGo");
const patch = join(import.meta.dir, "ipvgo-walls.patch");

async function run(command: string[], cwd = projectRoot, quiet = false): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    quiet ? new Response(process.stdout).text() : "",
    quiet ? new Response(process.stderr).text() : "",
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})${stderr ? `\n${stderr}` : ""}`);
  return stdout.trim();
}

async function succeeds(command: string[], cwd = projectRoot): Promise<boolean> {
  const process = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await process.exited === 0;
}

async function hash(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function download(url: string, path: string, expected: string): Promise<void> {
  if (await Bun.file(path).exists() && await hash(path) === expected) return;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} (${response.status})`);
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, response.body);
  const actual = await hash(temporary);
  if (actual !== expected) throw new Error(`model checksum mismatch: ${actual} != ${expected}`);
  await run(["mv", temporary, path]);
}

async function main(): Promise<void> {
  await mkdir(join(goAiRoot, ".deps"), { recursive: true });
  if (!await Bun.file(join(checkout, ".git/HEAD")).exists()) {
    await run([
      "git", "clone", "--branch", "v1.16.3", "--depth", "1",
      "https://github.com/lightvector/KataGo.git", checkout,
    ]);
  }
  const commit = await run(["git", "rev-parse", "HEAD"], checkout, true);
  if (commit !== KATAGO_COMMIT) {
    throw new Error(`KataGo checkout is ${commit}; expected pinned ${KATAGO_COMMIT}`);
  }
  if (await succeeds(["git", "apply", "--check", patch], checkout)) {
    await run(["git", "apply", patch], checkout);
  } else if (!await succeeds(["git", "apply", "--reverse", "--check", patch], checkout)) {
    throw new Error("KataGo checkout is dirty in a way that does not match ipvgo-walls.patch");
  }

  await mkdir(join(goAiRoot, "katago/models"), { recursive: true });
  await mkdir(join(goAiRoot, "katago/results/logs"), { recursive: true });
  for (const model of Object.values(KATAGO_MODELS)) {
    await download(model.url, join(projectRoot, model.file), model.sha256);
  }

  if (Bun.argv.includes("--no-build")) return;
  const backendIndex = Bun.argv.indexOf("--backend");
  const backend = (backendIndex >= 0 ? Bun.argv[backendIndex + 1]
    : process.platform === "darwin" ? "OPENCL" : "EIGEN")!.toUpperCase();
  const build = join(checkout, `build/ipvgo-${backend.toLowerCase()}`);
  const configure = [
    "cmake", "-S", join(checkout, "cpp"), "-B", build,
    "-DCMAKE_BUILD_TYPE=Release", `-DUSE_BACKEND=${backend}`, "-DNO_GIT_REVISION=1",
  ];
  if (backend === "METAL") {
    if (!await succeeds(["sh", "-c", "command -v ninja"])) {
      throw new Error("the Metal build requires Ninja (install with `brew install ninja`)");
    }
    configure.push("-G", "Ninja");
  }
  await run(configure);
  await run(["cmake", "--build", build, "--parallel", "4"]);
  console.log(JSON.stringify({ checkout, commit, backend, binary: join(build, "katago") }));
}

if (import.meta.main) await main();
