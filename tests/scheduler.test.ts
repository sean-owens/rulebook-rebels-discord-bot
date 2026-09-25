import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  scheduleGames,
  complexityBufferMinutes,
  toSchedulableGame,
  minutesToUnix,
  buildScheduleEmbed,
  lockAndScheduleEvent,
  checkPendingSchedules,
  previewSchedule,
  isLineupLocked,
  SchedulableGame,
  computeHeadcountTableFloor,
  computePreferenceSplitTableFloor,
  computeEffectiveTableCount,
  computeSharedPlayerConflictDegree,
  resolveRsvpComplexityPreferences,
  computeSplitGroupSizes,
  baseGameId,
  makeGroupGameId,
} from '../src/utils/scheduler';
import { GameSuggestion } from '../src/utils/gameStorage';

const BUFFER_CONFIG = { lightBufferMinutes: 20, mediumBufferMinutes: 30, heavyBufferMinutes: 40 };

// Refinements config for tests that aren't exercising breaks/repeats/person-breaks —
// keeps their assertions focused on the behavior actually under test.
const NO_REFINEMENTS = { heavyGameBreakMinutes: 0, maxGameRepeats: 1, breakMinutesBetweenGames: 0, flexTableCount: 0 };

function makeGame(overrides: Partial<SchedulableGame> = {}): SchedulableGame {
  return {
    id: overrides.id ?? 'g1',
    title: overrides.title ?? 'Game',
    minPlayers: overrides.minPlayers ?? 2,
    // High enough that no existing fixture accidentally triggers group-
    // splitting (see computeSplitGroupSizes) unless a test opts in via an
    // explicit override.
    maxPlayers: overrides.maxPlayers ?? 8,
    suggestedPlayers: overrides.suggestedPlayers,
    seatedPlayers: overrides.seatedPlayers ?? ['p1', 'p2'],
    waitlistedPlayers: overrides.waitlistedPlayers,
    effectiveDurationMinutes: overrides.effectiveDurationMinutes ?? 60,
    rawMaxPlaytime: overrides.rawMaxPlaytime ?? 60,
    complexity: overrides.complexity,
  };
}

describe('complexityBufferMinutes', () => {
  it('returns the matching tier', () => {
    expect(complexityBufferMinutes('Light', BUFFER_CONFIG)).toBe(20);
    expect(complexityBufferMinutes('Medium', BUFFER_CONFIG)).toBe(30);
    expect(complexityBufferMinutes('Heavy', BUFFER_CONFIG)).toBe(40);
  });

  it('falls back to the medium tier when complexity is unset', () => {
    expect(complexityBufferMinutes(undefined, BUFFER_CONFIG)).toBe(30);
    expect(complexityBufferMinutes('', BUFFER_CONFIG)).toBe(30);
  });
});

describe('toSchedulableGame', () => {
  it('adds the complexity buffer to maxPlaytime and carries raw playtime/complexity through', () => {
    const game = {
      id: 'g1', title: 'Wingspan', minPlayers: 2, maxPlayers: 4, suggestedPlayers: null,
      maxPlaytime: 70, complexity: 'Medium', seats: ['p1'],
    } as GameSuggestion;
    const result = toSchedulableGame(game, BUFFER_CONFIG);
    expect(result.effectiveDurationMinutes).toBe(100); // 70 + 30
    expect(result.seatedPlayers).toEqual(['p1']);
    expect(result.rawMaxPlaytime).toBe(70);
    expect(result.complexity).toBe('Medium');
  });

  it('does not scale the estimate for a bigger table — the complexity buffer alone accounts for that', () => {
    const baseline = {
      id: 'g1', title: 'Wingspan', minPlayers: 2, maxPlayers: 10, suggestedPlayers: 3,
      maxPlaytime: 70, complexity: 'Medium', seats: ['p1', 'p2', 'p3'],
    } as GameSuggestion;
    const moreSeated = { ...baseline, seats: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] } as GameSuggestion; // 4 over suggestedPlayers

    const baseResult = toSchedulableGame(baseline, BUFFER_CONFIG);
    const biggerResult = toSchedulableGame(moreSeated, BUFFER_CONFIG);
    expect(baseResult.effectiveDurationMinutes).toBe(100); // 70 + 30
    expect(biggerResult.effectiveDurationMinutes).toBe(100); // unaffected by seat count
  });

  it('carries suggestedPlayers through unchanged, including when unset', () => {
    const withRecommendation = { id: 'g1', title: 'Wingspan', minPlayers: 1, maxPlayers: 5, suggestedPlayers: 2, maxPlaytime: 70, seats: ['p1'] } as GameSuggestion;
    const withoutRecommendation = { ...withRecommendation, suggestedPlayers: null } as GameSuggestion;
    expect(toSchedulableGame(withRecommendation, BUFFER_CONFIG).suggestedPlayers).toBe(2);
    expect(toSchedulableGame(withoutRecommendation, BUFFER_CONFIG).suggestedPlayers).toBeNull();
  });
});

