import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType } from 'discord.js';
import {
  updateGeneralHubPin,
  handleGeneralHubConfig,
  handleHubGeneralRsvpButton,
  handleHubGeneralBrowseButton,
  handleHubGeneralMineButton,
  handleHubGeneralRandomButton,
} from '../src/utils/generalHub';
import { getGuildConfig, updateGuildConfig } from '../src/utils/config';
import { upsertGameNight, GameNight } from '../src/utils/storage';
import { addGame } from '../src/utils/libraryStorage';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: overrides.id ?? 'gn1',
    title: overrides.title ?? 'Board Game Bash',
    date: 'August 22',
    time: '7pm',
    location: 'TBD',
    link: '',
    description: '',
    messageId: 'announce-msg-1',
    channelId: 'announcements',
    guildId: 'guild-1',
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

function makeChannelClient() {
  let nextId = 1;
  const sentMessages = new Map<string, { edit: ReturnType<typeof vi.fn>; pinned: boolean; pin: ReturnType<typeof vi.fn> }>();
  const channel = {
    send: vi.fn(async () => {
      const id = `msg-${nextId++}`;
      const msg = {
        id,
        pinned: false,
        pin: vi.fn(async () => {
          msg.pinned = true;
        }),
        edit: vi.fn(async () => {}),
      };
      sentMessages.set(id, msg as any);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async (id: string) => {
        const msg = sentMessages.get(id);
        if (!msg) throw new Error('message not found');
        return msg;
      }),
    },
  };
  return {
    channels: { fetch: vi.fn(async () => channel) },
    _channel: channel,
  };
}

