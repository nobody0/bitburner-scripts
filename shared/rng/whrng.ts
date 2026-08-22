/** Exact Wichmann-Hill stream shared by game predictors. */
export function whrng(seedMilliseconds: number, count = 1): number[] {
  const seed = (seedMilliseconds / 1000) % 30000;
  let s1 = seed;
  let s2 = seed;
  let s3 = seed;
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    s1 = (171 * s1) % 30269;
    s2 = (172 * s2) % 30307;
    s3 = (170 * s3) % 30323;
    values.push((s1 / 30269 + s2 / 30307 + s3 / 30323) % 1);
  }
  return values;
}
