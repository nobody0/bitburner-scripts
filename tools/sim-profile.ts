/** Throughput matrix for the simulator, and the CPU-profile driver.
 *
 * Two jobs, because they answer two halves of "why is this run slow":
 *
 *   - `--matrix` runs the same profile under varying configurations, each
 *     bounded to the same real budget, and reports virtual-hours-per-wall-minute
 *     for each. It needs no new simulator code — `--only`, `--perf` and
 *     `--compact` already exist.
 *
 *     Read it as a screen, NOT as attribution by subtraction. Turning a feature
 *     off does not run the same simulation more cheaply; it runs a DIFFERENT
 *     simulation. A build that cannot buy servers has fewer hosts to dispatch
 *     to and looks fast for a reason that has nothing to do with the cost of
 *     the feature removed — which is why the feature ladder is not monotonic.
 *     What the matrix is good for is spotting an order-of-magnitude outlier and
 *     confirming that a suspect is NOT the problem. Clean attribution comes
 *     from `--cpu-prof`.
 *   - `--cpu-prof` takes a single bounded run under Bun's sampling profiler,
 *     writing both a `.cpuprofile` and the markdown digest that is actually
 *     readable without a flamegraph viewer.
 *
 * Every run is a child process for the reason `sim/run.ts` already spawns them:
 * the game driver installs process-wide virtual time and module-level BitNode
 * multipliers, so one run per process is not a preference. It also means the
 * profiler flags can be put in front of the child's own argv, which is the only
 * way to profile the run rather than an idle parent.
 *
 * Read the numbers as ratios, not absolutes. These are wall-clock measurements
 * on a shared machine; a 5% gap is noise and a 2x gap is a finding. */

const args = process.argv.slice(2);
const valueAfter = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};
const has = (name: string): boolean => args.includes(name);

const profile = valueAfter("--profile", "leg-bn1.1");
const seed = valueAfter("--seed", "1");
const budget = valueAfter("--wall-budget", "2m");
const outDir = valueAfter("--out-dir", "runs/profiles");
// Aim for roughly ten samples per case however short the budget, so the drift
// column has enough intervals to show a direction. parseDuration lives in
// sim/run.ts and is not worth importing for this; the child parses the string.
const sampleEvery = `${Math.max(1, Math.round(approxSeconds(budget) / 10))}s`;

/** Rough seconds for a duration string, only ever used to pick a sampling
 * cadence. The child does the real parsing. */
function approxSeconds(duration: string): number {
  const match = /^([\d.]+)\s*(ms|s|m|h)?$/.exec(duration.trim());
  if (!match) return 120;
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms": return value / 1000;
    case "m": return value * 60;
    case "h": return value * 3600;
    default: return value;
  }
}

interface Case {
  name: string;
  /** Extra sim/run.ts arguments on top of the shared base. */
  args: string[];
  note: string;
}

/** The screening matrix. Each row differs from the one above it in one thing,
 * which makes a large gap worth investigating — not a cost attributable to the
 * thing that changed. */
function matrixCases(): Case[] {
  return [
    { name: "baseline", args: ["--compact", "--perf"], note: "how the benchmark is actually run" },
    { name: "+telemetry", args: ["--compact"], note: "cost of the telemetry JSON round-trip" },
    { name: "+artifacts", args: ["--perf"], note: "cost of serializing every record to JSONL" },
    { name: "only:hacking", args: ["--compact", "--perf", "--only", "hacking"], note: "the dispatcher alone" },
    { name: "+factions", args: ["--compact", "--perf", "--only", "hacking,factions"], note: "" },
    { name: "+progression", args: ["--compact", "--perf", "--only", "hacking,factions,progression"], note: "" },
    { name: "+career", args: ["--compact", "--perf", "--only", "hacking,factions,progression,career"], note: "" },
    { name: "+hacknet", args: ["--compact", "--perf", "--only", "hacking,factions,progression,career,hacknet"], note: "" },
    { name: "+stock", args: ["--compact", "--perf", "--only", "hacking,factions,progression,career,hacknet,stock"], note: "" },
    { name: "+side", args: ["--compact", "--perf", "--only", "hacking,factions,progression,career,hacknet,stock,side"], note: "" },
    { name: "+go", args: ["--compact", "--perf", "--only", "hacking,factions,progression,career,hacknet,stock,side,go"], note: "= the baseline feature set" },
  ];
}

