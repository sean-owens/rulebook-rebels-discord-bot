import { describe, it, expect, vi } from 'vitest';

const mockGetGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
}));

import { execute } from '../src/commands/gettingStarted';

function makeInteraction() {
  return {
    guildId: 'guild-1',
    reply: vi.fn(async () => {}),
  } as any;
}

describe('/getting-started', () => {
  it('omits the rules-channel step when no rules channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const interaction = makeInteraction();

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).not.toContain('Read the rules');
    expect(embed.description).toContain('RSVP to a game night');
    expect(embed.description).toContain('/myroles');
    expect(embed.description).toContain('/game suggest');
    expect(embed.description).toContain('🎲 Suggest a Game');
    expect(embed.description).toContain('/library list');
  });

  it('includes the rules-channel step first when a rules channel is configured', async () => {
    mockGetGuildConfig.mockResolvedValue({ rulesChannelId: '123', announcementsChannelId: '456' });
    const interaction = makeInteraction();

    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).toContain('**1. Read the rules**');
    expect(embed.description).toContain('<#123>');
    expect(embed.description).toContain('<#456>');
  });

  it('replies ephemerally', async () => {
    mockGetGuildConfig.mockResolvedValue({});
    const interaction = makeInteraction();

    await execute(interaction);

    expect(interaction.reply.mock.calls[0][0].flags).toBeDefined();
  });
});