describe('scheduleGames', () => {
  it('schedules a single game onto table 1 starting at minute 0', () => {
    const result = scheduleGames([makeGame({ id: 'g1' })], 2, 120, NO_REFINEMENTS);
    expect(result.assignments).toEqual([
      { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
    ]);
    expect(result.unscheduled).toEqual([]);
    expect(result.totalDurationMinutes).toBe(60);
    expect(result.fitsInWindow).toBe(true);
  });

  it('excludes a game below its minimum player count, with a clear reason', () => {
    const result = scheduleGames(
      [makeGame({ id: 'g1', minPlayers: 4, seatedPlayers: ['p1', 'p2'] })],
      2,
      120,
      NO_REFINEMENTS,
    );
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([
      { gameId: 'g1', reason: 'only 2/4 minimum players seated' },
    ]);
  });

  it('counts a guest pseudo-id toward the minimum-players threshold like any other seat', () => {
    // A guest is just another string in seatedPlayers as far as this
    // capacity/grouping math is concerned — 3 real + 1 guest meets a
    // 4-minimum the same as 4 real players would.
    const result = scheduleGames(
      [makeGame({ id: 'g1', minPlayers: 4, seatedPlayers: ['p1', 'p2', 'p3', 'guest:abc'] })],
      2,
      120,
      NO_REFINEMENTS,
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].attendingPlayerIds).toContain('guest:abc');
    expect(result.unscheduled).toEqual([]);
  });

  it('excludes a 0-seated game, with a distinct reason from the minimum-players case', () => {
    const result = scheduleGames(
      [makeGame({ id: 'g1', minPlayers: 2, seatedPlayers: [] })],
      2,
      120,
      NO_REFINEMENTS,
    );
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([{ gameId: 'g1', reason: 'only 0/2 minimum players seated' }]);
  });

  it('handles an empty game list', () => {
    const result = scheduleGames([], 2, 120, NO_REFINEMENTS);
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([]);
    expect(result.totalDurationMinutes).toBe(0);
    expect(result.fitsInWindow).toBe(true);
  });

  it('places two non-conflicting games concurrently on separate tables', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'] }),
      ],
      2,
      120,
      NO_REFINEMENTS,
    );
    expect(result.assignments.every((a) => a.startMinutes === 0)).toBe(true);
    expect(result.assignments.map((a) => a.table).sort()).toEqual([1, 2]);
  });

  it('spreads a returning group onto a never-yet-used table instead of always reusing a lower-numbered one', () => {
    // g1/g2 fill tables 1 and 2 for the first 30 minutes; g3 reuses g1's
    // players once they're free again. A 3rd table has sat idle the whole
    // time — it should pick up g3, not table 1 again, otherwise a table can
    // sit empty all day purely because it's never the first one checked.
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30 }),
        makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 30 }),
        makeGame({ id: 'g3', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30 }),
      ],
      3,
      120,
      NO_REFINEMENTS,
    );
    const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
    const g3 = result.assignments.find((a) => a.gameId === 'g3')!;
    expect(g3.startMinutes).toBe(g1.endMinutes); // starts the moment p1/p2 free up
    expect(g3.table).not.toBe(g1.table); // picks up the idle 3rd table instead of reusing table 1
  });

  it('queues games sequentially on a single table when only one table is available', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'] }),
      ],
      1,
      240,
      NO_REFINEMENTS,
    );
    const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
    const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
    expect(g1.table).toBe(1);
    expect(g2.table).toBe(1);
    expect(g2.startMinutes).toBe(g1.endMinutes);
    // The table itself was the limiting factor here, not any specific player.
    expect(g2.delayedByPlayerId).toBeUndefined();
  });

  it('delays a player-conflicting game until the shared player is available again, even with a free table', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'] }), // shares p1 with g1
      ],
      2, // two tables available — the delay is about the shared player, not table capacity
      240,
      NO_REFINEMENTS,
    );
    const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
    const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
    expect(g1.startMinutes).toBe(0);
    expect(g2.startMinutes).toBe(g1.endMinutes); // not 0, even though a second table is free the whole time
    // The whole game waits on p1 here, not table capacity — surfaced so it's
    // clear the delay is a shared-player thing, not framed as a private
    // "p1 is running late" note.
    expect(g2.delayedByPlayerId).toBe('p1');
  });

  it('flags fitsInWindow as false when the schedule exceeds the event window', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90 }),
        makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 90 }), // conflicts with g1
      ],
      2,
      120, // only enough time for one 90-minute game before the shared player's second game overruns
      NO_REFINEMENTS,
    );
    expect(result.totalDurationMinutes).toBe(180);
    expect(result.fitsInWindow).toBe(false);
  });

  it('never lets a shared player have two overlapping game intervals, even under load', () => {
    // 6 games, alternating between two overlapping player pools, 3 tables available.
    const games = Array.from({ length: 6 }, (_, i) =>
      makeGame({
        id: `g${i}`,
        seatedPlayers: i % 2 === 0 ? ['p1', 'p2'] : ['p2', 'p3'],
        effectiveDurationMinutes: 60,
      }),
    );
    const result = scheduleGames(games, 3, 600, NO_REFINEMENTS);

    const byPlayer = new Map<string, Array<{ start: number; end: number }>>();
    for (const a of result.assignments) {
      const game = games.find((g) => g.id === a.gameId)!;
      for (const p of game.seatedPlayers) {
        const intervals = byPlayer.get(p) ?? [];
        for (const iv of intervals) {
          const overlaps = a.startMinutes < iv.end && iv.start < a.endMinutes;
          expect(overlaps).toBe(false);
        }
        intervals.push({ start: a.startMinutes, end: a.endMinutes });
        byPlayer.set(p, intervals);
      }
    }
  });

  describe('flex table reservation', () => {
    it('never lets a Medium/Heavy game use a reserved flex table, even when it sits idle', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'med', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 30, complexity: 'Medium' }),
        ],
        2,
        200,
        { ...NO_REFINEMENTS, flexTableCount: 1 }, // table 2 reserved for Light games only
      );
      const med = result.assignments.find((a) => a.gameId === 'med')!;
      // Queues behind the busy regular table instead of taking the idle flex one.
      expect(med.table).toBe(1);
      expect(med.startMinutes).toBe(60);
    });

    it('lets a Light game use a reserved flex table when that gives the earliest start', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'light', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 30, complexity: 'Light' }),
        ],
        2,
        200,
        { ...NO_REFINEMENTS, flexTableCount: 1 },
      );
      const light = result.assignments.find((a) => a.gameId === 'light')!;
      expect(light.table).toBe(2);
      expect(light.startMinutes).toBe(0);
    });

    it('lets a Light game use a regular table when that is genuinely earlier, instead of forcing it onto the flex table', () => {
      const result = scheduleGames(
        [makeGame({ id: 'light', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30, complexity: 'Light' })],
        2,
        200,
        { ...NO_REFINEMENTS, flexTableCount: 1 },
      );
      const light = result.assignments.find((a) => a.gameId === 'light')!;
      expect(light.table).toBe(1); // both tables tied at minute 0 -> regular table wins via load-balance tie-break
    });

    it('treats a game with no complexity set as not flex-eligible, same as Medium/Heavy', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'unrated', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 30 }),
        ],
        2,
        200,
        { ...NO_REFINEMENTS, flexTableCount: 1 },
      );
      const unrated = result.assignments.find((a) => a.gameId === 'unrated')!;
      expect(unrated.table).toBe(1);
      expect(unrated.startMinutes).toBe(60);
    });

    it('clamps to at least 1 regular table when flexTableCount is set at or above the table count', () => {
      const result = scheduleGames(
        [makeGame({ id: 'med', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30, complexity: 'Medium' })],
        3,
        200,
        { ...NO_REFINEMENTS, flexTableCount: 5 },
      );
      // Never fully locked out of every table, even though flexTableCount exceeds the table count.
      expect(result.assignments.find((a) => a.gameId === 'med')).toBeDefined();
    });

    it('behaves identically to today when flexTableCount is 0 (the default) — any game, any table', () => {
      const result = scheduleGames(
        [makeGame({ id: 'med', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30, complexity: 'Medium' })],
        2,
        200,
        NO_REFINEMENTS,
      );
      expect(result.assignments.find((a) => a.gameId === 'med')?.startMinutes).toBe(0);
    });
  });

  describe('computeSharedPlayerConflictDegree', () => {
    it('counts distinct other games sharing at least one seated player, deduped by game not by shared-player count', () => {
      const games = [
        makeGame({ id: 'a', seatedPlayers: ['p1', 'p2'] }),
        // Shares BOTH p1 and p2 with 'a' — still only one conflict, not two.
        makeGame({ id: 'b', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'c', seatedPlayers: ['p2', 'p3'] }),
      ];
      const degree = computeSharedPlayerConflictDegree(games);
      expect(degree.get('a')).toBe(2); // conflicts with b (p1,p2) and c (p2)
      expect(degree.get('b')).toBe(2); // conflicts with a (p1,p2) and c (p2)
      expect(degree.get('c')).toBe(2); // conflicts with a and b (both via p2)
    });

    it('scores 0 for a game with no shared players', () => {
      const games = [
        makeGame({ id: 'solo', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'other', seatedPlayers: ['p3', 'p4'] }),
      ];
      const degree = computeSharedPlayerConflictDegree(games);
      expect(degree.get('solo')).toBe(0);
      expect(degree.get('other')).toBe(0);
    });
  });

  describe('computeSplitGroupSizes', () => {
    it('rebalances evenly instead of leaving an uneven leftover group', () => {
      // Naive chunking would give 4/4/1 — the last group can't meet even a
      // typical minPlayers of 2. Rebalanced, 3 groups of 3 each works.
      expect(computeSplitGroupSizes(9, 2, 4)).toEqual([3, 3, 3]);
    });

    it('distributes the remainder across the first groups when it does not divide evenly', () => {
      expect(computeSplitGroupSizes(13, 2, 4)).toEqual([4, 3, 3, 3]);
    });

    it('returns a single group (no split) when everyone already fits within maxPlayers', () => {
      expect(computeSplitGroupSizes(4, 2, 4)).toEqual([4]);
      expect(computeSplitGroupSizes(8, 2, 6)).toEqual([4, 4]);
    });

    it('falls back to a single group when no valid multi-group split exists', () => {
      // ceil(7/6) = 2 groups, but floor(7/2) = 3 < minPlayers(4) — no group
      // count can satisfy both maxPlayers and minPlayers here.
      expect(computeSplitGroupSizes(7, 4, 6)).toEqual([7]);
    });
  });

  describe('group-splitting (oversized seats + waitlist)', () => {
    it('splits into evenly-rebalanced groups, all chained onto the same table', () => {
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3', 'p4'],
            waitlistedPlayers: ['p5', 'p6', 'p7', 'p8', 'p9'],
            minPlayers: 2,
            maxPlayers: 4,
            effectiveDurationMinutes: 60,
          }),
        ],
        1,
        1000,
        NO_REFINEMENTS,
      );
      expect(result.assignments).toHaveLength(3);
      expect(new Set(result.assignments.map((a) => a.table))).toEqual(new Set([1]));
      const byId = new Map(result.assignments.map((a) => [a.gameId, a]));
      expect(byId.get('g1')).toMatchObject({ startMinutes: 0, endMinutes: 60, attendingPlayerIds: ['p1', 'p2', 'p3'] });
      expect(byId.get('g1::g2')).toMatchObject({ startMinutes: 60, endMinutes: 120, attendingPlayerIds: ['p4', 'p5', 'p6'] });
      expect(byId.get('g1::g3')).toMatchObject({ startMinutes: 120, endMinutes: 180, attendingPlayerIds: ['p7', 'p8', 'p9'] });
      expect(baseGameId('g1::g3')).toBe('g1');
      expect(makeGroupGameId('g1', 3)).toBe('g1::g3');
    });

    it('does not split when seats + waitlist already fit within maxPlayers', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2', 'p3'], waitlistedPlayers: ['p4'], maxPlayers: 4, effectiveDurationMinutes: 60 })],
        1,
        1000,
        NO_REFINEMENTS,
      );
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].attendingPlayerIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('leaves the excess waitlisted (today\'s behavior) when no valid split exists', () => {
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
            waitlistedPlayers: ['p7'],
            minPlayers: 4,
            maxPlayers: 6,
            effectiveDurationMinutes: 60,
          }),
        ],
        1,
        1000,
        NO_REFINEMENTS,
      );
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].attendingPlayerIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
      expect(result.unscheduled).toEqual([]);
    });

    it('gates a later group\'s start on its own players\' other commitments, not just the previous group finishing', () => {
      // p4 is also seated in "other" (0-200) — group 2 (p4,p5,p6) can't start
      // until p4 is actually free, even though group 1 finishes much earlier.
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3'],
            waitlistedPlayers: ['p4', 'p5', 'p6'],
            minPlayers: 2,
            maxPlayers: 3,
            effectiveDurationMinutes: 60,
          }),
          makeGame({ id: 'other', seatedPlayers: ['p4', 'p9'], effectiveDurationMinutes: 200 }),
        ],
        2,
        1000,
        NO_REFINEMENTS,
      );
      const group2 = result.assignments.find((a) => a.gameId === 'g1::g2')!;
      expect(group2.startMinutes).toBe(200);
      expect(group2.delayedByPlayerId).toBe('p4');
    });

    it('reserves the whole chain\'s table time so an unrelated game cannot land in the gap between groups', () => {
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3'],
            waitlistedPlayers: ['p4', 'p5', 'p6'],
            minPlayers: 2,
            maxPlayers: 3,
            effectiveDurationMinutes: 60,
          }),
          makeGame({ id: 'filler', seatedPlayers: ['p7', 'p8'], effectiveDurationMinutes: 30 }),
        ],
        2,
        1000,
        NO_REFINEMENTS,
      );
      const g1Table = result.assignments.find((a) => a.gameId === 'g1')!.table;
      const filler = result.assignments.find((a) => a.gameId === 'filler')!;
      // filler must land on the OTHER table, not squeezed into g1's table
      // between group 1 (0-60) and group 2 (60-120).
      expect(filler.table).not.toBe(g1Table);
    });

    it("requires a group's full roster before starting, even when suggestedPlayers is lower than the group's own size", () => {
      // suggestedPlayers:2 would normally let quorum trim to just 2 — but
      // group 1's own assigned roster is 5 (10 people, maxPlayers 6 -> two
      // groups of 5), and nobody assigned to a group should be excludable
      // from it, so it must wait for all 5.
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3', 'p4', 'p5'],
            waitlistedPlayers: ['p6', 'p7', 'p8', 'p9', 'p10'],
            minPlayers: 2,
            maxPlayers: 6,
            suggestedPlayers: 2,
            effectiveDurationMinutes: 60,
          }),
        ],
        1,
        1000,
        NO_REFINEMENTS,
      );
      const group1 = result.assignments.find((a) => a.gameId === 'g1')!;
      expect(group1.attendingPlayerIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    });

    it('drops a chained group (and reports why) when it would start past the event horizon, without disturbing earlier groups', () => {
      const result = scheduleGames(
        [
          makeGame({
            id: 'g1',
            seatedPlayers: ['p1', 'p2', 'p3'],
            waitlistedPlayers: ['p4', 'p5', 'p6', 'p7', 'p8', 'p9'],
            minPlayers: 2,
            maxPlayers: 3,
            effectiveDurationMinutes: 60,
          }),
        ],
        1,
        50, // horizon = 100; group 3 would start at minute 120
        NO_REFINEMENTS,
      );
      expect(result.assignments.map((a) => a.gameId).sort()).toEqual(['g1', 'g1::g2']);
      expect(result.unscheduled).toEqual([
        { gameId: 'g1::g3', reason: 'not enough time left in the event window' },
      ]);
    });
  });

  describe('multi-pass scheduling (tries several placement strategies, keeps the best)', () => {
    it('picks whichever pass leaves the fewest games unscheduled, not just the dynamic default', () => {
      // "gate" ties up r; L needs p1+r; three 60-min fillers chain onto p1.
      // Verified via script: earliest-ready drops only L (1 unscheduled);
      // sorting by duration or by conflict-degree first protects L but
      // starves the fillers instead, dropping 2-3 games — objectively worse.
      // The winner must be earliest-ready specifically because it drops the
      // fewest games overall, not because it's first in the list.
      const result = scheduleGames(
        [
          makeGame({ id: 'gate', seatedPlayers: ['r', 'r2'], effectiveDurationMinutes: 150 }),
          makeGame({ id: 'L', seatedPlayers: ['p1', 'r'], effectiveDurationMinutes: 120 }),
          makeGame({ id: 'F1', seatedPlayers: ['p1', 'a'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'F2', seatedPlayers: ['p1', 'b'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'F3', seatedPlayers: ['p1', 'c'], effectiveDurationMinutes: 60 }),
        ],
        5,
        80, // horizon = 160: tight enough that protecting L instead starves the fillers
        NO_REFINEMENTS,
      );
      expect(result.unscheduled).toEqual([{ gameId: 'L', reason: 'not enough time left in the event window' }]);
      expect(result.assignments.map((a) => a.gameId).sort()).toEqual(['F1', 'F2', 'F3', 'gate']);
    });

    it('rejects a worse candidate even when nothing is unscheduled — picks the lower total span', () => {
      // Same shape as above but with room for everything to fit eventually.
      // Verified via script: earliest-ready and most-shared-players both
      // finish at 300min; longest-duration-first alone finishes at 450min
      // (protecting L pushes all three fillers behind it). Multi-pass must
      // not return the 450min outcome.
      const result = scheduleGames(
        [
          makeGame({ id: 'gate', seatedPlayers: ['r', 'r2'], effectiveDurationMinutes: 150 }),
          makeGame({ id: 'L', seatedPlayers: ['p1', 'r'], effectiveDurationMinutes: 120 }),
          makeGame({ id: 'F1', seatedPlayers: ['p1', 'a'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'F2', seatedPlayers: ['p1', 'b'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'F3', seatedPlayers: ['p1', 'c'], effectiveDurationMinutes: 60 }),
        ],
        5,
        1000,
        NO_REFINEMENTS,
      );
      expect(result.unscheduled).toEqual([]);
      expect(result.totalDurationMinutes).toBe(300);
    });

    it('converges to exactly today\'s output for fully independent games (tie goes to the dynamic pass)', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
        ],
        2,
        200,
        NO_REFINEMENTS,
      );
      expect(result.assignments).toEqual([
        { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, delayedByPlayerId: undefined, attendingPlayerIds: ['p1', 'p2'] },
        { gameId: 'g2', table: 2, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, delayedByPlayerId: undefined, attendingPlayerIds: ['p3', 'p4'] },
      ]);
    });
  });

  describe('walk-up (1-signup) games', () => {
    it('routes a game with exactly 1 seated player to walkUps instead of the table-placement loop', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', minPlayers: 2, seatedPlayers: ['p1'] })],
        2,
        120,
        NO_REFINEMENTS,
      );
      expect(result.unscheduled).toEqual([]);
      expect(result.assignments).toEqual([]);
      expect(result.walkUps).toEqual([{ gameId: 'g1' }]);
    });

    it('never lets a walk-up game consume a table, even when a table is otherwise free', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'walkup', minPlayers: 1, seatedPlayers: ['p1'] }),
          makeGame({ id: 'real', minPlayers: 2, seatedPlayers: ['p2', 'p3'] }),
        ],
        2,
        120,
        NO_REFINEMENTS,
      );
      // The walk-up game never enters the table loop at all — only the real
      // signup shows up as a table assignment.
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].gameId).toBe('real');
      expect(result.walkUps).toEqual([{ gameId: 'walkup' }]);
      expect(result.unscheduled).toEqual([]);
    });
  });

  describe('Heavy-adjacency break (per table)', () => {
    it('inserts a break before a Heavy game following another Heavy game at the same table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
        ],
        1, // forces both onto the same table
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g2.table).toBe(g1.table);
      expect(g2.startMinutes - g1.endMinutes).toBe(20);
    });

    it('inserts no break when heavyGameBreakMinutes is 0 (disabled)', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
        ],
        1,
        600,
        NO_REFINEMENTS,
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g2.startMinutes).toBe(g1.endMinutes);
    });

    it('does not trigger a break for Heavy followed by a non-Heavy game at the same table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], complexity: 'Light', effectiveDurationMinutes: 60 }),
        ],
        1,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g2.startMinutes).toBe(g1.endMinutes);
    });

    it('applies independently per table — one table with Heavy-Heavy adjacency does not delay an unrelated table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'h1', seatedPlayers: ['a1', 'a2'], complexity: 'Heavy', effectiveDurationMinutes: 60 }),
          makeGame({ id: 'h2', seatedPlayers: ['a1', 'a2'], complexity: 'Heavy', effectiveDurationMinutes: 60 }), // same players as h1 -> same table, sequential
          makeGame({ id: 'light1', seatedPlayers: ['b1', 'b2'], complexity: 'Light', effectiveDurationMinutes: 60 }),
          makeGame({ id: 'light2', seatedPlayers: ['b1', 'b2'], complexity: 'Light', effectiveDurationMinutes: 60 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const light2 = result.assignments.find((a) => a.gameId === 'light2')!;
      const light1 = result.assignments.find((a) => a.gameId === 'light1')!;
      // The b1/b2 table's own back-to-back Light games are unaffected by the
      // unrelated a1/a2 table's Heavy-Heavy break — this is the key benefit
      // of the per-table check over the old model's global round-shift.
      expect(light2.startMinutes).toBe(light1.endMinutes);
    });
  });

  describe('per-person break between games', () => {
    it('delays a shared player\'s next game by the configured break, beyond just avoiding overlap', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 60 }),
        ],
        2,
        300,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 1, breakMinutesBetweenGames: 15, flexTableCount: 0 },
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g2.startMinutes).toBe(g1.endMinutes + 15);
    });

    it('does not delay two games that share no players, even with a break configured', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
        ],
        2,
        300,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 1, breakMinutesBetweenGames: 15, flexTableCount: 0 },
      );
      expect(result.assignments.every((a) => a.startMinutes === 0)).toBe(true);
    });
  });

  describe('quorum-based partial-group starts (recommended player count)', () => {
    it('starts once the recommended headcount is ready, without waiting for stragglers, when the excluded remainder is big enough to be redeemable', () => {
      // p3/p4 are tied up elsewhere until minute 60; p1/p2 have nothing else
      // queued and are free from minute 0. suggestedPlayers:2 means the group
      // of 4 shouldn't have to wait for p3/p4 — excluding them leaves a
      // remainder of 2, which meets minPlayers, so it's not stranding anyone
      // below a viable group size (see quorumThreshold).
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
          makeGame({
            id: 'quad', seatedPlayers: ['p1', 'p2', 'p3', 'p4'], minPlayers: 2, suggestedPlayers: 2,
            effectiveDurationMinutes: 30,
          }),
        ],
        2,
        300,
        NO_REFINEMENTS,
      );
      const quad = result.assignments.find((a) => a.gameId === 'quad')!;
      expect(quad.startMinutes).toBe(0);
      expect(quad.attendingPlayerIds.sort()).toEqual(['p1', 'p2']);
    });

    it('leaves a redeemable excluded remainder completely free for another suggestion', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
          makeGame({
            id: 'quad', seatedPlayers: ['p1', 'p2', 'p3', 'p4'], minPlayers: 2, suggestedPlayers: 2,
            effectiveDurationMinutes: 30,
          }),
          // p3/p4's other suggestion — should still be free to start at minute
          // 0 via the 'busy' game above, unaffected by 'quad' having formed
          // without them.
        ],
        2,
        300,
        NO_REFINEMENTS,
      );
      const busy = result.assignments.find((a) => a.gameId === 'busy')!;
      expect(busy.startMinutes).toBe(0); // p3/p4 were never marked occupied by 'quad'
    });

    it('falls back to waiting for everyone when the excluded remainder would be too small to be its own valid group', () => {
      // Only p3 would be excluded here (3 seated, quorum target 2) — a lone
      // straggler can never meet minPlayers(2) on their own, so they'd be
      // permanently stranded (signed up, but this game never runs again to
      // include them). Rather than strand them, the game waits for everyone.
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
          makeGame({
            id: 'trio', seatedPlayers: ['p1', 'p2', 'p3'], minPlayers: 2, suggestedPlayers: 2,
            effectiveDurationMinutes: 30,
          }),
        ],
        2,
        300,
        NO_REFINEMENTS,
      );
      const trio = result.assignments.find((a) => a.gameId === 'trio')!;
      expect(trio.startMinutes).toBe(60); // waited for p3, not just p1/p2
      expect(trio.attendingPlayerIds.sort()).toEqual(['p1', 'p2', 'p3']);
      expect(trio.delayedByPlayerId).toBe('p3');
    });

    it('falls back to waiting for every signed-up player when suggestedPlayers is unset', () => {
      const result = scheduleGames(
        [makeGame({ id: 'trio', seatedPlayers: ['p1', 'p2', 'p3'], minPlayers: 2, effectiveDurationMinutes: 30 })],
        1,
        300,
        NO_REFINEMENTS,
      );
      const trio = result.assignments.find((a) => a.gameId === 'trio')!;
      expect(trio.attendingPlayerIds.sort()).toEqual(['p1', 'p2', 'p3']);
    });

    it('never targets fewer than minPlayers even if suggestedPlayers is oddly lower', () => {
      const result = scheduleGames(
        [makeGame({ id: 'trio', seatedPlayers: ['p1', 'p2', 'p3'], minPlayers: 3, suggestedPlayers: 1, effectiveDurationMinutes: 30 })],
        1,
        300,
        NO_REFINEMENTS,
      );
      const trio = result.assignments.find((a) => a.gameId === 'trio')!;
      expect(trio.attendingPlayerIds).toHaveLength(3);
    });

    it('caps the quorum target at the total signed-up count when suggestedPlayers exceeds it', () => {
      const result = scheduleGames(
        [makeGame({ id: 'duo', seatedPlayers: ['p1', 'p2'], minPlayers: 2, suggestedPlayers: 4, effectiveDurationMinutes: 30 })],
        1,
        300,
        NO_REFINEMENTS,
      );
      const duo = result.assignments.find((a) => a.gameId === 'duo')!;
      expect(duo.attendingPlayerIds.sort()).toEqual(['p1', 'p2']);
    });

    it('computes delayedByPlayerId against the attending subset only, never naming an excluded straggler', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'busy', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60 }),
          makeGame({
            id: 'quad', seatedPlayers: ['p1', 'p2', 'p3', 'p4'], minPlayers: 2, suggestedPlayers: 2,
            effectiveDurationMinutes: 30,
          }),
        ],
        2,
        300,
        NO_REFINEMENTS,
      );
      const quad = result.assignments.find((a) => a.gameId === 'quad')!;
      // p1 and p2 are both fresh (tied at minute 0) -> no unique gating player.
      expect(quad.delayedByPlayerId).toBeUndefined();
    });
  });

  describe('opportunistic repeat-fill', () => {
    it('repeats a short game back-to-back at its own table, capped by maxGameRepeats', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'short', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const shortAssignment = result.assignments.find((a) => a.gameId === 'short')!;
      // starts at 0, ends 40; +20 = 60, +20 = 80 -> 2 extra plays, playCount 3
      expect(shortAssignment.playCount).toBe(3);
      expect(shortAssignment.endMinutes).toBe(80);
      const longAssignment = result.assignments.find((a) => a.gameId === 'long')!;
      expect(longAssignment.playCount).toBe(1);
    });

    it('is bounded by the event window, not just maxGameRepeats', () => {
      const result = scheduleGames(
        [makeGame({ id: 'short', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 })],
        1,
        100, // window too small for maxGameRepeats(100) worth of 20-min repeats
        { heavyGameBreakMinutes: 0, maxGameRepeats: 100, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'short')!;
      // 40 -> 60 -> 80 -> 100 (fits), 120 would overrun -> playCount 4
      expect(assignment.playCount).toBe(4);
      expect(assignment.endMinutes).toBe(100);
    });

    it('does not repeat at all when the event window is infinite (nothing to fill up against)', () => {
      const result = scheduleGames(
        [makeGame({ id: 'short', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 })],
        1,
        Number.POSITIVE_INFINITY,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 5, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'short')!;
      expect(assignment.playCount).toBe(1);
    });

    it('excludes a game at the 30-minute boundary (not eligible — must be strictly under 30)', () => {
      const result = scheduleGames(
        [makeGame({ id: 'boundary', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60, rawMaxPlaytime: 30 })],
        1,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'boundary')!;
      expect(assignment.playCount).toBe(1);
    });

    it('does not repeat when the window has no room for even one more play', () => {
      const result = scheduleGames(
        [makeGame({ id: 'short', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 40, rawMaxPlaytime: 29 })],
        1,
        65, // ends at 40; 40+29=69 > 65 -> no repeat fits
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'short')!;
      expect(assignment.playCount).toBe(1);
    });

    it('does not extend past a shared player already committed to another table\'s game', () => {
      // "short" (p1,p2) is the only game on its table, so it's normally
      // eligible to repeat-fill the rest of the event. But p1 is also seated
      // in "other" on a second table, placed to start right as "short"
      // finishes — extending "short" would double-book p1 into both games
      // at once, which is exactly the bug this test guards against.
      const result = scheduleGames(
        [
          makeGame({ id: 'short', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 }),
          makeGame({ id: 'other', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 30, rawMaxPlaytime: 30 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3, breakMinutesBetweenGames: 0, flexTableCount: 0 },
      );
      const shortAssignment = result.assignments.find((a) => a.gameId === 'short')!;
      const otherAssignment = result.assignments.find((a) => a.gameId === 'other')!;
      expect(shortAssignment.playCount).toBe(1);
      expect(shortAssignment.endMinutes).toBe(40);
      expect(otherAssignment.startMinutes).toBeGreaterThanOrEqual(shortAssignment.endMinutes);
    });
  });

  describe('mayNotFinish flag (window overrun)', () => {
    it('flags a game whose end runs past the window, and not one that fits', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90 }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 90 }), // conflicts with g1 -> sequential
        ],
        2,
        120,
        NO_REFINEMENTS,
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g1.mayNotFinish).toBe(false);
      expect(g2.mayNotFinish).toBe(true);
    });

    it('does not flag anything when the whole schedule fits the window', () => {
      const result = scheduleGames([makeGame({ id: 'g1', effectiveDurationMinutes: 60 })], 2, 120, NO_REFINEMENTS);
      expect(result.assignments.every((a) => !a.mayNotFinish)).toBe(true);
    });

    it('never flags anything when there is no end time (window is Infinity)', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', effectiveDurationMinutes: 600 })],
        2,
        Number.POSITIVE_INFINITY,
        NO_REFINEMENTS,
      );
      expect(result.assignments.every((a) => !a.mayNotFinish)).toBe(true);
    });
  });

  describe('playerWarnings (multi-game players)', () => {
    it('warns for a player with 2+ games when one of them is at risk of not finishing', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90 }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 90 }), // p1 in both, forced sequential
        ],
        2,
        100, // g2 will overrun
        NO_REFINEMENTS,
      );
      expect(result.playerWarnings).toEqual([
        { userId: 'p1', reason: expect.stringContaining('seated in 2 games') },
      ]);
      // Names the specific at-risk game rather than a bare count, so the
      // severity (which game, how many of the total) is visible at a glance.
      expect(result.playerWarnings[0].reason).toContain('may not happen as scheduled');
    });

    it('does not warn for a player with only 1 game, even if it is at risk', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', seatedPlayers: ['p2', 'p3'], effectiveDurationMinutes: 200 })],
        1,
        100, // this game itself overruns, but p2/p3 only have 1 game each
        NO_REFINEMENTS,
      );
      expect(result.playerWarnings).toEqual([]);
    });

    it('does not warn when a multi-game player\'s games all comfortably fit', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30 }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 30 }),
        ],
        2,
        600,
        NO_REFINEMENTS,
      );
      expect(result.playerWarnings).toEqual([]);
    });

    it('warns for a player whose signed-up game never got scheduled at all', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 30 }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'], minPlayers: 5, effectiveDurationMinutes: 30 }), // never meets minPlayers
        ],
        2,
        600,
        NO_REFINEMENTS,
      );
      expect(result.playerWarnings.map((w) => w.userId)).toEqual(['p1']);
    });
  });
});

