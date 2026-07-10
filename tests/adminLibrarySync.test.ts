import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  getBGGGamesBatch: vi.fn(),
  weightTag: vi.fn((w: number) => (w <= 2 ? 'Light' : w <= 3.5 ? 'Medium' : 'Heavy')),
  fetchBggOwnedCollection: vi.fn(() => null),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return {
    ...actual,
    searchCatalog: vi.fn(() => []),
    isCatalogLoaded: vi.fn(() => true),
  };
});

vi.mock('../src/utils/bggAccountStorage', () => ({
  getBggAccount: vi.fn(() => null),
}));

vi.mock('../src/utils/userCollectionStorage', () => ({
  mergeUserCollection: vi.fn(),
  getUserCollection: vi.fn(() => []),
  setUserCollection: vi.fn(),
  updateCollectionEntry: vi.fn(),
}));

vi.mock('../src/utils/storage', () => ({
  loadGameNights: vi.fn(() => []),
  findGameNight: vi.fn(() => null),
  upsertGameNight: vi.fn(),
}));

vi.mock('../src/utils/gameRoles', () => ({
  getGameRoles: vi.fn(() => []),
}));

vi.mock('../src/utils/requestPin', () => ({
  updateRequestPin: vi.fn(),
}));

vi.mock('../src/utils/pins', () => ({
  upsertLibraryPin: vi.fn(),
}));

vi.mock('../src/utils/libraryStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/libraryStorage')>();
  return {
    ...actual,
    loadGameInfos: vi.fn(),
    upsertGameInfo: vi.fn(async () => {}),
  };
});

import { handleSyncAll } from '../src/commands/library';
import { loadGameInfos, upsertGameInfo, GameInfo } from '../src/utils/libraryStorage';
import { getBGGGamesBatch, BGGGame } from '../src/utils/bgg';

const mockLoadGameInfos = vi.mocked(loadGameInfos);
const mockUpsertGameInfo = vi.mocked(upsertGameInfo);
const mockGetBGGGamesBatch = vi.mocked(getBGGGamesBatch);

function makeInfo(overrides: Partial<GameInfo>): GameInfo {
  return {
    gameName: 'Game',
    objectid: '1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const FULLY_ENRICHED: Partial<GameInfo> = {
  tags: ['Euro'],
  bggExpansions: [],
  bestPlayers: 4,
  complexity: 'Medium',
  howToPlayUrl: null,
  thumbnail: null,
};

function makeBGGGame(id: string, overrides: Partial<BGGGame> = {}): BGGGame {
  return {
    id,
    name: `BGG Game ${id}`,
    bggLink: `https://boardgamegeek.com/boardgame/${id}`,
    minPlayers: 2,
    maxPlayers: 4,
    suggestedPlayers: 3,
    minPlaytime: 30,
    maxPlaytime: 60,
    weight: 2.5,
    thumbnail: 'https://example.com/thumb.png',
    expansions: [],
    tags: ['Strategy'],
    howToPlayUrl: 'https://example.com/video',
    ...overrides,
  };
}

function makeInteraction(force: boolean | null) {
  return {
    options: {
      getBoolean: (name: string) => (name === 'force' ? force : null),
    },
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
  } as any;
}

describe('/admin library syncall — force option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('with no force option (default true), re-syncs every game with a BGG ID, overwriting existing data', async () => {
    const enriched = makeInfo({ objectid: '1', gameName: 'Enriched Game', ...FULLY_ENRICHED });
    const unenriched = makeInfo({ objectid: '2', gameName: 'Unenriched Game' });
    mockLoadGameInfos.mockResolvedValue([enriched, unenriched]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('1'), makeBGGGame('2')]);

    const interaction = makeInteraction(null);
    await handleSyncAll(interaction);

    expect(mockGetBGGGamesBatch).toHaveBeenCalledWith(['1', '2'], 500);
    expect(mockUpsertGameInfo).toHaveBeenCalledTimes(2);
    // force=true overwrites the already-enriched game's tags with BGG's data
    const enrichedCall = mockUpsertGameInfo.mock.calls.find((c) => c[0].objectid === '1')![0];
    expect(enrichedCall.tags).toEqual(['Strategy']);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Sync complete') }),
    );
  });

  it('with force:false, only fetches games missing BGG data and does not overwrite existing fields', async () => {
    const enriched = makeInfo({ objectid: '1', gameName: 'Enriched Game', ...FULLY_ENRICHED });
    const unenriched = makeInfo({ objectid: '2', gameName: 'Unenriched Game' });
    mockLoadGameInfos.mockResolvedValue([enriched, unenriched]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('2')]);

    const interaction = makeInteraction(false);
    await handleSyncAll(interaction);

    // only the unenriched game's id should ever be sent to BGG
    expect(mockGetBGGGamesBatch).toHaveBeenCalledWith(['2'], 500);
    expect(mockUpsertGameInfo).toHaveBeenCalledTimes(1);
    const call = mockUpsertGameInfo.mock.calls[0][0];
    expect(call.objectid).toBe('2');
    expect(call.tags).toEqual(['Strategy']);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Enrich complete') }),
    );
  });

  it('with force:false and nothing missing BGG data, replies without calling BGG at all', async () => {
    const enriched = makeInfo({ objectid: '1', gameName: 'Enriched Game', ...FULLY_ENRICHED });
    mockLoadGameInfos.mockResolvedValue([enriched]);

    const interaction = makeInteraction(false);
    await handleSyncAll(interaction);

    expect(mockGetBGGGamesBatch).not.toHaveBeenCalled();
    expect(mockUpsertGameInfo).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('nothing to enrich') }),
    );
  });

  it('with no games having a BGG ID at all, replies with the sync-nothing message regardless of force', async () => {
    mockLoadGameInfos.mockResolvedValue([makeInfo({ objectid: undefined })]);

    const interaction = makeInteraction(null);
    await handleSyncAll(interaction);

    expect(mockGetBGGGamesBatch).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('nothing to sync') }),
    );
  });
});
