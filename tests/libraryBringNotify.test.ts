import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  weightTag: vi.fn(() => 'Medium'),
  fetchBggOwnedCollection: vi.fn(() => null),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return { ...actual, searchCatalog: vi.fn(() => []), isCatalogLoaded: vi.fn(() => true) };
});

vi.mock('../src/utils/bggAccountStorage', () => ({ getBggAccount: vi.fn(() => null) }));

vi.mock('../src/utils/userCollectionStorage', () => ({
  mergeUserCollection: vi.fn(),
  getUserCollection: vi.fn(() => []),
  setUserCollection: vi.fn(),
  updateCollectionEntry: vi.fn(),
}));

vi.mock('../src/utils/gameRoles', () => ({ getGameRoles: vi.fn(() => []) }));
vi.mock('../src/utils/pins', () => ({ upsertLibraryPin: vi.fn() }));
vi.mock('../src/utils/requestPin', () => ({ updateRequestPin: vi.fn(async () => {}) }));

const mockLoadGameNights = vi.fn();
const mockFindGameNight = vi.fn();
vi.mock('../src/utils/storage', () => ({
  loadGameNights: () => mockLoadGameNights(),
  findGameNight: (id: string) => mockFindGameNight(id),
  upsertGameNight: vi.fn(),
}));

import {
  execute,
  handleLibraryConfirmBring,
  handleLibraryDeclineBring,
  handleHubRequestButton,
  handleHubRequestModal,
  handleHubViewModal,
  handleHubBringButton,
} from '../src/commands/library';
import { addGame, getRequestsForEvent, getRequestById, addPendingAsk, addRequest } from '../src/utils/libraryStorage';
import { reconcileRequestCopies } from '../src/utils/libraryBringDm';

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'event-1',
    guildId: 'g1',
    eventChannelId: 'event-channel-1',
    startTimeISO: future,
    endTimeISO: null,
    date: 'Saturday',
    cancelled: false,
    archived: false,
    rsvps: { yes: [], maybe: [], no: [] },
    ...overrides,
  };
}

// A fake client whose DM sends produce editable "messages" keyed by channel+message id,
// so invalidateBringDm / the confirm button can later fetch and edit them.
function makeDmClient() {
  const dmMessages = new Map<string, { content: string; edit: ReturnType<typeof vi.fn> }>();
  const sentTo: string[] = [];

  const client = {
    users: {
      fetch: vi.fn(async (ownerId: string) => ({
        id: ownerId,
        send: vi.fn(async (payload: { content: string }) => {
          sentTo.push(ownerId);
          const channelId = `dm-channel-${ownerId}`;
          const messageId = `dm-message-${sentTo.length}`;
          const msg = {
            content: payload.content,
            edit: vi.fn(async (editPayload: { content: string }) => {
              msg.content = editPayload.content;
            }),
          };
          dmMessages.set(`${channelId}:${messageId}`, msg);
          return { id: messageId, channelId };
        }),
      })),
    },
    channels: {
      fetch: vi.fn(async (channelId: string) => ({
        isTextBased: () => true,
        messages: {
          fetch: vi.fn(async (messageId: string) => dmMessages.get(`${channelId}:${messageId}`)),
        },
      })),
    },
  };
  return { client, sentTo, dmMessages };
}

function makeRequestInteraction(gameName: string, client: any, opts: Partial<Record<string, unknown>> = {}) {
  return {
    options: {
      getSubcommand: () => 'request',
      getSubcommandGroup: (_allowNull?: boolean) => null,
      getString: (name: string) => (name === 'game' ? gameName : null),
    },
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    guildId: 'g1',
    channelId: 'event-channel-1',
    user: { id: 'requester' },
    client,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    ...opts,
  } as any;
}

function makeBringConfirmInteraction(gameName: string, userId: string, client: any) {
  return {
    options: {
      getSubcommand: () => 'bring',
      getSubcommandGroup: (_allowNull?: boolean) => null,
      getString: (name: string) => (name === 'game' ? gameName : null),
    },
    reply: vi.fn(async () => {}),
    guildId: 'g1',
    channelId: 'event-channel-1',
    user: { id: userId },
    client,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
  } as any;
}