describe('minutesToUnix', () => {
  it('converts minutes-from-start into a Unix timestamp relative to the event start', () => {
    const start = new Date('2026-01-01T18:00:00.000Z');
    const startUnix = Math.floor(start.getTime() / 1000);
    expect(minutesToUnix(start.toISOString(), 0)).toBe(startUnix);
    expect(minutesToUnix(start.toISOString(), 90)).toBe(startUnix + 90 * 60);
  });
});

describe('isLineupLocked', () => {
  it('is false when unset', () => {
    expect(isLineupLocked({})).toBe(false);
  });
  it('is true only when explicitly set', () => {
    expect(isLineupLocked({ suggestionsLocked: true })).toBe(true);
    expect(isLineupLocked({ suggestionsLocked: false })).toBe(false);
  });
});

describe('computeHeadcountTableFloor', () => {
  it('returns 0 for no RSVPs', () => {
    expect(computeHeadcountTableFloor(0)).toBe(0);
  });

  it('picks the evenly-dividing size, tie-breaking toward fewer tables', () => {
    // 6 divides evenly by both 3 (2 tables) and 6 (1 table) — prefer 1 table.
    expect(computeHeadcountTableFloor(6)).toBe(1);
  });

  it('uses the normalized decimal distance, not raw remainder, to pick a size', () => {
    // Raw remainders (13 mod 3/4/6 all = 1) would tie; the decimal method
    // clearly prefers size 6 (13/6 = 2.1667, distance .1667) over size 4
    // (13/4 = 3.25, distance .25) or size 3 (13/3 = 4.333, distance .333).
    expect(computeHeadcountTableFloor(13)).toBe(3);
  });

  it('prefers the larger size again when both give a perfect (0-remainder) fit', () => {
    // 15 divides evenly by 3 (5 tables) and 5 (3 tables) — prefer 3 tables.
    expect(computeHeadcountTableFloor(15)).toBe(3);
  });

  it('never returns fewer than 1 table for any positive headcount', () => {
    expect(computeHeadcountTableFloor(1)).toBe(1);
    expect(computeHeadcountTableFloor(2)).toBe(1);
  });

  // 28 attendees, no cap — matches the real event recap this feature was validated against.
  it('computes 7 tables for 28 attendees (divides evenly by 4)', () => {
    expect(computeHeadcountTableFloor(28)).toBe(7);
  });
});

