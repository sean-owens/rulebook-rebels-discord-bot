import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  searchCatalog,
  searchCatalogWithFallback,
  addCatalogEntry,
  isCatalogLoaded,
  normalizeName,
  getCatalogEntryById,
  _loadFromCsvText,
  _resetCatalog,
} from '../src/utils/bggCatalog';

vi.mock('../src/utils/bgg', () => ({
  searchBGG: vi.fn(),
}));
vi.mock('../src/utils/db', () => ({
  readJson: vi.fn(async (_: string, fallback: unknown) => fallback),
  writeJson: vi.fn(async () => {}),
}));

import { searchBGG } from '../src/utils/bgg';
import { writeJson } from '../src/utils/db';

const TEST_CSV = `id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion,abstracts_rank
224517,"Brass: Birmingham",2018,1,8.39,8.56,58991,0,
266192,Wingspan,2019,5,8.01,8.10,80000,0,
13,Catan,1995,100,6.89,7.20,120000,0,
174430,Gloomhaven,2017,4,8.29,8.53,67317,0,
342942,"Ark Nova",2021,2,8.35,8.53,61610,0,
266192001,"Wingspan: European Expansion",2019,,,,5000,1,
999,"Pandemic Legacy: Season 1",2015,3,8.34,8.50,57510,0,
888,"Arkham Horror: The Card Game",2016,20,7.89,8.10,40000,0,
777,"Arkham Horror",2005,150,6.90,7.30,25000,0,`;

describe('normalizeName', () => {
  it('lowercases and strips special characters', () => {
    expect(normalizeName('Brass: Birmingham')).toBe('brass birmingham');
    expect(normalizeName("Wonderland's War")).toBe('wonderlands war');
    expect(normalizeName('Ticket to Ride: Europe')).toBe('ticket to ride europe');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeName('Foo  Bar')).toBe('foo bar');
    expect(normalizeName('  Wingspan  ')).toBe('wingspan');
  });

  it('keeps numbers', () => {
    expect(normalizeName('Pandemic Legacy: Season 1')).toBe('pandemic legacy season 1');
  });
});

describe('searchCatalog', () => {
  beforeEach(() => {
    _resetCatalog();
    _loadFromCsvText(TEST_CSV);
  });

  it('returns empty array when catalog not loaded', () => {
    _resetCatalog();
    expect(searchCatalog('Wingspan')).toEqual([]);
    expect(isCatalogLoaded()).toBe(false);
  });

  it('finds exact match by canonical name', () => {
    const results = searchCatalog('Wingspan');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Wingspan');
    expect(results[0].id).toBe('266192');
    expect(results[0].year).toBe(2019);
    expect(results[0].isExpansion).toBe(false);
  });

  it('matches when user input normalizes to same string as catalog name', () => {
    const results = searchCatalog('brass birmingham');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Brass: Birmingham');
    expect(results[0].id).toBe('224517');
  });

  it('matches colon-separated names with spaces in input', () => {
    const results = searchCatalog('pandemic legacy season 1');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Pandemic Legacy: Season 1');
  });

  it('finds results via token intersection when no exact match', () => {
    const results = searchCatalog('arkham', 5);
    const names = results.map((r) => r.name);
    expect(names).toContain('Arkham Horror');
    expect(names).toContain('Arkham Horror: The Card Game');
  });

  it('sorts base games before expansions', () => {
    const results = searchCatalog('wingspan', 5);
    const base = results.find((r) => r.name === 'Wingspan');
    const expansion = results.find((r) => r.name === 'Wingspan: European Expansion');
    if (base && expansion) {
      expect(results.indexOf(base)).toBeLessThan(results.indexOf(expansion));
    }
    // At least the base game must appear first
    expect(results[0].isExpansion).toBe(false);
  });

  it('sorts by rank within the same expansion status', () => {
    const results = searchCatalog('arkham', 5);
    const baseGames = results.filter((r) => !r.isExpansion);
    // Arkham Horror: The Card Game (rank 20) should come before Arkham Horror (rank 150)
    const cardGame = baseGames.findIndex((r) => r.name === 'Arkham Horror: The Card Game');
    const original = baseGames.findIndex((r) => r.name === 'Arkham Horror');
    expect(cardGame).toBeLessThan(original);
  });

  it('respects the limit parameter', () => {
    const results = searchCatalog('arkham', 1);
    expect(results).toHaveLength(1);
  });

  it('returns empty array for query with no match', () => {
    expect(searchCatalog('xyzzy no match here')).toEqual([]);
  });

  it('returns empty array for empty query', () => {
    expect(searchCatalog('')).toEqual([]);
    expect(searchCatalog('   ')).toEqual([]);
  });

  it('marks expansions correctly', () => {
    const results = searchCatalog('wingspan european expansion', 5);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Wingspan: European Expansion');
    expect(results[0].isExpansion).toBe(true);
  });

  it('returns rank for ranked games and null for unranked', () => {
    const results = searchCatalog('Brass: Birmingham');
    expect(results[0].rank).toBe(1);

    const expResults = searchCatalog('wingspan european expansion');
    const exp = expResults.find((r) => r.isExpansion);
    expect(exp?.rank).toBeNull();
  });
});

