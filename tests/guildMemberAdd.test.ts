import { describe, it, expect, vi } from 'vitest';

const mockGetGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
}));

import { handleGuildMemberAdd } from '../src/events/guildMemberAdd';

function makeMember(overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async () => {});
  const channelSend = vi.fn(async () => {});
  const fetch = vi.fn(async () => ({ send: channelSend }));

  const member = {
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
    expect(fieldNames).toContain('📚 Browse the Library');
    expect(fieldNames).toContain('🎲 Suggest a Game');
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
