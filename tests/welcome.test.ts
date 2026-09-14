import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';

const mockGetGuildConfig = vi.fn();
const mockUpdateGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
  updateGuildConfig: (...args: unknown[]) => mockUpdateGuildConfig(...args),
}));

const mockHandleGuildMemberAdd = vi.fn();
vi.mock('../src/events/guildMemberAdd', () => ({
  handleGuildMemberAdd: (...args: unknown[]) => mockHandleGuildMemberAdd(...args),
}));

import { handleConfig, handleTest, handleGreet } from '../src/commands/welcome';

function makeInteraction(options: Record<string, unknown> = {}, guildId = 'guild-1') {
  return {
    guildId,
    guild: { members: { fetch: vi.fn(async () => ({ id: 'member-1' })) } },
    user: { id: 'admin-1' },
    options: {
      getChannel: (name: string) => (options[name] as { id: string } | undefined) ?? null,
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getUser: () => ({ id: 'member-1' }),
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}

describe('/admin welcome config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows current config, including the announcement channel, when no options are given', async () => {
    mockGetGuildConfig.mockResolvedValue({
      welcomeChannelId: 'chan-1',
      memberAnnouncementChannelId: '',
      memberAnnouncementImageUrl: '',
      rulesChannelId: '',
      facebookGroupUrl: '',
      bggGroupUrl: '',
    });
    const interaction = makeInteraction();

    await handleConfig(interaction);

    expect(mockUpdateGuildConfig).not.toHaveBeenCalled();
    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('Welcome channel: <#chan-1>');
    expect(reply.content).toContain('Announcement channel: *not set*');
    // No bundled default GIF asset is shipped yet, so this falls all the way to "*not set*"
    // rather than "*not set (using bundled default)*" — see resolveAnnouncementImage.
    expect(reply.content).toContain('Announcement image/GIF: *not set*');
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
  });

  it('sets the announcement channel independently of the welcome channel', async () => {
    mockUpdateGuildConfig.mockResolvedValue({
      welcomeChannelId: '',
      memberAnnouncementChannelId: 'chan-2',
      memberAnnouncementImageUrl: '',
      rulesChannelId: '',
      facebookGroupUrl: '',
      bggGroupUrl: '',
    });
    const interaction = makeInteraction({ announcement_channel: { id: 'chan-2' } });

    await handleConfig(interaction);

    expect(mockUpdateGuildConfig).toHaveBeenCalledWith('guild-1', {
      memberAnnouncementChannelId: 'chan-2',
    });
    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('Announcement channel: <#chan-2>');
  });

  it('sets the announcement image URL and echoes it back verbatim', async () => {
    mockUpdateGuildConfig.mockResolvedValue({
      welcomeChannelId: '',
      memberAnnouncementChannelId: '',
      memberAnnouncementImageUrl: 'https://example.com/wave.gif',
      rulesChannelId: '',
      facebookGroupUrl: '',
      bggGroupUrl: '',
    });
    const interaction = makeInteraction({ announcement_image_url: 'https://example.com/wave.gif' });

    await handleConfig(interaction);

    expect(mockUpdateGuildConfig).toHaveBeenCalledWith('guild-1', {
      memberAnnouncementImageUrl: 'https://example.com/wave.gif',
    });
    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('Announcement image/GIF: https://example.com/wave.gif');
  });
});

describe('/admin welcome test and greet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mentions the announcement channel in the test preview confirmation', async () => {
    const interaction = makeInteraction();

    await handleTest(interaction);

    expect(mockHandleGuildMemberAdd).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('announcement channel'),
    );
  });

  it('sends the welcome message to the specified member for greet', async () => {
    const interaction = makeInteraction();

    await handleGreet(interaction);

    expect(mockHandleGuildMemberAdd).toHaveBeenCalledWith({ id: 'member-1' });
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