interface Measured {
  name: string;
  note: string;
  throughput: number;
  virtualHours: number;
  usPerEvent: number;
  eventsPerSecond: number;
  heap: number;
  cancelled: number;
  nsCalls: number;
  records: number;
  /** First and last per-interval throughput, so decay is visible per row. */
  drift: string;
  topCalls: { name: string; count: number; perVirtualHour: number }[];
}

/** One bounded child run. The cost report is read back off the process's stdout
 * rather than a side file: `sim/run.ts` already prints it, and parsing what the
 * user can also see keeps the two from drifting apart. */
async function measure(testCase: Case, extraBunArgs: string[] = []): Promise<Measured | undefined> {
  const child = Bun.spawn(
    [
      "bun",
      ...extraBunArgs,
      "sim/run.ts",
      "--profile", profile,
      "--seed", seed,
      "--wall-budget", budget,
      "--cost",
      "--cost-every", sampleEvery,
      "--out-dir", outDir,
      "--label", `profile-${testCase.name}`,
      ...testCase.args,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const text = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (has("--verbose")) console.log(text);

  const report = parseCostReport(text);
  if (!report) {
    // Exit code 2 is the simulator's "invalid for goal", which a budgeted run
    // should never produce; anything else here means the child died.
    console.error(
      `  ${testCase.name}: no cost report in output (child exited ${exitCode}` +
        `${has("--verbose") ? "" : "; rerun with --verbose"})`,
    );
    return undefined;
  }
  return { name: testCase.name, note: testCase.note, ...report };
}

/** Pull the numbers back out of `formatReport`'s output. */
function parseCostReport(text: string): Omit<Measured, "name" | "note"> | undefined {
  const headline = /cost: ([\d.]+)s real bought ([\d.]+)h virtual \(([\d.]+) virtual-hours per wall-minute\)/.exec(text);
  if (!headline) return undefined;
  const events = /events=(\d+) \((\d+)\/s real, ([\d.]+)us each/.exec(text);
  const queue = /queue: heap=(\d+) cancelled=(\d+)\s+engineCycles=(\d+)\s+records=(\d+)\s+nsCalls=(\d+)/.exec(text);
  const drift = /throughput ([\d.]+) -> ([\d.]+) vh\/min \(first vs last half of \d+ samples, ([-+]?\d+)%\)/.exec(text);

  const topCalls: { name: string; count: number; perVirtualHour: number }[] = [];
  for (const line of text.split("\n")) {
    const call = /^ {4}(\S+)\s+(\d+)\s+(\d+)\/vh$/.exec(line);
    if (call) topCalls.push({ name: call[1]!, count: Number(call[2]), perVirtualHour: Number(call[3]) });
  }

  return {
    throughput: Number(headline[3]),
    virtualHours: Number(headline[2]),
    usPerEvent: events ? Number(events[3]) : 0,
    eventsPerSecond: events ? Number(events[2]) : 0,
    heap: queue ? Number(queue[1]) : 0,
    cancelled: queue ? Number(queue[2]) : 0,
    records: queue ? Number(queue[4]) : 0,
    nsCalls: queue ? Number(queue[5]) : 0,
    drift: drift ? `${drift[1]} -> ${drift[2]} (${drift[3]}%)` : "-",
    topCalls,
  };
}

async function runMatrix(): Promise<void> {
  const cases = matrixCases();
  console.log(
    `Simulator throughput matrix: profile=${profile} seed=${seed} budget=${budget} per case, ${cases.length} cases.\n` +
      "Each case is one bounded child process. Higher vh/min is faster.\n\n" +
      "A SCREEN, not an attribution. Each row is a different simulation, not the same one with a\n" +
      "cost removed: a build that cannot buy servers has fewer hosts to dispatch to and looks fast\n" +
      "for unrelated reasons, so the feature ladder is not monotonic. Chase order-of-magnitude gaps\n" +
      "and use it to rule suspects out; get real attribution from --cpu-prof.\n\n" +
      "us/event travels better across rows than vh/min, being cost per unit of work rather than\n" +
      "per unit of simulated time. The drift column is the one to read first: it compares the\n" +
      "first half of a case's samples against the second, and strongly negative means cost grows\n" +
      "with run length, which is a different bug from being uniformly slow.\n",
  );

  const measured: Measured[] = [];
  for (const testCase of cases) {
    process.stdout.write(`  running ${testCase.name} ...`);
    const result = await measure(testCase);
    if (result) {
      measured.push(result);
      console.log(` ${result.throughput.toFixed(2)} vh/min`);
    }
  }
  if (measured.length === 0) return;

  const baseline = measured[0]!.throughput;
  console.table(
    measured.map((row) => ({
      case: row.name,
      "vh/min": row.throughput.toFixed(2),
      "vs baseline": `${(row.throughput / baseline).toFixed(2)}x`,
      "us/event": row.usPerEvent.toFixed(1),
      "events/s": row.eventsPerSecond,
      "ns calls": row.nsCalls,
      records: row.records,
      heap: row.heap,
      cancelled: row.cancelled,
      "throughput drift": row.drift,
      note: row.note,
    })),
  );

  const last = measured[measured.length - 1]!;
  if (last.topCalls.length > 0) {
    console.log(`\nHottest Netscript calls in the fullest configuration (${last.name}), per virtual hour:`);
    console.table(last.topCalls.slice(0, 15).map((call) => ({
      call: call.name,
      count: call.count,
      "per virtual hour": call.perVirtualHour,
    })));
  }
}

async function runCpuProfile(): Promise<void> {
  const heap = has("--heap-prof");
  console.log(
    `CPU profile: profile=${profile} seed=${seed} budget=${budget} -> ${outDir}\n` +
      "Single seed on purpose: a multi-seed run fans out to child processes and the profiler would only see an idle parent.\n",
  );
  const bunArgs = [
    "--cpu-prof",
    "--cpu-prof-md",
    "--cpu-prof-dir", outDir,
    "--cpu-prof-name", `${profile}-seed${seed}`,
    ...(has("--interval") ? ["--cpu-prof-interval", valueAfter("--interval", "1000")] : []),
    // --heap-prof-md alone: passing both makes Bun warn and pick the markdown
    // one anyway, and the raw .heapsnapshot for a 2-minute BN1 run is ~95 MB.
    ...(heap ? ["--heap-prof-md", "--heap-prof-dir", outDir, "--heap-prof-name", `${profile}-seed${seed}-heap`] : []),
  ];
  const save = has("--save") ? valueAfter("--save", "") : undefined;
  if (save === "") throw new Error("--save needs a checkpoint id (bun run saves lists them)");
  const result = await measure(
    { name: "cpu-prof", args: ["--compact", "--perf", ...(save ? ["--save", save] : [])], note: "" },
    bunArgs,
  );
  if (result) {
    console.log(
      `\n${result.throughput.toFixed(2)} vh/min over ${result.virtualHours.toFixed(2)} virtual hours; ` +
        `throughput ${result.drift}`,
    );
  }
  console.log(`\nProfile written under ${outDir}/. Read the .md digest; the .cpuprofile is for a flamegraph viewer.`);
}

if (has("--help")) {
  console.log(
    [
      "bun run tools/sim-profile.ts [--matrix | --cpu-prof] [options]",
      "",
      "  --matrix              throughput across configurations (default)",
      "  --cpu-prof            one bounded run under Bun's sampling profiler",
      "  --heap-prof           with --cpu-prof, also write a heap snapshot",
      "  --interval <us>       sampling interval, default 1000us",
      "  --profile <id>        sim profile, default leg-bn1.1",
      "  --seed <n>            default 1",
      "  --wall-budget <dur>   real time per case, default 2m",
      "  --save <id>           with --cpu-prof, start from a registered checkpoint",
      "  --out-dir <path>      default runs/profiles",
      "  --verbose             echo each child's full output",
      "",
      "Cost sampling is scaled to about ten samples per case, so the drift column",
      "stays readable at any budget. Output lands in --out-dir; runs/ is gitignored.",
    ].join("\n"),
  );
} else if (has("--cpu-prof")) {
  await runCpuProfile();
} else {
  await runMatrix();
}

export {};
