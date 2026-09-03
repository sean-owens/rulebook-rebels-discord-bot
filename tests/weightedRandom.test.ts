import { describe, it, expect, vi, afterEach } from 'vitest';
import { weightedSampleWithoutReplacement } from '../src/utils/weightedRandom';

describe('weightedSampleWithoutReplacement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picks deterministically for a rigged Math.random sequence with uniform weights', () => {
    const items = ['a', 'b', 'c', 'd'];
    // Round 1: weights [1,1,1,1], total 4, roll = 0.1*4 = 0.4 -> index 0 ('a')
    // Round 2: pool ['b','c','d'], total 3, roll = 0.5*3 = 1.5 -> index 1 ('c')
    // Round 3: pool ['b','d'], total 2, roll = 0.9*2 = 1.8 -> index 1 ('d')
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.5).mockReturnValueOnce(0.9);

    const picks = weightedSampleWithoutReplacement(items, () => 1, 3);
    expect(picks).toEqual(['a', 'c', 'd']);
  });

  it('biases strongly toward a much higher-weighted item', () => {
    const items = ['heavy', 'light1', 'light2'];
    // total = 102, roll = 0.5 * 102 = 51 -> falls entirely within "heavy"'s
    // weight of 100, even though 0.5 is a "middling" random draw.
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5);

    const picks = weightedSampleWithoutReplacement(items, (i) => (i === 'heavy' ? 100 : 1), 1);
    expect(picks).toEqual(['heavy']);
  });

  it('falls back to a uniform pick when every remaining weight is zero', () => {
    const items = ['a', 'b', 'c'];
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.75); // floor(0.75 * 3) = 2 -> 'c'

    const picks = weightedSampleWithoutReplacement(items, () => 0, 1);
    expect(picks).toEqual(['c']);
  });

  it('returns every item with no duplicates when count exceeds the pool size', () => {
    const items = ['a', 'b', 'c'];
    const picks = weightedSampleWithoutReplacement(items, () => 1, 10);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
  });

  it('returns an empty array when count is 0', () => {
    expect(weightedSampleWithoutReplacement(['a', 'b'], () => 1, 0)).toEqual([]);
  });

  it('returns an empty array for an empty pool', () => {
    expect(weightedSampleWithoutReplacement([], () => 1, 3)).toEqual([]);
  });
});
