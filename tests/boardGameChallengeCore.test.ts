import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetGuildConfig = vi.fn();
const mockGetGuildIdsWithConfig = vi.fn();
const mockUpdateGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
  getGuildIdsWithConfig: (...args: unknown[]) => mockGetGuildIdsWithConfig(...args),
  updateGuildConfig: (...args: unknown[]) => mockUpdateGuildConfig(...args),
}));

const mockGetActiveChallenge = vi.fn();
const mockGetChallengesForGuild = vi.fn();
const mockCreateWeeklyChallenge = vi.fn();
const mockRecordHintPosted = vi.fn();
const mockRevealChallenge = vi.fn();
const mockGetRecentGameIds = vi.fn();
const mockGetLeaderboard = vi.fn();
const mockUpdateChallengeChannel = vi.fn();
vi.mock('../src/utils/boardGameChallengeStorage', () => ({
  getActiveChallenge: (...args: unknown[]) => mockGetActiveChallenge(...args),
  getChallengesForGuild: (...args: unknown[]) => mockGetChallengesForGuild(...args),
  createWeeklyChallenge: (...args: unknown[]) => mockCreateWeeklyChallenge(...args),
  recordHintPosted: (...args: unknown[]) => mockRecordHintPosted(...args),
  revealChallenge: (...args: unknown[]) => mockRevealChallenge(...args),
  getRecentGameIds: (...args: unknown[]) => mockGetRecentGameIds(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  updateChallengeChannel: (...args: unknown[]) => mockUpdateChallengeChannel(...args),
}));

const mockGetBGGGame = vi.fn();
vi.mock('../src/utils/bgg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bgg')>();
  return { ...actual, getBGGGame: (...args: unknown[]) => mockGetBGGGame(...args) };
});

const mockGetTopRankedGames = vi.fn();
vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return { ...actual, getTopRankedGames: (...args: unknown[]) => mockGetTopRankedGames(...args) };
});

vi.mock('../src/utils/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/timezone')>();
  return {
    ...actual,
    // zonedTimeToUtc is left as the real implementation (via ...actual) since
    // checkAndAdvanceChallengeSchedule now drives every decision off real
    // Date.now()/fake-timer instants rather than a mocked weekday/hour pair.
    mondayOfWeekInTimeZone: () => '2026-08-24',
  };
});

import {
  generateClues,
  normalizeGuess,
  isCorrectGuess,
  selectWeeklyGame,
  checkAndAdvanceChallengeSchedule,
  postHint,
  postReveal,
  updateChallengeLeaderboardPin,
} from '../src/utils/boardGameChallenge';
import { BGGGame } from '../src/utils/bgg';
import { WeeklyChallenge } from '../src/utils/boardGameChallengeStorage';

function makeGame(overrides: Partial<BGGGame> = {}): BGGGame {
  return {
    id: '13',
    name: 'Zephyr Fortune',
    bggLink: 'https://boardgamegeek.com/boardgame/13',
    minPlayers: 2,
    maxPlayers: 4,
    suggestedPlayers: 3,
    minPlaytime: 30,
    maxPlaytime: 45,
    weight: 2.5,
    thumbnail: 'https://example.com/thumb.jpg',
    expansions: [],
    tags: ['Worker Placement', 'Tile Placement', 'Strategy', 'Economic'],
    categories: ['Strategy', 'Economic'],
    mechanics: ['Worker Placement', 'Tile Placement'],
    howToPlayUrl: null,
    yearPublished: 2021,
    designers: ['Jane Doe'],
    publishers: ['Acme Games'],
    ...overrides,
  };
}

function makeChallenge(overrides: Partial<WeeklyChallenge> = {}): WeeklyChallenge {
  return {
    id: 'guild-1-2026-08-24',
    guildId: 'guild-1',
    weekStart: '2026-08-24',
    bggId: '13',
    title: 'Zephyr Fortune',
    clues: ['clue1', 'clue2', 'clue3'],
    thumbnail: 'https://example.com/thumb.jpg',
    bggLink: 'https://boardgamegeek.com/boardgame/13',
    hintsPostedCount: 0,
    hintMessageIds: [],
    channelId: 'channel-1',
    revealed: false,
    revealMessageId: null,
    correctGuesses: [],
    ...overrides,
  };
}

function makeClient() {
  const channel = {
    isTextBased: () => true,
    send: vi.fn(async () => ({ id: 'msg-1', pin: vi.fn(async () => {}) })),
    messages: {
      fetchPinned: vi.fn(async () => new Map()),
      delete: vi.fn(async () => {}),
      fetch: vi.fn(async () => { throw new Error('unknown message'); }),
    },
  };
  return { user: { id: 'bot-1' }, channels: { fetch: vi.fn(async () => channel) }, _channel: channel };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLeaderboard.mockResolvedValue([]);
});

