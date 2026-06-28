import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getUserCollection,
  setUserCollection,
  mergeUserCollection,
  updateCollectionEntry,
  UserCollectionEntry,
} from '../src/utils/userCollectionStorage';

vi.spyOn(process, 'cwd').mockReturnValue(import.meta.dirname);

function makeEntry(
  bggGameId: string,
  gameName: string,
  overrides: Partial<UserCollectionEntry> = {},
): UserCollectionEntry {
  return {
    bggGameId,
    gameName,
    bggOwn: true,
    bggForTrade: false,
    bggWantToPlay: false,
    bggWishlisted: false,
    bggUserRating: null,
    bggNumPlays: 0,
    bggSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('getUserCollection', () => {
  it('returns empty array for unknown guild/user', () => {
    expect(getUserCollection('g1', 'u1')).toEqual([]);
  });
});

describe('setUserCollection / getUserCollection', () => {
  it('stores and retrieves entries', () => {
    const entries = [makeEntry('123', 'Wingspan'), makeEntry('456', 'Gloomhaven')];
    setUserCollection('g1', 'u1', entries);
    expect(getUserCollection('g1', 'u1')).toHaveLength(2);
    expect(getUserCollection('g1', 'u1')[0].gameName).toBe('Wingspan');
  });

  it('isolates by guild', () => {
    setUserCollection('gA', 'u1', [makeEntry('1', 'Game A')]);
    setUserCollection('gB', 'u1', [makeEntry('2', 'Game B')]);
    expect(getUserCollection('gA', 'u1')[0].gameName).toBe('Game A');
    expect(getUserCollection('gB', 'u1')[0].gameName).toBe('Game B');
  });

  it('isolates by user', () => {
    setUserCollection('g1', 'uA', [makeEntry('1', 'Game A')]);
    setUserCollection('g1', 'uB', [makeEntry('2', 'Game B')]);
    expect(getUserCollection('g1', 'uA')[0].gameName).toBe('Game A');
    expect(getUserCollection('g1', 'uB')[0].gameName).toBe('Game B');
  });
});

describe('mergeUserCollection', () => {
  it('adds new entries from incoming sync', () => {
    setUserCollection('g1', 'u1', []);
    mergeUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan')]);
    expect(getUserCollection('g1', 'u1')).toHaveLength(1);
  });

  it('preserves bot-tracked fields on re-sync', () => {
    setUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan', { traded: true })]);
    mergeUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan', { bggForTrade: true })]);
    const result = getUserCollection('g1', 'u1')[0];
    expect(result.traded).toBe(true);
    expect(result.bggForTrade).toBe(true);
  });

  it('overwrites BGG-sourced fields on re-sync', () => {
    setUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan', { bggNumPlays: 3 })]);
    mergeUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan', { bggNumPlays: 7 })]);
    expect(getUserCollection('g1', 'u1')[0].bggNumPlays).toBe(7);
  });
});

describe('updateCollectionEntry', () => {
  it('updates bot-tracked fields by bggGameId', () => {
    setUserCollection('g1', 'u1', [makeEntry('123', 'Wingspan')]);
    const result = updateCollectionEntry('g1', 'u1', '123', { sold: true });
    expect(result).toBe(true);
    expect(getUserCollection('g1', 'u1')[0].sold).toBe(true);
  });

  it('returns false for unknown game', () => {
    setUserCollection('g1', 'u1', []);
    expect(updateCollectionEntry('g1', 'u1', '999', { traded: true })).toBe(false);
  });

  it('returns false for unknown user', () => {
    expect(updateCollectionEntry('g1', 'nobody', '123', { traded: true })).toBe(false);
  });
});
