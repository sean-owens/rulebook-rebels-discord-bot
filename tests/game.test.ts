import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  searchBGG: vi.fn(() => []),
  getBGGGame: vi.fn(),
  weightTag: vi.fn(() => 'Medium'),
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return {
    ...actual,
    searchCatalog: vi.fn(() => []),
    isCatalogLoaded: vi.fn(() => true),
  };
});

vi.mock('../src/utils/requestPin', () => ({
  updateRequestPin: vi.fn(),
  updateGameListPin: vi.fn(),
}));

vi.mock('../src/utils/config', () => ({
  getGuildConfig: vi.fn(() => ({})),
}));

import { execute, handleEventSelect, handleBGGSearchPage } from '../src/commands/game';
import { upsertGameNight, GameNight } from '../src/utils/storage';
import { searchBGG } from '../src/utils/bgg';
import { updateRequestPin, updateGameListPin } from '../src/utils/requestPin';

const mockSearchBGG = vi.mocked(searchBGG);
const mockUpdateRequestPin = vi.mocked(updateRequestPin);
const mockUpdateGameListPin = vi.mocked(updateGameListPin);

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: overrides.id ?? 'gn1',
    date: 'August 22',
    time: '7pm',
    location: 'TBD',
    link: '',
    description: '',
    messageId: 'm1',
    channelId: 'announcements',
    guildId: 'g1',
    discordEventId: null,
    eventChannelId: 'event-channel-1',
    startTimeISO: future,
    endTimeISO: null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: 'host1',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSuggestInteraction(
  title: string,
  channelId: string,
  guildId = 'g1',
  userId = 'u1',
) {
  const postedChannel = { send: vi.fn(async () => ({ id: 'card-msg-1' })) };
  return {
    options: {
      getString: (name: string) => (name === 'title' ? title : null),
      getBoolean: () => null,
      getSubcommand: () => 'suggest',
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    channelId,
    guildId,
    user: { id: userId },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    client: { channels: { fetch: vi.fn(async () => postedChannel) } },
    _postedChannel: postedChannel,
  } as any;
}

describe('/game suggest — event resolution outside an event channel', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows the event picker when run outside the event channel with exactly one upcoming event', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));

    const interaction = makeSuggestInteraction('Wingspan', 'general-channel');
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Which event would you like to suggest'),
      }),
    );
    // Regression case: previously this single-event case skipped the picker entirely
    // and fell through as if `general-channel` were the event channel, which left
    // `pendingEventContext` unset and broke every follow-up interaction.
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('shows the event picker when run outside any event channel with multiple upcoming events', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));
    await upsertGameNight(
      makeGameNight({
        id: 'gn2',
        eventChannelId: 'event-channel-2',
        startTimeISO: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      }),
    );

    const interaction = makeSuggestInteraction('Wingspan', 'general-channel');
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Which event would you like to suggest'),
      }),
    );
  });

  it('does not show the picker when run inside the event channel', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));

    const interaction = makeSuggestInteraction('Some Custom Game', 'event-channel-1');
    await execute(interaction);

    const replyCall = interaction.reply.mock.calls[0]?.[0];
    if (replyCall) {
      expect(replyCall.content ?? '').not.toContain('Which event would you like to suggest');
    }
    // No library/BGG match → falls through to manual entry for a custom title.
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('replies with a clear message when there are no upcoming events at all', async () => {
    const interaction = makeSuggestInteraction('Wingspan', 'general-channel');
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('no upcoming events'),
      }),
    );
  });

  it('handleEventSelect records pendingEventContext so follow-up interactions can resolve the event', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));

    // Trigger the picker first so pendingEventSuggest is populated for this user.
    const suggestInteraction = makeSuggestInteraction('Wingspan', 'general-channel', 'g1', 'u42');
    await execute(suggestInteraction);

    const selectInteraction = {
      values: ['gn1'],
      guildId: 'g1',
      user: { id: 'u42' },
      update: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;

    await handleEventSelect(selectInteraction);

    // Should not report the event as unavailable — confirms it resolved gn1 correctly.
    expect(selectInteraction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer available') }),
    );
  });
});

