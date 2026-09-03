import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createWeeklyChallenge,
  getActiveChallenge,
  getChallengesForGuild,
  getChallenge,
  recordHintPosted,
  recordCorrectGuess,
  revealChallenge,
  getRecentGameIds,
  getLeaderboard,
} from '../src/utils/boardGameChallengeStorage';

const BASE_CHALLENGE = {
  weekStart: '2026-08-24',
  bggId: '13',
  title: 'Catan',
  clues: ['clue1', 'clue2', 'clue3'] as [string, string, string],
  thumbnail: 'https://example.com/thumb.jpg',
  bggLink: 'https://boardgamegeek.com/boardgame/13',
  channelId: 'channel-1',
};

describe('boardGameChallengeStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createWeeklyChallenge', () => {
    it('creates a challenge with hintsPostedCount 0 and not revealed', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      expect(c.hintsPostedCount).toBe(0);
      expect(c.revealed).toBe(false);
      expect(c.correctGuesses).toHaveLength(0);
      expect(c.id).toBe('guild-1-2026-08-24');
    });

    it('scopes challenges per guild', async () => {
      await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      await createWeeklyChallenge('guild-2', BASE_CHALLENGE);
      expect(await getChallengesForGuild('guild-1')).toHaveLength(1);
      expect(await getChallengesForGuild('guild-2')).toHaveLength(1);
    });

    // Regression: a duplicate id (same guildId+weekStart) used to silently
    // corrupt every future by-id lookup — recordHintPosted/revealChallenge/
    // getChallenge all resolve to whichever matching record comes first,
    // permanently orphaning the other with no error surfaced anywhere. This
    // happened once in production (see checkAndAdvanceChallengeSchedule's
    // "already started this period" guard, the primary defense — this is
    // the backstop underneath it).
    it('refuses to create a second challenge with the same id (same guild + weekStart)', async () => {
      await createWeeklyChallenge('guild-1', BASE_CHALLENGE);

      await expect(createWeeklyChallenge('guild-1', BASE_CHALLENGE)).rejects.toThrow(/duplicate/i);

      // The original is untouched — still exactly one record, not overwritten or duplicated.
      const challenges = await getChallengesForGuild('guild-1');
      expect(challenges).toHaveLength(1);
    });

    it('does not consider a different weekStart or guild a duplicate', async () => {
      await createWeeklyChallenge('guild-1', BASE_CHALLENGE);

      await expect(
        createWeeklyChallenge('guild-1', { ...BASE_CHALLENGE, weekStart: '2026-08-31' }),
      ).resolves.toBeDefined();
      await expect(createWeeklyChallenge('guild-2', BASE_CHALLENGE)).resolves.toBeDefined();

      expect(await getChallengesForGuild('guild-1')).toHaveLength(2);
      expect(await getChallengesForGuild('guild-2')).toHaveLength(1);
    });
  });

  describe('getActiveChallenge', () => {
    it('returns undefined when no challenge exists', async () => {
      expect(await getActiveChallenge('guild-1')).toBeUndefined();
    });

    it('returns the non-revealed challenge', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const active = await getActiveChallenge('guild-1');
      expect(active?.id).toBe(c.id);
    });

    it('returns undefined once revealed', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      await revealChallenge('guild-1', c.id);
      expect(await getActiveChallenge('guild-1')).toBeUndefined();
    });
  });

  describe('recordHintPosted', () => {
    it('advances hintsPostedCount and appends the message id', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const updated = await recordHintPosted('guild-1', c.id, 1, 'msg-1');
      expect(updated?.hintsPostedCount).toBe(1);
      expect(updated?.hintMessageIds).toEqual(['msg-1']);

      const updated2 = await recordHintPosted('guild-1', c.id, 2, 'msg-2');
      expect(updated2?.hintsPostedCount).toBe(2);
      expect(updated2?.hintMessageIds).toEqual(['msg-1', 'msg-2']);
    });

    it('returns undefined for a missing challenge', async () => {
      expect(await recordHintPosted('guild-1', 'nope', 1, 'msg-1')).toBeUndefined();
    });
  });

  describe('recordCorrectGuess', () => {
    it('awards points by hint stage and updates the leaderboard', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const result = await recordCorrectGuess('guild-1', c.id, 'user-1', 1);
      expect(result).toEqual({ points: 100, totalPoints: 100 });

      const stored = await getChallenge('guild-1', c.id);
      expect(stored?.correctGuesses).toEqual([
        expect.objectContaining({ userId: 'user-1', points: 100, hintStage: 1 }),
      ]);

      const leaderboard = await getLeaderboard('guild-1');
      expect(leaderboard).toEqual([{ userId: 'user-1', points: 100 }]);
    });

    it('is idempotent — a user cannot double-score the same challenge', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      await recordCorrectGuess('guild-1', c.id, 'user-1', 1);
      const second = await recordCorrectGuess('guild-1', c.id, 'user-1', 2);
      expect(second).toBeUndefined();

      const leaderboard = await getLeaderboard('guild-1');
      expect(leaderboard).toEqual([{ userId: 'user-1', points: 100 }]);
    });

    it('accumulates points across multiple challenges', async () => {
      const c1 = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      await recordCorrectGuess('guild-1', c1.id, 'user-1', 1);

      const c2 = await createWeeklyChallenge('guild-1', { ...BASE_CHALLENGE, weekStart: '2026-08-31' });
      const result = await recordCorrectGuess('guild-1', c2.id, 'user-1', 3);

      expect(result).toEqual({ points: 50, totalPoints: 150 });
    });

    it('scopes leaderboard totals per guild', async () => {
      const c1 = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const c2 = await createWeeklyChallenge('guild-2', BASE_CHALLENGE);
      await recordCorrectGuess('guild-1', c1.id, 'user-1', 1);
      await recordCorrectGuess('guild-2', c2.id, 'user-1', 3);

      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-1', points: 100 }]);
      expect(await getLeaderboard('guild-2')).toEqual([{ userId: 'user-1', points: 50 }]);
    });
  });

  describe('revealChallenge', () => {
    it('marks the challenge revealed', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const revealed = await revealChallenge('guild-1', c.id);
      expect(revealed?.revealed).toBe(true);
    });

    it('stores the reveal message id when given one — used later to clean up old posts', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const revealed = await revealChallenge('guild-1', c.id, 'reveal-msg-1');
      expect(revealed?.revealMessageId).toBe('reveal-msg-1');
    });

    it('leaves revealMessageId null when no message id is given (e.g. the channel was unavailable)', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      const revealed = await revealChallenge('guild-1', c.id);
      expect(revealed?.revealMessageId).toBeNull();
    });
  });

  describe('getRecentGameIds', () => {
    it('includes games within the window and excludes older ones', async () => {
      await createWeeklyChallenge('guild-1', { ...BASE_CHALLENGE, bggId: 'recent', weekStart: '2026-08-24' });
      await createWeeklyChallenge('guild-1', {
        ...BASE_CHALLENGE,
        bggId: 'ancient',
        weekStart: '2020-01-06',
      });

      const recent = await getRecentGameIds('guild-1', 52);
      expect(recent.has('recent')).toBe(true);
      expect(recent.has('ancient')).toBe(false);
    });
  });

  describe('getLeaderboard', () => {
    it('sorts by points descending', async () => {
      const c = await createWeeklyChallenge('guild-1', BASE_CHALLENGE);
      await recordCorrectGuess('guild-1', c.id, 'user-1', 3); // 50
      const c2 = await createWeeklyChallenge('guild-1', { ...BASE_CHALLENGE, weekStart: '2026-08-31' });
      await recordCorrectGuess('guild-1', c2.id, 'user-2', 1); // 100

      const leaderboard = await getLeaderboard('guild-1');
      expect(leaderboard.map((e) => e.userId)).toEqual(['user-2', 'user-1']);
    });
  });
});
