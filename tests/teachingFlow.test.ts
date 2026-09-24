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
  return { ...actual, searchCatalog: vi.fn(() => []), isCatalogLoaded: vi.fn(() => true) };
});

vi.mock('../src/utils/requestPin', () => ({
  updateRequestPin: vi.fn(),
  updateGameListPin: vi.fn(),
}));

vi.mock('../src/utils/config', () => ({
  getGuildConfig: vi.fn(() => ({})),
}));

import { execute, handleTeachingChoice, handleGameTeachToggle, handleGameLeave } from '../src/commands/game';
import { upsertGameNight, GameNight } from '../src/utils/storage';
import { findGame, findGamesByChannel, upsertGame } from '../src/utils/gameStorage';
import { addGame } from '../src/utils/libraryStorage';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  return {
    id: 'gn-teach',
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
    startTimeISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    endTimeISO: null,
    rsvps: { yes: ['u1', 'u2'], maybe: [], no: [] },
    createdBy: 'host1',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSuggestInteraction() {
  const postedChannel = { send: vi.fn(async () => ({ id: 'card-msg-1' })) };
  return {
    options: {
      getString: (name: string) => (name === 'title' ? 'Wingspan' : null),
      getBoolean: () => null,
      getSubcommand: () => 'suggest',
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    channelId: 'event-channel-1',
    guildId: 'g1',
    user: { id: 'u1' },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    client: { channels: { fetch: vi.fn(async () => postedChannel) } },
    _postedChannel: postedChannel,
  } as any;
}

function buttonClick(userId: string) {
  return {
    user: { id: userId },
    reply: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    client: { users: { fetch: vi.fn(async (id: string) => ({ id })) } },
  } as any;
}

// Waits for the "how well do you know it?" prompt to be shown and returns the
// encoded "<token>_<level>" payload of its Nth button.
async function promptPayload(interaction: any, buttonIndex: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const call = interaction.editReply.mock.calls.find((c: any) => c[0]?.content?.includes('Last step'));
    if (call) {
      const customId = call[0].components[0].toJSON().components[buttonIndex].custom_id as string;
      return customId.slice('game_teach_'.length);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('teaching prompt never appeared');
}

describe('teaching prompt and 🎓 button', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-game-teaching-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    await upsertGameNight(makeGameNight());
    await addGame('g1', 'u1', 'Wingspan');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [0, 'teach', ['u1'], []],
    [1, 'answer', [], ['u1']],
    [2, 'learning', [], []],
  ] as const)('button %i ("%s") is recorded on the created game', async (index, _level, teachers, helpers) => {
    const interaction = makeSuggestInteraction();
    const running = execute(interaction);
    await handleTeachingChoice(buttonClick('u1'), await promptPayload(interaction, index));
    await running;

    const [created] = await findGamesByChannel('event-channel-1');
    expect(created.teachers).toEqual(teachers);
    expect(created.helpers).toEqual(helpers);
  });

  it('does not post the card until the prompt is answered', async () => {
    const interaction = makeSuggestInteraction();
    const running = execute(interaction);
    const payload = await promptPayload(interaction, 0);
    expect(interaction._postedChannel.send).not.toHaveBeenCalled();

    await handleTeachingChoice(buttonClick('u1'), payload);
    await running;
    expect(interaction._postedChannel.send).toHaveBeenCalled();
  });

  it("rejects someone else's click and keeps waiting for the suggester", async () => {
    const interaction = makeSuggestInteraction();
    const running = execute(interaction);
    const payload = await promptPayload(interaction, 0);

    const intruder = buttonClick('other');
    await handleTeachingChoice(intruder, payload);
    expect(intruder.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("isn't your") }));
    expect(intruder.deferUpdate).not.toHaveBeenCalled();
    expect(interaction._postedChannel.send).not.toHaveBeenCalled();

    await handleTeachingChoice(buttonClick('u1'), payload);
    await running;
    expect(interaction._postedChannel.send).toHaveBeenCalled();
  });

  it('reports an expired prompt for an unknown token', async () => {
    const click = buttonClick('u1');
    await handleTeachingChoice(click, 'deadbeef_teach');
    expect(click.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
  });

  it('times out without posting anything', async () => {
    vi.useFakeTimers();
    const interaction = makeSuggestInteraction();
    const running = execute(interaction);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    await running;

    expect(interaction._postedChannel.send).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Timed out') }),
    );
    expect(await findGamesByChannel('event-channel-1')).toHaveLength(0);
  });

  describe('🎓 I Can Teach button', () => {
    beforeEach(async () => {
      await upsertGame({
        id: 'gt1',
        eventId: 'gn-teach',
        channelId: 'event-channel-1',
        messageId: 'm1',
        guildId: 'g1',
        bggId: '',
        title: 'Wingspan',
        bggLink: '',
        minPlayers: 1,
        maxPlayers: 5,
        suggestedPlayers: null,
        minPlaytime: 60,
        maxPlaytime: 60,
        suggestedStartTime: null,
        expansions: [],
        seats: ['u1', 'u2'],
        waitlist: [],
        teachers: [],
        helpers: [],
        createdAt: new Date().toISOString(),
        createdBy: 'u1',
      });
    });

    it('lets a seated player become a teacher, then un-volunteer', async () => {
      const first = buttonClick('u2');
      await handleGameTeachToggle(first, 'gt1');
      expect((await findGame('gt1'))!.teachers).toEqual(['u2']);
      const embed = first.update.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.fields.find((f: any) => f.name === 'Teaching').value).toContain('Can teach');

      await handleGameTeachToggle(buttonClick('u2'), 'gt1');
      expect((await findGame('gt1'))!.teachers).toEqual([]);
    });

    it('refuses someone who is not seated in the game', async () => {
      const outsider = buttonClick('u9');
      await handleGameTeachToggle(outsider, 'gt1');
      expect(outsider.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Join the game first') }),
      );
      expect((await findGame('gt1'))!.teachers).toEqual([]);
    });

    it('drops a teacher from the list when they leave the game', async () => {
      await handleGameTeachToggle(buttonClick('u2'), 'gt1');
      await handleGameLeave(buttonClick('u2'), 'gt1');
      expect((await findGame('gt1'))!.teachers).toEqual([]);
    });
  });
});