describe('/game suggest — BGG results pagination', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  function makeBGGResults(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: String(i),
      name: `Game ${i}`,
      yearPublished: 2000 + i,
    }));
  }

  function makeButtonInteraction(userId: string) {
    return {
      user: { id: userId },
      update: vi.fn(async () => {}),
    } as any;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-bgg-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockSearchBGG.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows no pagination buttons when results fit on one page', async () => {
    await upsertGameNight(makeGameNight());
    mockSearchBGG.mockResolvedValue(makeBGGResults(5));

    const interaction = makeSuggestInteraction('Some Custom Game', 'event-channel-1');
    await execute(interaction);

    const reply = interaction.editReply.mock.calls[0][0];
    expect(reply.components).toHaveLength(1); // select menu row only
    expect(reply.components[0].components[0].options).toHaveLength(6); // 5 results + manual entry
  });

  it('shows Previous (disabled) and Next (enabled) buttons on page 1 when results span multiple pages', async () => {
    await upsertGameNight(makeGameNight());
    mockSearchBGG.mockResolvedValue(makeBGGResults(30));

    const interaction = makeSuggestInteraction('Some Custom Game', 'event-channel-1', 'g1', 'u7');
    await execute(interaction);

    const reply = interaction.editReply.mock.calls[0][0];
    expect(reply.components).toHaveLength(2); // select menu row + pagination row
    const [select] = reply.components[0].components;
    expect(select.options).toHaveLength(25); // 24 results + manual entry on page 1

    const [prevBtn, pageBtn, nextBtn] = reply.components[1].components;
    expect(prevBtn.data.disabled).toBe(true);
    expect(pageBtn.data.label).toBe('Page 1 of 2');
    expect(nextBtn.data.disabled).toBe(false);
  });

  it('clicking Next shows page 2 with the remaining results', async () => {
    await upsertGameNight(makeGameNight());
    mockSearchBGG.mockResolvedValue(makeBGGResults(30));

    const interaction = makeSuggestInteraction('Some Custom Game', 'event-channel-1', 'g1', 'u8');
    await execute(interaction);

    const nextInteraction = makeButtonInteraction('u8');
    await handleBGGSearchPage(nextInteraction, 'next');

    const reply = nextInteraction.update.mock.calls[0][0];
    const [select] = reply.components[0].components;
    expect(select.options).toHaveLength(7); // remaining 6 results + manual entry
    expect(select.options[0].data.label).toBe('Game 24'); // first item of page 2

    const [prevBtn, pageBtn, nextBtn] = reply.components[1].components;
    expect(prevBtn.data.disabled).toBe(false);
    expect(pageBtn.data.label).toBe('Page 2 of 2');
    expect(nextBtn.data.disabled).toBe(true);
  });

  it('clicking Previous from page 2 returns to page 1', async () => {
    await upsertGameNight(makeGameNight());
    mockSearchBGG.mockResolvedValue(makeBGGResults(30));

    const interaction = makeSuggestInteraction('Some Custom Game', 'event-channel-1', 'g1', 'u9');
    await execute(interaction);
    await handleBGGSearchPage(makeButtonInteraction('u9'), 'next');

    const prevInteraction = makeButtonInteraction('u9');
    await handleBGGSearchPage(prevInteraction, 'prev');

    const reply = prevInteraction.update.mock.calls[0][0];
    const [select] = reply.components[0].components;
    expect(select.options[0].data.label).toBe('Game 0');
  });

  it('replies gracefully when paging without a prior search (expired/missing session)', async () => {
    const interaction = makeButtonInteraction('u-no-session');
    await handleBGGSearchPage(interaction, 'next');

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('expired') }),
    );
  });
});

