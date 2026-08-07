/** What the simulator does not model yet.
 *
 * The rule: never fabricate. A synthetic ns that quietly returns 0 or [] for an
 * unimplemented call produces a run whose results blend measured and invented
 * behaviour, which is the specific way a simulation starts lying to you. So an
 * unmodelled surface reports itself and then throws.
 *
 * Throwing is survivable by construction: probe-runner isolates every probe
 * (probe-runner.ts:188), the controller isolates every feature driver
 * (controller.ts:139), so a run degrades to "that probe failed" rather than
 * dying — and the gap list is the roadmap. */

export interface UnmodeledReport {
  /** "ns" for an unimplemented Netscript path, "subsystem" for an engine
   *  system with no model, "formula" for an untranscribed calculation. */
  kind: string;
  /** The ns path (`gang.getMemberInformation`) or subsystem name. */
  name: string;
  detail?: string;
}

export class UnmodeledError extends Error {
  readonly report: UnmodeledReport;

  constructor(report: UnmodeledReport) {
    super(`not modelled by the simulator: ${report.kind} ${report.name}${report.detail ? ` (${report.detail})` : ""}`);
    this.name = "UnmodeledError";
    this.report = report;
  }
}

type Reporter = (report: UnmodeledReport) => void;

let reporter: Reporter | undefined;
const counts = new Map<string, number>();

/** Install the sink that turns a gap into a `sim.unmodeled` record. */
export function setUnmodeledReporter(fn: Reporter | undefined): void {
  reporter = fn;
}

/** Every gap hit so far, `"kind name" -> times`. The run summary reports this
 * rather than one event per hit: a probe retried every sweep would otherwise
 * emit forever. */
export function unmodeledCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

export function resetUnmodeled(): void {
  counts.clear();
  reporter = undefined;
}

/** Report a gap and throw. Reports only the first hit of each kind+name, so the
 * record stream stays a digest; `unmodeledCounts()` carries the totals. */
export function unmodeled(kind: string, name: string, detail?: string): never {
  const key = `${kind} ${name}`;
  const seen = counts.get(key) ?? 0;
  counts.set(key, seen + 1);
  const report: UnmodeledReport = detail === undefined ? { kind, name } : { kind, name, detail };
  if (seen === 0) reporter?.(report);
  throw new UnmodeledError(report);
}
