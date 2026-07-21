import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  scheduleGames,
  complexityBufferMinutes,
  toSchedulableGame,
  computeRoundClocks,
  buildScheduleEmbed,
  lockAndScheduleEvent,
  checkPendingSchedules,
  previewSchedule,
  isLineupLocked,
  SchedulableGame,
  computeHeadcountTableFloor,
  computePreferenceSplitTableFloor,
  computeEffectiveTableCount,
  resolveRsvpComplexityPreferences,
} from '../src/utils/scheduler';
import { GameSuggestion } from '../src/utils/gameStorage';

const BUFFER_CONFIG = { lightBufferMinutes: 20, mediumBufferMinutes: 30, heavyBufferMinutes: 40 };

// Refinements config for tests that aren't exercising breaks/repeats — keeps
// their assertions identical to pre-refinement behavior.
const NO_REFINEMENTS = { heavyGameBreakMinutes: 0, maxGameRepeats: 1 };

function makeGame(overrides: Partial<SchedulableGame> = {}): SchedulableGame {
  return {
    id: overrides.id ?? 'g1',
    title: overrides.title ?? 'Game',
    minPlayers: overrides.minPlayers ?? 2,
    seatedPlayers: overrides.seatedPlayers ?? ['p1', 'p2'],
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
    const game = { id: 'g1', title: 'Wingspan', minPlayers: 2, maxPlaytime: 70, complexity: 'Medium', seats: ['p1'] } as GameSuggestion;
    const result = toSchedulableGame(game, BUFFER_CONFIG);
    expect(result.effectiveDurationMinutes).toBe(100); // 70 + 30
    expect(result.seatedPlayers).toEqual(['p1']);
    expect(result.rawMaxPlaytime).toBe(70);
    expect(result.complexity).toBe('Medium');
  });
});

