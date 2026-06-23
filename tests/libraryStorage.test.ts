import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addGame,
  removeGame,
  findGamesByName,
  findGameNamesByPartial,
  getGamesByUser,
  clearUserLibrary,
  loadLibrary,
  addRequest,
  getRequestsForEvent,
  removeRequests,
  removeAllRequestsForEvent,
  updateRequestCopies,
  getGameInfo,
  upsertGameInfo,
} from '../src/utils/libraryStorage';

describe('libraryStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── addGame ────────────────────────────────────────────────────────────────

  describe('addGame', () => {
    it('adds a new game and returns "added"', () => {
      expect(addGame('user1', 'Wingspan')).toBe('added');
      expect(loadLibrary()).toHaveLength(1);
    });

    it('returns "duplicate" when same user adds same title again', () => {
      addGame('user1', 'Wingspan');
      expect(addGame('user1', 'Wingspan')).toBe('duplicate');
      expect(loadLibrary()).toHaveLength(1);
    });

    it('returns "duplicate" when same user adds same objectid under a different name', () => {
      addGame('user1', 'Wingspan', 'obj-123');
      expect(addGame('user1', 'Wingspan (Different Spelling)', 'obj-123')).toBe('duplicate');
    });

    it('allows two different users to add the same game', () => {
      addGame('user1', 'Wingspan');
      expect(addGame('user2', 'Wingspan')).toBe('added');
      expect(loadLibrary()).toHaveLength(2);
    });

    it('is case-insensitive for duplicate detection', () => {
      addGame('user1', 'wingspan');
      expect(addGame('user1', 'Wingspan')).toBe('duplicate');
    });

    it('persists entries across calls', () => {
      addGame('user1', 'Catan');
      addGame('user1', 'Ticket to Ride');
      expect(loadLibrary()).toHaveLength(2);
    });
  });

  // ── removeGame ─────────────────────────────────────────────────────────────

  describe('removeGame', () => {
    it('removes an existing game and returns "removed"', () => {
      addGame('user1', 'Wingspan');
      expect(removeGame('user1', 'Wingspan')).toBe('removed');
      expect(loadLibrary()).toHaveLength(0);
    });

    it('returns "not_found" when game is not in library', () => {
      expect(removeGame('user1', 'Nonexistent')).toBe('not_found');
    });

    it('only removes the matching user\'s copy, not other users\'', () => {
      addGame('user1', 'Wingspan');
      addGame('user2', 'Wingspan');
      removeGame('user1', 'Wingspan');
      expect(loadLibrary()).toHaveLength(1);
      expect(loadLibrary()[0].userId).toBe('user2');
    });

    it('is case-insensitive', () => {
      addGame('user1', 'Wingspan');
      expect(removeGame('user1', 'wingspan')).toBe('removed');
    });
  });

  // ── findGamesByName ────────────────────────────────────────────────────────

  describe('findGamesByName', () => {
    it('returns all entries for an exact name match', () => {
      addGame('user1', 'Wingspan');
      addGame('user2', 'Wingspan');
      expect(findGamesByName('Wingspan')).toHaveLength(2);
    });

    it('is case-insensitive', () => {
      addGame('user1', 'Wingspan');
      expect(findGamesByName('wingspan')).toHaveLength(1);
    });

    it('returns an empty array when no match', () => {
      expect(findGamesByName('Nonexistent')).toHaveLength(0);
    });

    it('does not return partial matches', () => {
      addGame('user1', 'Wingspan');
      expect(findGamesByName('Wing')).toHaveLength(0);
    });
  });

  // ── findGameNamesByPartial ─────────────────────────────────────────────────

  describe('findGameNamesByPartial', () => {
    it('returns names that contain the search term', () => {
      addGame('user1', 'Wingspan');
      addGame('user1', 'Ticket to Ride');
      addGame('user1', 'Catan');
      expect(findGameNamesByPartial('wing')).toEqual(['Wingspan']);
    });

    it('deduplicates names across multiple owners', () => {
      addGame('user1', 'Wingspan');
      addGame('user2', 'Wingspan');
      expect(findGameNamesByPartial('wing')).toHaveLength(1);
    });

    it('returns results sorted alphabetically', () => {
      addGame('user1', 'Wingspread');
      addGame('user1', 'Wingspan');
      const results = findGameNamesByPartial('wing');
      expect(results).toEqual(['Wingspan', 'Wingspread']);
    });

    it('returns an empty array when no match', () => {
      expect(findGameNamesByPartial('zzz')).toHaveLength(0);
    });
  });

  // ── getGamesByUser ─────────────────────────────────────────────────────────

  describe('getGamesByUser', () => {
    it('returns only the specified user\'s games', () => {
      addGame('user1', 'Wingspan');
      addGame('user2', 'Catan');
      addGame('user1', 'Ticket to Ride');
      const games = getGamesByUser('user1');
      expect(games).toHaveLength(2);
      expect(games.every(g => g.userId === 'user1')).toBe(true);
    });

    it('returns an empty array for a user with no games', () => {
      expect(getGamesByUser('nobody')).toHaveLength(0);
    });
  });

  // ── clearUserLibrary ───────────────────────────────────────────────────────

  describe('clearUserLibrary', () => {
    it('removes all games for the given user and returns the count', () => {
      addGame('user1', 'Wingspan');
      addGame('user1', 'Catan');
      addGame('user2', 'Ticket to Ride');
      expect(clearUserLibrary('user1')).toBe(2);
      expect(loadLibrary()).toHaveLength(1);
      expect(loadLibrary()[0].userId).toBe('user2');
    });

    it('returns 0 when the user has no games', () => {
      expect(clearUserLibrary('nobody')).toBe(0);
    });
  });

  // ── addRequest / getRequestsForEvent ──────────────────────────────────────

  describe('addRequest', () => {
    it('adds a request and returns "added"', () => {
      expect(addRequest('event1', 'Wingspan', 'user1')).toBe('added');
    });

    it('returns "duplicate" if the same game is already requested for the same event', () => {
      addRequest('event1', 'Wingspan', 'user1');
      expect(addRequest('event1', 'Wingspan', 'user2')).toBe('duplicate');
    });

    it('allows the same game to be requested for different events', () => {
      addRequest('event1', 'Wingspan', 'user1');
      expect(addRequest('event2', 'Wingspan', 'user1')).toBe('added');
    });

    it('is case-insensitive for duplicate detection', () => {
      addRequest('event1', 'wingspan', 'user1');
      expect(addRequest('event1', 'Wingspan', 'user1')).toBe('duplicate');
    });
  });

  describe('getRequestsForEvent', () => {
    it('returns only requests for the specified event', () => {
      addRequest('event1', 'Wingspan', 'user1');
      addRequest('event2', 'Catan', 'user1');
      expect(getRequestsForEvent('event1')).toHaveLength(1);
      expect(getRequestsForEvent('event1')[0].gameName).toBe('Wingspan');
    });

    it('returns an empty array for an event with no requests', () => {
      expect(getRequestsForEvent('no-such-event')).toHaveLength(0);
    });
  });

  // ── removeRequests / removeAllRequestsForEvent ─────────────────────────────

  describe('removeRequests', () => {
    it('removes requests by ID and returns the count removed', () => {
      addRequest('event1', 'Wingspan', 'user1');
      addRequest('event1', 'Catan', 'user1');
      const [r1, r2] = getRequestsForEvent('event1');
      expect(removeRequests([r1.id])).toBe(1);
      expect(getRequestsForEvent('event1')).toHaveLength(1);
      expect(getRequestsForEvent('event1')[0].gameName).toBe(r2.gameName);
    });
  });

  describe('removeAllRequestsForEvent', () => {
    it('removes all requests for an event when no userId given', () => {
      addRequest('event1', 'Wingspan', 'user1');
      addRequest('event1', 'Catan', 'user2');
      expect(removeAllRequestsForEvent('event1')).toBe(2);
      expect(getRequestsForEvent('event1')).toHaveLength(0);
    });

    it('removes only the specified user\'s requests when userId given', () => {
      addRequest('event1', 'Wingspan', 'user1');
      addRequest('event1', 'Catan', 'user2');
      expect(removeAllRequestsForEvent('event1', 'user1')).toBe(1);
      expect(getRequestsForEvent('event1')).toHaveLength(1);
      expect(getRequestsForEvent('event1')[0].requestedBy).toBe('user2');
    });
  });

  // ── updateRequestCopies ────────────────────────────────────────────────────

  describe('updateRequestCopies', () => {
    it('updates the copies needed for a game request', () => {
      addRequest('event1', 'Wingspan', 'user1');
      updateRequestCopies('event1', 'Wingspan', 2);
      expect(getRequestsForEvent('event1')[0].copiesNeeded).toBe(2);
    });

    it('is a no-op when the game is not requested for that event', () => {
      updateRequestCopies('event1', 'Nonexistent', 2);
      expect(getRequestsForEvent('event1')).toHaveLength(0);
    });
  });

  // ── getGameInfo / upsertGameInfo ───────────────────────────────────────────

  describe('getGameInfo / upsertGameInfo', () => {
    it('returns undefined when no info exists', () => {
      expect(getGameInfo('Wingspan')).toBeUndefined();
    });

    it('stores and retrieves game info', () => {
      upsertGameInfo({
        gameName: 'Wingspan',
        minPlayers: 1,
        maxPlayers: 5,
        playTime: 70,
        tags: ['Engine Building'],
        updatedAt: new Date().toISOString(),
      });
      const info = getGameInfo('Wingspan');
      expect(info?.minPlayers).toBe(1);
      expect(info?.maxPlayers).toBe(5);
      expect(info?.tags).toEqual(['Engine Building']);
    });

    it('updates existing info on upsert', () => {
      const now = new Date().toISOString();
      upsertGameInfo({ gameName: 'Wingspan', playTime: 60, updatedAt: now });
      upsertGameInfo({ gameName: 'Wingspan', playTime: 90, updatedAt: now });
      expect(getGameInfo('Wingspan')?.playTime).toBe(90);
    });

    it('is case-insensitive for lookup', () => {
      upsertGameInfo({ gameName: 'Wingspan', updatedAt: new Date().toISOString() });
      expect(getGameInfo('wingspan')).toBeDefined();
    });
  });
});