describe('bring-request DM notifications', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-bring-dm-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
    mockFindGameNight.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not DM anyone before the lineup locks — the ask is deferred', async () => {
    // No "please bring this" DM goes out at request-creation time anymore;
    // it waits for lock so pickPreferredOwner sees final confirmed-brings
    // counts instead of an early, mostly-arbitrary snapshot.
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] } });
    mockLoadGameNights.mockReturnValue([event]);

    const { client, sentTo } = makeDmClient();
    const interaction = makeRequestInteraction('Wingspan', client);
    await execute(interaction);

    expect(sentTo).toEqual([]);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('will be asked to bring it once the lineup locks') }),
    );
    const [req] = await getRequestsForEvent('event-1');
    expect(req.pendingAsks).toEqual([]);
  });

  it('DMs the sole owner with a confirm button when /library request succeeds after the lineup is already locked', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] }, suggestionsLocked: true });
    mockLoadGameNights.mockReturnValue([event]);

    const { client, sentTo } = makeDmClient();
    const interaction = makeRequestInteraction('Wingspan', client);
    await execute(interaction);

    expect(sentTo).toEqual(['alice']);
    const [req] = await getRequestsForEvent('event-1');
    expect(req.pendingAsks).toEqual([
      expect.objectContaining({ ownerId: 'alice', dmChannelId: 'dm-channel-alice' }),
    ]);
    expect(req.pendingAsks[0].dmMessageId).toBeTruthy();
  });

  it('load-balances the DM to whichever attending owner has fewest confirmed brings, for a late request made after the lineup locks', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    await addGame('g1', 'bob', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice', 'bob'], maybe: [], no: [] }, suggestionsLocked: true });
    mockLoadGameNights.mockReturnValue([event]);

    const { client, sentTo } = makeDmClient();
    const interaction = makeRequestInteraction('Wingspan', client);
    await execute(interaction);

    // Neither owner has any confirmed brings yet, so pickPreferredOwner falls
    // back to the first attending owner (alice).
    expect(sentTo).toEqual(['alice']);
    const [req] = await getRequestsForEvent('event-1');
    expect(req.pendingAsks).toEqual([expect.objectContaining({ ownerId: 'alice' })]);
  });

  it('does not DM anyone when the request is a duplicate', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] }, suggestionsLocked: true });
    mockLoadGameNights.mockReturnValue([event]);

    const { client: client1 } = makeDmClient();
    await execute(makeRequestInteraction('Wingspan', client1));

    const { client: client2, sentTo: sentTo2 } = makeDmClient();
    await execute(makeRequestInteraction('Wingspan', client2));

    expect(sentTo2).toEqual([]);
  });
});

describe('handleLibraryConfirmBring (DM button)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-confirmbring-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
    mockFindGameNight.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeButtonInteraction(userId: string, client: any) {
    return {
      user: { id: userId },
      client,
      message: { content: '🎲 Someone requested that you bring **Wingspan**!' },
      update: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('confirms bringing when the clicking user owns the game', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent();
    mockFindGameNight.mockResolvedValue(event);
    const req = await import('../src/utils/libraryStorage').then((m) =>
      m.addRequest('event-1', 'Wingspan', 'requester'),
    );

    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryConfirmBring(interaction, (req as any).id);

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('✅ Confirmed'), components: [] }),
    );
    const stored = await getRequestById((req as any).id);
    expect(stored?.confirmations).toEqual([expect.objectContaining({ ownerId: 'alice' })]);
  });

  it("rejects confirmation when the clicking user doesn't own the game", async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent();
    mockFindGameNight.mockResolvedValue(event);
    const req = await import('../src/utils/libraryStorage').then((m) =>
      m.addRequest('event-1', 'Wingspan', 'requester'),
    );

    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('mallory', client);
    await handleLibraryConfirmBring(interaction, (req as any).id);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can only confirm") }),
    );
    const stored = await getRequestById((req as any).id);
    expect(stored?.confirmations).toEqual([]);
  });

  it('gracefully handles a click on a request that no longer exists', async () => {
    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryConfirmBring(interaction, 'no-such-request-id');

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer exists'), components: [] }),
    );
  });
});