describe('computePreferenceSplitTableFloor', () => {
  it('returns 0 when nobody has set a preference', () => {
    expect(computePreferenceSplitTableFloor([null, null, undefined])).toBe(0);
  });

  it('sums a per-tier floor across distinct preference tiers', () => {
    // 3 Light + 3 Medium — each tier independently floors to 1 table.
    const prefs = ['Light', 'Light', 'Light', 'Medium', 'Medium', 'Medium'];
    expect(computePreferenceSplitTableFloor(prefs)).toBe(2);
  });

  it('ignores unrecognized/null preferences when tallying tiers', () => {
    const prefs = ['Light', 'Light', 'Light', null, undefined];
    expect(computePreferenceSplitTableFloor(prefs)).toBe(1);
  });

  it('does not double-count a single homogeneous group beyond its own floor', () => {
    const prefs = ['Heavy', 'Heavy', 'Heavy', 'Heavy', 'Heavy', 'Heavy'];
    expect(computePreferenceSplitTableFloor(prefs)).toBe(1);
  });
});

describe('computeEffectiveTableCount', () => {
  it('falls back to the config default when there are no RSVPs at all', () => {
    expect(computeEffectiveTableCount(0, [], 2)).toBe(2);
  });

  it('uses the headcount floor when it exceeds the config default', () => {
    expect(computeEffectiveTableCount(13, [], 1)).toBe(3);
  });

  it('uses the preference-split floor when it exceeds both the headcount floor and config default', () => {
    const prefs = ['Light', 'Light', 'Light', 'Medium', 'Medium', 'Medium'];
    // Headcount floor for 6 alone would be 1, but the preference split needs 2.
    expect(computeEffectiveTableCount(6, prefs, 1)).toBe(2);
  });

  it('never goes below 1 even with a 0 config default and no RSVPs', () => {
    expect(computeEffectiveTableCount(0, [], 0)).toBe(1);
  });

  it('caps the computed table count at maxTableCount when set — e.g. a venue with a real 6-table limit', () => {
    // 28 attendees would otherwise compute a 7-table need (see computeHeadcountTableFloor above).
    expect(computeEffectiveTableCount(28, [], 1, 6)).toBe(6);
  });

  it('does not cap when maxTableCount is 0 (uncapped, the default)', () => {
    expect(computeEffectiveTableCount(28, [], 1, 0)).toBe(7);
    expect(computeEffectiveTableCount(28, [], 1)).toBe(7); // omitted entirely
  });
});

