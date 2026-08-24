import type { AgentIo, DnetDelayRequest } from "./shared.ts";

/** Await one delayed Darknet operation while exposing its best cached estimate.
 * A refusal or early completion clears an overestimate immediately. */
export async function awaitDnetOperation<T>(
  io: AgentIo,
  request: DnetDelayRequest,
  call: () => Promise<T>,
): Promise<T> {
  const delay = io.deps.expectedDelayMs(request);
  io.setExpectedDoneAt(delay === undefined ? undefined : Date.now() + delay);
  try {
    return await call();
  } finally {
    io.setExpectedDoneAt(undefined);
  }
}