describe('generateClues', () => {
  it('never includes the game title', () => {
    const game = makeGame();
    const clues = generateClues(game);
    for (const clue of clues) {
      expect(clue.toLowerCase()).not.toContain(game.name.toLowerCase());
    }
  });

  it('hint 1 covers player count, duration, and genre (category) — nothing more specific', () => {
    const [clue1] = generateClues(makeGame());
    expect(clue1).toContain('2–4 players');
    expect(clue1).toContain('~30–45 min');
    expect(clue1).toContain('Strategy/Economic genre');
    expect(clue1).not.toContain('Worker Placement'); // mechanic — belongs in hint 2, not hint 1
    expect(clue1).not.toContain('Medium'); // weight — belongs in hint 2, not hint 1
    expect(clue1).not.toContain('2021'); // year — belongs in hint 3, not hint 1
  });

  it('hint 1 still shows player count/duration when there are no categories on file', () => {
    const [clue1] = generateClues(makeGame({ categories: [] }));
    expect(clue1).not.toContain('null');
    expect(clue1).toContain('2–4 players');
    expect(clue1).toContain('~30–45 min');
  });

  it('hint 2 covers mechanics, weight/complexity, and best player count', () => {
    const [, clue2] = generateClues(makeGame());
    expect(clue2).toContain('Mechanics: Worker Placement, Tile Placement');
    expect(clue2).toContain('Medium weight/complexity');
    expect(clue2).toContain('Best with 3 players');
    expect(clue2).not.toContain('Strategy'); // category — belongs in hint 1, not hint 2
  });

  it('hint 2 still shows a best-player-count fact when mechanics/weight are missing', () => {
    const [, clue2] = generateClues(makeGame({ mechanics: [], weight: null }));
    expect(clue2).not.toContain('null');
    expect(clue2).toBe('Best with 3 players');
  });

  it('hint 2 uses singular "player" for a 1-player best count', () => {
    const [, clue2] = generateClues(makeGame({ suggestedPlayers: 1 }));
    expect(clue2).toContain('Best with 1 player');
    expect(clue2).not.toContain('1 players');
  });

  it('hint 3 covers year released, designer(s), and publisher', () => {
    const [, , clue3] = generateClues(makeGame());
    expect(clue3).toContain('Released in 2021');
    expect(clue3).toContain('Designed by Jane Doe');
    expect(clue3).toContain('Published by Acme Games');
  });

  it('hint 3 only shows the first publisher when several are on file', () => {
    const [, , clue3] = generateClues(makeGame({ publishers: ['Acme Games', 'Regional Reprint Co'] }));
    expect(clue3).toContain('Published by Acme Games');
    expect(clue3).not.toContain('Regional Reprint Co');
  });

  it('falls back to a placeholder when hint 3 has no year/designer/publisher at all', () => {
    const [, , clue3] = generateClues(makeGame({ yearPublished: null, designers: [], publishers: [] }));
    expect(clue3).toMatch(/that's all the data/i);
  });
});

describe('normalizeGuess', () => {
  it.each([
    ['Catan', 'catan'],
    ['CATAN', 'catan'],
    ['The Catan', 'catan'],
    ['A Catan', 'catan'],
    ["Terraforming Mars: Ares Expedition", 'terraforming mars'],
    ['Brass: Birmingham', 'brass'],
    ['  Wingspan!  ', 'wingspan'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeGuess(input)).toBe(expected);
  });
});

describe('isCorrectGuess', () => {
  it('matches an exact (case/punctuation-insensitive) guess', () => {
    expect(isCorrectGuess('catan', 'Catan')).toBe(true);
    expect(isCorrectGuess('THE CATAN', 'Catan')).toBe(true);
  });

  it('tolerates a small typo', () => {
    expect(isCorrectGuess('Wingspam', 'Wingspan')).toBe(true);
    expect(isCorrectGuess('Teraforming Mars', 'Terraforming Mars')).toBe(true);
  });

  it('rejects an unrelated title', () => {
    expect(isCorrectGuess('Chess', 'Catan')).toBe(false);
    expect(isCorrectGuess('Terraforming Venus', 'Terraforming Mars')).toBe(false);
  });

  it('rejects an empty guess', () => {
    expect(isCorrectGuess('', 'Catan')).toBe(false);
    expect(isCorrectGuess('the', 'Catan')).toBe(false);
  });
});

describe('selectWeeklyGame', () => {
  it('excludes recently played games from the pool', async () => {
    mockGetTopRankedGames.mockReturnValue([
      { id: '1', name: 'Recent Game', year: 2020, isExpansion: false, rank: 1 },
      { id: '2', name: 'Fresh Game', year: 2020, isExpansion: false, rank: 2 },
    ]);
    mockGetRecentGameIds.mockResolvedValue(new Set(['1']));
    mockGetBGGGame.mockResolvedValue(makeGame({ id: '2', name: 'Fresh Game' }));

    const game = await selectWeeklyGame('guild-1');
    expect(mockGetBGGGame).toHaveBeenCalledWith('2');
    expect(game?.id).toBe('2');
  });

  it('falls back to the full pool when every game has been played recently', async () => {
    mockGetTopRankedGames.mockReturnValue([
      { id: '1', name: 'Only Game', year: 2020, isExpansion: false, rank: 1 },
    ]);
    mockGetRecentGameIds.mockResolvedValue(new Set(['1']));
    mockGetBGGGame.mockResolvedValue(makeGame({ id: '1', name: 'Only Game' }));

    const game = await selectWeeklyGame('guild-1');
    expect(game?.id).toBe('1');
  });

  it('returns undefined when the catalog pool is empty', async () => {
    mockGetTopRankedGames.mockReturnValue([]);
    mockGetRecentGameIds.mockResolvedValue(new Set());

    expect(await selectWeeklyGame('guild-1')).toBeUndefined();
    expect(mockGetBGGGame).not.toHaveBeenCalled();
  });
});

describe('checkAndAdvanceChallengeSchedule', () => {
  beforeEach(() => {
    mockGetGuildIdsWithConfig.mockResolvedValue(['guild-1']);
    mockGetTopRankedGames.mockReturnValue([
      { id: '13', name: 'Zephyr Fortune', year: 2021, isExpansion: false, rank: 1 },
    ]);
    mockGetRecentGameIds.mockResolvedValue(new Set());
    mockGetBGGGame.mockResolvedValue(makeGame());
    mockGetChallengesForGuild.mockResolvedValue([]);
    // The "force-reveal a stale challenge" safety net (checkAndAdvanceChallengeSchedule
    // in boardGameChallenge.ts) compares the real wall clock against
    // makeChallenge()'s hardcoded weekStart ('2026-08-24'), not the mocked
    // nowInTimeZone() the rest of these tests drive — pin the clock so that
    // comparison stays under the 7-day staleness threshold regardless of
    // when the suite actually runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function enabledConfig(overrides: Record<string, unknown> = {}) {
    return {
      boardGameChallengeEnabled: true,
      boardGameChallengeChannelId: 'channel-1',
      timezone: 'UTC',
      challengeClue1Weekday: 1,
      challengeClue1Hour: 8,
      challengeClue2Weekday: 3,
      challengeClue2Hour: 8,
      challengeClue3Weekday: 5,
      challengeClue3Hour: 8,
      challengeRevealWeekday: 6,
      challengeRevealHour: 18,
      challengeFrequency: 'weekly' as const,
      challengeCycleAnchor: null as string | null,
      challengeCleanupOldPosts: false,
      ...overrides,
    };
  }

  it('does nothing when the feature is disabled', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeEnabled: false }));
    vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // Monday 9am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('does nothing when no channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeChannelId: null }));
    vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // Monday 9am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('creates a challenge and posts hint 1 on Monday morning when none is active', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-24T08:00:00Z')); // Monday 8am
    mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({ weekStart: '2026-08-24', bggId: '13' }),
    );
    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 1, 'msg-1');
  });

  describe('cleaning up the previous cycle\'s posts when a new one starts (challengeCleanupOldPosts)', () => {
    it('deletes the previous challenge\'s hint + reveal messages when the setting is enabled', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeCleanupOldPosts: true }));
      mockGetActiveChallenge.mockResolvedValue(undefined);
      mockGetChallengesForGuild.mockResolvedValue([
        makeChallenge({
          weekStart: '2026-08-17',
          revealed: true,
          hintMessageIds: ['hint-1', 'hint-2', 'hint-3'],
          revealMessageId: 'reveal-1',
        }),
      ]);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z')); // Monday 8am
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.messages.delete).toHaveBeenCalledTimes(4);
      expect(client._channel.messages.delete).toHaveBeenCalledWith('hint-1');
      expect(client._channel.messages.delete).toHaveBeenCalledWith('hint-2');
      expect(client._channel.messages.delete).toHaveBeenCalledWith('hint-3');
      expect(client._channel.messages.delete).toHaveBeenCalledWith('reveal-1');
      expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
    });

    it('does not delete anything when the setting is off (the default)', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig());
      mockGetActiveChallenge.mockResolvedValue(undefined);
      mockGetChallengesForGuild.mockResolvedValue([
        makeChallenge({ weekStart: '2026-08-17', revealed: true, hintMessageIds: ['hint-1'], revealMessageId: 'reveal-1' }),
      ]);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.messages.delete).not.toHaveBeenCalled();
    });

    it('does nothing when there is no previous revealed challenge to clean up', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeCleanupOldPosts: true }));
      mockGetActiveChallenge.mockResolvedValue(undefined);
      mockGetChallengesForGuild.mockResolvedValue([]);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.messages.delete).not.toHaveBeenCalled();
      expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
    });

    it('still starts the new challenge even if deleting an old message fails (best-effort, logged and swallowed)', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeCleanupOldPosts: true }));
      mockGetActiveChallenge.mockResolvedValue(undefined);
      mockGetChallengesForGuild.mockResolvedValue([
        makeChallenge({ weekStart: '2026-08-17', revealed: true, hintMessageIds: ['hint-1'], revealMessageId: 'reveal-1' }),
      ]);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();
      client._channel.messages.delete.mockRejectedValue(new Error('Unknown Message'));
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(checkAndAdvanceChallengeSchedule(client as any)).resolves.not.toThrow();

      expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete old post'),
        expect.any(Error),
      );
      consoleWarnSpy.mockRestore();
    });
  });

  it('logs and moves on, without crashing, if the storage layer\'s duplicate-id guard is ever tripped', async () => {
    // Belt-and-suspenders: this scheduler-level "already started this period"
    // check is the primary defense, but if it were ever bypassed,
    // createWeeklyChallenge itself refuses duplicates and throws — confirm
    // that surfaces as a caught, logged error rather than an unhandled
    // rejection that could take down the whole per-guild loop.
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
    mockCreateWeeklyChallenge.mockRejectedValue(new Error('Refusing to create a duplicate challenge guild-1-2026-08-24'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    await expect(checkAndAdvanceChallengeSchedule(client as any)).resolves.not.toThrow();

    expect(client._channel.send).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Schedule check failed for guild guild-1'),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  it('does not start a second challenge later the same day when reveal shares hint 1\'s weekday (same-day schedule)', async () => {
    // Regression: a schedule where every stage falls on Monday (e.g. 8am/10am/12pm/5pm)
    // used to restart the whole cycle the moment the 5pm reveal fired, because
    // "no active challenge + past hint 1's hour" was true again all evening.
    mockGetGuildConfig.mockResolvedValue(
      enabledConfig({ challengeClue2Weekday: 1, challengeClue3Weekday: 1, challengeRevealWeekday: 1 }),
    );
    mockGetActiveChallenge.mockResolvedValue(undefined); // just revealed earlier today
    mockGetChallengesForGuild.mockResolvedValue([makeChallenge({ hintsPostedCount: 3, revealed: true })]);
    vi.setSystemTime(new Date('2026-08-24T19:00:00Z')); // Monday evening — well past every hour gate
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('still starts a new challenge this week even if an older week\'s challenge exists in history', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    mockGetChallengesForGuild.mockResolvedValue([makeChallenge({ weekStart: '2020-01-06', revealed: true })]);
    vi.setSystemTime(new Date('2026-08-24T08:00:00Z')); // Monday 8am
    mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
  });

  it('does not create a second challenge before Monday 8am local time', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-24T06:00:00Z')); // Monday 6am — before hint 1's hour
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('does not retroactively start a new challenge hours after hint 1\'s moment has passed — waits for the next occurrence instead', async () => {
    // Starting a brand-new cycle is deliberately NOT "catch up whenever" the
    // way an already-running cycle's later stages are — if the moment's
    // already well past (bot was off, data got reset, an admin just
    // reconfigured mid-afternoon, etc.), members expect it to wait for the
    // next real occurrence rather than suddenly posting right now.
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-24T21:00:00Z')); // Monday 9pm — 13 hours after hint 1's 8am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('still starts a new challenge within a short grace window right after hint 1\'s moment (absorbs the hourly check\'s own timing jitter)', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-24T08:45:00Z')); // Monday 8:45am — 45 minutes late, well within the window
    mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
  });

  it('is idempotent — does not recreate a challenge that is already active on Monday', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // Monday 9am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('posts hint 2 on Wednesday once hint 1 is posted', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    vi.setSystemTime(new Date('2026-08-26T08:00:00Z')); // Wednesday 8am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 2, 'msg-1');
  });

  it('posts hint 3 on Friday once hint 2 is posted', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 2 }));
    vi.setSystemTime(new Date('2026-08-28T08:00:00Z')); // Friday 8am
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 3, 'msg-1');
  });

  it('does not post hint 2 early just because a challenge is active', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    vi.setSystemTime(new Date('2026-08-25T09:00:00Z')); // Tuesday — before hint 2's Wednesday
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('reveals on Saturday evening once all hints are posted, then posts and pins the leaderboard', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    const active = makeChallenge({ hintsPostedCount: 3 });
    mockGetActiveChallenge.mockResolvedValue(active);
    vi.setSystemTime(new Date('2026-08-29T18:00:00Z')); // Saturday 6pm
    mockGetLeaderboard.mockResolvedValue([{ userId: 'user-1', points: 100 }]);
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    // Reveal embed, then the leaderboard post
    expect(client._channel.send).toHaveBeenCalledTimes(2);
    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id, 'msg-1');
    expect(mockGetLeaderboard).toHaveBeenCalledWith('guild-1');
    const leaderboardMessage = await client._channel.send.mock.results[1].value;
    expect(leaderboardMessage.pin).toHaveBeenCalled();
  });

  it('does not reveal before Saturday evening', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 3 }));
    vi.setSystemTime(new Date('2026-08-29T10:00:00Z')); // Saturday 10am — before the 6pm reveal hour
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockRevealChallenge).not.toHaveBeenCalled();
  });

  it('honors a per-guild override of the hint 1 day/hour instead of the Monday 8am default', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeClue1Weekday: 2, challengeClue1Hour: 14 })); // Tuesday 2pm
    mockGetActiveChallenge.mockResolvedValue(undefined);
    mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
    const client = makeClient();

    vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // old default time (Monday 9am) — should NOT fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-08-25T14:00:00Z')); // configured time (Tuesday 2pm) — should fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
  });

  it('honors a per-guild override of the reveal day/hour instead of the Saturday 6pm default', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeRevealWeekday: 0, challengeRevealHour: 12 })); // Sunday noon
    const active = makeChallenge({ hintsPostedCount: 3 });
    mockGetActiveChallenge.mockResolvedValue(active);
    const client = makeClient();

    vi.setSystemTime(new Date('2026-08-29T18:00:00Z')); // old default time (Saturday 6pm) — should NOT fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockRevealChallenge).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-08-30T12:00:00Z')); // configured time (Sunday noon) — should fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id, 'msg-1');
  });

  it('force-reveals a stale challenge instead of blocking forever, regardless of weekday', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    const stale = makeChallenge({ weekStart: '2020-01-06', hintsPostedCount: 2 });
    mockGetActiveChallenge.mockResolvedValue(stale);
    vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // Monday — would otherwise try to create a new one
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', stale.id, 'msg-1');
    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  // Regression: the staleness threshold used to read `weekStart` as UTC
  // midnight (plain `new Date(weekStart)`) instead of midnight in the
  // guild's own timezone. Every other test in this file uses timezone:
  // 'UTC', where that bug is invisible (UTC midnight *is* local midnight) —
  // these use a real zone behind UTC to actually exercise it. In daily mode
  // (a 24h period) a multi-hour timezone offset is a large fraction of the
  // period, so this fired hours before a true full day had passed, forcing
  // a reveal before hint 2/3 ever got a chance to catch up.
  describe('the staleness threshold accounts for the guild\'s own timezone (not UTC midnight)', () => {
    it('does not force-reveal a daily challenge before a true full local day has passed, for a zone behind UTC', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'daily', timezone: 'America/New_York' }),
      );
      // weekStart "2026-08-24" at America/New_York midnight is 2026-08-24T04:00:00Z.
      // The old (buggy) UTC-midnight reading would treat this challenge as already
      // stale by 2026-08-25T00:00:00Z — 4 hours before a true local day has passed.
      const active = makeChallenge({ weekStart: '2026-08-24', hintsPostedCount: 1 });
      mockGetActiveChallenge.mockResolvedValue(active);
      vi.setSystemTime(new Date('2026-08-24T23:00:00Z')); // 7pm ET — within the true local day, past the old buggy threshold
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).not.toHaveBeenCalled();
    });

    it('does force-reveal once a true full local day has actually passed, for a zone behind UTC', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'daily', timezone: 'America/New_York' }),
      );
      const stale = makeChallenge({ weekStart: '2026-08-24', hintsPostedCount: 1 });
      mockGetActiveChallenge.mockResolvedValue(stale);
      vi.setSystemTime(new Date('2026-08-25T05:00:00Z')); // 1am ET the next day — a true full local day has now passed
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', stale.id, 'msg-1');
    });
  });

  describe('retrying a stuck hint 1 (channel unavailable at creation time)', () => {
    // Regression: startNewChallenge creates the WeeklyChallenge record first,
    // then calls postHint — if the channel it was created against turns out
    // to be unresolvable at that moment, postHint just logs a warning and
    // returns, leaving hintsPostedCount stuck at 0 forever with nothing ever
    // retrying it (the hint-2/3/reveal branches all require a specific
    // hintsPostedCount that never arrives). /challenge status then shows a
    // blank hint section and a broken channel mention forever, even after
    // the admin reconfigures a working channel — because postHint always
    // uses the channel stored on the challenge, not the live config.
    it('retries hint 1 on the same configured channel when it still matches', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeChannelId: 'channel-1' }));
      const stuck = makeChallenge({ hintsPostedCount: 0, channelId: 'channel-1' });
      mockGetActiveChallenge.mockResolvedValue(stuck);
      vi.setSystemTime(new Date('2026-08-24T09:00:00Z')); // Monday 9am — past hint 1's 8am
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.send).toHaveBeenCalledTimes(1);
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', stuck.id, 1, 'msg-1');
      expect(mockUpdateChallengeChannel).not.toHaveBeenCalled();
    });

    it('re-points the stuck challenge at the currently configured channel when it has since changed', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeChannelId: 'channel-new' }));
      const stuck = makeChallenge({ hintsPostedCount: 0, channelId: 'channel-old' });
      mockGetActiveChallenge.mockResolvedValue(stuck);
      mockUpdateChallengeChannel.mockResolvedValue({ ...stuck, channelId: 'channel-new' });
      vi.setSystemTime(new Date('2026-08-24T09:00:00Z'));
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockUpdateChallengeChannel).toHaveBeenCalledWith('guild-1', stuck.id, 'channel-new');
      // postHint fetches whatever channel id it's handed — confirm it was handed the new one.
      expect(client.channels.fetch).toHaveBeenCalledWith('channel-new');
      expect(client._channel.send).toHaveBeenCalledTimes(1);
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', stuck.id, 1, 'msg-1');
    });

    it('does not retry hint 1 before its scheduled hour', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig());
      const stuck = makeChallenge({ hintsPostedCount: 0 });
      mockGetActiveChallenge.mockResolvedValue(stuck);
      vi.setSystemTime(new Date('2026-08-24T06:00:00Z')); // Monday 6am — before hint 1's 8am
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.send).not.toHaveBeenCalled();
    });
  });

  describe('catching up after a multi-day outage (bot down across an entire scheduled hint day)', () => {
    it('still posts hint 2 once the bot is back, even though its exact scheduled day (Wednesday) was missed entirely', async () => {
      // Previously required *today* to exactly equal hint 2's configured
      // weekday, so an outage spanning all of Wednesday meant hint 2 (and
      // hint 3 right after it) would never post at all, even though the
      // challenge isn't stale enough yet to hit the 7-day force-reveal net.
      mockGetGuildConfig.mockResolvedValue(enabledConfig());
      mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
      vi.setSystemTime(new Date('2026-08-28T09:00:00Z')); // Friday — hint 2 was due Wednesday 8am
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(client._channel.send).toHaveBeenCalledTimes(1);
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 2, 'msg-1');
    });

    it('still posts hint 3 once the bot is back, even past hint 3\'s own original day', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig());
      mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 2 }));
      vi.setSystemTime(new Date('2026-08-29T09:00:00Z')); // Saturday morning — hint 3 was due Friday 8am
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 3, 'msg-1');
    });

    it('fully self-heals over consecutive ticks after hint 2 was missed — advances one stage per tick without skipping any', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig());
      const challenge = makeChallenge({ hintsPostedCount: 1 });
      mockGetActiveChallenge.mockResolvedValue(challenge);
      // As if the bot were down the entire rest of the week and only just
      // came back — every remaining stage's moment (hint 2, hint 3, reveal)
      // has already passed by now.
      vi.setSystemTime(new Date('2026-08-30T00:00:00Z')); // Sunday
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any); // tick 1: catches up hint 2 only
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 2, 'msg-1');
      expect(mockRevealChallenge).not.toHaveBeenCalled();

      mockGetActiveChallenge.mockResolvedValue({ ...challenge, hintsPostedCount: 2 });
      await checkAndAdvanceChallengeSchedule(client as any); // tick 2: catches up hint 3 only
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 3, 'msg-1');
      expect(mockRevealChallenge).not.toHaveBeenCalled();

      mockGetActiveChallenge.mockResolvedValue({ ...challenge, hintsPostedCount: 3 });
      await checkAndAdvanceChallengeSchedule(client as any); // tick 3: finally reveals
      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', challenge.id, 'msg-1');
    });
  });

  describe('daily frequency', () => {
    // todayInTimeZone is the real implementation here (not mocked, unlike
    // mondayOfWeekInTimeZone), so daily-mode tests can freely vary the fake
    // system clock to represent "today".
    it('creates a challenge and posts hint 1 today, on any weekday, ignoring the *Weekday config entirely', async () => {
      const config = enabledConfig({
        challengeFrequency: 'daily',
        challengeClue1Weekday: 5, // Friday — deliberately mismatched vs. the actual day below, to prove it's ignored
        challengeClue1Hour: 8,
      });
      mockGetGuildConfig.mockResolvedValue(config);
      mockGetActiveChallenge.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-08-25T08:00:00Z')); // a Tuesday, 8am
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge({ weekStart: '2026-08-25' }));
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).toHaveBeenCalledWith(
        'guild-1',
        expect.objectContaining({ weekStart: '2026-08-25' }),
      );
    });

    it('does not retroactively start today\'s challenge hours after hint 1\'s hour has passed — waits for tomorrow instead', async () => {
      // The exact bug reported live: data got reset with frequency still set
      // to 'daily' and hint 1 at 8am; the next check ran well into the
      // evening and immediately posted a "today" challenge hours late,
      // instead of waiting for the next real 8am.
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeFrequency: 'daily', challengeClue1Hour: 8 }));
      mockGetActiveChallenge.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-08-25T21:00:00Z')); // Tuesday 9pm — 13 hours after 8am
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    });

    it('posts hint 2, hint 3, and the reveal on the same calendar day, at their configured hours', async () => {
      const config = enabledConfig({
        challengeFrequency: 'daily',
        challengeClue2Hour: 12,
        challengeClue3Hour: 16,
        challengeRevealHour: 20,
      });
      mockGetGuildConfig.mockResolvedValue(config);
      const client = makeClient();

      mockGetActiveChallenge.mockResolvedValue(makeChallenge({ weekStart: '2026-08-25', hintsPostedCount: 1 }));
      vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
      await checkAndAdvanceChallengeSchedule(client as any);
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 2, 'msg-1');

      mockGetActiveChallenge.mockResolvedValue(makeChallenge({ weekStart: '2026-08-25', hintsPostedCount: 2 }));
      vi.setSystemTime(new Date('2026-08-25T16:00:00Z'));
      await checkAndAdvanceChallengeSchedule(client as any);
      expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 3, 'msg-1');

      const active = makeChallenge({ weekStart: '2026-08-25', hintsPostedCount: 3 });
      mockGetActiveChallenge.mockResolvedValue(active);
      vi.setSystemTime(new Date('2026-08-25T20:00:00Z'));
      await checkAndAdvanceChallengeSchedule(client as any);
      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id, 'msg-1');
    });

    it('does not start a second daily challenge later the same day right after a reveal', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeFrequency: 'daily' }));
      mockGetActiveChallenge.mockResolvedValue(undefined); // just revealed earlier today
      mockGetChallengesForGuild.mockResolvedValue([makeChallenge({ weekStart: '2026-08-25', hintsPostedCount: 3, revealed: true })]);
      vi.setSystemTime(new Date('2026-08-25T22:00:00Z'));
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    });

    it('force-reveals a daily challenge stuck for over a day, instead of waiting a full week', async () => {
      mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeFrequency: 'daily' }));
      const stale = makeChallenge({ weekStart: '2026-08-23', hintsPostedCount: 1 }); // ~1.4 days before the mocked "now" (Aug 24, 9am)
      mockGetActiveChallenge.mockResolvedValue(stale);
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', stale.id, 'msg-1');
    });
  });

  describe('bi-weekly frequency', () => {
    // mondayOfWeekInTimeZone is mocked to always return '2026-08-24' ("this
    // week"), so these tests vary the anchor (not the system clock) to move
    // "today" between a bi-weekly cycle's on/off weeks.

    it('starts a new challenge on an "on" week (anchor lines up with this week)', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-24' }),
      );
      mockGetActiveChallenge.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).toHaveBeenCalledWith(
        'guild-1',
        expect.objectContaining({ weekStart: '2026-08-24' }),
      );
    });

    it('also treats a week two full cycles after the anchor as an "on" week', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-10' }), // 14 days before "this week"
      );
      mockGetActiveChallenge.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).toHaveBeenCalledWith(
        'guild-1',
        expect.objectContaining({ weekStart: '2026-08-24' }),
      );
    });

    it('does not start a new challenge on an "off" week — the in-between week of the 14-day cycle', async () => {
      // Anchor puts the *previous* week (Aug 17) as the on-week, making "this
      // week" (Aug 24, mocked) the idle in-between week.
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-17' }),
      );
      mockGetActiveChallenge.mockResolvedValue(undefined);
      mockGetChallengesForGuild.mockResolvedValue([
        makeChallenge({ weekStart: '2026-08-17', hintsPostedCount: 3, revealed: true }),
      ]);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    });

    it('does not start anything if the configured anchor is still in the future', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-09-07' }),
      );
      mockGetActiveChallenge.mockResolvedValue(undefined);
      vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    });

    it('reveals an already-running bi-weekly challenge using its own weekday/hour schedule, same as weekly', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-17' }),
      );
      const active = makeChallenge({ weekStart: '2026-08-17', hintsPostedCount: 3 });
      mockGetActiveChallenge.mockResolvedValue(active);
      vi.setSystemTime(new Date('2026-08-22T18:00:00Z')); // Saturday of the Aug 17 on-week, reveal hour
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id, 'msg-1');
    });

    it('force-reveals a bi-weekly challenge only after a full 14 days, not 7', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-24' }),
      );
      // ~10 days before the mocked "now" (Aug 24, 9am) — past weekly's 7-day
      // threshold, but still under bi-weekly's 14-day one.
      const stillWithinWindow = makeChallenge({ weekStart: '2026-08-14', hintsPostedCount: 2 });
      mockGetActiveChallenge.mockResolvedValue(stillWithinWindow);
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).not.toHaveBeenCalled();
    });

    it('does eventually force-reveal a bi-weekly challenge once past the full 14 days', async () => {
      mockGetGuildConfig.mockResolvedValue(
        enabledConfig({ challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-08-24' }),
      );
      const stale = makeChallenge({ weekStart: '2026-08-09', hintsPostedCount: 2 }); // ~15 days before "now"
      mockGetActiveChallenge.mockResolvedValue(stale);
      const client = makeClient();

      await checkAndAdvanceChallengeSchedule(client as any);

      expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', stale.id, 'msg-1');
    });
  });
});

