import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetGuildConfig = vi.fn();
const mockGetGuildIdsWithConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
  getGuildIdsWithConfig: (...args: unknown[]) => mockGetGuildIdsWithConfig(...args),
}));

const mockGetActiveChallenge = vi.fn();
const mockCreateWeeklyChallenge = vi.fn();
const mockRecordHintPosted = vi.fn();
const mockRevealChallenge = vi.fn();
const mockGetRecentGameIds = vi.fn();
vi.mock('../src/utils/boardGameChallengeStorage', () => ({
  getActiveChallenge: (...args: unknown[]) => mockGetActiveChallenge(...args),
  createWeeklyChallenge: (...args: unknown[]) => mockCreateWeeklyChallenge(...args),
  recordHintPosted: (...args: unknown[]) => mockRecordHintPosted(...args),
  revealChallenge: (...args: unknown[]) => mockRevealChallenge(...args),
  getRecentGameIds: (...args: unknown[]) => mockGetRecentGameIds(...args),
  getLeaderboard: vi.fn(),
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

const mockNowInTimeZone = vi.fn();
vi.mock('../src/utils/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/timezone')>();
  return {
    ...actual,
    nowInTimeZone: (...args: unknown[]) => mockNowInTimeZone(...args),
    mondayOfWeekInTimeZone: () => '2026-08-24',
  };
});

import {
  generateClues,
  normalizeGuess,
  isCorrectGuess,
  selectWeeklyGame,
  checkAndAdvanceChallengeSchedule,
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
    tags: ['Worker Placement', 'Tile Placement', 'Area Control', 'Drafting'],
    howToPlayUrl: null,
    yearPublished: 2021,
    designers: ['Jane Doe'],
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
    correctGuesses: [],
    ...overrides,
  };
}

function makeClient() {
  const channel = { isTextBased: () => true, send: vi.fn(async () => ({ id: 'msg-1' })) };
  return { channels: { fetch: vi.fn(async () => channel) }, _channel: channel };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateClues', () => {
  it('never includes the game title', () => {
    const game = makeGame();
    const clues = generateClues(game);
    for (const clue of clues) {
      expect(clue.toLowerCase()).not.toContain(game.name.toLowerCase());
    }
  });

  it('includes player count, playtime, weight, and decade in hint 1', () => {
    const [clue1] = generateClues(makeGame());
    expect(clue1).toContain('2–4 players');
    expect(clue1).toContain('~30–45 min');
    expect(clue1).toContain('Medium');
    expect(clue1).toContain('2020s');
  });

  it('omits missing weight/year gracefully', () => {
    const [clue1] = generateClues(makeGame({ weight: null, yearPublished: null }));
    expect(clue1).not.toContain('null');
    expect(clue1).toContain('players');
  });

  it('shows up to 3 tags in hint 2 and the rest in hint 3', () => {
    const [, clue2, clue3] = generateClues(makeGame());
    expect(clue2).toContain('Worker Placement, Tile Placement, Area Control');
    expect(clue3).toContain('Drafting');
  });

  it('falls back to a placeholder when there are no tags', () => {
    const [, clue2] = generateClues(makeGame({ tags: [] }));
    expect(clue2).toMatch(/no standout/i);
  });

  it('includes designers and exact year in hint 3', () => {
    const [, , clue3] = generateClues(makeGame());
    expect(clue3).toContain('Jane Doe');
    expect(clue3).toContain('2021');
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
      ...overrides,
    };
  }

  it('does nothing when the feature is disabled', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeEnabled: false }));
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 9 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('does nothing when no channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ boardGameChallengeChannelId: null }));
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 9 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('creates a challenge and posts hint 1 on Monday morning when none is active', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 8 });
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

  it('does not create a second challenge before Monday 8am local time', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(undefined);
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 6 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });

  it('is idempotent — does not recreate a challenge that is already active on Monday', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 9 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('posts hint 2 on Wednesday once hint 1 is posted', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    mockNowInTimeZone.mockReturnValue({ weekday: 3, hour: 8 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 2, 'msg-1');
  });

  it('posts hint 3 on Friday once hint 2 is posted', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 2 }));
    mockNowInTimeZone.mockReturnValue({ weekday: 5, hour: 8 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRecordHintPosted).toHaveBeenCalledWith('guild-1', 'guild-1-2026-08-24', 3, 'msg-1');
  });

  it('does not post hint 2 early just because a challenge is active', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 1 }));
    mockNowInTimeZone.mockReturnValue({ weekday: 2, hour: 9 }); // Tuesday
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('reveals on Saturday evening once all hints are posted', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    const active = makeChallenge({ hintsPostedCount: 3 });
    mockGetActiveChallenge.mockResolvedValue(active);
    mockNowInTimeZone.mockReturnValue({ weekday: 6, hour: 18 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id);
  });

  it('does not reveal before Saturday evening', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    mockGetActiveChallenge.mockResolvedValue(makeChallenge({ hintsPostedCount: 3 }));
    mockNowInTimeZone.mockReturnValue({ weekday: 6, hour: 10 });
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockRevealChallenge).not.toHaveBeenCalled();
  });

  it('honors a per-guild override of the hint 1 day/hour instead of the Monday 8am default', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeClue1Weekday: 2, challengeClue1Hour: 14 })); // Tuesday 2pm
    mockGetActiveChallenge.mockResolvedValue(undefined);
    mockCreateWeeklyChallenge.mockResolvedValue(makeChallenge());
    const client = makeClient();

    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 9 }); // old default time — should NOT fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();

    mockNowInTimeZone.mockReturnValue({ weekday: 2, hour: 14 }); // configured time — should fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockCreateWeeklyChallenge).toHaveBeenCalled();
  });

  it('honors a per-guild override of the reveal day/hour instead of the Saturday 6pm default', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig({ challengeRevealWeekday: 0, challengeRevealHour: 12 })); // Sunday noon
    const active = makeChallenge({ hintsPostedCount: 3 });
    mockGetActiveChallenge.mockResolvedValue(active);
    const client = makeClient();

    mockNowInTimeZone.mockReturnValue({ weekday: 6, hour: 18 }); // old default time — should NOT fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockRevealChallenge).not.toHaveBeenCalled();

    mockNowInTimeZone.mockReturnValue({ weekday: 0, hour: 12 }); // configured time — should fire
    await checkAndAdvanceChallengeSchedule(client as any);
    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', active.id);
  });

  it('force-reveals a stale challenge instead of blocking forever, regardless of weekday', async () => {
    mockGetGuildConfig.mockResolvedValue(enabledConfig());
    const stale = makeChallenge({ weekStart: '2020-01-06', hintsPostedCount: 2 });
    mockGetActiveChallenge.mockResolvedValue(stale);
    mockNowInTimeZone.mockReturnValue({ weekday: 1, hour: 9 }); // Monday — would otherwise try to create a new one
    const client = makeClient();

    await checkAndAdvanceChallengeSchedule(client as any);

    expect(mockRevealChallenge).toHaveBeenCalledWith('guild-1', stale.id);
    expect(mockCreateWeeklyChallenge).not.toHaveBeenCalled();
  });
});