describe('lineup lock enforcement', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-lock-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedLockedGame(locked: boolean) {
    const { upsertGame } = await import('../src/utils/gameStorage');
    await upsertGameNight(makeGameNight({ id: 'gn-lock', suggestionsLocked: locked }));
    const game = {
      id: 'game-lock-1',
      eventId: 'gn-lock',
      channelId: 'event-channel-1',
      messageId: 'msg-1',
      guildId: 'g1',
      bggId: '1',
      title: 'Locked Game',
      bggLink: '',
      minPlayers: 1,
      maxPlayers: 4,
      suggestedPlayers: null,
      minPlaytime: 30,
      maxPlaytime: 60,
      suggestedStartTime: null,
      expansions: [],
      seats: ['seated-1'],
      waitlist: [],
      createdAt: new Date().toISOString(),
      createdBy: 'u1',
    };
    await upsertGame(game as any);
    return game;
  }

  function makeGameButtonInteraction(userId: string) {
    return {
      user: { id: userId },
      client: {},
      reply: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    } as any;
  }

  it('/game suggest is blocked once the event is locked', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn-lock', eventChannelId: 'event-channel-1', suggestionsLocked: true }));
    const interaction = makeSuggestInteraction('Wingspan', 'event-channel-1');

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('locked') }),
    );
  });

  it('Join is blocked once the event is locked', async () => {
    const { handleGameJoin } = await import('../src/commands/game');
    await seedLockedGame(true);
    const interaction = makeGameButtonInteraction('new-player');

    await handleGameJoin(interaction, 'game-lock-1');

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('locked') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('Leave is blocked once the event is locked', async () => {
    const { handleGameLeave } = await import('../src/commands/game');
    await seedLockedGame(true);
    const interaction = makeGameButtonInteraction('seated-1');

    await handleGameLeave(interaction, 'game-lock-1');

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('locked') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('Join Waitlist is blocked once the event is locked', async () => {
    const { handleWaitlistJoin } = await import('../src/commands/game');
    await seedLockedGame(true);
    const interaction = makeGameButtonInteraction('new-player');

    await handleWaitlistJoin(interaction, 'game-lock-1');

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('locked') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('Leave Waitlist is blocked once the event is locked', async () => {
    const { handleWaitlistLeave, handleWaitlistJoin } = await import('../src/commands/game');
    const game = await seedLockedGame(false);
    // Join the waitlist while unlocked, then lock, then try to leave it.
    game.seats = ['seated-1', 'seated-2', 'seated-3', 'seated-4']; // fill seats so waitlist join is valid
    const { upsertGame } = await import('../src/utils/gameStorage');
    await upsertGame(game as any);
    await handleWaitlistJoin(makeGameButtonInteraction('waiter-1'), 'game-lock-1');

    const { upsertGameNight } = await import('../src/utils/storage');
    await upsertGameNight(makeGameNight({ id: 'gn-lock', suggestionsLocked: true }));

    const interaction = makeGameButtonInteraction('waiter-1');
    await handleWaitlistLeave(interaction, 'game-lock-1');

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('locked') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('Join still works normally when the event is not locked', async () => {
    const { handleGameJoin } = await import('../src/commands/game');
    await seedLockedGame(false);
    const interaction = makeGameButtonInteraction('new-player');

    await handleGameJoin(interaction, 'game-lock-1');

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
  });
});

describe('/game suggest — inside a private room', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-room-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockUpdateRequestPin.mockClear();
    mockUpdateGameListPin.mockClear();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedRoom(overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertRoom } = await import('../src/utils/roomStorage');
    const room = {
      id: 'room1',
      guildId: 'g1',
      channelId: 'room-channel-1',
      name: 'Test Room',
      createdBy: 'creator-1',
      invitedUserIds: ['invitee-1'],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    await upsertRoom(room as any);
    return room;
  }

  it('posts directly in the room with no event picker, even with upcoming events present', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));
    await seedRoom();

    const interaction = makeSuggestInteraction('Some Custom Game', 'room-channel-1', 'g1', 'creator-1');
    await execute(interaction);

    const replyCall = interaction.reply.mock.calls[0]?.[0];
    if (replyCall) {
      expect(replyCall.content ?? '').not.toContain('Which event would you like to suggest');
    }
  });

  it('allows suggesting a library game owned by a room member', async () => {
    const { addGame } = await import('../src/utils/libraryStorage');
    await seedRoom();
    await addGame('g1', 'invitee-1', 'Wingspan');

    const interaction = makeSuggestInteraction('Wingspan', 'room-channel-1', 'g1', 'creator-1');
    await execute(interaction);

    expect(interaction._postedChannel.send).toHaveBeenCalled();
  });

  it('rejects a library game whose owner is not a room member, same as the event case', async () => {
    const { addGame } = await import('../src/utils/libraryStorage');
    await seedRoom();
    await addGame('g1', 'outsider-1', 'Wingspan');

    const interaction = makeSuggestInteraction('Wingspan', 'room-channel-1', 'g1', 'creator-1');
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('None of the owners') }),
    );
    expect(interaction._postedChannel.send).not.toHaveBeenCalled();
  });

  it('allows the room creator to suggest a game they own themselves', async () => {
    const { addGame } = await import('../src/utils/libraryStorage');
    await seedRoom();
    await addGame('g1', 'creator-1', 'Wingspan');

    const interaction = makeSuggestInteraction('Wingspan', 'room-channel-1', 'g1', 'creator-1');
    await execute(interaction);

    expect(interaction._postedChannel.send).toHaveBeenCalled();
  });

  it('does not create a request-pin or lineup-pin entry for a room-suggested game', async () => {
    const { addGame } = await import('../src/utils/libraryStorage');
    await seedRoom();
    await addGame('g1', 'invitee-1', 'Wingspan');

    const interaction = makeSuggestInteraction('Wingspan', 'room-channel-1', 'g1', 'creator-1');
    await execute(interaction);

    expect(mockUpdateRequestPin).not.toHaveBeenCalled();
    expect(mockUpdateGameListPin).not.toHaveBeenCalled();
  });
});