describe('postHint', () => {
  it('includes a "How to play" field on hint 1 only', async () => {
    const client = makeClient();
    await postHint(client as any, makeChallenge(), 1);
    const embed1 = client._channel.send.mock.calls[0][0].embeds[0];
    expect(embed1.data.fields?.some((f: { name: string }) => f.name === 'How to play')).toBe(true);

    client._channel.send.mockClear();
    await postHint(client as any, makeChallenge({ hintsPostedCount: 1 }), 2);
    const embed2 = client._channel.send.mock.calls[0][0].embeds[0];
    expect(embed2.data.fields?.some((f: { name: string }) => f.name === 'How to play')).toBeFalsy();
  });

  it('hint 1 shows only hint 1, labeled', async () => {
    const client = makeClient();
    await postHint(client as any, makeChallenge(), 1);
    const embed = client._channel.send.mock.calls[0][0].embeds[0];
    expect(embed.data.description).toBe('**Hint 1:** clue1');
  });

  it('hint 2 also shows hint 1, so nobody has to scroll back to find it', async () => {
    const client = makeClient();
    await postHint(client as any, makeChallenge({ hintsPostedCount: 1 }), 2);
    const embed = client._channel.send.mock.calls[0][0].embeds[0];
    expect(embed.data.description).toBe('**Hint 1:** clue1\n\n**Hint 2:** clue2');
  });

  it('hint 3 shows all three hints cumulatively', async () => {
    const client = makeClient();
    await postHint(client as any, makeChallenge({ hintsPostedCount: 2 }), 3);
    const embed = client._channel.send.mock.calls[0][0].embeds[0];
    expect(embed.data.description).toBe('**Hint 1:** clue1\n\n**Hint 2:** clue2\n\n**Hint 3:** clue3');
  });
});

