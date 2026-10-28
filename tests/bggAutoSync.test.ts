import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockFetchCollection = vi.fn();
vi.mock('../src/utils/bgg', () => ({
  fetchBggOwnedCollection: (...args: unknown[]) => mockFetchCollection(...args),
  weightTag: vi.fn(() => 'Medium'),
  BGG_TO_TAG: {},
}));

import {
  isBggSyncDue,
  buildAutoSyncDm,
  checkBggAutoSync,
  BGG_AUTO_SYNC_MAX_PER_RUN,
  BGG_AUTO_SYNC_RETRY_BACKOFF_HOURS,
} from '../src/utils/bggAutoSync';
import { applyBggCollectionToLibrary } from '../src/utils/bggLibrarySync';
import { setBggAccount, getBggAccount, recordBggSyncAttempt, listAllBggAccounts } from '../src/utils/bggAccountStorage';
import { addGame, removeGame, loadLibraryForGuild } from '../src/utils/libraryStorage';
import { getUserCollection, setUserCollection } from '../src/utils/userCollectionStorage';
import { updateGuildConfig, bggAutoSyncDaysFor, DEFAULT_BGG_AUTO_SYNC_DAYS, getGuildConfig } from '../src/utils/config';
import { handleAutoSyncConfig, describeAutoSync } from '../src/commands/autoSyncConfig';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

function bggGame(id: string, name: string, isExpansion = false) {
  return {
    gameName: name,
    bggGameId: id,
    isExpansion,
    yearPublished: 2020,
    thumbnail: null,
    minPlayers: 1,
    maxPlayers: 4,
    minPlaytime: 30,
    maxPlaytime: 60,
    playingTime: 45,
    avgRating: null,
    bggRank: null,
    own: true,
    forTrade: false,
    wantToPlay: false,
    wishlisted: false,
    userRating: null,
    numPlays: 0,
  };
}

function snapshotEntry(id: string, name: string) {
  return {
    bggGameId: id,
    gameName: name,
    bggOwn: true,
    bggForTrade: false,
    bggWantToPlay: false,
    bggWishlisted: false,
    bggUserRating: null,
    bggNumPlays: 0,
    bggSyncedAt: daysAgo(10),
  };
}

