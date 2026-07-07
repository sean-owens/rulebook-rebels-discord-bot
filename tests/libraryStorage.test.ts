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
  confirmBring,
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
    it('adds a new game and returns "added"', async () => {
      expect(await addGame('guild-1', 'user1', 'Wingspan')).toBe('added');
      expect(await loadLibrary()).toHaveLength(1);
    });

    it('returns "duplicate" when same user adds same title again', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await addGame('guild-1', 'user1', 'Wingspan')).toBe('duplicate');
      expect(await loadLibrary()).toHaveLength(1);
    });

    it('returns "duplicate" when same user adds same objectid under a different name', async () => {
      await addGame('guild-1', 'user1', 'Wingspan', 'obj-123');
      expect(
        await addGame('guild-1', 'user1', 'Wingspan (Different Spelling)', 'obj-123'),
      ).toBe('duplicate');
    });

    it('allows two different users to add the same game', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await addGame('guild-1', 'user2', 'Wingspan')).toBe('added');
      expect(await loadLibrary()).toHaveLength(2);
    });

    it('is case-insensitive for duplicate detection', async () => {
      await addGame('guild-1', 'user1', 'wingspan');
      expect(await addGame('guild-1', 'user1', 'Wingspan')).toBe('duplicate');
    });

    it('persists entries across calls', async () => {
      await addGame('guild-1', 'user1', 'Catan');
      await addGame('guild-1', 'user1', 'Ticket to Ride');
      expect(await loadLibrary()).toHaveLength(2);
    });

    it('allows the same user to add the same game in different guilds', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await addGame('guild-2', 'user1', 'Wingspan')).toBe('added');
      expect(await loadLibrary()).toHaveLength(2);
    });
  });

  // ── removeGame ─────────────────────────────────────────────────────────────

  describe('removeGame', () => {
    it('removes an existing game and returns "removed"', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await removeGame('guild-1', 'user1', 'Wingspan')).toBe('removed');
      expect(await loadLibrary()).toHaveLength(0);
    });

    it('returns "not_found" when game is not in library', async () => {
      expect(await removeGame('guild-1', 'user1', 'Nonexistent')).toBe('not_found');
    });

    it("only removes the matching user's copy, not other users'", async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user2', 'Wingspan');
      await removeGame('guild-1', 'user1', 'Wingspan');
      expect(await loadLibrary()).toHaveLength(1);
      expect((await loadLibrary())[0].userId).toBe('user2');
    });

    it('is case-insensitive', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await removeGame('guild-1', 'user1', 'wingspan')).toBe('removed');
    });

    it('does not remove the same game from a different guild', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await removeGame('guild-2', 'user1', 'Wingspan')).toBe('not_found');
      expect(await loadLibrary()).toHaveLength(1);
    });
  });

  // ── findGamesByName ────────────────────────────────────────────────────────

  describe('findGamesByName', () => {
    it('returns all entries for an exact name match', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user2', 'Wingspan');
      expect(await findGamesByName('guild-1', 'Wingspan')).toHaveLength(2);
    });

    it('is case-insensitive', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await findGamesByName('guild-1', 'wingspan')).toHaveLength(1);
    });

    it('returns an empty array when no match', async () => {
      expect(await findGamesByName('guild-1', 'Nonexistent')).toHaveLength(0);
    });

    it('does not return partial matches', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await findGamesByName('guild-1', 'Wing')).toHaveLength(0);
    });

    it('does not return entries from other guilds', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await findGamesByName('guild-2', 'Wingspan')).toHaveLength(0);
    });
  });

  // ── findGameNamesByPartial ─────────────────────────────────────────────────

  describe('findGameNamesByPartial', () => {
    it('returns names that contain the search term', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user1', 'Ticket to Ride');
      await addGame('guild-1', 'user1', 'Catan');
      expect(await findGameNamesByPartial('guild-1', 'wing')).toEqual(['Wingspan']);
    });

    it('deduplicates names across multiple owners', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user2', 'Wingspan');
      expect(await findGameNamesByPartial('guild-1', 'wing')).toHaveLength(1);
    });

    it('returns results sorted alphabetically', async () => {
      await addGame('guild-1', 'user1', 'Wingspread');
      await addGame('guild-1', 'user1', 'Wingspan');
      const results = await findGameNamesByPartial('guild-1', 'wing');
      expect(results).toEqual(['Wingspan', 'Wingspread']);
    });

    it('returns an empty array when no match', async () => {
      expect(await findGameNamesByPartial('guild-1', 'zzz')).toHaveLength(0);
    });

    it('matches despite punctuation differences (apostrophes)', async () => {
      await addGame('guild-1', 'user1', "Wonderland's War");
      expect(await findGameNamesByPartial('guild-1', 'Wonderlands War')).toEqual([
        "Wonderland's War",
      ]);
    });

    it('matches despite punctuation differences (hyphens)', async () => {
      await addGame('guild-1', 'user1', 'Dungeon-Crawler');
      expect(await findGameNamesByPartial('guild-1', 'Dungeon Crawler')).toEqual([
        'Dungeon-Crawler',
      ]);
    });

    it('does not return entries from other guilds', async () => {
      await addGame('guild-2', 'user1', 'Wingspan');
      expect(await findGameNamesByPartial('guild-1', 'wing')).toHaveLength(0);
    });
  });

  // ── getGamesByUser ─────────────────────────────────────────────────────────

  describe('getGamesByUser', () => {
    it("returns only the specified user's games", async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user2', 'Catan');
      await addGame('guild-1', 'user1', 'Ticket to Ride');
      const games = await getGamesByUser('guild-1', 'user1');
      expect(games).toHaveLength(2);
      expect(games.every((g) => g.userId === 'user1')).toBe(true);
    });

    it('returns an empty array for a user with no games', async () => {
      expect(await getGamesByUser('guild-1', 'nobody')).toHaveLength(0);
    });

    it('does not return games from other guilds', async () => {
      await addGame('guild-2', 'user1', 'Wingspan');
      expect(await getGamesByUser('guild-1', 'user1')).toHaveLength(0);
    });
  });

  // ── clearUserLibrary ───────────────────────────────────────────────────────

  describe('clearUserLibrary', () => {
    it('removes all games for the given user and returns the count', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addGame('guild-1', 'user1', 'Catan');
      await addGame('guild-1', 'user2', 'Ticket to Ride');
      expect(await clearUserLibrary('guild-1', 'user1')).toBe(2);
      expect(await loadLibrary()).toHaveLength(1);
      expect((await loadLibrary())[0].userId).toBe('user2');
    });

    it('returns 0 when the user has no games', async () => {
      expect(await clearUserLibrary('guild-1', 'nobody')).toBe(0);
    });

    it('does not remove games from other guilds', async () => {
      await addGame('guild-2', 'user1', 'Wingspan');
      expect(await clearUserLibrary('guild-1', 'user1')).toBe(0);
      expect(await loadLibrary()).toHaveLength(1);
    });
  });

  // ── addRequest / getRequestsForEvent ──────────────────────────────────────

  describe('addRequest', () => {
    it('adds a request and returns "added"', async () => {
      expect(await addRequest('event1', 'Wingspan', 'user1')).toBe('added');
    });

    it('returns "duplicate" if the same game is already requested for the same event', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      expect(await addRequest('event1', 'Wingspan', 'user2')).toBe('duplicate');
    });

    it('allows the same game to be requested for different events', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      expect(await addRequest('event2', 'Wingspan', 'user1')).toBe('added');
    });

    it('is case-insensitive for duplicate detection', async () => {
      await addRequest('event1', 'wingspan', 'user1');
      expect(await addRequest('event1', 'Wingspan', 'user1')).toBe('duplicate');
    });
  });

  describe('getRequestsForEvent', () => {
    it('returns only requests for the specified event', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      await addRequest('event2', 'Catan', 'user1');
      expect(await getRequestsForEvent('event1')).toHaveLength(1);
      expect((await getRequestsForEvent('event1'))[0].gameName).toBe('Wingspan');
    });

    it('returns an empty array for an event with no requests', async () => {
      expect(await getRequestsForEvent('no-such-event')).toHaveLength(0);
    });
  });

  // ── removeRequests / removeAllRequestsForEvent ─────────────────────────────

  describe('removeRequests', () => {
    it('removes requests by ID and returns the count removed', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      await addRequest('event1', 'Catan', 'user1');
      const [r1, r2] = await getRequestsForEvent('event1');
      expect(await removeRequests([r1.id])).toBe(1);
      expect(await getRequestsForEvent('event1')).toHaveLength(1);
      expect((await getRequestsForEvent('event1'))[0].gameName).toBe(r2.gameName);
    });
  });

  describe('removeAllRequestsForEvent', () => {
    it('removes all requests for an event when no userId given', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      await addRequest('event1', 'Catan', 'user2');
      expect(await removeAllRequestsForEvent('event1')).toBe(2);
      expect(await getRequestsForEvent('event1')).toHaveLength(0);
    });

    it("removes only the specified user's requests when userId given", async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      await addRequest('event1', 'Catan', 'user2');
      expect(await removeAllRequestsForEvent('event1', 'user1')).toBe(1);
      expect(await getRequestsForEvent('event1')).toHaveLength(1);
      expect((await getRequestsForEvent('event1'))[0].requestedBy).toBe('user2');
    });
  });

  // ── updateRequestCopies ────────────────────────────────────────────────────

  describe('updateRequestCopies', () => {
    it('updates the copies needed for a game request', async () => {
      await addRequest('event1', 'Wingspan', 'user1');
      await updateRequestCopies('event1', 'Wingspan', 2);
      expect((await getRequestsForEvent('event1'))[0].copiesNeeded).toBe(2);
    });

    it('is a no-op when the game is not requested for that event', async () => {
      await updateRequestCopies('event1', 'Nonexistent', 2);
      expect(await getRequestsForEvent('event1')).toHaveLength(0);
    });
  });

  // ── getGameInfo / upsertGameInfo ───────────────────────────────────────────

  describe('getGameInfo / upsertGameInfo', () => {
    it('returns undefined when no info exists', async () => {
      expect(await getGameInfo('Wingspan')).toBeUndefined();
    });

    it('stores and retrieves game info', async () => {
      await upsertGameInfo({
        gameName: 'Wingspan',
        minPlayers: 1,
        maxPlayers: 5,
        playTime: 70,
        tags: ['Engine Building'],
        updatedAt: new Date().toISOString(),
      });
      const info = await getGameInfo('Wingspan');
      expect(info?.minPlayers).toBe(1);
      expect(info?.maxPlayers).toBe(5);
      expect(info?.tags).toEqual(['Engine Building']);
    });

    it('updates existing info on upsert', async () => {
      const now = new Date().toISOString();
      await upsertGameInfo({ gameName: 'Wingspan', playTime: 60, updatedAt: now });
      await upsertGameInfo({ gameName: 'Wingspan', playTime: 90, updatedAt: now });
      expect((await getGameInfo('Wingspan'))?.playTime).toBe(90);
    });

    it('is case-insensitive for lookup', async () => {
      await upsertGameInfo({ gameName: 'Wingspan', updatedAt: new Date().toISOString() });
      expect(await getGameInfo('wingspan')).toBeDefined();
    });
  });

  // ── confirmBring ───────────────────────────────────────────────────────────

  describe('confirmBring', () => {
    it('returns "confirmed" and sets confirmedBy when the owner confirms a requested game', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addRequest('event1', 'Wingspan', 'user2');
      expect(await confirmBring('guild-1', 'event1', 'Wingspan', 'user1')).toBe('confirmed');
      expect((await getRequestsForEvent('event1'))[0].confirmedBy).toBe('user1');
    });

    it('returns "not_requested" when the game has not been requested for that event', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      expect(await confirmBring('guild-1', 'event1', 'Wingspan', 'user1')).toBe('not_requested');
    });

    it('returns "not_owner" when the user does not own the game', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addRequest('event1', 'Wingspan', 'user2');
      expect(await confirmBring('guild-1', 'event1', 'Wingspan', 'user2')).toBe('not_owner');
    });

    it('is case-insensitive for the game name lookup', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addRequest('event1', 'wingspan', 'user2');
      expect(await confirmBring('guild-1', 'event1', 'WINGSPAN', 'user1')).toBe('confirmed');
    });

    it('allows re-confirmation (idempotent)', async () => {
      await addGame('guild-1', 'user1', 'Wingspan');
      await addRequest('event1', 'Wingspan', 'user2');
      await confirmBring('guild-1', 'event1', 'Wingspan', 'user1');
      expect(await confirmBring('guild-1', 'event1', 'Wingspan', 'user1')).toBe('confirmed');
      expect((await getRequestsForEvent('event1'))[0].confirmedBy).toBe('user1');
    });

    it('returns "not_owner" when the user owns the game in a different guild', async () => {
      await addGame('guild-2', 'user1', 'Wingspan');
      await addRequest('event1', 'Wingspan', 'user2');
      expect(await confirmBring('guild-1', 'event1', 'Wingspan', 'user1')).toBe('not_owner');
    });
  });
});
