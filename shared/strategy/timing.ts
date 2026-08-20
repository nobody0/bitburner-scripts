/** Measured worker handoff uncertainty. A process which lands at t cannot be
 * budgeted for another invocation at exactly t: promise continuation, exec
 * and timer jitter consume a few milliseconds even when the math is exact.
 *
 * This lives in a leaf module of its own solely so the deployed worker can
 * import it without pulling jit.ts into its bundle. esbuild cannot tree-shake
 * jit.ts's timing constants apart — they cross-reference each other — so the
 * worker was carrying five values it never reads. jit.ts re-exports this, so
 * every other importer is unaffected and there is still one definition. */
export const MINIMUM_WORKER_PRECISION_MS = 5;
