import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  addGame,
  addRequest,
  addPendingAsk,
  declineBring,
  getRequestById,
  getRequestsForEvent,
  matchRequestedExpansions,
  findOwnersCoveringExpansions,
  buildRequestExpansionNote,
  upsertGameInfo,
  GameRequest,
  RequestedExpansion,
} from '../src/utils/libraryStorage';
import { addLibraryLink } from '../src/utils/libraryLinkStorage';
import { reconcileRequestCopies } from '../src/utils/libraryBringDm';
import { buildRequestEmbed } from '../src/utils/requestPin';

const OCEANIA: RequestedExpansion = { id: '300', name: 'Wingspan: Oceania Expansion' };
const EUROPE: RequestedExpansion = { id: '301', name: 'Wingspan: European Expansion' };

// Minimal fake client: records who got a DM and what it said.
function makeDmClient() {
  const sent: Array<{ ownerId: string; content: string }> = [];
  const client = {
    users: {
      fetch: vi.fn(async (ownerId: string) => ({
        id: ownerId,
        send: vi.fn(async (payload: { content: string }) => {
          sent.push({ ownerId, content: payload.content });
          return { id: `dm-${sent.length}`, channelId: `dm-channel-${ownerId}` };
        }),
      })),
    },
  } as any;
  return { client, sent, sentTo: () => sent.map((s) => s.ownerId) };
}

