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

import { execute, handleEventSelect } from '../src/commands/game';
import { upsertGameNight, GameNight } from '../src/utils/storage';

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
