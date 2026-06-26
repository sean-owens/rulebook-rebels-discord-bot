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
    it('returns an empty array when no file exists', () => {
      expect(loadGames()).toEqual([]);
    });
  });

  // ── upsertGame ────────────────────────────────────────────────────────────

  describe('upsertGame', () => {
    it('inserts a new game', () => {
      upsertGame(makeGame());
      expect(loadGames()).toHaveLength(1);
    });

    it('updates an existing game by id', () => {
      upsertGame(makeGame({ title: 'Wingspan' }));
      upsertGame(makeGame({ title: 'Wingspan (updated)' }));
      const all = loadGames();
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe('Wingspan (updated)');
    });

    it('stores multiple distinct games', () => {
      upsertGame(makeGame({ id: 'game-1', title: 'Wingspan' }));
      upsertGame(makeGame({ id: 'game-2', title: 'Catan' }));
      expect(loadGames()).toHaveLength(2);
    });
  });

  // ── findGame ──────────────────────────────────────────────────────────────

  describe('findGame', () => {
    it('returns the game when found by id', () => {
      upsertGame(makeGame({ id: 'game-1' }));
      expect(findGame('game-1')?.title).toBe('Wingspan');
    });

    it('returns undefined when the id does not exist', () => {
      expect(findGame('nonexistent')).toBeUndefined();
    });
  });

  // ── findGamesByChannel ────────────────────────────────────────────────────

  describe('findGamesByChannel', () => {
    it('returns games in the given channel', () => {
      upsertGame(makeGame({ id: 'game-1', channelId: 'ch-A' }));
      upsertGame(makeGame({ id: 'game-2', channelId: 'ch-B' }));
      expect(findGamesByChannel('ch-A')).toHaveLength(1);
      expect(findGamesByChannel('ch-A')[0].id).toBe('game-1');
    });

    it('returns an empty array when no games are in that channel', () => {
      upsertGame(makeGame({ channelId: 'ch-A' }));
      expect(findGamesByChannel('ch-Z')).toHaveLength(0);
    });
  });

  // ── findGamesByEvent ──────────────────────────────────────────────────────

  describe('findGamesByEvent', () => {
    it('returns all games for the given event', () => {
      upsertGame(makeGame({ id: 'game-1', eventId: 'event-1' }));
      upsertGame(makeGame({ id: 'game-2', eventId: 'event-1' }));
      upsertGame(makeGame({ id: 'game-3', eventId: 'event-2' }));
      expect(findGamesByEvent('event-1')).toHaveLength(2);
    });

    it('returns an empty array when no games exist for that event', () => {
      expect(findGamesByEvent('event-99')).toHaveLength(0);
    });
  });

  // ── removeGamesByEvent ────────────────────────────────────────────────────

  describe('removeGamesByEvent', () => {
    it('removes all games for the given event', () => {
      upsertGame(makeGame({ id: 'game-1', eventId: 'event-1' }));
      upsertGame(makeGame({ id: 'game-2', eventId: 'event-1' }));
      upsertGame(makeGame({ id: 'game-3', eventId: 'event-2' }));
      removeGamesByEvent('event-1');
      expect(loadGames()).toHaveLength(1);
      expect(loadGames()[0].eventId).toBe('event-2');
    });

    it('is a no-op when no games exist for that event', () => {
      upsertGame(makeGame({ eventId: 'event-1' }));
      removeGamesByEvent('event-99');
      expect(loadGames()).toHaveLength(1);
    });

    it('leaves the store empty when the only event is removed', () => {
      upsertGame(makeGame({ eventId: 'event-1' }));
      removeGamesByEvent('event-1');
      expect(loadGames()).toHaveLength(0);
    });
  });
});
