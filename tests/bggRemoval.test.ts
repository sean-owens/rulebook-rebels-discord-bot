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

import { applyBggCollectionToLibrary } from '../src/utils/bggLibrarySync';
import { checkBggAutoSync } from '../src/utils/bggAutoSync';
import {
  createRemovalProposal,
  getRemovalProposal,
  resolveRemovalProposal,
  REMOVAL_PROPOSAL_MAX_AGE_DAYS,
} from '../src/utils/bggRemovalStorage';
import {
  buildRemovalProposalDm,
  buildRemovalProposalButtons,
  BGG_REMOVE_YES_PREFIX,
  BGG_REMOVE_NO_PREFIX,
} from '../src/utils/bggRemovalDm';
import { handleBggRemovalConfirm, handleBggRemovalKeep } from '../src/commands/bggRemoval';
import { setBggAccount, getBggAccount, recordBggSyncAttempt } from '../src/utils/bggAccountStorage';
import { addGame, removeGame, loadLibraryForGuild } from '../src/utils/libraryStorage';
import { getUserCollection, setUserCollection } from '../src/utils/userCollectionStorage';
import { runRetentionCleanup } from '../src/utils/guildLifecycle';
import { writeJson } from '../src/utils/db';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

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

const proposed = (id: string, name: string, isExpansion = false) => ({ bggGameId: id, gameName: name, isExpansion });

