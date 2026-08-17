/** Outcome-blind bounded sampling for KataGo labels on frozen-student routes. */
export function shouldSampleDaggerPoint(
  elapsed: number, sampled: number, stride: number, pointsPerGame: number,
  immediate: boolean,
): boolean {
  return !immediate && sampled < pointsPerGame && elapsed >= sampled * stride;
}