describe('scheduleGames', () => {
  it('schedules a single game onto round 1, table 1', () => {
    const result = scheduleGames([makeGame({ id: 'g1' })], 2, 120, NO_REFINEMENTS);
    expect(result.assignments).toEqual([
      { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
    ]);
    expect(result.unscheduled).toEqual([]);
    expect(result.lowInterest).toEqual([]);
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

  it('places two non-conflicting games in the same round when tables allow it', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'] }),
      ],
      2,
      120,
      NO_REFINEMENTS,
    );
    const rounds = new Set(result.assignments.map((a) => a.round));
    expect(rounds.size).toBe(1);
    const tables = result.assignments.map((a) => a.table).sort();
    expect(tables).toEqual([1, 2]);
  });

  it('pushes a player-conflicting game to a later round even with a free table', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'] }), // shares p1 with g1
      ],
      2, // two tables available — conflict is about the player, not table capacity
      240,
      NO_REFINEMENTS,
    );
    const g1Round = result.assignments.find((a) => a.gameId === 'g1')!.round;
    const g2Round = result.assignments.find((a) => a.gameId === 'g2')!.round;
    expect(g1Round).not.toBe(g2Round);
  });

  it('queues a third game to round 2 when only one table is available', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'] }),
      ],
      1, // single table
      240,
      NO_REFINEMENTS,
    );
    const rounds = result.assignments.map((a) => a.round).sort();
    expect(rounds).toEqual([1, 2]);
  });

  it('computes each round duration as the max effective duration among its games', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 45, rawMaxPlaytime: 45 }),
      ],
      2,
      120,
      NO_REFINEMENTS,
    );
    expect(result.roundDurationsMinutes).toEqual([90]);
    expect(result.totalDurationMinutes).toBe(90);
  });

  it('flags fitsInWindow as false when the schedule exceeds the event window', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p1', 'p3'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }), // conflicts with g1 -> forced to round 2
      ],
      1,
      120, // only enough time for one 90-minute round
      NO_REFINEMENTS,
    );
    expect(result.totalDurationMinutes).toBe(180);
    expect(result.fitsInWindow).toBe(false);
  });

  it('handles an empty game list', () => {
    const result = scheduleGames([], 2, 120, NO_REFINEMENTS);
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([]);
    expect(result.lowInterest).toEqual([]);
    expect(result.totalDurationMinutes).toBe(0);
    expect(result.fitsInWindow).toBe(true);
  });

  it('never double-books a player across tables in the same round, even under load', () => {
    // 6 games, alternating between two overlapping player pools, 3 tables available.
    const games = Array.from({ length: 6 }, (_, i) =>
      makeGame({
        id: `g${i}`,
        seatedPlayers: i % 2 === 0 ? ['p1', 'p2'] : ['p2', 'p3'],
        effectiveDurationMinutes: 60,
      }),
    );
    const result = scheduleGames(games, 3, 600, NO_REFINEMENTS);

    const byRound = new Map<number, string[]>();
    for (const a of result.assignments) {
      const game = games.find((g) => g.id === a.gameId)!;
      const existing = byRound.get(a.round) ?? [];
      for (const p of game.seatedPlayers) {
        expect(existing.includes(p)).toBe(false);
      }
      byRound.set(a.round, [...existing, ...game.seatedPlayers]);
    }
  });

  describe('low-interest bucket', () => {
    it('routes a game with exactly 1 seated player to lowInterest instead of unscheduled', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', minPlayers: 2, seatedPlayers: ['p1'] })],
        2,
        120,
        NO_REFINEMENTS,
      );
      expect(result.lowInterest).toEqual([
        { gameId: 'g1', reason: 'only 1 player interested — may not get played' },
      ]);
      expect(result.unscheduled).toEqual([]);
      expect(result.assignments).toEqual([]);
    });

    it('routes a 1-seated game to lowInterest even when its own minPlayers is 1 (would otherwise be schedulable)', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1'] })],
        2,
        120,
        NO_REFINEMENTS,
      );
      expect(result.lowInterest).toEqual([
        { gameId: 'g1', reason: 'only 1 player interested — may not get played' },
      ]);
      expect(result.assignments).toEqual([]);
    });

    it('leaves a 0-seated game in the unscheduled bucket, not lowInterest', () => {
      const result = scheduleGames(
        [makeGame({ id: 'g1', minPlayers: 2, seatedPlayers: [] })],
        2,
        120,
        NO_REFINEMENTS,
      );
      expect(result.unscheduled).toEqual([
        { gameId: 'g1', reason: 'only 0/2 minimum players seated' },
      ]);
      expect(result.lowInterest).toEqual([]);
    });

    it('only pulls out the 1-seated game when games are mixed', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1'] }),
          makeGame({ id: 'g2', minPlayers: 2, seatedPlayers: ['p2', 'p3'] }),
        ],
        2,
        120,
        NO_REFINEMENTS,
      );
      expect(result.lowInterest.map((u) => u.gameId)).toEqual(['g1']);
      expect(result.assignments.map((a) => a.gameId)).toEqual(['g2']);
    });
  });

  describe('Heavy-adjacency break', () => {
    it('inserts a break before the second round when one table plays Heavy games in consecutive rounds', () => {
      // 1 table, disjoint players -> g1 forced to round 1, g2 forced to round 2, both Heavy.
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Heavy' }),
        ],
        1,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1 },
      );
      expect(result.roundDurationsMinutes).toHaveLength(2);
      expect(result.roundBreakMinutesBefore).toEqual([0, 20]);
      expect(result.totalDurationMinutes).toBe(60 + 60 + 20);
    });

    it('inserts no break when heavyGameBreakMinutes is 0 (disabled)', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Heavy' }),
        ],
        1,
        600,
        NO_REFINEMENTS,
      );
      expect(result.roundBreakMinutesBefore).toEqual([0, 0]);
    });

    it('inserts a global break even when only one of several tables has the Heavy-heavy adjacency', () => {
      // 2 tables: table 1 gets Heavy->Heavy, table 2 gets Light->Light — the
      // break is global, so table 2's round 2 also shifts even though it
      // didn't strictly need a break itself.
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['a1', 'a2'], complexity: 'Heavy', effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['b1', 'b2'], complexity: 'Light', effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
          makeGame({ id: 'g3', minPlayers: 1, seatedPlayers: ['c1', 'c2'], complexity: 'Heavy', effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
          makeGame({ id: 'g4', minPlayers: 1, seatedPlayers: ['d1', 'd2'], complexity: 'Light', effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1 },
      );
      expect(result.roundDurationsMinutes).toHaveLength(2);
      expect(result.roundBreakMinutesBefore).toEqual([0, 20]);
    });

    it('does not trigger a break for Heavy followed by a non-Heavy game at the same table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Light' }),
        ],
        1,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1 },
      );
      expect(result.roundBreakMinutesBefore).toEqual([0, 0]);
    });

    it('does not detect Heavy games separated by a non-Heavy filler round at the same table (v1 limitation)', () => {
      // Force 3 rounds at 1 table: Heavy (round1), non-Heavy (round2), Heavy (round3) —
      // all players distinct so each is forced to its own new round in order.
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Light' }),
          makeGame({ id: 'g3', minPlayers: 1, seatedPlayers: ['p5', 'p6'], complexity: 'Heavy' }),
        ],
        1,
        600,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1 },
      );
      expect(result.roundDurationsMinutes).toHaveLength(3);
      expect(result.roundBreakMinutesBefore).toEqual([0, 0, 0]);
    });

    it('can flip fitsInWindow from true to false once break minutes are counted', () => {
      const withoutBreak = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Heavy' }),
        ],
        1,
        130,
        NO_REFINEMENTS,
      );
      expect(withoutBreak.totalDurationMinutes).toBe(120);
      expect(withoutBreak.fitsInWindow).toBe(true);

      const withBreak = scheduleGames(
        [
          makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1', 'p2'], complexity: 'Heavy' }),
          makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p3', 'p4'], complexity: 'Heavy' }),
        ],
        1,
        130,
        { heavyGameBreakMinutes: 20, maxGameRepeats: 1 },
      );
      expect(withBreak.totalDurationMinutes).toBe(140);
      expect(withBreak.fitsInWindow).toBe(false);
    });
  });

  describe('opportunistic repeat-fill', () => {
    it('repeats a short game to fill leftover time in a longer round, capped by maxGameRepeats', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3 },
      );
      expect(result.roundDurationsMinutes).toEqual([90]);
      const shortAssignment = result.assignments.find((a) => a.gameId === 'short')!;
      // leftover = 90 - 40 = 50; floor(50/20) = 2 extra plays -> playCount 3
      expect(shortAssignment.playCount).toBe(3);
      const longAssignment = result.assignments.find((a) => a.gameId === 'long')!;
      expect(longAssignment.playCount).toBe(1);
    });

    it('caps repeats at maxGameRepeats even when leftover time allows more', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 2 },
      );
      const shortAssignment = result.assignments.find((a) => a.gameId === 'short')!;
      expect(shortAssignment.playCount).toBe(2);
    });

    it('does not repeat a short game that itself sets the round duration (no leftover)', () => {
      const result = scheduleGames(
        [makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 })],
        1,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'short')!;
      expect(assignment.playCount).toBe(1);
    });

    it('excludes a game at the 30-minute boundary (not eligible — must be strictly under 30)', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'boundary', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60, rawMaxPlaytime: 30 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3 },
      );
      const assignment = result.assignments.find((a) => a.gameId === 'boundary')!;
      expect(assignment.playCount).toBe(1);
    });

    it('does not repeat when leftover time is not enough for even one more play', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 62, rawMaxPlaytime: 29 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3 },
      );
      // leftover = 90 - 62 = 28, less than rawMaxPlaytime (29) -> no repeat
      const assignment = result.assignments.find((a) => a.gameId === 'short')!;
      expect(assignment.playCount).toBe(1);
    });

    it('never changes roundDurationsMinutes regardless of playCount', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'long', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 40, rawMaxPlaytime: 20 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 3 },
      );
      expect(result.roundDurationsMinutes).toEqual([90]);
    });
  });

  describe('multi-game chaining (fills leftover table time with other games, not just repeats)', () => {
    it('chains two different shorter games onto a table to fill the anchor table\'s time window', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 120, rawMaxPlaytime: 120, complexity: 'Heavy' }),
          makeGame({ id: 'first', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 70, rawMaxPlaytime: 70 }),
          makeGame({ id: 'second', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 50, rawMaxPlaytime: 50 }),
        ],
        2,
        600,
        NO_REFINEMENTS,
      );

      expect(result.roundDurationsMinutes).toEqual([120]);
      const anchor = result.assignments.find((a) => a.gameId === 'anchor')!;
      const first = result.assignments.find((a) => a.gameId === 'first')!;
      const second = result.assignments.find((a) => a.gameId === 'second')!;

      expect(anchor.table).toBe(1);
      // Both fillers land on the same (non-anchor) table, chained sequentially.
      expect(first.table).toBe(2);
      expect(second.table).toBe(2);
      expect(first.slotIndex).toBe(0);
      expect(first.startOffsetMinutes).toBe(0);
      expect(second.slotIndex).toBe(1);
      expect(second.startOffsetMinutes).toBe(70);
    });

    it('does not chain a game that would overflow the round\'s target duration', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90, rawMaxPlaytime: 90 }),
          // Fills table 2 (the round's only other table), leaving 30 min leftover there.
          makeGame({ id: 'filler', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
          // Doesn't fit in the 30 min left on table 2, and table 1 (the anchor's
          // own table) has zero leftover — no table in round 1 can hold it.
          makeGame({ id: 'toobig', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 40, rawMaxPlaytime: 40 }),
        ],
        2,
        600,
        NO_REFINEMENTS,
      );

      const filler = result.assignments.find((a) => a.gameId === 'filler')!;
      const toobig = result.assignments.find((a) => a.gameId === 'toobig')!;
      expect(filler.round).toBe(1);
      // 'toobig' can't fit in round 1's remaining 30 minutes on table 2 (and
      // table 1 is already full with the anchor), so it opens round 2.
      expect(toobig.round).toBe(2);
    });

    it('inserts a Heavy break between two Heavy games chained back-to-back at the same table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 150, rawMaxPlaytime: 150, complexity: 'Heavy' }),
          makeGame({ id: 'heavyA', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60, complexity: 'Heavy' }),
          makeGame({ id: 'heavyB', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60, complexity: 'Heavy' }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 15, maxGameRepeats: 1 },
      );

      const heavyA = result.assignments.find((a) => a.gameId === 'heavyA')!;
      const heavyB = result.assignments.find((a) => a.gameId === 'heavyB')!;
      expect(heavyA.table).toBe(heavyB.table);
      expect(heavyA.slotIndex).toBe(0);
      expect(heavyB.slotIndex).toBe(1);
      // heavyB starts after heavyA's 60 minutes PLUS the 15-min intra-chain break.
      expect(heavyB.startOffsetMinutes).toBe(75);
      // The chain's total (60 + 15 + 60 = 135) fits within the 150-min anchor,
      // so this is purely an intra-chain break — no round-level break is
      // needed since there's only one round.
      expect(result.roundBreakMinutesBefore).toEqual([0]);
    });

    it('does not insert a break for a Heavy game chained after a non-Heavy game', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 150, rawMaxPlaytime: 150, complexity: 'Heavy' }),
          makeGame({ id: 'light', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60, complexity: 'Light' }),
          makeGame({ id: 'heavy', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60, complexity: 'Heavy' }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 15, maxGameRepeats: 1 },
      );

      const heavy = result.assignments.find((a) => a.gameId === 'heavy')!;
      // No break inserted before it (light -> heavy isn't a Heavy-Heavy pair),
      // so it starts immediately after 'light' at minute 60.
      expect(heavy.startOffsetMinutes).toBe(60);
    });

    it('best-fits a filler onto the table with the tightest leftover rather than an empty table', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 100, rawMaxPlaytime: 100 }),
          // Opens table 2 with 70 min used, leaving 30 min leftover there.
          makeGame({ id: 'partial', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 70, rawMaxPlaytime: 70 }),
          // A 25-min game fits table 2's 30-min leftover (tighter fit) just as
          // well as the fully-empty table 3's 100-min leftover — best-fit
          // should prefer table 2, not spread out to the empty table 3.
          makeGame({ id: 'filler', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 25, rawMaxPlaytime: 25 }),
        ],
        3,
        600,
        NO_REFINEMENTS,
      );

      const partial = result.assignments.find((a) => a.gameId === 'partial')!;
      const filler = result.assignments.find((a) => a.gameId === 'filler')!;
      expect(filler.table).toBe(partial.table);
      expect(filler.slotIndex).toBe(1);
    });

    it('only applies opportunistic repeat-fill to the last slot in a chain', () => {
      const result = scheduleGames(
        [
          makeGame({ id: 'anchor', minPlayers: 1, seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 100, rawMaxPlaytime: 100 }),
          makeGame({ id: 'filler', minPlayers: 1, seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 60, rawMaxPlaytime: 60 }),
          // Short game chained after 'filler' — leftover after it is 100 - 60 - 15 = 25,
          // enough for one repeat (rawMaxPlaytime 10) but not more with maxGameRepeats capping it anyway.
          makeGame({ id: 'short', minPlayers: 1, seatedPlayers: ['p5', 'p6'], effectiveDurationMinutes: 15, rawMaxPlaytime: 10 }),
        ],
        2,
        600,
        { heavyGameBreakMinutes: 0, maxGameRepeats: 5 },
      );

      const filler = result.assignments.find((a) => a.gameId === 'filler')!;
      const short = result.assignments.find((a) => a.gameId === 'short')!;
      expect(filler.playCount).toBe(1); // not the last slot in its chain — no repeat-fill
      // leftover = 100 - (60 + 15) = 25; floor(25/10) = 2 extra plays -> playCount 3
      expect(short.playCount).toBe(3);
    });
  });

  describe('mayNotFinish flag (window overrun)', () => {
    it('flags every game in a round whose cumulative end runs past the window', () => {
      // Two rounds of 90 min each (no shared players -> two separate rounds
      // needed since table_count is 1), window is only 120 min: round 1 ends
      // at minute 90 (fits), round 2 ends at minute 180 (overruns).
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 90 }),
          makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'], effectiveDurationMinutes: 90 }),
        ],
        1,
        120,
        NO_REFINEMENTS,
      );
      const g1 = result.assignments.find((a) => a.gameId === 'g1')!;
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g1.round).toBe(1);
      expect(g1.mayNotFinish).toBe(false);
      expect(g2.round).toBe(2);
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

    it('accounts for inserted break minutes when deciding if a round overruns', () => {
      // Round 1: 60 min (ends at 60). Round 2: same table plays two Heavy
      // games back-to-back so a 30-min break is inserted before round 2,
      // pushing its end to 60 + 30 + 60 = 150 -- over a 140-min window even
      // though the raw game durations alone (120) would have fit.
      const result = scheduleGames(
        [
          makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60, complexity: 'Heavy' }),
          makeGame({ id: 'g2', seatedPlayers: ['p1', 'p2'], effectiveDurationMinutes: 60, complexity: 'Heavy' }),
        ],
        1,
        140,
        { heavyGameBreakMinutes: 30, maxGameRepeats: 1 },
      );
      const g2 = result.assignments.find((a) => a.gameId === 'g2')!;
      expect(g2.round).toBe(2);
      expect(g2.mayNotFinish).toBe(true);
    });
  });
});