describe('postReveal / leaderboard pin', () => {
  it('posts the leaderboard after the reveal and pins it', async () => {
    mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: 'channel-1' });
    mockGetLeaderboard.mockResolvedValue([{ userId: 'user-1', points: 100 }]);
    const client = makeClient();

    await postReveal(client as any, makeChallenge({ hintsPostedCount: 3 }));

    expect(client._channel.send).toHaveBeenCalledTimes(2);
    const leaderboardEmbed = client._channel.send.mock.calls[1][0].embeds[0];
    expect(leaderboardEmbed.data.title).toContain('Leaderboard');
    const leaderboardMessage = await client._channel.send.mock.results[1].value;
    expect(leaderboardMessage.pin).toHaveBeenCalled();
  });

  it('unpins the bot\'s previous leaderboard pin before pinning the new one, leaving other pins alone', async () => {
    mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: 'channel-1' });
    mockGetLeaderboard.mockResolvedValue([]);
    const client = makeClient();
    const botPin = { author: { id: 'bot-1' }, unpin: vi.fn(async () => {}) };
    const otherPin = { author: { id: 'user-1' }, unpin: vi.fn(async () => {}) };
    client._channel.messages.fetchPinned.mockResolvedValue(
      new Map([
        ['msg-a', botPin],
        ['msg-b', otherPin],
      ]),
    );

    await postReveal(client as any, makeChallenge({ hintsPostedCount: 3 }));

    expect(botPin.unpin).toHaveBeenCalled();
    expect(otherPin.unpin).not.toHaveBeenCalled();
  });

  it('does not let a leaderboard post/pin failure block the reveal itself', async () => {
    mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: 'channel-1' });
    mockGetLeaderboard.mockRejectedValue(new Error('storage down'));
    const client = makeClient();

    await expect(postReveal(client as any, makeChallenge({ hintsPostedCount: 3 }))).resolves.not.toThrow();
    expect(mockRevealChallenge).toHaveBeenCalled();
  });
});

