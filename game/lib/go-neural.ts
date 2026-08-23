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
  player(): GoPlayer | Promise<GoPlayer>;
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
  /** Milliseconds deliberately slept waiting for the dispatch tick, summed
   * across every attempt. This is intended latency, not lag. */
  waitedMs: number;
  /** The anchor is returned because a contradictory public read invalidates
   * it. The caller retains the still-valid anchor across turns. */
  phase?: GoTickPhase;
}

export type GoVerifiedDispatch<R> =
  | { player: GoPlayer; observedAt: number; dispatched: false }
  | { player: GoPlayer; observedAt: number; dispatched: true; response: Promise<R> };

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
  /** Optional atomic final boundary. The implementation synchronously reads
   * the public clock and invokes the ns action in one dodge when `accept`
   * succeeds; the returned action Promise is awaited only after that stub exits. */
  verifyAndDispatch?(
    value: T,
    accept: (player: GoPlayer, observedAt: number) => boolean,
  ): Promise<GoVerifiedDispatch<R>>;
  onDispatched?(value: T, observedAt: number): void;
  maxReplans?: number;
  /** Earliest engine tick allowed to dispatch, for phase-exact committed
   * playbook turns. Requires an agreeing anchor; ignored without one. */
  notBeforePlaytime?: number;
}): Promise<GoNeuralSeedDispatch<T, R>> {
  const maxReplans = options.maxReplans ?? GO_MAX_SEED_REPLANS;
  let phase = options.phase;
  let boundaryRetries = 0;
  let waitedMs = 0;
  let player = await options.clock.player();

  for (;;) {
    const observedAt = options.clock.now();
    if (phase && !goPhaseAgrees(phase, player.totalPlaytime, observedAt)) phase = undefined;
    const target = phase
      ? goChooseSeedTarget(phase, player.totalPlaytime, observedAt, GO_DISPATCH_GUARD_MS, options.notBeforePlaytime)
      : undefined;
    const dispatchPlaytime = target?.targetPlaytime ?? player.totalPlaytime;

    const value = await options.infer(player, target);

    const delay = target ? goDispatchDelayMs(target, options.clock.now()) : 0;
    if (delay > 0) {
      const sleepStartedAt = options.clock.now();
      await options.clock.sleep(delay);
      waitedMs += options.clock.now() - sleepStartedAt;
    }

    let verified: GoPlayer;
    let verifiedAt: number;
    // A timer can wake just before Engine.updateGame applies the rollover. Poll
    // only while genuinely early; this is normally zero iterations and avoids
    // adding a fixed latency tax to every move.
    if (target && !options.verifyAndDispatch) {
      verified = await options.clock.player();
      verifiedAt = options.clock.now();
      for (
        let poll = 0;
        verified.totalPlaytime < dispatchPlaytime && poll < GO_TARGET_POLL_LIMIT;
        poll++
      ) {
        const pollStartedAt = options.clock.now();
        await options.clock.sleep(GO_TARGET_POLL_MS);
        verified = await options.clock.player();
        verifiedAt = options.clock.now();
        waitedMs += verifiedAt - pollStartedAt;
      }
    } else if (!options.verifyAndDispatch) {
      verified = await options.clock.player();
      verifiedAt = options.clock.now();
    } else {
      const accepted = (candidate: GoPlayer, at: number): boolean => {
        const agrees = !phase || goPhaseAgrees(phase, candidate.totalPlaytime, at);
        const targetMatched = candidate.totalPlaytime === dispatchPlaytime;
        const safeMargin = !phase || goNextRolloverAt(phase, at) - at > GO_DISPATCH_GUARD_MS;
        return agrees && targetMatched && safeMargin;
      };
      const dispatched = await options.verifyAndDispatch(value, accepted);
      verified = dispatched.player;
      verifiedAt = dispatched.observedAt;
      if (dispatched.dispatched) {
        const attempt = {
          player: verified,
          observedAt: verifiedAt,
          dispatchPlaytime,
          ...(target ? { target } : {}),
          value,
        };
        options.onDispatched?.(value, verifiedAt);
        const response = await dispatched.response;
        return { attempt, response, boundaryRetries, waitedMs, ...(phase ? { phase } : {}) };
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
      return { attempt, response, boundaryRetries, waitedMs, ...(phase ? { phase } : {}) };
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