describe('BGG library auto-resync (#116)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bgg-auto-sync-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockFetchCollection.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── schedule ─────────────────────────────────────────────────────────────────

  describe('isBggSyncDue', () => {
    it('is never due when the interval is 0 (off)', () => {
      expect(isBggSyncDue({}, 0, NOW)).toBe(false);
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(400) }, 0, NOW)).toBe(false);
    });

    it('is due immediately when the account has never been synced', () => {
      expect(isBggSyncDue({}, 7, NOW)).toBe(true);
    });

    it('is not due until the full interval has passed since the last success', () => {
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(6) }, 7, NOW)).toBe(false);
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(7) }, 7, NOW)).toBe(true);
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(30) }, 7, NOW)).toBe(true);
    });

    it('honours a different interval', () => {
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(2) }, 1, NOW)).toBe(true);
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(2) }, 14, NOW)).toBe(false);
    });

    it('backs off after a recent attempt, even a failed one, instead of retrying every tick', () => {
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(30), lastSyncAttemptAt: hoursAgo(1) }, 7, NOW)).toBe(false);
      expect(isBggSyncDue({ lastSyncAttemptAt: hoursAgo(1) }, 7, NOW)).toBe(false);
    });

    it('retries once the back-off has elapsed', () => {
      const stale = hoursAgo(BGG_AUTO_SYNC_RETRY_BACKOFF_HOURS + 1);
      expect(isBggSyncDue({ lastSyncedAt: daysAgo(30), lastSyncAttemptAt: stale }, 7, NOW)).toBe(true);
    });
  });

  // ── DM text ──────────────────────────────────────────────────────────────────

  describe('buildAutoSyncDm', () => {
    const empty = {
      addedGames: 0,
      addedExpansions: 0,
      skipped: 5,
      addedGameNames: [],
      addedExpansionNames: [],
      noLongerOnBgg: [],
      heldBack: false,
    };

    it('says nothing when nothing was added', () => {
      expect(buildAutoSyncDm(empty)).toBeNull();
    });

    it('lists the games that were added', () => {
      const dm = buildAutoSyncDm({ ...empty, addedGames: 2, addedGameNames: ['Wingspan', 'Azul'] })!;
      expect(dm).toContain('**2** games: Wingspan, Azul');
    });

    it('uses the singular for a single game', () => {
      const dm = buildAutoSyncDm({ ...empty, addedGames: 1, addedGameNames: ['Wingspan'] })!;
      expect(dm).toContain('**1** game: Wingspan');
    });

    it('lists expansions separately', () => {
      const dm = buildAutoSyncDm({
        ...empty,
        addedGames: 1,
        addedGameNames: ['Wingspan'],
        addedExpansions: 1,
        addedExpansionNames: ['Wingspan: Oceania Expansion'],
      })!;
      expect(dm).toContain('**1** expansion: Wingspan: Oceania Expansion');
    });

    it('still reports when only expansions were added', () => {
      const dm = buildAutoSyncDm({ ...empty, addedExpansions: 2, addedExpansionNames: ['A', 'B'] })!;
      expect(dm).toContain('**2** expansions: A, B');
      expect(dm).not.toContain('game:');
    });

    it('truncates a long list rather than blowing the message size', () => {
      const names = Array.from({ length: 30 }, (_, i) => `Game ${i + 1}`);
      const dm = buildAutoSyncDm({ ...empty, addedGames: 30, addedGameNames: names })!;
      expect(dm).toContain('Game 10');
      expect(dm).not.toContain('Game 11,');
      expect(dm).toContain('and 20 more');
      expect(dm.length).toBeLessThan(2000);
    });

    it('tells the member how to remove a game for good and how to stop syncing', () => {
      const dm = buildAutoSyncDm({ ...empty, addedGames: 1, addedGameNames: ['Azul'] })!;
      expect(dm).toContain('/library remove');
      expect(dm).toContain('/bgg unlink');
    });
  });

  // ── applying a collection ────────────────────────────────────────────────────

  describe('applyBggCollectionToLibrary', () => {
    const collection = [bggGame('1', 'Wingspan'), bggGame('2', 'Azul'), bggGame('3', 'Catan')];

    it("'new-only' adds only games that weren't in the previous snapshot", async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');

      const summary = await applyBggCollectionToLibrary('g1', 'u1', collection, 'new-only');

      expect(summary.addedGames).toBe(1);
      expect(summary.addedGameNames).toEqual(['Catan']);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName).sort()).toEqual(['Azul', 'Catan', 'Wingspan']);
    });

    it('does NOT re-add a game the member deliberately removed — it was already in their snapshot', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');
      await removeGame('g1', 'u1', 'Azul'); // they still own it on BGG, but don't want it listed

      const summary = await applyBggCollectionToLibrary('g1', 'u1', collection, 'new-only');

      expect(summary.addedGameNames).toEqual(['Catan']);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).not.toContain('Azul');
    });

    it("'all' (the manual import) does bring a removed game back, as before", async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Azul', '2');
      await removeGame('g1', 'u1', 'Azul');

      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('2', 'Azul')], 'all');

      expect(summary.addedGameNames).toEqual(['Azul']);
    });

    it('does not report a new-to-BGG game the member had already added by hand', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Catan'); // added manually before it showed up in their BGG snapshot

      const summary = await applyBggCollectionToLibrary(
        'g1',
        'u1',
        [bggGame('1', 'Wingspan'), bggGame('3', 'Catan')],
        'new-only',
      );

      expect(summary.addedGames).toBe(0);
      expect(summary.addedGameNames).toEqual([]);
    });

    it('counts new expansions separately from games', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan')]);
      await addGame('g1', 'u1', 'Wingspan', '1');

      const summary = await applyBggCollectionToLibrary(
        'g1',
        'u1',
        [bggGame('1', 'Wingspan'), bggGame('9', 'Wingspan: Oceania Expansion', true)],
        'new-only',
      );

      expect(summary.addedGames).toBe(0);
      expect(summary.addedExpansions).toBe(1);
      expect(summary.addedExpansionNames).toEqual(['Wingspan: Oceania Expansion']);
      expect((await loadLibraryForGuild('g1')).find((e) => e.gameName.includes('Oceania'))?.isExpansion).toBe(true);
    });

    it('refreshes the stored snapshot to the whole fetched collection, so the next pass diffs against it', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan')]);
      await addGame('g1', 'u1', 'Wingspan', '1');

      await applyBggCollectionToLibrary('g1', 'u1', collection, 'new-only');

      expect((await getUserCollection('g1', 'u1')).map((e) => e.bggGameId).sort()).toEqual(['1', '2', '3']);

      // A second pass over the same collection finds nothing new.
      const again = await applyBggCollectionToLibrary('g1', 'u1', collection, 'new-only');
      expect(again.addedGames).toBe(0);
    });

    it('never removes anything from the library', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');

      // Azul no longer on their BGG shelf
      await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');

      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
    });
  });

  // ── account storage ──────────────────────────────────────────────────────────

  describe('bgg account sync timestamps', () => {
    it('records a successful sync and an attempt time', async () => {
      await setBggAccount('g1', 'u1', 'fan');
      await recordBggSyncAttempt('g1', 'u1', { at: daysAgo(1), success: true });
      const acct = await getBggAccount('g1', 'u1');
      expect(acct?.lastSyncedAt).toBe(daysAgo(1));
      expect(acct?.lastSyncAttemptAt).toBe(daysAgo(1));
    });

    it('a failed attempt moves only the attempt time, leaving the last success alone', async () => {
      await setBggAccount('g1', 'u1', 'fan');
      await recordBggSyncAttempt('g1', 'u1', { at: daysAgo(10), success: true });
      await recordBggSyncAttempt('g1', 'u1', { at: daysAgo(1), success: false });
      const acct = await getBggAccount('g1', 'u1');
      expect(acct?.lastSyncedAt).toBe(daysAgo(10));
      expect(acct?.lastSyncAttemptAt).toBe(daysAgo(1));
    });

    it('is a no-op for an account that was unlinked in the meantime', async () => {
      await expect(recordBggSyncAttempt('g1', 'nobody', { at: daysAgo(1), success: true })).resolves.toBeUndefined();
    });

    it('lists accounts across every guild, tagged with their guild', async () => {
      await setBggAccount('g1', 'u1', 'a');
      await setBggAccount('g2', 'u2', 'b');
      const all = await listAllBggAccounts();
      expect(all.map((a) => `${a.guildId}:${a.userId}`).sort()).toEqual(['g1:u1', 'g2:u2']);
    });
  });

  // ── the hourly sweep ─────────────────────────────────────────────────────────

  describe('checkBggAutoSync', () => {
    function makeClient(opts: { memberMissing?: string[]; dmRejects?: boolean } = {}) {
      const sent: Array<{ userId: string; content: string }> = [];
      const client = {
        guilds: {
          fetch: vi.fn(async () => ({
            members: {
              fetch: vi.fn(async (userId: string) => {
                if (opts.memberMissing?.includes(userId)) throw new Error('Unknown Member');
                return { id: userId };
              }),
            },
          })),
        },
        users: {
          fetch: vi.fn(async (userId: string) => {
            if (opts.dmRejects) throw new Error('Cannot send messages to this user');
            return { send: vi.fn(async (p: { content: string }) => void sent.push({ userId, content: p.content })) };
          }),
        },
      } as any;
      return { client, sent };
    }

    // A member who imported before: a stored snapshot, and their BGG now shows one more game.
    async function importedMember(guildId: string, userId: string, lastSyncedAt?: string) {
      await setBggAccount(guildId, userId, `bgg-${userId}`);
      if (lastSyncedAt) await recordBggSyncAttempt(guildId, userId, { at: lastSyncedAt, success: true });
      await setUserCollection(guildId, userId, [snapshotEntry('1', 'Wingspan')]);
      await addGame(guildId, userId, 'Wingspan', '1');
    }

    const nowWithNewGame = () => [bggGame('1', 'Wingspan'), bggGame('2', 'Azul')];

    it('syncs a due member, adds the new game, stamps the account, and DMs them', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      mockFetchCollection.mockResolvedValue(nowWithNewGame());
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledWith('bgg-u1');
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
      expect(sent).toHaveLength(1);
      expect(sent[0].userId).toBe('u1');
      expect(sent[0].content).toContain('Azul');
      expect(Date.parse((await getBggAccount('g1', 'u1'))!.lastSyncedAt!)).toBeGreaterThan(Date.parse(daysAgo(8)));
    });

    it('does not DM when nothing new was found, but still counts as synced', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(0);
      expect(Date.parse((await getBggAccount('g1', 'u1'))!.lastSyncedAt!)).toBeGreaterThan(Date.parse(daysAgo(8)));
    });

    it('leaves a member alone who is not yet due', async () => {
      await importedMember('g1', 'u1', daysAgo(2));
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).not.toHaveBeenCalled();
    });

    it('never touches a member who linked BGG but has never imported', async () => {
      await setBggAccount('g1', 'u1', 'bgg-u1'); // linked only — no snapshot, no lastSyncedAt
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).not.toHaveBeenCalled();
      expect(await loadLibraryForGuild('g1')).toEqual([]);
    });

    it('picks up an account that imported before this feature existed (snapshot but no lastSyncedAt)', async () => {
      await importedMember('g1', 'u1'); // no lastSyncedAt
      mockFetchCollection.mockResolvedValue(nowWithNewGame());
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledWith('bgg-u1');
    });

    it('does nothing for a server where an admin turned auto-sync off', async () => {
      await importedMember('g1', 'u1', daysAgo(30));
      await updateGuildConfig('g1', { bggAutoSyncDays: 0 });
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).not.toHaveBeenCalled();
    });

    it("uses each server's own interval", async () => {
      await importedMember('g1', 'u1', daysAgo(3));
      await importedMember('g2', 'u2', daysAgo(3));
      await updateGuildConfig('g1', { bggAutoSyncDays: 2 }); // due
      await updateGuildConfig('g2', { bggAutoSyncDays: 14 }); // not due
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledTimes(1);
      expect(mockFetchCollection).toHaveBeenCalledWith('bgg-u1');
    });

    it('treats a server saved before the setting existed as the default (on), not as off', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      await updateGuildConfig('g1', { timezone: 'America/New_York' }); // persisted record with no bggAutoSyncDays
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledTimes(1);
    });

    it('records a failed fetch, changes nothing else, and does not retry within the back-off', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      mockFetchCollection.mockResolvedValue(null); // BGG unreachable / still queued
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });
      await checkBggAutoSync(client, { gapMs: 0, now: NOW }); // the next hourly tick

      expect(mockFetchCollection).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(0);
      const acct = await getBggAccount('g1', 'u1');
      expect(acct?.lastSyncedAt).toBe(daysAgo(8)); // unchanged
      expect(acct?.lastSyncAttemptAt).toBeTruthy();
    });

    it('retries a failed account after the back-off', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      mockFetchCollection.mockResolvedValue(null);
      const { client } = makeClient();
      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      const later = new Date(NOW.getTime() + (BGG_AUTO_SYNC_RETRY_BACKOFF_HOURS + 1) * 60 * 60 * 1000);
      mockFetchCollection.mockResolvedValue(nowWithNewGame());
      await checkBggAutoSync(client, { gapMs: 0, now: later });

      expect(mockFetchCollection).toHaveBeenCalledTimes(2);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
    });

    it('limits how many members are synced per run, oldest-overdue first', async () => {
      const total = BGG_AUTO_SYNC_MAX_PER_RUN + 2;
      for (let i = 0; i < total; i++) {
        // u0 is the most overdue, the last is the least overdue
        await importedMember('g1', `u${i}`, daysAgo(100 - i));
      }
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledTimes(BGG_AUTO_SYNC_MAX_PER_RUN);
      const synced = mockFetchCollection.mock.calls.map((c) => c[0]);
      expect(synced).toContain('bgg-u0');
      expect(synced).not.toContain(`bgg-u${total - 1}`);
    });

    it('skips a member who has left the server, without calling BGG', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      const { client } = makeClient({ memberMissing: ['u1'] });

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).not.toHaveBeenCalled();
    });

    it("doesn't fail the sync when the member's DMs are closed", async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      mockFetchCollection.mockResolvedValue(nowWithNewGame());
      const { client } = makeClient({ dmRejects: true });

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
      expect(Date.parse((await getBggAccount('g1', 'u1'))!.lastSyncedAt!)).toBeGreaterThan(Date.parse(daysAgo(8)));
    });

    it("one member's failure doesn't stop the rest of the batch", async () => {
      await importedMember('g1', 'u1', daysAgo(20));
      await importedMember('g1', 'u2', daysAgo(10));
      mockFetchCollection.mockImplementation(async (username: string) => {
        if (username === 'bgg-u1') throw new Error('boom');
        return nowWithNewGame();
      });
      const { client } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(mockFetchCollection).toHaveBeenCalledTimes(2);
      expect((await loadLibraryForGuild('g1')).filter((e) => e.userId === 'u2').map((e) => e.gameName)).toContain('Azul');
    });

    it('ignores a second call while a run is already in flight', async () => {
      await importedMember('g1', 'u1', daysAgo(8));
      let release!: () => void;
      mockFetchCollection.mockImplementation(
        () => new Promise((resolve) => (release = () => resolve([bggGame('1', 'Wingspan')]))),
      );
      const { client } = makeClient();

      const first = checkBggAutoSync(client, { gapMs: 0, now: NOW });
      await new Promise((r) => setTimeout(r, 20)); // let the first reach the BGG call
      await checkBggAutoSync(client, { gapMs: 0, now: NOW }); // overlapping — must be a no-op
      release();
      await first;

      expect(mockFetchCollection).toHaveBeenCalledTimes(1);
    });
  });

  // ── per-server setting ───────────────────────────────────────────────────────

  describe('bggAutoSyncDaysFor / /admin library autosync', () => {
    function makeInteraction(days: number | null) {
      return {
        guildId: 'g1',
        options: { getInteger: (name: string) => (name === 'days' ? days : null) },
        reply: vi.fn(async () => {}),
      } as any;
    }

    it('defaults to weekly, and a record without the field is the default rather than off', () => {
      expect(DEFAULT_BGG_AUTO_SYNC_DAYS).toBe(7);
      expect(bggAutoSyncDaysFor({})).toBe(7);
      expect(bggAutoSyncDaysFor({ bggAutoSyncDays: 0 })).toBe(0);
      expect(bggAutoSyncDaysFor({ bggAutoSyncDays: 3 })).toBe(3);
    });

    it('describes the setting, including singular days and off', () => {
      expect(describeAutoSync(7)).toContain('every **7 days**');
      expect(describeAutoSync(1)).toContain('every **1 day**');
      expect(describeAutoSync(0)).toContain('**off**');
    });

    it('shows the current setting when no days are given, without changing it', async () => {
      const i = makeInteraction(null);
      await handleAutoSyncConfig(i);
      expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('every **7 days**') }));
      expect(bggAutoSyncDaysFor(await getGuildConfig('g1'))).toBe(7);
    });

    it('saves a new interval', async () => {
      const i = makeInteraction(3);
      await handleAutoSyncConfig(i);
      expect(bggAutoSyncDaysFor(await getGuildConfig('g1'))).toBe(3);
      expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('every **3 days**') }));
    });

    it('turns it off with 0, and that survives a later read', async () => {
      await handleAutoSyncConfig(makeInteraction(0));
      expect(bggAutoSyncDaysFor(await getGuildConfig('g1'))).toBe(0);
      const i = makeInteraction(null);
      await handleAutoSyncConfig(i);
      expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('**off**') }));
    });
  });
});
