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
    getTopRankedGames: vi.fn(() => []),
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

// applyBGGDataToGameInfo's own merge semantics (force vs. fill-gaps-only,
// including the categories/mechanics/designers/publishers fields) are
// covered directly in libraryStorage.test.ts — mocked here as a spy so
// these tests verify orchestration only (which games get batched, and what
// each is handed off with), not the merge logic itself.
vi.mock('../src/utils/libraryStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/libraryStorage')>();
  return {
    ...actual,
    loadGameInfos: vi.fn(),
    applyBGGDataToGameInfo: vi.fn(async () => {}),
  };
});

import { handleSyncAll, handleBackfillTopRanked } from '../src/commands/library';
import { loadGameInfos, applyBGGDataToGameInfo, GameInfo } from '../src/utils/libraryStorage';
import { getBGGGamesBatch, BGGGame } from '../src/utils/bgg';
import { getTopRankedGames, BGGCatalogEntry } from '../src/utils/bggCatalog';

const mockLoadGameInfos = vi.mocked(loadGameInfos);
const mockApplyBGGDataToGameInfo = vi.mocked(applyBGGDataToGameInfo);
const mockGetBGGGamesBatch = vi.mocked(getBGGGamesBatch);
const mockGetTopRankedGames = vi.mocked(getTopRankedGames);

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

function makeCatalogEntry(overrides: Partial<BGGCatalogEntry> = {}): BGGCatalogEntry {
  return { id: '1', name: 'Catalog Game', year: 2020, isExpansion: false, rank: 1, ...overrides };
}

function makeBackfillInteraction(force: boolean | null, count: number | null = null) {
  return {
    options: {
      getBoolean: (name: string) => (name === 'force' ? force : null),
      getInteger: (name: string) => (name === 'count' ? count : null),
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
    expect(mockApplyBGGDataToGameInfo).toHaveBeenCalledTimes(2);
    // force=true is passed through so the already-enriched game gets overwritten
    const enrichedCall = mockApplyBGGDataToGameInfo.mock.calls.find((c) => c[0].objectid === '1')!;
    expect(enrichedCall[2]).toBe(true);
    expect(enrichedCall[1].tags).toEqual(['Strategy']);
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
    expect(mockApplyBGGDataToGameInfo).toHaveBeenCalledTimes(1);
    const call = mockApplyBGGDataToGameInfo.mock.calls[0];
    expect(call[0].objectid).toBe('2');
    expect(call[2]).toBe(false);
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
    expect(mockApplyBGGDataToGameInfo).not.toHaveBeenCalled();
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

  it('logs the batch ids and the actual error when a batch fails, instead of failing silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadGameInfos.mockResolvedValue([
      makeInfo({ objectid: '1', gameName: 'Game 1' }),
      makeInfo({ objectid: '2', gameName: 'Game 2' }),
    ]);
    mockGetBGGGamesBatch.mockRejectedValue(new Error('BGG returned 403 for https://boardgamegeek.com/xmlapi2/thing?id=1,2&stats=1'));

    const interaction = makeInteraction(null);
    await handleSyncAll(interaction);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('batch 1/1 (ids: 1,2) failed'),
      expect.any(Error),
    );
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('2** failed') }),
    );
    errorSpy.mockRestore();
  });

  // Regression: a ~1000-game sync outlasted Discord's 15-minute interaction
  // token, so the final followUp threw "Invalid Webhook Token" (50027) and the
  // admin never learned the sync had succeeded.
  it('delivers the completion result by DM when the sync outlasted the 15-minute interaction token', async () => {
    mockLoadGameInfos.mockResolvedValue([makeInfo({ objectid: '1', gameName: 'Game 1' })]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('1')]);

    const interaction = makeInteraction(null);
    interaction.createdTimestamp = Date.now() - 20 * 60 * 1000;
    interaction.user = { id: 'admin-1', send: vi.fn(async () => {}) };
    await handleSyncAll(interaction);

    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.user.send).toHaveBeenCalledWith(expect.stringContaining('Sync complete — **1** updated, **0** failed.'));
  });
});

