import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';

vi.mock('../src/utils/commandUsageStorage', () => ({
  loadCommandUsage: vi.fn(),
}));

import { handleUsage } from '../src/commands/admin';
import { loadCommandUsage, CommandUsageEntry } from '../src/utils/commandUsageStorage';

const mockLoadCommandUsage = loadCommandUsage as unknown as ReturnType<typeof vi.fn>;

function makeInteraction(guildId = 'guild-1') {
  return {
    guildId,
    reply: vi.fn(async () => {}),
  } as any;
}

function entry(overrides: Partial<CommandUsageEntry> = {}): CommandUsageEntry {
  return {
    guildId: 'guild-1',
    commandPath: 'game bgstats',
    totalCalls: 1,
    paramCounts: {},
    lastUsedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('/admin usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports no usage recorded when the guild has no entries', async () => {
    mockLoadCommandUsage.mockResolvedValue([]);
    const interaction = makeInteraction();

    await handleUsage(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'No command usage recorded yet.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('lists commands sorted by call count, most-used first, with param counts', async () => {
    mockLoadCommandUsage.mockResolvedValue([
      entry({ commandPath: 'library add', totalCalls: 2, paramCounts: { game: 2 } }),
      entry({
        commandPath: 'game bgstats',
        totalCalls: 5,
        paramCounts: { location: 3, title: 5 },
      }),
    ]);
    const interaction = makeInteraction();

    await handleUsage(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    const bgstatsIndex = reply.content.indexOf('/game bgstats');
    const libraryIndex = reply.content.indexOf('/library add');
    expect(bgstatsIndex).toBeGreaterThanOrEqual(0);
    expect(bgstatsIndex).toBeLessThan(libraryIndex);
    expect(reply.content).toContain('5 calls');
    expect(reply.content).toContain('title: 5');
    expect(reply.content).toContain('location: 3');
    expect(reply.content).toContain('2 calls');
  });

  it('omits the param list for commands with no tracked optional params', async () => {
    mockLoadCommandUsage.mockResolvedValue([entry({ commandPath: 'help', paramCounts: {} })]);
    const interaction = makeInteraction();

    await handleUsage(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('/help — 1 call');
    expect(reply.content).not.toContain('/help — 1 call (');
  });
});
