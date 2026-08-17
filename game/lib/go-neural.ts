import type { NS } from "@ns";
import {
  goChooseSeedTarget,
  GO_DISPATCH_GUARD_MS,
  goDispatchDelayMs,
  goNextRolloverAt,
  goPhaseAgrees,
  type GoSeedTarget,
  type GoTickPhase,
} from "../../shared/strategy/go/tick.ts";

/** Prediction is comfortably below one engine cycle. This cap prevents a
 * pathologically throttled browser from holding the Go dodge forever; failure
 * is safer than deliberately dispatching a move with the wrong seed. */
export const GO_MAX_SEED_REPLANS = 4;

const GO_TARGET_POLL_MS = 2;
const GO_TARGET_POLL_LIMIT = Math.ceil(GO_DISPATCH_GUARD_MS / GO_TARGET_POLL_MS) + 2;

type GoPlayer = ReturnType<NS["getPlayer"]>;

export interface GoNeuralSeedClock {
  now(): number;
  player(): GoPlayer;
  sleep(ms: number): Promise<void>;
}

export interface GoNeuralSeedAttempt<T> {
  player: GoPlayer;
  /** Wall time paired with the verified player snapshot. */
  observedAt: number;
  /** Engine tick in which the Go action must be dispatched. */
  dispatchPlaytime: number;
  target?: GoSeedTarget;
  value: T;
}

export interface GoNeuralSeedDispatch<T, R> {
  attempt: GoNeuralSeedAttempt<T>;
  response: R;
  /** Number of completed inferences discarded because their target tick was
   * missed or no longer had a safe dispatch margin. */
  boundaryRetries: number;
  /** The anchor is returned because a contradictory public read invalidates
   * it. The caller retains the still-valid anchor across turns. */
  phase?: GoTickPhase;
}

/** Run seed-dependent neural inference and the Go call as one assured unit.
 *
 * A target tick is chosen before inference. Inference runs immediately, so it
 * consumes any wait for a next-tick target. Only the remaining delay is slept.
 * A public playtime read then proves that the intended tick is in force before
 * `dispatch` is called. If inference overran its slot, the warm calculation is
 * repeated for a new target instead of knowingly sending a mismatched move. */
export async function runGoNeuralSeedDispatch<T, R>(options: {
  clock: GoNeuralSeedClock;
  phase?: GoTickPhase;
  infer(player: GoPlayer, target?: GoSeedTarget): Promise<T>;
  dispatch(value: T): Promise<R>;
  maxReplans?: number;
  /** Earliest engine tick allowed to dispatch, for phase-exact committed
   * playbook turns. Requires an agreeing anchor; ignored without one. */
  notBeforePlaytime?: number;
}): Promise<GoNeuralSeedDispatch<T, R>> {
  const maxReplans = options.maxReplans ?? GO_MAX_SEED_REPLANS;
  let phase = options.phase;
  let boundaryRetries = 0;
  let player = options.clock.player();

  for (;;) {
    const observedAt = options.clock.now();
    if (phase && !goPhaseAgrees(phase, player.totalPlaytime, observedAt)) phase = undefined;
    const target = phase
      ? goChooseSeedTarget(phase, player.totalPlaytime, observedAt, GO_DISPATCH_GUARD_MS, options.notBeforePlaytime)
      : undefined;
    const dispatchPlaytime = target?.targetPlaytime ?? player.totalPlaytime;

    const value = await options.infer(player, target);

    const delay = target ? goDispatchDelayMs(target, options.clock.now()) : 0;
    if (delay > 0) await options.clock.sleep(delay);

    let verified = options.clock.player();
    let verifiedAt = options.clock.now();
    // A timer can wake just before Engine.updateGame applies the rollover. Poll
    // only while genuinely early; this is normally zero iterations and avoids
    // adding a fixed latency tax to every move.
    if (target) {
      for (
        let poll = 0;
        verified.totalPlaytime < dispatchPlaytime && poll < GO_TARGET_POLL_LIMIT;
        poll++
      ) {
        await options.clock.sleep(GO_TARGET_POLL_MS);
        verified = options.clock.player();
        verifiedAt = options.clock.now();
      }
    }

    if (phase && !goPhaseAgrees(phase, verified.totalPlaytime, verifiedAt)) phase = undefined;
    const targetMatched = verified.totalPlaytime === dispatchPlaytime;
    const safeMargin = !phase
      || goNextRolloverAt(phase, verifiedAt) - verifiedAt > GO_DISPATCH_GUARD_MS;

    if (targetMatched && safeMargin) {
      const attempt = {
        player: verified,
        observedAt: verifiedAt,
        dispatchPlaytime,
        ...(target ? { target } : {}),
        value,
      };
      // Deliberately no await or other work between the verified read and
      // invoking dispatch. The returned Go promise may then take as long as the
      // opponent needs without affecting seed alignment.
      const response = await options.dispatch(value);
      return { attempt, response, boundaryRetries, ...(phase ? { phase } : {}) };
    }

    if (boundaryRetries >= maxReplans) {
      throw new Error(
        `could not secure Go seed tick ${dispatchPlaytime} after ${boundaryRetries + 1} attempts`,
      );
    }
    boundaryRetries++;
    player = verified;
  }
}
