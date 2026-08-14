import type { SimWorld } from "../world.ts";
import {
  calculateEffectiveSharedThreads,
  calculateShareBonus,
  setShareContext,
} from "../vendor/bitburner/src/NetworkShare/Share.ts";

/** Per-simulation NetworkShare state.
 *
 * Upstream keeps the accumulator in module scope. A simulator process can host
 * more than one unit run, so only the vendored formula/context are shared; the
 * mutable effective-thread total belongs to this instance.
 *
 * Source: bitburner-src v3.0.1 src/NetworkShare/Share.ts.
 */
export class ShareSystem {
  #world: SimWorld;
  #shareThreads = 1;

  constructor(world: SimWorld) {
    this.#world = world;
  }

  get effectiveThreads(): number {
    return this.#shareThreads;
  }

  /** v3.0.1 startSharing(), with its mutable singleton replaced by instance
   * state. Intelligence is intentionally sampled live at call start. */
  startSharing(threads: number, cpuCores: number): () => void {
    setShareContext({ intelligence: this.#world.person.skills.intelligence });
    const effectiveThreads = calculateEffectiveSharedThreads(threads, cpuCores);
    this.#shareThreads += effectiveThreads;
    return () => {
      this.#shareThreads = Math.max(1, this.#shareThreads - effectiveThreads);
      if (this.#shareThreads < 1.00001) this.#shareThreads = 1;
    };
  }

  currentBonus(): number {
    return calculateShareBonus(this.#shareThreads);
  }

  reset(): void {
    this.#shareThreads = 1;
  }
}
