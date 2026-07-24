// Weighted, without-replacement sampling (roulette-wheel selection): each
// remaining item's chance of being picked next is proportional to its weight
// relative to the remaining pool. Used by /library random (see
// resolveRandomGames in src/commands/library.ts) to bias picks away from
// games that have come up recently, without deterministically excluding them.
export function weightedSampleWithoutReplacement<T>(
  items: T[],
  weightFn: (item: T) => number,
  count: number,
): T[] {
  const pool = [...items];
  const picks: T[] = [];

  while (pool.length > 0 && picks.length < count) {
    const weights = pool.map((item) => Math.max(weightFn(item), 0));
    const total = weights.reduce((sum, w) => sum + w, 0);

    let idx = pool.length - 1;
    if (total > 0) {
      let roll = Math.random() * total;
      for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];
        if (roll <= 0) {
          idx = i;
          break;
        }
      }
    } else {
      // All remaining weights are zero — fall back to a uniform pick rather
      // than always taking the last element.
      idx = Math.floor(Math.random() * pool.length);
    }

    picks.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return picks;
}