describe('resolveRsvpComplexityPreferences', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-prefs-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMember(roleIds: string[]) {
    return { roles: { cache: { has: (id: string) => roleIds.includes(id) } } };
  }

  it('returns an empty array without touching the client when there are no RSVPs', async () => {
    const client = { guilds: { fetch: vi.fn() } };
    const result = await resolveRsvpComplexityPreferences(client as any, 'guild-1', []);
    expect(result).toEqual([]);
    expect(client.guilds.fetch).not.toHaveBeenCalled();
  });

  it("resolves each RSVP'd member's complexity preference via their /myroles Discord roles", async () => {
    const { addGameRole } = await import('../src/utils/gameRoles');
    await addGameRole('guild-1', { roleId: 'role-light', name: 'Light', type: 'difficulty' });
    await addGameRole('guild-1', { roleId: 'role-medium', name: 'Medium', type: 'difficulty' });

    const guild = {
      members: {
        fetch: vi.fn(async (id: string) => {
          if (id === 'u1') return makeMember(['role-light']);
          if (id === 'u2') return makeMember(['role-medium']);
          return makeMember([]); // u3: no preference set
        }),
      },
    };
    const client = { guilds: { fetch: vi.fn(async () => guild) } };

    const result = await resolveRsvpComplexityPreferences(client as any, 'guild-1', ['u1', 'u2', 'u3']);
    expect(result).toEqual(['Light', 'Medium', null]);
  });

  it('skips a member who has left the server rather than failing the whole lookup', async () => {
    const guild = {
      members: {
        fetch: vi.fn(async (id: string) => {
          if (id === 'left-user') throw new Error('Unknown Member');
          return makeMember([]);
        }),
      },
    };
    const client = { guilds: { fetch: vi.fn(async () => guild) } };

    const result = await resolveRsvpComplexityPreferences(client as any, 'guild-1', ['left-user', 'u2']);
    expect(result).toHaveLength(1);
  });

  it('returns an empty array when the guild itself fails to resolve', async () => {
    const client = { guilds: { fetch: vi.fn(async () => { throw new Error('unknown guild'); }) } };
    const result = await resolveRsvpComplexityPreferences(client as any, 'guild-1', ['u1']);
    expect(result).toEqual([]);
  });
});

