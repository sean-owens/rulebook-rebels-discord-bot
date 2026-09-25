import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PermissionFlagsBits } from 'discord.js';
import { repostPin, ALL_REPOST_TARGETS } from '../src/utils/repostPins';
import { handleEventRepost } from '../src/commands/host';
import { upsertGameNight, findGameNight, GameNight } from '../src/utils/storage';
import { addSnackItem, findSnackListByChannel, upsertSnackList } from '../src/utils/snackStorage';

const CHANNEL_ID = 'event-channel-1';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  return {
    id: 'gn1',
    date: 'August 22',
    time: '7pm',
    location: 'TBD',
    link: '',
    description: '',
    messageId: 'm1',
    channelId: 'announcements',
    guildId: 'guild-1',
    discordEventId: null,
    eventChannelId: CHANNEL_ID,
    startTimeISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    endTimeISO: null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: 'host1',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// A channel whose send() hands out sequential message ids, so a repost is
// distinguishable from the original by id.
function makeClient() {
  let n = 0;
  const sent: { id: string; embeds: any[]; pin: ReturnType<typeof vi.fn> }[] = [];
  const channel = {
    send: vi.fn(async (payload: any) => {
      const msg = { id: `new-${++n}`, embeds: payload.embeds, pin: vi.fn(async () => {}) };
      sent.push(msg);
      return msg;
    }),
    messages: {
      delete: vi.fn(async () => {}),
      fetch: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    },
  };
  const client = {
    channels: { fetch: vi.fn(async () => channel) },
    guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => ({ displayName: 'Alice' })) } })) },
    users: { cache: new Map() },
  } as any;
  return { client, channel, sent };
}

describe('repostPin', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-repost-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['game_list', 'gameListPinMessageId'],
    ['requests', 'requestPinMessageId'],
    ['hub', 'hubPinMessageId'],
  ] as const)('%s: deletes the old pinned message, posts and pins a fresh one, and stores its id', async (target, field) => {
    const gn = makeGameNight({ [field]: 'old-msg' } as Partial<GameNight>);
    await upsertGameNight(gn);
    const { client, channel, sent } = makeClient();

    expect(await repostPin(client, gn, target)).toBe(true);

    expect(channel.messages.delete).toHaveBeenCalledWith('old-msg');
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(sent[0].pin).toHaveBeenCalled();
    const stored = await findGameNight('gn1');
    expect((stored as any)[field]).toBe('new-1');
  });

  it('posts a new message even when there was no previous pin', async () => {
    const gn = makeGameNight();
    await upsertGameNight(gn);
    const { client, channel } = makeClient();

    expect(await repostPin(client, gn, 'game_list')).toBe(true);

    expect(channel.messages.delete).not.toHaveBeenCalled();
    expect((await findGameNight('gn1'))?.gameListPinMessageId).toBe('new-1');
  });

  it('still reposts when the old message was already deleted by hand', async () => {
    const gn = makeGameNight({ gameListPinMessageId: 'gone' });
    await upsertGameNight(gn);
    const { client, channel } = makeClient();
    channel.messages.delete.mockRejectedValueOnce(new Error('Unknown Message'));

    expect(await repostPin(client, gn, 'game_list')).toBe(true);
    expect((await findGameNight('gn1'))?.gameListPinMessageId).toBe('new-1');
  });

  it('snacks: reposts the list with its current items and updates the stored pin id', async () => {
    const gn = makeGameNight();
    await upsertGameNight(gn);
    await addSnackItem(CHANNEL_ID, 'guild-1', 'gn1', 'user-1', 'Chips');
    const list = (await findSnackListByChannel(CHANNEL_ID))!;
    list.pinMessageId = 'old-snacks';
    await upsertSnackList(list);
    const { client, channel, sent } = makeClient();

    expect(await repostPin(client, gn, 'snacks')).toBe(true);

    expect(channel.messages.delete).toHaveBeenCalledWith('old-snacks');
    expect(JSON.stringify(sent[0].embeds[0].toJSON())).toContain('Chips');
    expect((await findSnackListByChannel(CHANNEL_ID))?.pinMessageId).toBe('new-1');
  });

  it('snacks: does nothing when nobody has started a snack list', async () => {
    const gn = makeGameNight();
    await upsertGameNight(gn);
    const { client, channel } = makeClient();

    expect(await repostPin(client, gn, 'snacks')).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does nothing for an event with no channel', async () => {
    const gn = makeGameNight({ eventChannelId: undefined });
    const { client, channel } = makeClient();
    expect(await repostPin(client, gn, 'game_list')).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('/host event repost', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-repost-cmd-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeInteraction(item: string, opts: { channelId?: string; canManage?: boolean } = {}) {
    const { client, channel, sent } = makeClient();
    const interaction = {
      channelId: opts.channelId ?? CHANNEL_ID,
      client,
      memberPermissions: { has: (p: bigint) => (opts.canManage ?? true) && p === PermissionFlagsBits.ManageEvents },
      options: { getString: () => item },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
    return { interaction, channel, sent };
  }

  it('reposts a single chosen item and reports it privately', async () => {
    await upsertGameNight(makeGameNight({ gameListPinMessageId: 'old' }));
    const { interaction, channel } = makeInteraction('game_list');

    await handleEventRepost(interaction);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Reposted: Game lineup') });
  });

  it('"all" reposts everything that exists and notes a snack list that was never started', async () => {
    await upsertGameNight(makeGameNight());
    const { interaction, channel } = makeInteraction('all');

    await handleEventRepost(interaction);

    // lineup + games to bring + quick actions; no snack list yet
    expect(channel.send).toHaveBeenCalledTimes(ALL_REPOST_TARGETS.length - 1);
    const reply = interaction.editReply.mock.calls[0][0].content as string;
    expect(reply).toContain('Reposted: Game lineup, Games to bring, Quick Actions');
    expect(reply).toContain('Nothing to repost');
    expect(reply).toContain('Snacks list');
  });

  it('refuses members without Manage Events, and channels that are not an active event', async () => {
    await upsertGameNight(makeGameNight());

    const denied = makeInteraction('game_list', { canManage: false });
    await handleEventRepost(denied.interaction);
    expect(denied.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Only hosts and admins') }));
    expect(denied.channel.send).not.toHaveBeenCalled();

    const wrongChannel = makeInteraction('game_list', { channelId: 'random-channel' });
    await handleEventRepost(wrongChannel.interaction);
    expect(wrongChannel.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('active event channel') }));
    expect(wrongChannel.channel.send).not.toHaveBeenCalled();
  });

  it('ignores cancelled and archived events', async () => {
    await upsertGameNight(makeGameNight({ id: 'gn-old', archived: true }));
    const { interaction, channel } = makeInteraction('game_list');
    await handleEventRepost(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('active event channel') }));
    expect(channel.send).not.toHaveBeenCalled();
  });
});
