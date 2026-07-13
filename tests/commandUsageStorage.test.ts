import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ApplicationCommandOptionType, ChatInputCommandInteraction } from 'discord.js';
import {
  extractCommandUsage,
  loadCommandUsage,
  recordCommandUsage,
} from '../src/utils/commandUsageStorage';

function fakeInteraction(
  commandName: string,
  data: ChatInputCommandInteraction['options']['data'],
): ChatInputCommandInteraction {
  return { commandName, options: { data } } as unknown as ChatInputCommandInteraction;
}

describe('extractCommandUsage', () => {
  it('returns the command name and top-level param names for a command with no subcommand', () => {
    const interaction = fakeInteraction('bgg', [
      { name: 'username', type: ApplicationCommandOptionType.String, value: 'someone' },
    ]);
    expect(extractCommandUsage(interaction)).toEqual({
      commandPath: 'bgg',
      paramNames: ['username'],
    });
  });

  it('returns an empty param list for a command with no options at all', () => {
    expect(extractCommandUsage(fakeInteraction('help', []))).toEqual({
      commandPath: 'help',
      paramNames: [],
    });
  });

  it('walks into a subcommand to find the leaf params', () => {
    const interaction = fakeInteraction('library', [
      {
        name: 'add',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'game', type: ApplicationCommandOptionType.String, value: 'Wingspan' }],
      },
    ]);
    expect(extractCommandUsage(interaction)).toEqual({
      commandPath: 'library add',
      paramNames: ['game'],
    });
  });

  it('walks into a subcommand group + subcommand to find the leaf params', () => {
    const interaction = fakeInteraction('admin', [
      {
        name: 'event',
        type: ApplicationCommandOptionType.SubcommandGroup,
        options: [
          {
            name: 'config',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
              { name: 'location', type: ApplicationCommandOptionType.String, value: 'Sean\'s place' },
              { name: 'table_count', type: ApplicationCommandOptionType.Integer, value: 2 },
            ],
          },
        ],
      },
    ]);
    expect(extractCommandUsage(interaction)).toEqual({
      commandPath: 'admin event config',
      paramNames: ['location', 'table_count'],
    });
  });
});

describe('commandUsageStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-commandusage-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array for a guild with no recorded usage', async () => {
    expect(await loadCommandUsage('guild-1')).toEqual([]);
  });

  it('creates a new entry on first use with a call count of 1', async () => {
    await recordCommandUsage('guild-1', 'game bgstats', ['location']);
    const stats = await loadCommandUsage('guild-1');
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      guildId: 'guild-1',
      commandPath: 'game bgstats',
      totalCalls: 1,
      paramCounts: { location: 1 },
    });
  });

  it('increments totalCalls and paramCounts on repeated use', async () => {
    await recordCommandUsage('guild-1', 'game bgstats', ['location']);
    await recordCommandUsage('guild-1', 'game bgstats', []);
    await recordCommandUsage('guild-1', 'game bgstats', ['location']);

    const [entry] = await loadCommandUsage('guild-1');
    expect(entry.totalCalls).toBe(3);
    expect(entry.paramCounts).toEqual({ location: 2 });
  });

  it('keeps separate entries per guild for the same command path', async () => {
    await recordCommandUsage('guild-1', 'game bgstats', []);
    await recordCommandUsage('guild-2', 'game bgstats', []);

    expect(await loadCommandUsage('guild-1')).toHaveLength(1);
    expect(await loadCommandUsage('guild-2')).toHaveLength(1);
  });

  it('keeps separate entries per command path within the same guild', async () => {
    await recordCommandUsage('guild-1', 'game bgstats', []);
    await recordCommandUsage('guild-1', 'library add', ['game']);

    const stats = await loadCommandUsage('guild-1');
    expect(stats.map((s) => s.commandPath).sort()).toEqual(['game bgstats', 'library add']);
  });
});