describe('/library bring invalidates a pending DM on confirm', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-bring-invalidate-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
    mockFindGameNight.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('edits the pending DM to note it was confirmed via /library bring', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent();
    mockLoadGameNights.mockReturnValue([event]);

    const { addRequest } = await import('../src/utils/libraryStorage');
    const req = await addRequest('event-1', 'Wingspan', 'requester');

    const { client, dmMessages } = makeDmClient();
    // Simulate a DM already having been sent for this request.
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');
    dmMessages.set('dm-channel-alice:dm-message-1', {
      content: '🎲 Someone requested that you bring **Wingspan**!',
      edit: vi.fn(async () => {}),
    });

    const interaction = makeBringConfirmInteraction('Wingspan', 'alice', client);
    await execute(interaction);

    const editedMsg = dmMessages.get('dm-channel-alice:dm-message-1');
    expect(editedMsg?.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Confirmed via /library bring'), components: [] }),
    );
  });
});

describe('handleLibraryDeclineBring (DM button)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-declinebring-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
    mockFindGameNight.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeButtonInteraction(userId: string, client: any) {
    return {
      user: { id: userId },
      client,
      message: { content: '🎲 Someone requested that you bring **Wingspan**!' },
      update: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('declines and moves the owner to declinedOwnerIds', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] } });
    mockFindGameNight.mockResolvedValue(event);
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');

    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryDeclineBring(interaction, (req as any).id);

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No problem'), components: [] }),
    );
    const stored = await getRequestById((req as any).id);
    expect(stored?.declinedOwnerIds).toEqual(['alice']);
    expect(stored?.pendingAsks).toEqual([]);
  });

  it('cascades to a second attending owner once the first declines', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    await addGame('g1', 'bob', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice', 'bob'], maybe: [], no: [] } });
    mockFindGameNight.mockResolvedValue(event);
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');

    const { client, sentTo } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryDeclineBring(interaction, (req as any).id);

    // The decline handler calls reconcileRequestCopies, which should ask bob next.
    expect(sentTo).toEqual(['bob']);
    const stored = await getRequestById((req as any).id);
    expect(stored?.pendingAsks).toEqual([expect.objectContaining({ ownerId: 'bob' })]);
  });

  it('replies with "not asked" when the clicking user has no pending ask on this request', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent();
    mockFindGameNight.mockResolvedValue(event);
    const req = await addRequest('event-1', 'Wingspan', 'requester');

    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryDeclineBring(interaction, (req as any).id);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("weren't asked") }),
    );
  });

  it('gracefully handles a decline on a request that no longer exists', async () => {
    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('alice', client);
    await handleLibraryDeclineBring(interaction, 'no-such-request-id');

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer exists'), components: [] }),
    );
  });
});

