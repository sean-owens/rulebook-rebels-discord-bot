import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadGames,
  upsertGame,
  findGame,
  findGamesByChannel,
  findGamesByEvent,
  removeGamesByEvent,
  getLastScheduledAt,
  GameSuggestion,
} from '../src/utils/gameStorage';

function makeGame(overrides: Partial<GameSuggestion> = {}): GameSuggestion {
  return {
    id: 'game-1',
    eventId: 'event-1',
    channelId: 'ch-1',
    messageId: 'msg-1',
    guildId: 'guild-1',
    bggId: '12345',
    title: 'Wingspan',
    bggLink: 'https://boardgamegeek.com/boardgame/12345',
    minPlayers: 1,
    maxPlayers: 5,
    suggestedPlayers: 3,
    minPlaytime: 40,
    maxPlaytime: 70,
    suggestedStartTime: null,
    tags: ['Engine Building'],
    expansions: [],
    seats: [],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('gameStorage', () => {
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

  // ── loadGames ─────────────────────────────────────────────────────────────

  describe('loadGames', () => {
    it('returns an empty array when no file exists', async () => {
      expect(await loadGames()).toEqual([]);
    });
  });

  // ── upsertGame ────────────────────────────────────────────────────────────

  describe('upsertGame', () => {
    it('inserts a new game', async () => {
      await upsertGame(makeGame());
      expect(await loadGames()).toHaveLength(1);
    });

    it('updates an existing game by id', async () => {
      await upsertGame(makeGame({ title: 'Wingspan' }));
      await upsertGame(makeGame({ title: 'Wingspan (updated)' }));
      const all = await loadGames();
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe('Wingspan (updated)');
    });

    it('stores multiple distinct games', async () => {
      await upsertGame(makeGame({ id: 'game-1', title: 'Wingspan' }));
      await upsertGame(makeGame({ id: 'game-2', title: 'Catan' }));
      expect(await loadGames()).toHaveLength(2);
    });
  });

  // ── findGame ──────────────────────────────────────────────────────────────

  describe('findGame', () => {
    it('returns the game when found by id', async () => {
      await upsertGame(makeGame({ id: 'game-1' }));
      expect((await findGame('game-1'))?.title).toBe('Wingspan');
    });

    it('returns undefined when the id does not exist', async () => {
      expect(await findGame('nonexistent')).toBeUndefined();
    });
  });

  // ── findGamesByChannel ────────────────────────────────────────────────────

  describe('findGamesByChannel', () => {
    it('returns games in the given channel', async () => {
      await upsertGame(makeGame({ id: 'game-1', channelId: 'ch-A' }));
      await upsertGame(makeGame({ id: 'game-2', channelId: 'ch-B' }));
      expect(await findGamesByChannel('ch-A')).toHaveLength(1);
      expect((await findGamesByChannel('ch-A'))[0].id).toBe('game-1');
    });

    it('returns an empty array when no games are in that channel', async () => {
      await upsertGame(makeGame({ channelId: 'ch-A' }));
      expect(await findGamesByChannel('ch-Z')).toHaveLength(0);
    });
  });

  // ── findGamesByEvent ──────────────────────────────────────────────────────

  describe('findGamesByEvent', () => {
    it('returns all games for the given event', async () => {
      await upsertGame(makeGame({ id: 'game-1', eventId: 'event-1' }));
      await upsertGame(makeGame({ id: 'game-2', eventId: 'event-1' }));
      await upsertGame(makeGame({ id: 'game-3', eventId: 'event-2' }));
      expect(await findGamesByEvent('event-1')).toHaveLength(2);
    });

    it('returns an empty array when no games exist for that event', async () => {
      expect(await findGamesByEvent('event-99')).toHaveLength(0);
    });
  });

  // ── removeGamesByEvent ────────────────────────────────────────────────────

  describe('removeGamesByEvent', () => {
    it('removes all games for the given event', async () => {
      await upsertGame(makeGame({ id: 'game-1', eventId: 'event-1' }));
      await upsertGame(makeGame({ id: 'game-2', eventId: 'event-1' }));
      await upsertGame(makeGame({ id: 'game-3', eventId: 'event-2' }));
      await removeGamesByEvent('event-1');
      expect(await loadGames()).toHaveLength(1);
      expect((await loadGames())[0].eventId).toBe('event-2');
    });

    it('is a no-op when no games exist for that event', async () => {
      await upsertGame(makeGame({ eventId: 'event-1' }));
      await removeGamesByEvent('event-99');
      expect(await loadGames()).toHaveLength(1);
    });

    it('leaves the store empty when the only event is removed', async () => {
      await upsertGame(makeGame({ eventId: 'event-1' }));
      await removeGamesByEvent('event-1');
      expect(await loadGames()).toHaveLength(0);
    });
  });

  // ── getLastScheduledAt ────────────────────────────────────────────────────

  describe('getLastScheduledAt', () => {
    it('ignores suggestions that never got scheduled onto a lineup', async () => {
      await upsertGame(makeGame({ id: 'game-1', title: 'Wingspan', scheduledRound: undefined }));
      const result = await getLastScheduledAt('guild-1');
      expect(result.has('wingspan')).toBe(false);
    });

    it('keys by lowercased title and scopes to the given guild', async () => {
      await upsertGame(
        makeGame({ id: 'game-1', title: 'Wingspan', guildId: 'guild-1', scheduledRound: 1 }),
      );
      await upsertGame(
        makeGame({ id: 'game-2', title: 'Wingspan', guildId: 'guild-2', scheduledRound: 1 }),
      );
      const result = await getLastScheduledAt('guild-1');
      expect(result.has('wingspan')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('keeps the most recent createdAt when a title was scheduled more than once', async () => {
      const older = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const newer = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      await upsertGame(
        makeGame({ id: 'game-1', title: 'Catan', scheduledRound: 1, createdAt: older }),
      );
      await upsertGame(
        makeGame({ id: 'game-2', title: 'Catan', scheduledRound: 1, createdAt: newer }),
      );
      const result = await getLastScheduledAt('guild-1');
      expect(result.get('catan')).toBe(newer);
    });
  });
});