describe('updateChallengeLeaderboardPin', () => {
  it('edits the existing pinned message in place instead of posting a new one', async () => {
    mockGetGuildConfig.mockResolvedValue({
      boardGameChallengeChannelId: 'channel-1',
      challengeLeaderboardPinMessageId: 'pin-msg-1',
    });
    mockGetLeaderboard.mockResolvedValue([{ userId: 'user-1', points: 100 }]);
    const client = makeClient();
    const existing = { pinned: true, edit: vi.fn(async (payload: unknown) => ({ ...existing, ...(payload as object) })) };
    client._channel.messages.fetch.mockResolvedValue(existing);

    await updateChallengeLeaderboardPin(client as any, 'guild-1');

    expect(client._channel.messages.fetch).toHaveBeenCalledWith('pin-msg-1');
    expect(existing.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('pins the existing message if it was somehow unpinned', async () => {
    mockGetGuildConfig.mockResolvedValue({
      boardGameChallengeChannelId: 'channel-1',
      challengeLeaderboardPinMessageId: 'pin-msg-1',
    });
    mockGetLeaderboard.mockResolvedValue([]);
    const client = makeClient();
    const pin = vi.fn(async () => {});
    const existing = { pinned: false, pin, edit: vi.fn(async () => ({ pinned: false, pin })) };
    client._channel.messages.fetch.mockResolvedValue(existing);

    await updateChallengeLeaderboardPin(client as any, 'guild-1');

    expect(pin).toHaveBeenCalled();
  });

  it('falls back to posting and pinning a fresh message when the stored message id is stale (deleted)', async () => {
    mockGetGuildConfig.mockResolvedValue({
      boardGameChallengeChannelId: 'channel-1',
      challengeLeaderboardPinMessageId: 'deleted-msg',
    });
    mockGetLeaderboard.mockResolvedValue([]);
    const client = makeClient();
    client._channel.messages.fetch.mockRejectedValue(new Error('Unknown Message'));

    await updateChallengeLeaderboardPin(client as any, 'guild-1');

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    const posted = await client._channel.send.mock.results[0].value;
    expect(posted.pin).toHaveBeenCalled();
    expect(mockUpdateGuildConfig).toHaveBeenCalledWith('guild-1', { challengeLeaderboardPinMessageId: 'msg-1' });
  });

  it('posts and pins a fresh message when no pin message id has ever been recorded (first correct guess of a fresh setup)', async () => {
    mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: 'channel-1' });
    mockGetLeaderboard.mockResolvedValue([{ userId: 'user-1', points: 100 }]);
    const client = makeClient();

    await updateChallengeLeaderboardPin(client as any, 'guild-1');

    expect(client._channel.messages.fetch).not.toHaveBeenCalled();
    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockUpdateGuildConfig).toHaveBeenCalledWith('guild-1', { challengeLeaderboardPinMessageId: 'msg-1' });
  });

  it('does nothing when the challenge channel is not configured', async () => {
    mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: null });
    const client = makeClient();

    await updateChallengeLeaderboardPin(client as any, 'guild-1');

    expect(client._channel.send).not.toHaveBeenCalled();
    expect(mockGetLeaderboard).not.toHaveBeenCalled();
  });

  it('is best-effort — swallows any failure rather than throwing', async () => {
    mockGetGuildConfig.mockRejectedValue(new Error('storage down'));
    const client = makeClient();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(updateChallengeLeaderboardPin(client as any, 'guild-1')).resolves.not.toThrow();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update leaderboard pin'),
      expect.any(Error),
    );
    consoleWarnSpy.mockRestore();
  });
});