describe('removal proposals for games that left BGG', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bgg-removal-test-'));
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

  // ── storage ──────────────────────────────────────────────────────────────────

  describe('proposal storage', () => {
    it('creates, reads back, and resolves a proposal', async () => {
      const p = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')]);
      expect(p.id).toBeTruthy();
      expect(await getRemovalProposal(p.id)).toMatchObject({ guildId: 'g1', userId: 'u1', games: [proposed('2', 'Azul')] });

      await resolveRemovalProposal(p.id);
      expect(await getRemovalProposal(p.id)).toBeUndefined();
    });

    it('resolving an unknown proposal is a harmless no-op', async () => {
      await expect(resolveRemovalProposal('nope')).resolves.toBeUndefined();
    });

    it('gives each proposal its own id', async () => {
      const a = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')]);
      const b = await createRemovalProposal('g1', 'u1', [proposed('3', 'Catan')]);
      expect(a.id).not.toBe(b.id);
      expect(await getRemovalProposal(a.id)).toBeDefined();
      expect(await getRemovalProposal(b.id)).toBeDefined();
    });

    it('drops proposals older than the max age when a new one is created', async () => {
      const old = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')], new Date(daysAgo(REMOVAL_PROPOSAL_MAX_AGE_DAYS + 1)));
      const fresh = await createRemovalProposal('g1', 'u1', [proposed('3', 'Catan')], NOW);

      expect(await getRemovalProposal(old.id)).toBeUndefined();
      expect(await getRemovalProposal(fresh.id)).toBeDefined();
    });

    it("is purged with the rest of a server's data when the server is gone for good", async () => {
      const gone = await createRemovalProposal('gone-guild', 'u1', [proposed('2', 'Azul')]);
      const kept = await createRemovalProposal('other-guild', 'u2', [proposed('3', 'Catan')]);
      await writeJson('deleted_guilds.json', [
        { guildId: 'gone-guild', guildName: 'Old Server', deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() },
      ]);

      await runRetentionCleanup();

      expect(await getRemovalProposal(gone.id)).toBeUndefined();
      expect(await getRemovalProposal(kept.id)).toBeDefined();
    });
  });

  // ── the question the member sees ─────────────────────────────────────────────

  describe('buildRemovalProposalDm / buttons', () => {
    it('lists the games and says nothing is removed unless they tap Remove', () => {
      const dm = buildRemovalProposalDm([proposed('2', 'Azul'), proposed('3', 'Catan')]);
      expect(dm).toContain('• Azul');
      expect(dm).toContain('• Catan');
      expect(dm).toContain('Nothing is removed unless you tap Remove');
    });

    it('marks expansions', () => {
      expect(buildRemovalProposalDm([proposed('9', 'Wingspan: Oceania Expansion', true)])).toContain('Oceania Expansion *(expansion)*');
    });

    it('reads naturally for one item and for several', () => {
      expect(buildRemovalProposalDm([proposed('2', 'Azul')])).toContain('1 item is no longer');
      expect(buildRemovalProposalDm([proposed('2', 'Azul'), proposed('3', 'Catan')])).toContain('2 items are no longer');
    });

    it('truncates a long list instead of exceeding the DM size limit', () => {
      const many = Array.from({ length: 40 }, (_, i) => proposed(String(i), `Game ${i + 1}`));
      const dm = buildRemovalProposalDm(many);
      expect(dm).toContain('Game 15');
      expect(dm).not.toContain('Game 16');
      expect(dm).toContain('and 25 more');
      expect(dm.length).toBeLessThan(2000);
    });

    it('has a Remove button and a Keep button carrying the proposal id', () => {
      const row = buildRemovalProposalButtons('abc123', 3).toJSON();
      const [yes, no] = row.components as any[];
      expect(yes.custom_id).toBe(`${BGG_REMOVE_YES_PREFIX}abc123`);
      expect(yes.label).toContain('Remove all 3');
      expect(no.custom_id).toBe(`${BGG_REMOVE_NO_PREFIX}abc123`);
      expect(no.label).toContain('Keep');
    });

    it('labels the Remove button for a single item', () => {
      const yes = (buildRemovalProposalButtons('abc123', 1).toJSON().components as any[])[0];
      expect(yes.label).toContain('Remove it');
    });
  });

  // ── detecting what left BGG ──────────────────────────────────────────────────

  describe('applyBggCollectionToLibrary — detection', () => {
    async function importedMember() {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');
    }

    it('proposes a library game that has left their BGG collection', async () => {
      await importedMember();
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([proposed('2', 'Azul')]);
      expect(summary.heldBack).toBe(false);
    });

    it('only ever proposes — the library is untouched', async () => {
      await importedMember();
      await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName).sort()).toEqual(['Azul', 'Wingspan']);
    });

    it('does not propose a game that is still on BGG', async () => {
      await importedMember();
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan'), bggGame('2', 'Azul')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([]);
    });

    it('does not propose a game the member already removed from the library themselves', async () => {
      await importedMember();
      await removeGame('g1', 'u1', 'Azul');
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([]);
    });

    it('does not propose an entry the member added by hand (no BGG id), even with the same name', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul'); // typed in manually — not tied to BGG
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([]);
    });

    it('does not propose a library game that was never in their BGG snapshot', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Catan', '3'); // has a BGG id, but they never owned it on BGG
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([]);
    });

    it('flags expansions as such', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('9', 'Wingspan: Oceania Expansion')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Wingspan: Oceania Expansion', '9', true);
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([proposed('9', 'Wingspan: Oceania Expansion', true)]);
    });

    it("never proposes anything for a manual import ('all' mode)", async () => {
      await importedMember();
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'all');
      expect(summary.noLongerOnBgg).toEqual([]);
    });

    it("only considers the member's own library, not other members'", async () => {
      await importedMember();
      await addGame('g1', 'u2', 'Azul', '2'); // someone else owns Azul too
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(summary.noLongerOnBgg).toEqual([proposed('2', 'Azul')]);
    });

    it('asks about a game only once — the refreshed snapshot no longer contains it', async () => {
      await importedMember();
      await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      const again = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan')], 'new-only');
      expect(again.noLongerOnBgg).toEqual([]);
    });
  });

  // ── the empty-response guard ─────────────────────────────────────────────────

  describe('applyBggCollectionToLibrary — empty response guard', () => {
    it('holds back and writes nothing when BGG returns an empty collection for a member who had games', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');

      const summary = await applyBggCollectionToLibrary('g1', 'u1', [], 'new-only');

      expect(summary.heldBack).toBe(true);
      expect(summary.noLongerOnBgg).toEqual([]);
      expect(summary.addedGames).toBe(0);
      // snapshot intact — wiping it would make every game look "new" next time
      expect((await getUserCollection('g1', 'u1')).map((e) => e.bggGameId).sort()).toEqual(['1', '2']);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName).sort()).toEqual(['Azul', 'Wingspan']);
    });

    it('does not re-add a game the member removed after an empty response, once BGG recovers', async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');
      await removeGame('g1', 'u1', 'Azul'); // deliberately removed

      await applyBggCollectionToLibrary('g1', 'u1', [], 'new-only'); // glitchy empty response
      const recovered = await applyBggCollectionToLibrary('g1', 'u1', [bggGame('1', 'Wingspan'), bggGame('2', 'Azul')], 'new-only');

      expect(recovered.addedGameNames).toEqual([]);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).not.toContain('Azul');
    });

    it('is not held back when the member had no games to begin with', async () => {
      await setUserCollection('g1', 'u1', []);
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [], 'new-only');
      expect(summary.heldBack).toBe(false);
    });

    it("never holds back a manual import ('all' mode)", async () => {
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan')]);
      const summary = await applyBggCollectionToLibrary('g1', 'u1', [], 'all');
      expect(summary.heldBack).toBe(false);
      expect(await getUserCollection('g1', 'u1')).toEqual([]); // a member-asked refresh is believed
    });
  });

  // ── the member's answer ──────────────────────────────────────────────────────

  describe('button handlers', () => {
    function makeButton(userId: string) {
      return {
        user: { id: userId },
        update: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
      } as any;
    }

    async function setup() {
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');
      await addGame('g1', 'u1', 'Catan', '3');
      await addGame('g1', 'u2', 'Azul', '2'); // another member's copy must be left alone
      return createRemovalProposal('g1', 'u1', [proposed('2', 'Azul'), proposed('3', 'Catan')]);
    }

    it('Remove takes the proposed games off the proposer\'s library and nobody else\'s', async () => {
      const p = await setup();
      const i = makeButton('u1');
      await handleBggRemovalConfirm(i, p.id);

      const lib = await loadLibraryForGuild('g1');
      expect(lib.filter((e) => e.userId === 'u1').map((e) => e.gameName)).toEqual(['Wingspan']);
      expect(lib.filter((e) => e.userId === 'u2').map((e) => e.gameName)).toEqual(['Azul']);
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('**2** games'), components: [] }));
    });

    it('names the game when only one is removed', async () => {
      await addGame('g1', 'u1', 'Azul', '2');
      const p = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')]);
      const i = makeButton('u1');
      await handleBggRemovalConfirm(i, p.id);
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('**Azul**') }));
    });

    it('leaves a game alone that the member has since re-added by hand (no BGG id)', async () => {
      await addGame('g1', 'u1', 'Azul'); // typed in themselves after the proposal was made
      const p = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')]);
      const i = makeButton('u1');
      await handleBggRemovalConfirm(i, p.id);

      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toEqual(['Azul']);
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Nothing to remove') }));
    });

    it('says so when the games were already gone', async () => {
      const p = await createRemovalProposal('g1', 'u1', [proposed('2', 'Azul')]);
      const i = makeButton('u1');
      await handleBggRemovalConfirm(i, p.id);
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Nothing to remove') }));
    });

    it('closes the question, so a second tap reports it as expired and removes nothing more', async () => {
      const p = await setup();
      await handleBggRemovalConfirm(makeButton('u1'), p.id);
      await addGame('g1', 'u1', 'Azul', '2'); // they added it back afterward

      const again = makeButton('u1');
      await handleBggRemovalConfirm(again, p.id);

      expect(again.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
      expect((await loadLibraryForGuild('g1')).filter((e) => e.userId === 'u1').map((e) => e.gameName)).toContain('Azul');
    });

    it("refuses someone else's tap and leaves the question open", async () => {
      const p = await setup();
      const other = makeButton('intruder');
      await handleBggRemovalConfirm(other, p.id);

      expect(other.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("isn't for you") }));
      expect(other.update).not.toHaveBeenCalled();
      expect((await loadLibraryForGuild('g1')).filter((e) => e.userId === 'u1')).toHaveLength(3);
      expect(await getRemovalProposal(p.id)).toBeDefined();
    });

    it('reports an expired or unknown question without touching anything', async () => {
      await addGame('g1', 'u1', 'Azul', '2');
      const i = makeButton('u1');
      await handleBggRemovalConfirm(i, 'does-not-exist');
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired'), components: [] }));
      expect(await loadLibraryForGuild('g1')).toHaveLength(1);
    });

    it('Keep changes nothing and closes the question', async () => {
      const p = await setup();
      const i = makeButton('u1');
      await handleBggRemovalKeep(i, p.id);

      expect((await loadLibraryForGuild('g1')).filter((e) => e.userId === 'u1')).toHaveLength(3);
      expect(await getRemovalProposal(p.id)).toBeUndefined();
      expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    });

    it("Keep also refuses someone else's tap", async () => {
      const p = await setup();
      const other = makeButton('intruder');
      await handleBggRemovalKeep(other, p.id);
      expect(other.reply).toHaveBeenCalled();
      expect(await getRemovalProposal(p.id)).toBeDefined();
    });
  });

  // ── end to end through the hourly sweep ──────────────────────────────────────

  describe('checkBggAutoSync', () => {
    function makeClient(opts: { dmRejects?: boolean } = {}) {
      const sent: Array<{ userId: string; payload: any }> = [];
      const client = {
        guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async (id: string) => ({ id })) } })) },
        users: {
          fetch: vi.fn(async (userId: string) => {
            if (opts.dmRejects) throw new Error('Cannot send messages to this user');
            return { send: vi.fn(async (payload: any) => void sent.push({ userId, payload })) };
          }),
        },
      } as any;
      return { client, sent };
    }

    async function importedMember() {
      await setBggAccount('g1', 'u1', 'bgg-u1');
      await recordBggSyncAttempt('g1', 'u1', { at: daysAgo(8), success: true });
      await setUserCollection('g1', 'u1', [snapshotEntry('1', 'Wingspan'), snapshotEntry('2', 'Azul')]);
      await addGame('g1', 'u1', 'Wingspan', '1');
      await addGame('g1', 'u1', 'Azul', '2');
    }

    const buttonIds = (payload: any) => (payload.components?.[0]?.toJSON().components as any[]).map((c) => c.custom_id as string);

    it('DMs a question with Remove / Keep buttons when a game has left BGG, and removes nothing itself', async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(1);
      expect(sent[0].payload.content).toContain('Azul');
      const ids = buttonIds(sent[0].payload);
      expect(ids[0]).toMatch(new RegExp(`^${BGG_REMOVE_YES_PREFIX}`));
      expect(ids[1]).toMatch(new RegExp(`^${BGG_REMOVE_NO_PREFIX}`));
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
    });

    it('the button the member taps then actually removes it', async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client, sent } = makeClient();
      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      const proposalId = buttonIds(sent[0].payload)[0].slice(BGG_REMOVE_YES_PREFIX.length);
      const tap = { user: { id: 'u1' }, update: vi.fn(async () => {}), reply: vi.fn(async () => {}) } as any;
      await handleBggRemovalConfirm(tap, proposalId);

      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toEqual(['Wingspan']);
    });

    it('sends two DMs when something was added AND something left in the same sync', async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan'), bggGame('3', 'Catan')]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(2);
      expect(sent.some((m) => m.payload.content.includes('added what was new'))).toBe(true);
      expect(sent.some((m) => m.payload.content.includes('no longer in your BoardGameGeek collection'))).toBe(true);
    });

    it('sends no removal question when nothing left BGG', async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan'), bggGame('2', 'Azul')]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(0);
    });

    it('does not ask about a game the member had already removed from the library', async () => {
      await importedMember();
      await removeGame('g1', 'u1', 'Azul');
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(0);
    });

    it("discards the question and changes nothing if the DM can't be delivered", async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([bggGame('1', 'Wingspan')]);
      const { client } = makeClient({ dmRejects: true });

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName)).toContain('Azul');
      const raw = fs.existsSync(path.join(tmpDir, 'data', 'bgg_removal_proposals.json'))
        ? JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'bgg_removal_proposals.json'), 'utf8'))
        : [];
      expect(raw).toEqual([]);
    });

    it('an empty response from BGG proposes nothing, DMs nothing, and waits a full interval before checking again', async () => {
      await importedMember();
      mockFetchCollection.mockResolvedValue([]);
      const { client, sent } = makeClient();

      await checkBggAutoSync(client, { gapMs: 0, now: NOW });

      expect(sent).toHaveLength(0);
      expect((await loadLibraryForGuild('g1')).map((e) => e.gameName).sort()).toEqual(['Azul', 'Wingspan']);
      expect((await getUserCollection('g1', 'u1')).map((e) => e.bggGameId).sort()).toEqual(['1', '2']);
      // stamped as checked, so the next hourly run does not ask BGG again
      expect((await getBggAccount('g1', 'u1'))?.lastSyncedAt).toBe(NOW.toISOString());
      await checkBggAutoSync(client, { gapMs: 0, now: new Date(NOW.getTime() + 60 * 60 * 1000) });
      expect(mockFetchCollection).toHaveBeenCalledTimes(1);
    });
  });
});