describe('reconcileRequestCopies', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-reconcile-copies-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('asks an additional attending owner when copiesNeeded grows beyond what is pending+confirmed', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    await addGame('g1', 'bob', 'Wingspan');
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');
    await (await import('../src/utils/libraryStorage')).updateRequestCopies('event-1', 'Wingspan', 2);

    const { client, sentTo } = makeDmClient();
    const updated = await getRequestById((req as any).id);
    await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'bob'], maybe: [] }, updated!, 'Saturday');

    expect(sentTo).toEqual(['bob']);
    const stored = await getRequestById((req as any).id);
    expect(stored?.pendingAsks.map((a) => a.ownerId).sort()).toEqual(['alice', 'bob']);
  });

  it('retracts and invalidates the most recently asked owner when copiesNeeded shrinks', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    await addGame('g1', 'bob', 'Wingspan');
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');
    await addPendingAsk((req as any).id, 'bob', 'dm-channel-bob', 'dm-message-2');

    const { client, dmMessages } = makeDmClient();
    dmMessages.set('dm-channel-bob:dm-message-2', {
      content: '🎲 Someone requested that you bring **Wingspan**!',
      edit: vi.fn(async () => {}),
    });
    const updated = await getRequestById((req as any).id);
    await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'bob'], maybe: [] }, updated!, 'Saturday');

    const editedMsg = dmMessages.get('dm-channel-bob:dm-message-2');
    expect(editedMsg?.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No longer needed'), components: [] }),
    );
    const stored = await getRequestById((req as any).id);
    expect(stored?.pendingAsks).toEqual([expect.objectContaining({ ownerId: 'alice' })]);
  });

  describe('choosing which owner to ask (issue #101)', () => {
    async function suggest(eventId: string, title: string, createdBy: string) {
      const { upsertGame } = await import('../src/utils/gameStorage');
      await upsertGame({
        id: `g-${title}`, eventId, channelId: 'c', messageId: 'm', guildId: 'g1', bggId: '', title, bggLink: '',
        minPlayers: 1, maxPlayers: 4, suggestedPlayers: null, minPlaytime: 30, maxPlaytime: 60,
        suggestedStartTime: null, expansions: [], seats: [createdBy], waitlist: [],
        createdAt: new Date().toISOString(), createdBy,
      } as any);
    }

    it('spreads a lock-time batch of requests across owners instead of asking the first owner for everything', async () => {
      const titles = ['Wingspan', 'Catan', 'Azul', 'Root'];
      for (const t of titles) {
        await addGame('g1', 'alice', t);
        await addGame('g1', 'bob', t);
      }
      const requests = [];
      for (const t of titles) requests.push(await addRequest('event-1', t, 'requester'));

      const { client, sentTo } = makeDmClient();
      const rsvps = { yes: ['alice', 'bob'], maybe: [] };
      // Mirrors lockAndScheduleEvent's loop: each request reconciled in turn,
      // with nothing confirmed yet.
      for (const r of requests) await reconcileRequestCopies(client, 'g1', rsvps, (await getRequestById((r as any).id))!, 'Saturday');

      expect(sentTo).toHaveLength(4);
      expect(sentTo.filter((id) => id === 'alice')).toHaveLength(2);
      expect(sentTo.filter((id) => id === 'bob')).toHaveLength(2);
    });

    it('asks the owner who suggested the game ahead of fairness', async () => {
      await addGame('g1', 'alice', 'Wingspan');
      await addGame('g1', 'bob', 'Wingspan');
      await suggest('event-1', 'Wingspan', 'bob');
      const req = await addRequest('event-1', 'Wingspan', 'requester');

      const { client, sentTo } = makeDmClient();
      await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'bob'], maybe: [] }, (await getRequestById((req as any).id))!, 'Saturday');

      expect(sentTo).toEqual(['bob']);
    });

    it('ignores a suggester who does not own the game or is not attending', async () => {
      await addGame('g1', 'alice', 'Wingspan');
      await suggest('event-1', 'Wingspan', 'carol'); // suggested it, but owns no copy
      const req = await addRequest('event-1', 'Wingspan', 'requester');

      const { client, sentTo } = makeDmClient();
      await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'carol'], maybe: [] }, (await getRequestById((req as any).id))!, 'Saturday');

      expect(sentTo).toEqual(['alice']);
    });

    it('still honors an explicit copy-select owner over the suggester', async () => {
      await addGame('g1', 'alice', 'Wingspan');
      await addGame('g1', 'bob', 'Wingspan');
      await suggest('event-1', 'Wingspan', 'bob');
      const req = await addRequest('event-1', 'Wingspan', 'requester', 'alice');

      const { client, sentTo } = makeDmClient();
      await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'bob'], maybe: [] }, (await getRequestById((req as any).id))!, 'Saturday');

      expect(sentTo).toEqual(['alice']);
    });

    it('asks only one owner per copy even when several own the game', async () => {
      for (const o of ['alice', 'bob', 'carol']) await addGame('g1', o, 'Wingspan');
      const req = await addRequest('event-1', 'Wingspan', 'requester');

      const { client, sentTo } = makeDmClient();
      await reconcileRequestCopies(client, 'g1', { yes: ['alice', 'bob', 'carol'], maybe: [] }, (await getRequestById((req as any).id))!, 'Saturday');

      expect(sentTo).toHaveLength(1);
    });
  });

  it('does nothing when pending+confirmed already matches copiesNeeded', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await addPendingAsk((req as any).id, 'alice', 'dm-channel-alice', 'dm-message-1');

    const { client, sentTo } = makeDmClient();
    const updated = await getRequestById((req as any).id);
    await reconcileRequestCopies(client, 'g1', { yes: ['alice'], maybe: [] }, updated!, 'Saturday');

    expect(sentTo).toEqual([]);
    expect((await getRequestById((req as any).id))?.pendingAsks).toHaveLength(1);
  });

  it('stops asking once no more eligible owners remain, leaving the shortfall as-is', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const req = await addRequest('event-1', 'Wingspan', 'requester');
    await (await import('../src/utils/libraryStorage')).updateRequestCopies('event-1', 'Wingspan', 3);

    const { client, sentTo } = makeDmClient();
    const updated = await getRequestById((req as any).id);
    await reconcileRequestCopies(client, 'g1', { yes: ['alice'], maybe: [] }, updated!, 'Saturday');

    // Only one eligible owner exists — asks them once, then stops rather than looping forever.
    expect(sentTo).toEqual(['alice']);
  });
});