describe('computeRoundClocks', () => {
  it('cumulatively sums round durations and inserted breaks from the event start', () => {
    const start = new Date('2026-01-01T18:00:00.000Z');
    const clocks = computeRoundClocks(
      { roundDurationsMinutes: [60, 90], roundBreakMinutesBefore: [0, 20] },
      start.toISOString(),
    );
    const startUnix = Math.floor(start.getTime() / 1000);
    expect(clocks).toEqual([
      { round: 1, startUnix, endUnix: startUnix + 3600 },
      { round: 2, startUnix: startUnix + 3600 + 1200, endUnix: startUnix + 3600 + 1200 + 5400 },
    ]);
  });

  it('returns an empty array for an empty schedule', () => {
    const clocks = computeRoundClocks(
      { roundDurationsMinutes: [], roundBreakMinutesBefore: [] },
      new Date().toISOString(),
    );
    expect(clocks).toEqual([]);
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
    { id: 'g1', title: 'Wingspan', seats: ['p1', 'p2'] },
    { id: 'g2', title: 'Catan', seats: ['p3', 'p4'] },
  ];
  const gn = { title: 'Game Night', startTimeISO: new Date('2026-01-01T18:00:00.000Z').toISOString() };

  it('lists each round with real clock times and its table assignments', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
        { gameId: 'g2', round: 1, table: 2, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [90],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 90,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields).toHaveLength(1);
    expect(data.fields![0].name).toContain('Round 1');
    expect(data.fields![0].name).toMatch(/<t:\d+:t>.*<t:\d+:t>/);
    expect(data.fields![0].value).toContain('Wingspan');
    expect(data.fields![0].value).toContain('Catan');
  });

  it('lists the greeters in their own field, ahead of the round fields, when the event has any', () => {
    const gnWithGreeters = { ...gn, greeters: ['u1', 'u2'] };
    const result = {
      assignments: [],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [],
      roundBreakMinutesBefore: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gnWithGreeters, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].name).toBe('👋 Greeters');
    expect(data.fields![0].value).toBe('<@u1> and <@u2>');
  });

  it('shows a single greeter without "and"', () => {
    const gnWithGreeter = { ...gn, greeters: ['u1'] };
    const result = {
      assignments: [],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [],
      roundBreakMinutesBefore: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gnWithGreeter, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).toBe('<@u1>');
  });

  it('omits the greeters field entirely when the event has none set', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 60,
      fitsInWindow: true,
    };
    const embedNoField = buildScheduleEmbed(gn, games, result);
    expect(embedNoField.toJSON().fields!.some((f) => f.name === '🙋 Greeters')).toBe(false);

    const embedEmptyArray = buildScheduleEmbed({ ...gn, greeters: [] }, games, result);
    expect(embedEmptyArray.toJSON().fields!.some((f) => f.name === '🙋 Greeters')).toBe(false);
  });

  it('notes the play count on the table line when a game repeats', () => {
    const result = {
      assignments: [{ gameId: 'g1', round: 1, table: 1, playCount: 3, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 }],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [90],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 90,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).toContain('Wingspan** (3x)');
  });

  it('omits the play-count suffix entirely when a game is only played once', () => {
    const result = {
      assignments: [{ gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 }],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 60,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).toBe('Table 1: **Wingspan** — <@p1>, <@p2>');
  });

  it('omits the player-mention dash entirely for a game with no seated players', () => {
    const gamesWithEmptySeats = [{ id: 'g1', title: 'Wingspan', seats: [] }];
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 60,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, gamesWithEmptySeats, result);
    const data = embed.toJSON();
    expect(data.fields![0].value).toBe('Table 1: **Wingspan**');
  });

  it('lists each slot of a chained table with its own start/end time, computed from the next slot', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
        { gameId: 'g2', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 1, startOffsetMinutes: 60 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [90],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 90,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const value = embed.toJSON().fields![0].value;
    const startUnix = Math.floor(new Date('2026-01-01T18:00:00.000Z').getTime() / 1000);
    expect(value).toBe(
      `Table 1: **Wingspan** (<t:${startUnix}:t>–<t:${startUnix + 3600}:t>) — <@p1>, <@p2>\n` +
        `Table 1: **Catan** (<t:${startUnix + 3600}:t>–<t:${startUnix + 5400}:t>) — <@p3>, <@p4>`,
    );
  });

  it('keeps the plain single-line form for a table with only one slot, even alongside a chained table', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
        { gameId: 'g2', round: 1, table: 2, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [90],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 90,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const value = embed.toJSON().fields![0].value;
    expect(value).toBe('Table 1: **Wingspan** — <@p1>, <@p2>\nTable 2: **Catan** — <@p3>, <@p4>');
  });

  it('shows a break note before a round that has an inserted break', () => {
    const result = {
      assignments: [{ gameId: 'g1', round: 2, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 }],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60, 60],
      roundBreakMinutesBefore: [0, 20],
      totalDurationMinutes: 140,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    const round2 = data.fields!.find((f) => f.name.startsWith('Round 2'))!;
    expect(round2.value).toContain('20-minute break beforehand');
  });

  it('shows a warning note on a round flagged as mayNotFinish, and omits it on others', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1, playCount: 1, mayNotFinish: false, slotIndex: 0, startOffsetMinutes: 0 },
        { gameId: 'g2', round: 2, table: 1, playCount: 1, mayNotFinish: true, slotIndex: 0, startOffsetMinutes: 0 },
      ],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60, 60],
      roundBreakMinutesBefore: [0, 0],
      totalDurationMinutes: 120,
      fitsInWindow: false,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    const round1 = data.fields!.find((f) => f.name.startsWith('Round 1'))!;
    const round2 = data.fields!.find((f) => f.name.startsWith('Round 2'))!;
    expect(round1.value).not.toContain('⚠️');
    expect(round2.value).toContain("⚠️ This round is projected to start and/or run past the event's end time");
  });

  it('lists low-interest games in their own section, distinct from Not scheduled', () => {
    const result = {
      assignments: [],
      unscheduled: [{ gameId: 'g2', reason: 'only 0/2 minimum players seated' }],
      lowInterest: [{ gameId: 'g1', reason: 'only 1 player interested — may not get played' }],
      roundDurationsMinutes: [],
      roundBreakMinutesBefore: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    const lowInterestField = data.fields!.find((f) => f.name === 'Needs more players');
    expect(lowInterestField?.value).toContain('Wingspan');
    expect(lowInterestField?.value).toContain('only 1 player interested');
    const unscheduledField = data.fields!.find((f) => f.name === 'Not scheduled');
    expect(unscheduledField?.value).toContain('Catan');
  });

  it('lists unscheduled games with their reason', () => {
    const result = {
      assignments: [],
      unscheduled: [{ gameId: 'g1', reason: 'only 1/3 minimum players seated' }],
      lowInterest: [],
      roundDurationsMinutes: [],
      roundBreakMinutesBefore: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed(gn, games, result);
    const data = embed.toJSON();
    const unscheduledField = data.fields!.find((f) => f.name === 'Not scheduled');
    expect(unscheduledField?.value).toContain('Wingspan');
    expect(unscheduledField?.value).toContain('only 1/3 minimum players seated');
  });

  it('flags in the footer when the schedule does not fit the window', () => {
    const result = {
      assignments: [],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [],
      roundBreakMinutesBefore: [],
      totalDurationMinutes: 300,
      fitsInWindow: false,
    };
    const embed = buildScheduleEmbed(gn, [], result);
    expect(embed.toJSON().footer?.text).toContain('may run past');
  });

  it('notes total break minutes in the footer only when a break was inserted', () => {
    const withBreak = buildScheduleEmbed(gn, [], {
      assignments: [],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60, 60],
      roundBreakMinutesBefore: [0, 20],
      totalDurationMinutes: 140,
      fitsInWindow: true,
    });
    expect(withBreak.toJSON().footer?.text).toContain('includes 20 min of breaks');

    const withoutBreak = buildScheduleEmbed(gn, [], {
      assignments: [],
      unscheduled: [],
      lowInterest: [],
      roundDurationsMinutes: [60],
      roundBreakMinutesBefore: [0],
      totalDurationMinutes: 60,
      fitsInWindow: true,
    });
    expect(withoutBreak.toJSON().footer?.text).not.toContain('includes');
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
    lightBufferMinutes: 20,
    mediumBufferMinutes: 30,
    heavyBufferMinutes: 40,
    postBgStatsLinks: false,
    heavyGameBreakMinutes: 0,
    maxGameRepeats: 1,
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

  it('sizes the table count from RSVPs instead of a too-low config default, so non-conflicting games all fit in round 1', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    // 13 RSVPs -> computeHeadcountTableFloor(13) = 3 (see the dedicated describe
    // block above), well above the configured default of 1.
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
    // All three non-conflicting games should land in round 1 across 3 tables —
    // with the flat config default of 1 table, two of them would have been
    // pushed to later rounds instead.
    expect(games.every((g) => g?.scheduledRound === 1)).toBe(true);
    expect(new Set(games.map((g) => g?.scheduledTable)).size).toBe(3);
  });

  it('persists scheduledRound/scheduledTable/scheduledPlayCount on each scheduled game', async () => {
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
    expect(game?.scheduledRound).toBe(1);
    expect(game?.scheduledTable).toBe(1);
    expect(game?.scheduledPlayCount).toBe(1);
    expect(game?.scheduledMayNotFinish).toBe(false);
  });

  it('persists a higher scheduledPlayCount for a short game repeated into leftover round time', async () => {
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

  it('inserts a break and shifts round 2 for both tables when one table has back-to-back Heavy games', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
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

    const embedCall = (client._channel.send as any).mock.calls[0][0];
    const embed = embedCall.embeds[0].toJSON();
    expect(embed.fields[1].name).toContain('Round 2');
    expect(embed.fields[1].value).toContain('15-minute break beforehand');
    expect(embed.footer.text).toContain('includes 15 min of breaks');
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
    expect(updatedGame?.scheduledRound).toBeUndefined();
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