describe('requests that name expansions (#114)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-request-expansions-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── storage ──────────────────────────────────────────────────────────────────

  describe('addRequest', () => {
    it('stores the requested expansions on the request', async () => {
      const req = (await addRequest('e1', 'Wingspan', 'u1', undefined, [OCEANIA])) as GameRequest;
      expect((await getRequestById(req.id))?.requiredExpansions).toEqual([OCEANIA]);
    });

    it('leaves the field off entirely when no expansions are given', async () => {
      const none = (await addRequest('e1', 'Wingspan', 'u1')) as GameRequest;
      const empty = (await addRequest('e1', 'Catan', 'u1', undefined, [])) as GameRequest;
      expect(await getRequestById(none.id)).not.toHaveProperty('requiredExpansions');
      expect(await getRequestById(empty.id)).not.toHaveProperty('requiredExpansions');
    });

    it('still works with the original four-argument form (preferred owner only)', async () => {
      const req = (await addRequest('e1', 'Wingspan', 'u1', 'alice')) as GameRequest;
      expect(req.preferredOwnerId).toBe('alice');
      expect(req.requiredExpansions).toBeUndefined();
    });
  });

  describe('matchRequestedExpansions', () => {
    it('matches an owned expansion by BGG id', async () => {
      await addGame('g1', 'alice', 'Totally Different Title', '300', true);
      const { owned, missing } = await matchRequestedExpansions('g1', 'alice', [OCEANIA, EUROPE]);
      expect(owned).toEqual([OCEANIA]);
      expect(missing).toEqual([EUROPE]);
    });

    it('matches by name ignoring case and punctuation when the entry has no BGG id', async () => {
      await addGame('g1', 'alice', 'wingspan oceania expansion'); // added by hand — no id, not flagged as an expansion
      const { owned, missing } = await matchRequestedExpansions('g1', 'alice', [OCEANIA]);
      expect(owned).toEqual([OCEANIA]);
      expect(missing).toEqual([]);
    });

    it('does not count another member\'s expansion', async () => {
      await addGame('g1', 'bob', OCEANIA.name, OCEANIA.id, true);
      expect((await matchRequestedExpansions('g1', 'alice', [OCEANIA])).missing).toEqual([OCEANIA]);
    });

    it('counts an expansion owned by someone whose library the member is a delegate of', async () => {
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addLibraryLink('g1', 'alice', 'bob'); // bob can act on alice's library
      expect((await matchRequestedExpansions('g1', 'bob', [OCEANIA])).owned).toEqual([OCEANIA]);
    });

    it('does not leak across guilds', async () => {
      await addGame('other-guild', 'alice', OCEANIA.name, OCEANIA.id, true);
      expect((await matchRequestedExpansions('g1', 'alice', [OCEANIA])).missing).toEqual([OCEANIA]);
    });
  });

  describe('findOwnersCoveringExpansions', () => {
    beforeEach(async () => {
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addGame('g1', 'alice', EUROPE.name, EUROPE.id, true);
      await addGame('g1', 'bob', OCEANIA.name, OCEANIA.id, true); // only one of the two
    });

    it('returns only owners who have every requested expansion', async () => {
      expect(await findOwnersCoveringExpansions('g1', ['alice', 'bob', 'carol'], [OCEANIA, EUROPE])).toEqual(['alice']);
    });

    it('returns an empty list when nobody has them all', async () => {
      expect(await findOwnersCoveringExpansions('g1', ['bob', 'carol'], [OCEANIA, EUROPE])).toEqual([]);
    });

    it('treats everyone as covering when nothing was requested', async () => {
      expect(await findOwnersCoveringExpansions('g1', ['alice', 'carol'], undefined)).toEqual(['alice', 'carol']);
      expect(await findOwnersCoveringExpansions('g1', ['alice', 'carol'], [])).toEqual(['alice', 'carol']);
    });
  });

  describe('buildRequestExpansionNote', () => {
    it('lists the requested expansions the owner has', async () => {
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addGame('g1', 'alice', EUROPE.name, EUROPE.id, true);
      const note = await buildRequestExpansionNote('g1', 'alice', {
        gameName: 'Wingspan',
        requiredExpansions: [OCEANIA, EUROPE],
      });
      expect(note).toBe(` (with ${OCEANIA.name}, ${EUROPE.name})`);
    });

    it('warns about requested expansions the owner is missing', async () => {
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      const note = await buildRequestExpansionNote('g1', 'alice', {
        gameName: 'Wingspan',
        requiredExpansions: [OCEANIA, EUROPE],
      });
      expect(note).toContain(`(with ${OCEANIA.name})`);
      expect(note).toContain(`you don't have the requested ${EUROPE.name}`);
    });

    it('only warns when the owner has none of the requested expansions', async () => {
      const note = await buildRequestExpansionNote('g1', 'carol', {
        gameName: 'Wingspan',
        requiredExpansions: [OCEANIA],
      });
      expect(note).not.toContain('(with');
      expect(note).toContain(`you don't have the requested ${OCEANIA.name}`);
    });

    it('reports only the requested expansions, not every expansion the owner happens to own', async () => {
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addGame('g1', 'alice', EUROPE.name, EUROPE.id, true);
      const note = await buildRequestExpansionNote('g1', 'alice', { gameName: 'Wingspan', requiredExpansions: [OCEANIA] });
      expect(note).toBe(` (with ${OCEANIA.name})`);
    });

    it('falls back to the original owned-expansions note when the request names none', async () => {
      await upsertGameInfo({
        gameName: 'Wingspan',
        bggExpansions: [EUROPE.name],
        updatedAt: new Date().toISOString(),
      } as any);
      await addGame('g1', 'alice', EUROPE.name, EUROPE.id, true);
      expect(await buildRequestExpansionNote('g1', 'alice', { gameName: 'Wingspan' })).toBe(` (with ${EUROPE.name})`);
    });
  });

  // ── who gets asked ───────────────────────────────────────────────────────────

  describe('reconcileRequestCopies — choosing the owner to ask', () => {
    const rsvps = { yes: ['alice', 'bob', 'carol'], maybe: [] };

    async function ownWingspan(...userIds: string[]) {
      for (const u of userIds) await addGame('g1', u, 'Wingspan');
    }

    async function reconcile(req: GameRequest, client: any, attending = rsvps) {
      await reconcileRequestCopies(client, 'g1', attending, (await getRequestById(req.id))!, 'Saturday');
    }

    it('asks the owner who has the requested expansion, not just whoever has the lightest load', async () => {
      await ownWingspan('alice', 'bob');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      // Give alice a heavier load than bob, so plain fairness would pick bob.
      await addGame('g1', 'alice', 'Catan');
      const busy = (await addRequest('e1', 'Catan', 'requester')) as GameRequest;
      await addPendingAsk(busy.id, 'alice', 'dm', 'msg');

      const req = (await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA])) as GameRequest;
      const { client, sent, sentTo } = makeDmClient();
      await reconcile(req, client);

      expect(sentTo()).toEqual(['alice']);
      expect(sent[0].content).toContain(`(with ${OCEANIA.name})`);
    });

    it('is unchanged when the request names no expansions — fairness still picks the lighter-loaded owner', async () => {
      await ownWingspan('alice', 'bob');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addGame('g1', 'alice', 'Catan');
      const busy = (await addRequest('e1', 'Catan', 'requester')) as GameRequest;
      await addPendingAsk(busy.id, 'alice', 'dm', 'msg');

      const req = (await addRequest('e1', 'Wingspan', 'requester')) as GameRequest;
      const { client, sentTo } = makeDmClient();
      await reconcile(req, client);

      expect(sentTo()).toEqual(['bob']);
    });

    it('does not ask the suggester ahead of an owner with the expansion when the suggester lacks it', async () => {
      await ownWingspan('alice', 'bob');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      const { upsertGame } = await import('../src/utils/gameStorage');
      await upsertGame({
        id: 'g-wingspan', eventId: 'e1', channelId: 'c', messageId: 'm', guildId: 'g1', bggId: '', title: 'Wingspan',
        bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null, minPlaytime: 30, maxPlaytime: 60,
        suggestedStartTime: null, expansions: [OCEANIA], seats: ['bob'], waitlist: [],
        createdAt: new Date().toISOString(), createdBy: 'bob', // bob suggested it but has no Oceania
      } as any);

      const req = (await addRequest('e1', 'Wingspan', 'bob', undefined, [OCEANIA])) as GameRequest;
      const { client, sentTo } = makeDmClient();
      await reconcile(req, client);

      expect(sentTo()).toEqual(['alice']);
    });

    it('only considers owners who are attending', async () => {
      await ownWingspan('alice', 'bob');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);

      const req = (await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA])) as GameRequest;
      const { client, sent, sentTo } = makeDmClient();
      await reconcile(req, client, { yes: ['bob'], maybe: [] }); // alice isn't coming

      expect(sentTo()).toEqual(['bob']);
      expect(sent[0].content).toContain(`you don't have the requested ${OCEANIA.name}`);
    });

    it('falls back to a base-game owner — with a heads-up — when nobody has the expansion, rather than leaving it unbrought', async () => {
      await ownWingspan('alice', 'bob');

      const req = (await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA])) as GameRequest;
      const { client, sent } = makeDmClient();
      await reconcile(req, client);

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toContain('Wingspan');
      expect(sent[0].content).toContain(`you don't have the requested ${OCEANIA.name}`);
    });

    it('moves on to a base-game owner once the owner with the expansion declines', async () => {
      await ownWingspan('alice', 'bob');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);

      const req = (await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA])) as GameRequest;
      const first = makeDmClient();
      await reconcile(req, first.client);
      expect(first.sentTo()).toEqual(['alice']);

      await declineBring(req.id, 'alice');
      const second = makeDmClient();
      await reconcile(req, second.client);

      expect(second.sentTo()).toEqual(['bob']);
      expect(second.sent[0].content).toContain(`you don't have the requested ${OCEANIA.name}`);
    });

    it('with several owners who have the expansion, still load-balances between just those owners', async () => {
      await ownWingspan('alice', 'bob', 'carol');
      await addGame('g1', 'alice', OCEANIA.name, OCEANIA.id, true);
      await addGame('g1', 'bob', OCEANIA.name, OCEANIA.id, true);
      // alice already has a pending ask, so bob (also covering) should be next; carol must not be asked.
      await addGame('g1', 'alice', 'Catan');
      const busy = (await addRequest('e1', 'Catan', 'requester')) as GameRequest;
      await addPendingAsk(busy.id, 'alice', 'dm', 'msg');

      const req = (await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA])) as GameRequest;
      const { client, sentTo } = makeDmClient();
      await reconcile(req, client);

      expect(sentTo()).toEqual(['bob']);
    });
  });

  // ── "Games to Bring" pin ─────────────────────────────────────────────────────

  describe('buildRequestEmbed', () => {
    it('shows the requested expansions next to the game', async () => {
      await addGame('g1', 'alice', 'Wingspan');
      await addRequest('e1', 'Wingspan', 'requester', undefined, [OCEANIA, EUROPE]);

      const embed = (await buildRequestEmbed('g1', await getRequestsForEvent('e1'), { alice: 'Alice' })).toJSON();
      const text = embed.fields!.map((f) => f.value).join('\n');
      expect(text).toContain(`Wingspan *(+ ${OCEANIA.name}, ${EUROPE.name})*`);
    });

    it('is unchanged for a request with no expansions', async () => {
      await addGame('g1', 'alice', 'Wingspan');
      await addRequest('e1', 'Wingspan', 'requester');

      const embed = (await buildRequestEmbed('g1', await getRequestsForEvent('e1'), { alice: 'Alice' })).toJSON();
      const text = embed.fields!.map((f) => f.value).join('\n');
      expect(text).toContain('• Wingspan');
      expect(text).not.toContain('(+');
    });
  });
});