describe('hub buttons ("🙋 Request a Game to Bring" / "📋 My Games to Bring")', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-hub-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
    mockFindGameNight.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeButtonInteraction(channelId: string, client: any, userId = 'requester') {
    return {
      channelId,
      guildId: 'g1',
      user: { id: userId },
      client,
      reply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
    } as any;
  }

  function makeModalInteraction(channelId: string, gameName: string, client: any, userId = 'requester') {
    return {
      channelId,
      guildId: 'g1',
      user: { id: userId },
      client,
      reply: vi.fn(async () => {}),
      fields: { getTextInputValue: (name: string) => (name === 'game' ? gameName : '') },
    } as any;
  }

  it('handleHubRequestButton shows a modal asking for the game name', async () => {
    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('event-channel-1', client);

    await handleHubRequestButton(interaction);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0][0].toJSON();
    expect(modal.custom_id).toBe('hub_request_modal');
  });

  it('handleHubRequestModal resolves the event from the channel and creates the request', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] }, suggestionsLocked: true });
    mockLoadGameNights.mockReturnValue([event]);

    const { client, sentTo } = makeDmClient();
    const interaction = makeModalInteraction('event-channel-1', 'Wingspan', client);
    await handleHubRequestModal(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('requested **Wingspan**') }),
    );
    expect(sentTo).toEqual(['alice']);
  });

  it('handleHubBringButton shows the requester\'s bring list for the event in this channel', async () => {
    await addGame('g1', 'alice', 'Wingspan');
    const event = makeEvent({ rsvps: { yes: ['alice'], maybe: [], no: [] } });
    mockLoadGameNights.mockReturnValue([event]);
    await addRequest('event-1', 'Wingspan', 'someone-else');

    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('event-channel-1', client, 'alice');
    await handleHubBringButton(interaction);

    const replyCall = interaction.reply.mock.calls[0][0];
    expect(replyCall.embeds[0].data.title).toContain('Your Games to Bring');
  });

  it('handleHubBringButton replies gracefully when the channel has no active event', async () => {
    mockLoadGameNights.mockReturnValue([]);
    const { client } = makeDmClient();
    const interaction = makeButtonInteraction('no-such-channel', client);

    await handleHubBringButton(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Could not find this event') }),
    );
  });

  it('handleHubViewModal resolves an exact match, the same as /library view', async () => {
    await addGame('g1', 'alice', 'Catan');
    mockLoadGameNights.mockReturnValue([]);
    const interaction = {
      guildId: 'g1',
      user: { id: 'alice' },
      fields: { getTextInputValue: (name: string) => (name === 'game' ? 'Catan' : '') },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;

    await handleHubViewModal(interaction);

    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toBe('Catan');
  });

  it('handleHubViewModal shows a "did you mean" select for a partial match', async () => {
    await addGame('g1', 'alice', 'Catan');
    mockLoadGameNights.mockReturnValue([]);
    const interaction = {
      guildId: 'g1',
      user: { id: 'alice' },
      fields: { getTextInputValue: (name: string) => (name === 'game' ? 'cat' : '') },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;

    await handleHubViewModal(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('did you mean') }),
    );
  });
});