describe('buildScheduleEmbed', () => {
  const games = [
    { id: 'g1', title: 'Wingspan', seatedPlayers: ['p1', 'p2'] },
    { id: 'g2', title: 'Catan', seatedPlayers: ['p3', 'p4'] },
  ];
  const gn = { title: 'Game Night', startTimeISO: new Date('2026-01-01T18:00:00.000Z').toISOString() };
  const startUnix = Math.floor(new Date('2026-01-01T18:00:00.000Z').getTime() / 1000);

  function baseResult(overrides: Partial<Parameters<typeof buildScheduleEmbed>[2]> = {}) {
    return {
      assignments: [],
      unscheduled: [],
      walkUps: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
      playerWarnings: [],
      ...overrides,
    };
  }

  it('lists each table in its own field, with real clock times per game', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
        { gameId: 'g2', table: 2, startMinutes: 0, endMinutes: 30, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p3', 'p4'] },
      ],
      totalDurationMinutes: 60,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields).toHaveLength(2);
    expect(data.fields![0].name).toBe('Table 1');
    expect(data.fields![0].value).toBe(`**Wingspan** (<t:${startUnix}:t>–<t:${startUnix + 3600}:t>) — <@p1>, <@p2>`);
    expect(data.fields![1].name).toBe('Table 2');
    expect(data.fields![1].value).toContain('Catan');
  });

  it('rounds displayed start/end times up to the next quarter-hour, without changing the underlying schedule', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 19, endMinutes: 76, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
      ],
      totalDurationMinutes: 76,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const value = embed.toJSON().fields![0].value;
    // 19 -> 30 (next quarter-hour), 76 -> 90 — always rounded UP, never down
    // or to nearest, so a game is never shown as available before it is.
    expect(value).toBe(`**Wingspan** (<t:${startUnix + 30 * 60}:t>–<t:${startUnix + 90 * 60}:t>) — <@p1>, <@p2>`);
    // The rounding is purely a display concern — the assignment object
    // itself (what actually drives no-double-booking/chaining) is untouched.
    expect(result.assignments[0].startMinutes).toBe(19);
    expect(result.assignments[0].endMinutes).toBe(76);
  });

  it('does not re-round a start/end time that already lands on a quarter-hour', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 30, endMinutes: 90, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
      ],
      totalDurationMinutes: 90,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const value = embed.toJSON().fields![0].value;
    expect(value).toBe(`**Wingspan** (<t:${startUnix + 30 * 60}:t>–<t:${startUnix + 90 * 60}:t>) — <@p1>, <@p2>`);
  });

  it('sorts a table\'s own games chronologically and gives each its own start/end time', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
        { gameId: 'g2', table: 1, startMinutes: 60, endMinutes: 90, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p3', 'p4'] },
      ],
      totalDurationMinutes: 90,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const value = embed.toJSON().fields![0].value;
    expect(value).toBe(
      `**Wingspan** (<t:${startUnix}:t>–<t:${startUnix + 3600}:t>) — <@p1>, <@p2>\n` +
        `**Catan** (<t:${startUnix + 3600}:t>–<t:${startUnix + 5400}:t>) — <@p3>, <@p4>`,
    );
  });

  it('lists the greeters in their own field, ahead of the table fields, when the event has any', () => {
    const gnWithGreeters = { ...gn, greeters: ['u1', 'u2'] };
    const embed = buildScheduleEmbed(gnWithGreeters, games, baseResult());
    const data = embed.toJSON();
    expect(data.fields![0].name).toBe('👋 Greeters');
    expect(data.fields![0].value).toBe('<@u1> and <@u2>');
  });

  it('shows a single greeter without "and"', () => {
    const gnWithGreeter = { ...gn, greeters: ['u1'] };
    const embed = buildScheduleEmbed(gnWithGreeter, games, baseResult());
    expect(embed.toJSON().fields![0].value).toBe('<@u1>');
  });

  it('omits the greeters field entirely when the event has none set', () => {
    const embedNoField = buildScheduleEmbed(gn, games, baseResult());
    expect(embedNoField.toJSON().fields!.some((f) => f.name === '👋 Greeters')).toBe(false);

    const embedEmptyArray = buildScheduleEmbed({ ...gn, greeters: [] }, games, baseResult());
    expect(embedEmptyArray.toJSON().fields!.some((f) => f.name === '👋 Greeters')).toBe(false);
  });

  it('notes the play count when a game repeats, omits it when played once', () => {
    const repeated = buildScheduleEmbed(gn, games, baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 90, playCount: 3, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] }],
    }));
    expect(repeated.toJSON().fields![0].value).toContain('Wingspan** (3x)');

    const once = buildScheduleEmbed(gn, games, baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] }],
    }));
    expect(once.toJSON().fields![0].value).not.toContain('x)');
  });

  it('omits the player-mention suffix for a game with no seated players', () => {
    const gamesWithEmptySeats = [{ id: 'g1', title: 'Wingspan', seatedPlayers: [] as string[] }];
    const result = baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: [] }],
    });
    const embed = buildScheduleEmbed(gn, gamesWithEmptySeats, result);
    expect(embed.toJSON().fields![0].value).toBe(`**Wingspan** (<t:${startUnix}:t>–<t:${startUnix + 3600}:t>)`);
  });

  it('flags a mayNotFinish slot inline without affecting other slots', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
        { gameId: 'g2', table: 2, startMinutes: 0, endMinutes: 300, playCount: 1, mayNotFinish: true, attendingPlayerIds: ['p3', 'p4'] },
      ],
      totalDurationMinutes: 300,
      fitsInWindow: false,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).not.toContain('⚠️');
    expect(data.fields![1].value).toContain('⚠️');
  });

  it('notes on the game\'s own line when its start was delayed by a specific seated player, not table availability', () => {
    const result = baseResult({
      assignments: [
        { gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] },
        { gameId: 'g2', table: 2, startMinutes: 60, endMinutes: 120, playCount: 1, mayNotFinish: false, delayedByPlayerId: 'p1', attendingPlayerIds: ['p3', 'p4'] },
      ],
      totalDurationMinutes: 120,
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).not.toContain('waiting on');
    expect(data.fields![1].value).toContain('⏳ waiting on <@p1> to finish an earlier game');
  });

  it('notes a signed-up player as able to join once free when they were left out of the quorum', () => {
    const result = baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1'] }],
    });
    const embed = buildScheduleEmbed(gn, games, result);
    expect(embed.toJSON().fields![0].value).toContain('(+ <@p2> can join once free)');
  });

  it('omits the "can join once free" note when everyone signed up is attending', () => {
    const result = baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] }],
    });
    const embed = buildScheduleEmbed(gn, games, result);
    expect(embed.toJSON().fields![0].value).not.toContain('can join once free');
  });

  it('lists walk-up (1-signup) games in their own section, with no table or time estimate', () => {
    const result = baseResult({ walkUps: [{ gameId: 'g1' }] });
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    const field = data.fields!.find((f) => f.name === '🌱 Open to walk-ups')!;
    expect(field).toBeDefined();
    expect(field.value).toContain('**Wingspan** — <@p1>, <@p2>');
    expect(field.value).not.toContain(`<t:${startUnix}`); // no confident timestamp shown
    // A walk-up game never gets a table field of its own.
    expect(data.fields!.some((f) => f.name === 'Table 1')).toBe(false);
  });

  it('omits the "Schedule: no games scheduled" placeholder when only walk-up games exist', () => {
    const result = baseResult({ walkUps: [{ gameId: 'g1' }] });
    const embed = buildScheduleEmbed(gn, games, result);
    expect(embed.toJSON().fields!.some((f) => f.name === 'Schedule')).toBe(false);
  });

  it('shows a player-warning field when playerWarnings is non-empty', () => {
    const result = baseResult({
      playerWarnings: [{ userId: 'p1', reason: 'signed up for 3 games — may not get to all of them before the event ends' }],
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const field = embed.toJSON().fields!.find((f) => f.name === '⚠️ May not get to play everything');
    expect(field?.value).toContain('<@p1>');
    expect(field?.value).toContain('signed up for 3 games');
  });

  it('lists unscheduled games with their reason', () => {
    const result = baseResult({
      unscheduled: [{ gameId: 'g1', reason: 'only 1/3 minimum players seated' }],
    });
    const embed = buildScheduleEmbed(gn, games, result);
    const field = embed.toJSON().fields!.find((f) => f.name === 'Not scheduled');
    expect(field?.value).toContain('Wingspan');
    expect(field?.value).toContain('only 1/3 minimum players seated');
  });

  it('shows a "no games scheduled" placeholder field when nothing was assigned', () => {
    const embed = buildScheduleEmbed(gn, games, baseResult());
    const field = embed.toJSON().fields!.find((f) => f.name === 'Schedule');
    expect(field?.value).toContain('no games scheduled');
  });

  it('flags in the footer when the schedule does not fit the window', () => {
    const result = baseResult({ totalDurationMinutes: 300, fitsInWindow: false });
    const embed = buildScheduleEmbed(gn, [], result);
    expect(embed.toJSON().footer?.text).toContain('may run past');
    expect(embed.toJSON().footer?.text).toContain('300 min');
  });

  it('confirms in the footer when the schedule fits the window', () => {
    const result = baseResult({ totalDurationMinutes: 60, fitsInWindow: true });
    const embed = buildScheduleEmbed(gn, [], result);
    expect(embed.toJSON().footer?.text).toContain('fits within the event window');
  });

  it('renders a guest\'s display name instead of a broken mention when a guests array is given', () => {
    const guests = [{ id: 'guest:abc', ownerId: 'p1', name: 'Mom' }];
    const result = baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'guest:abc'] }],
    });
    const embed = buildScheduleEmbed(gn, games, result, guests);
    const value = embed.toJSON().fields![0].value;
    expect(value).toContain("<@p1>'s Guest (Mom)");
    expect(value).not.toContain('<@guest:abc>');
  });

  it('behaves exactly as before when no guests array is given (existing callers unaffected)', () => {
    const result = baseResult({
      assignments: [{ gameId: 'g1', table: 1, startMinutes: 0, endMinutes: 60, playCount: 1, mayNotFinish: false, attendingPlayerIds: ['p1', 'p2'] }],
    });
    const withDefault = buildScheduleEmbed(gn, games, result).toJSON();
    const withEmptyArray = buildScheduleEmbed(gn, games, result, []).toJSON();
    expect(withDefault).toEqual(withEmptyArray);
  });
});