describe('getCatalogEntryById', () => {
  beforeEach(() => {
    _resetCatalog();
    _loadFromCsvText(TEST_CSV);
  });

  it('finds an entry by its exact BGG id, regardless of name collisions', () => {
    const entry = getCatalogEntryById('174430');
    expect(entry?.name).toBe('Gloomhaven');
  });

  it('returns undefined for an id not in the catalog', () => {
    expect(getCatalogEntryById('999999999')).toBeUndefined();
  });

  it('returns undefined when the catalog is not loaded', () => {
    _resetCatalog();
    expect(getCatalogEntryById('174430')).toBeUndefined();
  });
});

describe('addCatalogEntry', () => {
  beforeEach(() => {
    _resetCatalog();
    _loadFromCsvText(TEST_CSV);
  });

  it('makes a new entry findable by exact name', () => {
    addCatalogEntry({ id: '111', name: 'Brand New Game', year: 2026, isExpansion: false, rank: null });
    const results = searchCatalog('Brand New Game');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('111');
  });

  it('does not duplicate an entry for an id that already exists', () => {
    const before = searchCatalog('wingspan', 10).length;
    addCatalogEntry({ id: '266192', name: 'Wingspan', year: 2019, isExpansion: false, rank: 5 });
    expect(searchCatalog('wingspan', 10)).toHaveLength(before);
  });

  it('keeps prefix search correct after inserting a word that sorts before every existing word', () => {
    addCatalogEntry({ id: '222', name: 'Aardvark Adventures', year: 2026, isExpansion: false, rank: null });
    expect(searchCatalog('Aardvark Adventures')).toHaveLength(1);
    expect(searchCatalog('Wingspan')[0]?.name).toBe('Wingspan');
  });

  it('keeps prefix search correct after inserting a word that sorts after every existing word', () => {
    addCatalogEntry({ id: '333', name: 'Zzztop Party Game', year: 2026, isExpansion: false, rank: null });
    expect(searchCatalog('Zzztop Party Game')).toHaveLength(1);
    expect(searchCatalog('Catan')[0]?.name).toBe('Catan');
  });
});

describe('searchCatalogWithFallback', () => {
  beforeEach(() => {
    _resetCatalog();
    _loadFromCsvText(TEST_CSV);
    vi.clearAllMocks();
  });

  it('returns the local match without calling searchBGG', async () => {
    const results = await searchCatalogWithFallback('Wingspan');
    expect(results).toHaveLength(1);
    expect(searchBGG).not.toHaveBeenCalled();
  });

  it('falls back to a live search and merges a hit into the catalog when the local search misses', async () => {
    vi.mocked(searchBGG).mockResolvedValue([{ id: '555', name: 'Brand New 2026 Game', yearPublished: 2026 }]);

    const results = await searchCatalogWithFallback('Brand New 2026 Game');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('555');
    expect(searchBGG).toHaveBeenCalledWith('Brand New 2026 Game');

    // Merged into the in-memory catalog so the next lookup is served locally
    expect(searchCatalog('Brand New 2026 Game')).toHaveLength(1);

    // Persisted (fire-and-forget) so it survives a restart
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalled());
  });

  it('returns an empty array when both local and live search miss', async () => {
    vi.mocked(searchBGG).mockResolvedValue([]);
    const results = await searchCatalogWithFallback('Totally Unknown Game Xyzzy');
    expect(results).toEqual([]);
  });

  it('returns an empty array without throwing when the live search fails', async () => {
    vi.mocked(searchBGG).mockRejectedValue(new Error('BGG unreachable'));
    const results = await searchCatalogWithFallback('Totally Unknown Game Xyzzy');
    expect(results).toEqual([]);
  });
});