describe('general "Quick Actions" hub', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-general-hub-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('updateGeneralHubPin', () => {
    it('does nothing when no general hub channel is configured', async () => {
      const client = makeChannelClient();
      await updateGeneralHubPin(client as any, 'guild-1');
      expect(client._channel.send).not.toHaveBeenCalled();
    });

    it('sends and pins the hub message on first call, storing the message id', async () => {
      await updateGuildConfig('guild-1', { generalHubChannelId: 'general-channel-1' });
      const client = makeChannelClient();

      await updateGeneralHubPin(client as any, 'guild-1');

      expect(client._channel.send).toHaveBeenCalledTimes(1);
      const sendCall = client._channel.send.mock.calls[0][0];
      expect(sendCall.embeds[0].data.title).toBe('🎮 Quick Actions');
      const config = await getGuildConfig('guild-1');
      expect(config.generalHubPinMessageId).toBe('msg-1');
    });

    it('edits the existing hub message on a subsequent call instead of posting a new one', async () => {
      await updateGuildConfig('guild-1', { generalHubChannelId: 'general-channel-1' });
      const client = makeChannelClient();

      await updateGeneralHubPin(client as any, 'guild-1');
      await updateGeneralHubPin(client as any, 'guild-1');

      expect(client._channel.send).toHaveBeenCalledTimes(1);
      const msg = await client._channel.messages.fetch('msg-1');
      expect(msg.edit).toHaveBeenCalledTimes(1);
    });

    it('logs a warning but still records the message id when pinning fails', async () => {
      await updateGuildConfig('guild-1', { generalHubChannelId: 'general-channel-1' });
      const channel = {
        send: vi.fn(async () => ({
          id: 'msg-1',
          pinned: false,
          pin: vi.fn(async () => {
            throw new Error('Missing Permissions');
          }),
          edit: vi.fn(async () => {}),
        })),
        messages: { fetch: vi.fn() },
      };
      const client = { channels: { fetch: vi.fn(async () => channel) } };

      await updateGeneralHubPin(client as any, 'guild-1');

      expect((await getGuildConfig('guild-1')).generalHubPinMessageId).toBe('msg-1');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not pin general hub message'), expect.any(Error));
    });
  });

  describe('handleGeneralHubConfig', () => {
    function makeConfigInteraction(channel: { id: string; type: number } | null, client: any) {
      return {
        guildId: 'guild-1',
        options: { getChannel: () => channel },
        client,
        deferReply: vi.fn(async () => {}),
        editReply: vi.fn(async () => {}),
      } as any;
    }

    it('shows the current config when no channel option is given', async () => {
      const interaction = makeConfigInteraction(null, makeChannelClient());
      await handleGeneralHubConfig(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not set') }),
      );
    });

    it('rejects a non-text channel', async () => {
      const interaction = makeConfigInteraction({ id: 'voice-1', type: ChannelType.GuildVoice }, makeChannelClient());
      await handleGeneralHubConfig(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('regular text channel') }),
      );
      expect((await getGuildConfig('guild-1')).generalHubChannelId).toBeUndefined();
    });

    it('sets the channel and posts the hub', async () => {
      const client = makeChannelClient();
      const interaction = makeConfigInteraction({ id: 'general-channel-1', type: ChannelType.GuildText }, client);

      await handleGeneralHubConfig(interaction);

      expect((await getGuildConfig('guild-1')).generalHubChannelId).toBe('general-channel-1');
      expect(client._channel.send).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('has been posted/refreshed') }),
      );
    });
  });

  describe('handleHubGeneralRsvpButton', () => {
    function makeButtonInteraction() {
      return { reply: vi.fn(async () => {}) } as any;
    }

    it('replies with a link button jumping to the soonest upcoming event', async () => {
      await upsertGameNight(makeGameNight({ id: 'gn1', title: 'Board Game Bash', date: 'August 22' }));
      const interaction = makeButtonInteraction();

      await handleHubGeneralRsvpButton(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      const button = replyCall.components[0].components[0].toJSON();
      expect(button.url).toBe('https://discord.com/channels/guild-1/announcements/announce-msg-1');
      expect(button.style).toBe(5); // ButtonStyle.Link
    });

    it('replies with a graceful message when there is no upcoming event', async () => {
      const interaction = makeButtonInteraction();
      await handleHubGeneralRsvpButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('no upcoming event') }),
      );
    });

    it('picks the soonest of multiple upcoming events', async () => {
      const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      await upsertGameNight(makeGameNight({ id: 'gn-later', messageId: 'later-msg', startTimeISO: later }));
      await upsertGameNight(makeGameNight({ id: 'gn-soon', messageId: 'soon-msg', startTimeISO: soon }));
      const interaction = makeButtonInteraction();

      await handleHubGeneralRsvpButton(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      const button = replyCall.components[0].components[0].toJSON();
      expect(button.url).toContain('soon-msg');
    });
  });

  describe('Browse / My Games / Random delegation', () => {
    function makeButtonInteraction(userId = 'u1') {
      return {
        guildId: 'guild-1',
        user: { id: userId },
        guild: { members: { fetch: vi.fn(async (id: string) => ({ id, roles: { cache: { has: () => false } } })) } },
        reply: vi.fn(async () => {}),
      } as any;
    }

    it('Browse Library delegates to the same output as /library list', async () => {
      await addGame('guild-1', 'owner-1', 'Catan');
      const interaction = makeButtonInteraction();

      await handleHubGeneralBrowseButton(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      expect(replyCall.embeds[0].data.fields[0].value).toContain('Catan');
    });

    it('My Games delegates to the same output as /library mine', async () => {
      await addGame('guild-1', 'u2', 'Azul');
      const interaction = makeButtonInteraction('u2');

      await handleHubGeneralMineButton(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      expect(replyCall.embeds[0].data.description).toContain('Azul');
    });

    it('Random Game delegates with no filters applied', async () => {
      await addGame('guild-1', 'owner-1', 'Wingspan');
      const interaction = makeButtonInteraction();

      await handleHubGeneralRandomButton(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      expect(replyCall.embeds[0].data.title).toContain('Random Game');
    });
  });
});