describe('lockAndScheduleEvent', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-lock-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function makeGameNight(overrides: Partial<Record<string, unknown>> = {}) {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    return {
      id: 'gn1',
      title: 'Game Night',
      date: 'Someday',
      time: 'Sometime',
      location: 'TBD',
      link: '',
      description: '',
      messageId: '',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: null,
      eventChannelId: 'event-channel-1',
      startTimeISO: start.toISOString(),
      endTimeISO: end.toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeClient(sendMock = vi.fn(async () => {})) {
    const channel = { send: sendMock };
    const guild = {
      members: { fetch: vi.fn(async (id: string) => ({ displayName: `Display-${id}` })) },
    };
    return {
      channels: { fetch: vi.fn(async () => channel) },
      guilds: { fetch: vi.fn(async () => guild) },
      _channel: channel,
    };
  }

  const BUFFER_CONFIG = {
    scheduleTableCount: 2,
    maxTableCount: 0,
    lightBufferMinutes: 20,
    mediumBufferMinutes: 30,
    heavyBufferMinutes: 40,
    postBgStatsLinks: false,
    heavyGameBreakMinutes: 0,
    maxGameRepeats: 1,
    breakMinutesBetweenGames: 0,
    flexTableCount: 0,
  };

  it('marks the event locked and posts a schedule embed', async () => {
    const { upsertGameNight, findGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    const updated = await findGameNight('gn1');
    expect(updated?.suggestionsLocked).toBe(true);
    expect(updated?.scheduledAt).toBeDefined();
    expect(client._channel.send).toHaveBeenCalled();
  });

  it('sizes the table count from RSVPs instead of a too-low config default, so non-conflicting games all run concurrently', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    // 13 RSVPs -> computeHeadcountTableFloor(13) = 3, well above the configured default of 1.
    const rsvpIds = Array.from({ length: 13 }, (_, i) => `rsvp-${i}`);
    const gn = makeGameNight({ rsvps: { yes: rsvpIds, maybe: [], no: [] } });
    await upsertGameNight(gn as any);
    for (const [i, seats] of [['p1', 'p2'], ['p3', 'p4'], ['p5', 'p6']].entries()) {
      await upsertGame({
        id: `game${i + 1}`, eventId: 'gn1', channelId: 'event-channel-1', messageId: `m${i + 1}`, guildId: 'guild-1',
        bggId: `${i + 1}`, title: `Game ${i + 1}`, bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats, waitlist: [],
        createdAt: new Date().toISOString(), createdBy: seats[0], complexity: 'Light',
      } as any);
    }
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, scheduleTableCount: 1 });

    const games = await Promise.all(['game1', 'game2', 'game3'].map((id) => findGame(id)));
    // All three non-conflicting games start at minute 0 across 3 distinct tables —
    // with the flat config default of 1 table, two of them would have queued sequentially instead.
    expect(games.every((g) => g?.scheduledStartMinutes === 0)).toBe(true);
    expect(new Set(games.map((g) => g?.scheduledTable)).size).toBe(3);
  });

  it('persists scheduledTable/scheduledStartMinutes/scheduledEndMinutes/scheduledPlayCount on each scheduled game', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    const game = await findGame('game1');
    expect(game?.scheduledTable).toBe(1);
    expect(game?.scheduledStartMinutes).toBe(0);
    expect(game?.scheduledEndMinutes).toBeGreaterThan(0);
    expect(game?.scheduledPlayCount).toBe(1);
    expect(game?.scheduledMayNotFinish).toBe(false);
  });

  it('persists a higher scheduledPlayCount for a short game repeated back-to-back at its table', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'long', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Twilight Imperium', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 90, maxPlaytime: 90, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Heavy',
    } as any);
    await upsertGame({
      id: 'short', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm2', guildId: 'guild-1',
      bggId: '2', title: 'Love Letter', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 15, maxPlaytime: 15, suggestedStartTime: null, expansions: [], seats: ['p3', 'p4'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p3', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, maxGameRepeats: 3 });

    const short = await findGame('short');
    expect(short?.scheduledPlayCount).toBeGreaterThan(1);
  });

  it('inserts a Heavy-adjacency break at the shared table when RSVP sizing forces two Heavy games onto it', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'heavy1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Heavy One', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 60, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Heavy',
    } as any);
    await upsertGame({
      id: 'heavy2', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm2', guildId: 'guild-1',
      bggId: '2', title: 'Heavy Two', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 60, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p3', 'p4'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p3', complexity: 'Heavy',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, scheduleTableCount: 1, heavyGameBreakMinutes: 15 });

    const h1 = await findGame('heavy1');
    const h2 = await findGame('heavy2');
    expect(h1?.scheduledTable).toBe(h2?.scheduledTable);
    expect(h2!.scheduledStartMinutes! - h1!.scheduledEndMinutes!).toBe(15);

    const embedCall = (client._channel.send as any).mock.calls[0][0];
    expect(embedCall.embeds[0].toJSON().footer.text).toContain(`${h2!.scheduledEndMinutes} min`);
  });

  it('posts a BG Stats button per scheduled game when postBgStatsLinks is enabled', async () => {
    // BG Stats' payload no longer fits under Discord's button limit even for
    // a solo play once every field their app actually requires is included —
    // stub the short-link server (the realistic production config) so the
    // button reliably appears, and verify its contents via the stored link.
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const { findShortLink } = await import('../src/utils/shortLinkStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    // One call for the schedule-summary embed, one more per scheduled game.
    expect(client._channel.send).toHaveBeenCalledTimes(2);
    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    expect(button.label).toBe('Log in BG Stats');

    const stored = await findShortLink(button.url.split('/s/')[1]);
    expect(stored?.guildId).toBe('guild-1');
    expect(stored?.eventId).toBe('gn1');
    expect(stored?.gameId).toBe('game1');
    const data = JSON.parse(decodeURIComponent(stored!.url.split('?data=')[1]));
    expect(data.sourceName).toBe('Rulebook Rebels Discord Bot');
    expect(data.sourcePlayId).toBe('game1');
    expect(typeof data.playDate).toBe('string');
    expect(data.game.name).toBe('Wingspan');
    expect(data.location).toBe('The Rec Room');
    expect(data.players).toEqual([
      { name: 'Display-p1', sourcePlayerId: 'p1', winner: false, startPlayer: false },
      { name: 'Display-p2', sourcePlayerId: 'p2', winner: false, startPlayer: false },
    ]);

    // A QR code (encoding the same short link as the button, for easier scanning) is attached alongside it.
    expect(bgStatsCall.files).toHaveLength(1);
    expect(bgStatsCall.files[0].toJSON().name).toBe('bgstats-game1.png');
  });

  it('excludes a guest pseudo-id from the BG Stats roster', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const { findShortLink } = await import('../src/utils/shortLinkStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [],
      seats: ['p1', 'guest:abc'], waitlist: [],
      guests: [{ id: 'guest:abc', ownerId: 'p1', name: 'Mom' }],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    const stored = await findShortLink(button.url.split('/s/')[1]);
    const data = JSON.parse(decodeURIComponent(stored!.url.split('?data=')[1]));
    expect(data.players).toEqual([{ name: 'Display-p1', sourcePlayerId: 'p1', winner: false, startPlayer: false }]);
  });

  // Regression: BG Stats' link grows with player count and Discord caps button
  // URLs at 512 chars. A real multi-player game crashed the whole post in
  // production (DiscordAPIError 50035) because the button was always included
  // regardless of URL length. The QR code has no such limit, so it must always
  // be attached even when the button is omitted.
  it('omits the button (but still attaches the QR code) for a game with enough players to exceed the Discord button URL limit', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 6, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2', 'p3', 'p4', 'p5'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    expect(bgStatsCall.components).toEqual([]);
    expect(bgStatsCall.files).toHaveLength(1);
    expect(bgStatsCall.files[0].toJSON().name).toBe('bgstats-game1.png');
  });

  it('includes a working short-link button for a multi-player game when SHORT_LINK_BASE_URL is configured', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 6, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2', 'p3', 'p4', 'p5'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    expect(button.url).toMatch(/^https:\/\/bot\.example\.com\/s\/[A-Za-z0-9_-]+$/);
  });

  it('does not post BG Stats buttons when postBgStatsLinks is disabled (default)', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
  });

  it('posts a walk-up (1-signup) game\'s BG Stats link with a walk-up note instead of a time range', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Firefly', bggLink: '', minPlayers: 3, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 120, maxPlaytime: 240, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Medium',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    expect(bgStatsCall.embeds[0].toJSON().description).toContain('Open to walk-ups');

    // No real table slot was reserved, but it's still marked as having a BG
    // Stats link posted (see handleAdminBgStats in src/commands/admin.ts),
    // and NOT marked scheduledTable (see getLastScheduledAt) — a walk-up was
    // never confidently placed, so it should still be eligible to come up
    // again via /library random.
    const { findGame } = await import('../src/utils/gameStorage');
    const stored = await findGame('game1');
    expect(stored?.scheduledTable).toBeUndefined();
    expect(stored?.scheduledWalkUp).toBe(true);
  });

  it('logs a clear reason instead of silently skipping when no game meets the scheduling threshold', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    // 2 players seated but 3 required — never gets a schedule assignment.
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 3, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    expect(client._channel.send).toHaveBeenCalledTimes(1); // schedule-summary embed only, no BG Stats post
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Skipping post for game night ${gn.id}`),
    );
    logSpy.mockRestore();
  });

  it("uses a player's linked BGG username instead of their Discord display name when available", async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const { setBggAccount } = await import('../src/utils/bggAccountStorage');
    const { findShortLink } = await import('../src/utils/shortLinkStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    await setBggAccount('guild-1', 'p1', 'sean_o');
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    const stored = await findShortLink(button.url.split('/s/')[1]);
    const data = JSON.parse(decodeURIComponent(stored!.url.split('?data=')[1]));
    expect(data.players).toEqual([
      { name: 'sean_o', sourcePlayerId: 'p1', winner: false, startPlayer: false },
      { name: 'Display-p2', sourcePlayerId: 'p2', winner: false, startPlayer: false },
    ]);
  });

  describe('DMing the host about games with no teacher', () => {
    async function seedTeachingGame(id: string, title: string, extra: Record<string, unknown>) {
      const { upsertGame } = await import('../src/utils/gameStorage');
      await upsertGame({
        id, eventId: 'gn1', channelId: 'event-channel-1', messageId: `m-${id}`, guildId: 'guild-1',
        bggId: id, title, bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light', ...extra,
      } as any);
    }

    function makeClientWithHostDm() {
      const hostSend = vi.fn(async () => {});
      const client = { ...makeClient(vi.fn(async () => ({ id: 'msg', pin: vi.fn(async () => {}) }))), users: { fetch: vi.fn(async () => ({ send: hostSend })) } };
      return { client, hostSend };
    }

    it('DMs the event host listing only the games nobody can teach', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const gn = makeGameNight({ createdBy: 'host-1' });
      await upsertGameNight(gn as any);
      await seedTeachingGame('a', 'Wingspan', { teachers: [], helpers: [] });
      await seedTeachingGame('b', 'Catan', { teachers: ['p1'], helpers: [] });
      await seedTeachingGame('c', 'Azul', {});
      const { client, hostSend } = makeClientWithHostDm();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(client.users.fetch).toHaveBeenCalledWith('host-1');
      expect(hostSend).toHaveBeenCalledTimes(1);
      const text = (hostSend.mock.calls[0] as unknown as [string])[0];
      expect(text).toContain('**Wingspan**');
      expect(text).not.toContain('Catan');
      expect(text).not.toContain('Azul');
    });

    it('sends no DM when every game has a teacher (or predates teaching tracking)', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await seedTeachingGame('b', 'Catan', { teachers: ['p1'], helpers: [] });
      await seedTeachingGame('c', 'Azul', {});
      const { client, hostSend } = makeClientWithHostDm();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(hostSend).not.toHaveBeenCalled();
    });

    it('still locks when the host has DMs disabled', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await seedTeachingGame('a', 'Wingspan', { teachers: [], helpers: [] });
      const { client } = makeClientWithHostDm();
      client.users.fetch = vi.fn(async () => ({ send: vi.fn(async () => { throw new Error('Cannot send messages to this user'); }) }));

      await expect(lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG)).resolves.toBeUndefined();
      expect(gn.suggestionsLocked).toBe(true);
    });
  });

  describe('snack reminders at lock', () => {
    it('DMs each member their snacks when the lineup locks, without blocking the lock', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { addSnackItem } = await import('../src/utils/snackStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await addSnackItem('event-channel-1', 'guild-1', 'gn1', 'alice', 'Chips');
      await addSnackItem('event-channel-1', 'guild-1', 'gn1', 'bob', 'Soda');

      const dms: string[] = [];
      const base = makeClient(vi.fn(async () => ({ id: 'msg', pin: vi.fn(async () => {}) })));
      const client = {
        ...base,
        users: {
          fetch: vi.fn(async (id: string) => ({
            send: vi.fn(async () => {
              if (id === 'bob') throw new Error('DMs closed');
              dms.push(id);
            }),
          })),
        },
      };

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(dms).toEqual(['alice']);
      expect(gn.suggestionsLocked).toBe(true);
      expect(base._channel.send).toHaveBeenCalled(); // the schedule still posted
    });
  });

  describe('dropping zero-signup "games to bring" requests', () => {
    // A send mock that returns a pinnable message object (unlike the shared
    // makeClient default, which resolves to undefined) — needed because this
    // path calls updateRequestPin, which sends/edits and pins a message.
    function makeClientWithPinSupport() {
      let callCount = 0;
      const sendMock = vi.fn(async () => {
        callCount += 1;
        return { id: `msg-${callCount}`, pin: vi.fn(async () => {}) };
      });
      return makeClient(sendMock);
    }

    it('drops a request for a game that ends up with zero signups, keeps one that still has signups', async () => {
      const { upsertGameNight, findGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addRequest, getRequestsForEvent } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      await upsertGame({
        id: 'game2', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm2', guildId: 'guild-1',
        bggId: '2', title: 'Catan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: [], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      await addRequest('gn1', 'Wingspan', 'user1');
      await addRequest('gn1', 'Catan', 'user2');
      const client = makeClientWithPinSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      const remaining = await getRequestsForEvent('gn1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].gameName).toBe('Wingspan');

      const updated = await findGameNight('gn1');
      expect(updated?.requestPinMessageId).toBeDefined();
    });

    it('leaves a request untouched when it has no matching game suggestion', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addRequest, getRequestsForEvent } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Catan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: [], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      // Requested to be brought along, but never suggested as a game to play.
      await addRequest('gn1', 'Azul', 'user1');
      const client = makeClientWithPinSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      const remaining = await getRequestsForEvent('gn1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].gameName).toBe('Azul');
    });

    it('does not touch the request pin when no requests were dropped', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      // Zero signups, but nobody requested it — nothing to drop.
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Catan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: [], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      const client = makeClient();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(client._channel.send).toHaveBeenCalledTimes(1); // schedule-summary embed only
    });

    it('drops a request even if the owner already confirmed bringing it', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addGame } = await import('../src/utils/libraryStorage');
      const { addRequest, getRequestsForEvent, confirmBring } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Catan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: [], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      await addGame('guild-1', 'owner1', 'Catan');
      await addRequest('gn1', 'Catan', 'user1');
      expect(await confirmBring('guild-1', 'gn1', 'Catan', 'owner1')).toMatchObject({ status: 'confirmed' });
      const client = makeClientWithPinSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(await getRequestsForEvent('gn1')).toHaveLength(0);
    });
  });

  describe('owner-asking and stale-DM cleanup at lock', () => {
    // A client that additionally supports DM sends (client.users.fetch(...).send)
    // and editing those DMs later (client.channels.fetch(dmChannelId).messages.fetch),
    // plus a call log to assert relative ordering between DMs and the schedule post.
    function makeClientWithDmSupport() {
      const callLog: string[] = [];
      const sentDms: Array<{ ownerId: string; content: string }> = [];
      const dmMessages = new Map<string, { content: string; edit: ReturnType<typeof vi.fn> }>();
      let scheduleSendCount = 0;

      const eventChannel = {
        send: vi.fn(async () => {
          callLog.push('schedule-post');
          scheduleSendCount += 1;
          return { id: `sched-msg-${scheduleSendCount}`, pin: vi.fn(async () => {}) };
        }),
      };

      const client = {
        channels: {
          fetch: vi.fn(async (id: string) => {
            if (id === 'event-channel-1') return eventChannel;
            return {
              isTextBased: () => true,
              messages: { fetch: vi.fn(async (msgId: string) => dmMessages.get(`${id}:${msgId}`)) },
            };
          }),
        },
        guilds: {
          fetch: vi.fn(async () => ({
            members: { fetch: vi.fn(async (id: string) => ({ displayName: `Display-${id}` })) },
          })),
        },
        users: {
          fetch: vi.fn(async (ownerId: string) => ({
            id: ownerId,
            send: vi.fn(async (payload: { content: string }) => {
              callLog.push('dm-send');
              sentDms.push({ ownerId, content: payload.content });
              const channelId = `dm-channel-${ownerId}`;
              const messageId = `dm-message-${sentDms.length}`;
              const msg = {
                content: payload.content,
                edit: vi.fn(async (editPayload: { content: string }) => {
                  callLog.push('dm-edit');
                  msg.content = editPayload.content;
                }),
              };
              dmMessages.set(`${channelId}:${messageId}`, msg);
              return { id: messageId, channelId };
            }),
          })),
        },
        _channel: eventChannel,
      };
      return { client, callLog, sentDms, dmMessages };
    }

    it('asks the owner of a never-before-asked request, before posting the schedule', async () => {
      // Under the deferred-ask design, no "please bring this" DM goes out
      // before lock — this is the very first ask for the request, not a
      // reminder to someone already pending.
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addGame, addRequest } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight({ rsvps: { yes: ['owner1'], maybe: [], no: [] } });
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      await addGame('guild-1', 'owner1', 'Wingspan');
      await addRequest('gn1', 'Wingspan', 'user1');
      const { client, callLog, sentDms } = makeClientWithDmSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(sentDms).toHaveLength(1);
      expect(sentDms[0].ownerId).toBe('owner1');
      expect(sentDms[0].content).toContain('Wingspan');
      expect(callLog.indexOf('dm-send')).toBeLessThan(callLog.indexOf('schedule-post'));
    });

    it('does not ask an owner who already confirmed before lock', async () => {
      // A member can proactively confirm via /library bring before the event
      // ever locks — that satisfies the request, so lock shouldn't ask anyone.
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addGame, addRequest, confirmBring } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight({ rsvps: { yes: ['owner1'], maybe: [], no: [] } });
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      await addGame('guild-1', 'owner1', 'Wingspan');
      await addRequest('gn1', 'Wingspan', 'user1');
      await confirmBring('guild-1', 'gn1', 'Wingspan', 'owner1');
      const { client, sentDms } = makeClientWithDmSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(sentDms).toHaveLength(0);
    });

    it('sends no ask when the requested game has no owner in the library', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addRequest } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      // No addGame call — nobody owns Wingspan, so there's no one eligible to ask.
      await addRequest('gn1', 'Wingspan', 'user1');
      const { client, sentDms } = makeClientWithDmSupport();

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      expect(sentDms).toHaveLength(0);
    });

    it('invalidates a pending DM for a request dropped due to zero signups, before posting the schedule', async () => {
      const { upsertGameNight } = await import('../src/utils/storage');
      const { upsertGame } = await import('../src/utils/gameStorage');
      const { addRequest, addPendingAsk } = await import('../src/utils/libraryStorage');
      const gn = makeGameNight();
      await upsertGameNight(gn as any);
      await upsertGame({
        id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
        bggId: '1', title: 'Catan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
        minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: [], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
      } as any);
      const req = await addRequest('gn1', 'Catan', 'user1');
      await addPendingAsk((req as any).id, 'owner1', 'dm-channel-owner1', 'dm-message-1');
      const { client, callLog, dmMessages } = makeClientWithDmSupport();
      dmMessages.set('dm-channel-owner1:dm-message-1', {
        content: '🎲 Someone requested that you bring **Catan**!',
        edit: vi.fn(async (payload: { content: string }) => {
          callLog.push('dm-edit');
        }),
      });

      await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

      const editedMsg = dmMessages.get('dm-channel-owner1:dm-message-1');
      expect(editedMsg?.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No longer needed'), components: [] }),
      );
      expect(callLog.indexOf('dm-edit')).toBeLessThan(callLog.indexOf('schedule-post'));
    });
  });
});

describe('checkPendingSchedules', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-check-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClient() {
    const channel = { send: vi.fn(async () => {}) };
    return { channels: { fetch: vi.fn(async () => channel) }, _channel: channel };
  }

  async function seedNight(hoursUntilStart: number, overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGameNight } = await import('../src/utils/storage');
    const start = new Date(Date.now() + hoursUntilStart * 60 * 60 * 1000);
    const gn = {
      id: 'gn1',
      title: 'Game Night',
      date: 'Someday',
      time: 'Sometime',
      location: 'TBD',
      link: '',
      description: '',
      messageId: '',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: null,
      eventChannelId: 'event-channel-1',
      startTimeISO: start.toISOString(),
      endTimeISO: new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    await upsertGameNight(gn as any);
    return gn;
  }

  it('locks an event once it crosses the configured lock threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    const { findGameNight } = await import('../src/utils/storage');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(20); // starts in 20h, threshold is 24h before -> already past lock time

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBe(true);
  });

  it('does not lock an event that has not yet reached the threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    const { findGameNight } = await import('../src/utils/storage');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(48); // starts in 48h, well before the 24h threshold

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBeFalsy();
  });

  it('locks using the default 48h threshold when lockHoursBeforeEvent has not been explicitly configured', async () => {
    const { findGameNight } = await import('../src/utils/storage');
    await seedNight(1); // starts in 1h, well past the default 48h threshold

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBe(true);
  });

  it('does nothing when the lock feature is explicitly disabled (lockHoursBeforeEvent: 0)', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    const { findGameNight } = await import('../src/utils/storage');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 0 });
    await seedNight(1); // starts very soon, would lock if enabled

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBeFalsy();
  });

  it('skips a cancelled event even past the threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(1, { cancelled: true });
    const client = makeClient();

    await checkPendingSchedules(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('does not re-lock/re-schedule an already-locked event', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(1, { suggestionsLocked: true });
    const client = makeClient();

    await checkPendingSchedules(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });
});

describe('previewSchedule', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-preview-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGameNight(overrides: Partial<Record<string, unknown>> = {}) {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    return {
      id: 'gn1',
      title: 'Game Night',
      date: 'Someday',
      time: 'Sometime',
      location: 'TBD',
      link: '',
      description: '',
      messageId: '',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: null,
      eventChannelId: 'event-channel-1',
      startTimeISO: start.toISOString(),
      endTimeISO: end.toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeInteraction(channelId: string) {
    return {
      channelId,
      guildId: 'guild-1',
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('shows a preview embed without locking, persisting, or posting anything', async () => {
    const { upsertGameNight, findGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const interaction = makeInteraction('event-channel-1');

    await previewSchedule(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: expect.anything() });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );

    const updatedNight = await findGameNight('gn1');
    expect(updatedNight?.suggestionsLocked).toBeFalsy();
    const updatedGame = await findGame('game1');
    expect(updatedGame?.scheduledTable).toBeUndefined();
  });

  it('replies with a clear error when run outside any event channel', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    const interaction = makeInteraction('some-other-channel');

    await previewSchedule(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("isn't an event channel"));
  });
});
