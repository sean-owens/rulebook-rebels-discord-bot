import { describe, it, expect, vi } from 'vitest';

const mockGetGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
}));

import { handleGuildMemberAdd, handleWelcomeWaveButton } from '../src/events/guildMemberAdd';

function makeMember(overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async () => {});
  const channelSend = vi.fn(async () => ({}));
  const fetch = vi.fn(async () => ({ send: channelSend }));

  const member = {
    id: 'user-1',
    guild: { id: 'guild-1', name: 'Rulebook Rebels', memberCount: 42 },
    client: { channels: { fetch } },
    user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
    displayName: 'Newbie',
    toString: () => '<@user-1>',
    send,
    ...overrides,
  };

  return { member, send, channelSend, fetch };
}

describe('handleGuildMemberAdd', () => {
  it('DMs the new member with the core starter commands, without requiring library add', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const { member, send } = makeMember();

    await handleGuildMemberAdd(member as any);

    expect(send).toHaveBeenCalled();
    const dm = send.mock.calls[0][0] as string;
    expect(dm).toContain('/hub');
    expect(dm).toContain('/myroles');
    expect(dm).toContain('/library list');
    expect(dm).toContain('/game suggest');
    expect(dm).toContain('/getting-started');
    expect(dm).toContain('/help');
    expect(dm).not.toContain('/library add');
  });

  it('posts a welcome embed with library/game-suggest fields when a welcome channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({ welcomeChannelId: 'chan-1' });
    const { member, channelSend, fetch } = makeMember();

    await handleGuildMemberAdd(member as any);

    expect(fetch).toHaveBeenCalledWith('chan-1');
    expect(channelSend).toHaveBeenCalled();
    const embed = channelSend.mock.calls[0][0].embeds[0].toJSON();
    const fieldNames = embed.fields.map((f: any) => f.name);
    expect(fieldNames).toContain('🎮 Quick Actions');
    expect(fieldNames).toContain('📚 Browse the Library');
    expect(fieldNames).toContain('🎲 Suggest a Game');
    expect(embed.fields.find((f: any) => f.name === '🎮 Quick Actions').value).toContain('/hub');
    expect(embed.fields.find((f: any) => f.name === '📚 Browse the Library').value).toContain(
      '/library list',
    );
  });

  it('skips posting to the welcome channel when none is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const { member, fetch } = makeMember();

    await handleGuildMemberAdd(member as any);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts a public announcement with a "Wave to say hi!" button when an announcement channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({ memberAnnouncementChannelId: 'chan-2' });
    const { member, channelSend, fetch } = makeMember();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    await handleGuildMemberAdd(member as any);

    expect(fetch).toHaveBeenCalledWith('chan-2');
    expect(channelSend).toHaveBeenCalled();
    const payload = channelSend.mock.calls[0][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('<@user-1>');
    expect(embed.footer.text).toBe('Member #42');

    const button = payload.components[0].components[0].toJSON();
    expect(button.custom_id).toBe('welcome_wave_user-1');
    expect(button.label).toBe('Wave to say hi!');

    randomSpy.mockRestore();
  });

  it('skips the public announcement when no announcement channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const { member, fetch } = makeMember();

    await handleGuildMemberAdd(member as any);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts both the introductions embed and the public announcement when both channels are configured', async () => {
    mockGetGuildConfig.mockResolvedValue({
      welcomeChannelId: 'chan-1',
      memberAnnouncementChannelId: 'chan-2',
    });
    const { member, fetch, channelSend } = makeMember();

    await handleGuildMemberAdd(member as any);

    expect(fetch).toHaveBeenCalledWith('chan-1');
    expect(fetch).toHaveBeenCalledWith('chan-2');
    expect(channelSend).toHaveBeenCalledTimes(2);
  });

  it('does not throw when posting the announcement fails (e.g. missing permissions)', async () => {
    mockGetGuildConfig.mockResolvedValue({ memberAnnouncementChannelId: 'chan-2' });
    const { member } = makeMember({
      client: {
        channels: {
          fetch: vi.fn(async () => {
            throw new Error('Missing Access');
          }),
        },
      },
    });

    await expect(handleGuildMemberAdd(member as any)).resolves.not.toThrow();
  });

  it('does not throw when the member has DMs disabled', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const { member } = makeMember({
      send: vi.fn(async () => {
        throw new Error('Cannot send messages to this user');
      }),
    });

    await expect(handleGuildMemberAdd(member as any)).resolves.not.toThrow();
  });
});

function makeButtonInteraction(userId: string) {
  return {
    user: { id: userId, toString: () => `<@${userId}>` },
    reply: vi.fn(async () => {}),
  };
}

describe('handleWelcomeWaveButton', () => {
  it('publicly replies that the clicker waved to the new member', async () => {
    const interaction = makeButtonInteraction('waver-1');

    await handleWelcomeWaveButton(interaction as any, 'newmember-1');

    expect(interaction.reply).toHaveBeenCalledWith('👋 <@waver-1> waved to <@newmember-1>!');
  });

  it('replies ephemerally instead when the new member clicks their own wave button', async () => {
    const interaction = makeButtonInteraction('newmember-1');

    await handleWelcomeWaveButton(interaction as any, 'newmember-1');

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain("can't wave to yourself");
    expect(reply.flags).toBeDefined();
  });
});