describe('/admin library backfilltop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates fresh GameInfo entries for top-ranked games with no cache entry at all', async () => {
    mockGetTopRankedGames.mockReturnValue([
      makeCatalogEntry({ id: '1', name: 'Uncached Game', rank: 1 }),
    ]);
    mockLoadGameInfos.mockResolvedValue([]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('1')]);

    const interaction = makeBackfillInteraction(null);
    await handleBackfillTopRanked(interaction);

    expect(mockGetBGGGamesBatch).toHaveBeenCalledWith(['1'], 500);
    expect(mockApplyBGGDataToGameInfo).toHaveBeenCalledTimes(1);
    const call = mockApplyBGGDataToGameInfo.mock.calls[0];
    // no existing GameInfo for this id, so a fresh skeleton is built from the catalog entry
    expect(call[0]).toEqual(expect.objectContaining({ objectid: '1', gameName: 'Uncached Game' }));
    expect(call[1].tags).toEqual(['Strategy']);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Backfill complete') }),
    );
  });

  it('with no force option (default false), skips top-ranked games already fully cached', async () => {
    mockGetTopRankedGames.mockReturnValue([
      makeCatalogEntry({ id: '1', name: 'Cached Game', rank: 1 }),
      makeCatalogEntry({ id: '2', name: 'Uncached Game', rank: 2 }),
    ]);
    mockLoadGameInfos.mockResolvedValue([
      makeInfo({ objectid: '1', gameName: 'Cached Game', ...FULLY_ENRICHED }),
    ]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('2')]);

    const interaction = makeBackfillInteraction(null);
    await handleBackfillTopRanked(interaction);

    expect(mockGetBGGGamesBatch).toHaveBeenCalledWith(['2'], 500);
    expect(mockApplyBGGDataToGameInfo).toHaveBeenCalledTimes(1);
    expect(mockApplyBGGDataToGameInfo.mock.calls[0][0].objectid).toBe('2');
  });

  it('with force:true, re-fetches every top-ranked game even ones already fully cached', async () => {
    mockGetTopRankedGames.mockReturnValue([
      makeCatalogEntry({ id: '1', name: 'Cached Game', rank: 1 }),
    ]);
    mockLoadGameInfos.mockResolvedValue([
      makeInfo({ objectid: '1', gameName: 'Cached Game', ...FULLY_ENRICHED }),
    ]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('1')]);

    const interaction = makeBackfillInteraction(true);
    await handleBackfillTopRanked(interaction);

    expect(mockGetBGGGamesBatch).toHaveBeenCalledWith(['1'], 500);
    expect(mockApplyBGGDataToGameInfo).toHaveBeenCalledTimes(1);
    expect(mockApplyBGGDataToGameInfo.mock.calls[0][2]).toBe(true);
  });

  it('respects a smaller count option instead of defaulting to the full top 500', async () => {
    mockGetTopRankedGames.mockReturnValue([makeCatalogEntry({ id: '1', rank: 1 })]);
    mockLoadGameInfos.mockResolvedValue([]);
    mockGetBGGGamesBatch.mockResolvedValue([makeBGGGame('1')]);

    const interaction = makeBackfillInteraction(null, 10);
    await handleBackfillTopRanked(interaction);

    expect(mockGetTopRankedGames).toHaveBeenCalledWith(10);
  });

  it('when everything in the pool is already fully cached, replies without calling BGG at all', async () => {
    mockGetTopRankedGames.mockReturnValue([
      makeCatalogEntry({ id: '1', name: 'Cached Game', rank: 1 }),
    ]);
    mockLoadGameInfos.mockResolvedValue([
      makeInfo({ objectid: '1', gameName: 'Cached Game', ...FULLY_ENRICHED }),
    ]);

    const interaction = makeBackfillInteraction(null);
    await handleBackfillTopRanked(interaction);

    expect(mockGetBGGGamesBatch).not.toHaveBeenCalled();
    expect(mockApplyBGGDataToGameInfo).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('nothing to backfill') }),
    );
  });

  it('logs the batch ids and the actual error when a batch fails, instead of failing silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetTopRankedGames.mockReturnValue([makeCatalogEntry({ id: '1', rank: 1 })]);
    mockLoadGameInfos.mockResolvedValue([]);
    mockGetBGGGamesBatch.mockRejectedValue(new Error('BGG returned 403 for https://boardgamegeek.com/xmlapi2/thing?id=1&stats=1'));

    const interaction = makeBackfillInteraction(null);
    await handleBackfillTopRanked(interaction);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('batch 1/1 (ids: 1) failed'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