describe('/game bgstats', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-bgstats-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeBgStatsInteraction(
    title: string,
    location: string | null,
    channelId: string,
    guildId = 'g1',
    userId = 'u1',
  ) {
    const guild = {
      members: { fetch: vi.fn(async (id: string) => ({ displayName: `Display-${id}` })) },
    };
    return {
      options: {
        getString: (name: string) =>
          name === 'title' ? title : name === 'location' ? location : null,
        getSubcommand: () => 'bgstats',
      },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      channelId,
      guildId,
      user: { id: userId },
      isChatInputCommand: () => true,
      client: {
        channels: { fetch: vi.fn(async () => ({})) },
        guilds: { fetch: vi.fn(async () => guild) },
      },
    } as any;
  }

  async function seedSuggestion(overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGame } = await import('../src/utils/gameStorage');
    const game = {
      id: 'game1',
      eventId: 'gn1',
      channelId: 'event-channel-1',
      messageId: 'm1',
      guildId: 'g1',
      bggId: '266192',
      title: 'Wingspan',
      bggLink: '',
      minPlayers: 1,
      maxPlayers: 4,
      suggestedPlayers: null,
      minPlaytime: 40,
      maxPlaytime: 60,
      suggestedStartTime: null,
      expansions: [],
      seats: ['p1'],
      waitlist: [],
      createdAt: new Date().toISOString(),
      createdBy: 'p1',
      ...overrides,
    };
    await upsertGame(game as any);
    return game;
  }

  it('finds a suggested game by title and posts publicly with the event location, button, and QR code', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1', location: 'The Rec Room' }));
    await seedSuggestion();

    const interaction = makeBgStatsInteraction('Wingspan', null, 'event-channel-1');
    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    const reply = interaction.editReply.mock.calls[0][0];
    expect(reply.files).toHaveLength(1);

    const button = reply.components[0].toJSON().components[0];
    const data = JSON.parse(decodeURIComponent(button.url.split('?data=')[1]));
    expect(data.game.name).toBe('Wingspan');
    expect(data.location).toBe('The Rec Room');
    expect(data.players).toEqual([{ name: 'Display-p1', sourcePlayerId: 'p1', winner: false }]);
  });

  // Regression: BG Stats' link grows with player count and Discord caps button
  // URLs at 512 chars — this crashed /game bgstats in production for any real
  // multi-player game (DiscordAPIError 50035). The QR code has no such limit.
  it('omits the button (but still attaches the QR code) for a game with enough players to exceed the Discord button URL limit', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1', location: 'The Rec Room' }));
    await seedSuggestion({ seats: ['p1', 'p2', 'p3', 'p4', 'p5'] });

    const interaction = makeBgStatsInteraction('Wingspan', null, 'event-channel-1');
    await execute(interaction);

    const reply = interaction.editReply.mock.calls[0][0];
    expect(reply.components).toEqual([]);
    expect(reply.files).toHaveLength(1);
  });

  it('uses the location option to override the event default', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1', location: 'The Rec Room' }));
    await seedSuggestion();

    const interaction = makeBgStatsInteraction('Wingspan', "Sean's place", 'event-channel-1');
    await execute(interaction);

    const reply = interaction.editReply.mock.calls[0][0];
    const button = reply.components[0].toJSON().components[0];
    const data = JSON.parse(decodeURIComponent(button.url.split('?data=')[1]));
    expect(data.location).toBe("Sean's place");
  });

  it('falls back to a blank location in a private room with no location option given', async () => {
    const { upsertRoom } = await import('../src/utils/roomStorage');
    await upsertRoom({
      id: 'room1',
      guildId: 'g1',
      channelId: 'room-channel-1',
      name: 'Test Room',
      createdBy: 'p1',
      invitedUserIds: [],
      createdAt: new Date().toISOString(),
    } as any);
    await seedSuggestion({ channelId: 'room-channel-1' });

    const interaction = makeBgStatsInteraction('Wingspan', null, 'room-channel-1');
    await execute(interaction);

    const reply = interaction.editReply.mock.calls[0][0];
    const button = reply.components[0].toJSON().components[0];
    const data = JSON.parse(decodeURIComponent(button.url.split('?data=')[1]));
    expect(data.location).toBe('');
  });

  it('replies with a clear ephemeral error when no game matches the given title', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn1', eventChannelId: 'event-channel-1' }));
    await seedSuggestion();

    const interaction = makeBgStatsInteraction('Not A Real Game', null, 'event-channel-1');
    await execute(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('No game called'),
        flags: expect.anything(),
      }),
    );
  });
});
