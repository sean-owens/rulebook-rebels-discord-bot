import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType } from 'discord.js';
import { execute, handleChallengeConfig } from '../src/commands/boardgamechallenge';
import { getGuildConfig, updateGuildConfig } from '../src/utils/config';
import { createWeeklyChallenge, recordCorrectGuess } from '../src/utils/boardGameChallengeStorage';

function makeInteraction(sub: string, overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'guild-1',
    options: { getSubcommand: () => sub, getChannel: () => null, getBoolean: () => null },
    memberPermissions: { has: () => true },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

describe('/challenge command', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-challenge-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('leaderboard', () => {
    it('shows an empty-state message when nobody has scored', async () => {
      const interaction = makeInteraction('leaderboard');
      await execute(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No points on the board') }),
      );
    });

    it('lists scorers ranked by points', async () => {
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c.id, 'user-1', 3); // 50
      const c2 = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-31',
        bggId: '14',
        title: 'Wingspan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/14',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c2.id, 'user-2', 1); // 100

      const interaction = makeInteraction('leaderboard');
      await execute(interaction);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toContain('<@user-2>');
      expect(embed.data.description.indexOf('user-2')).toBeLessThan(embed.data.description.indexOf('user-1'));
    });
  });

  describe('status', () => {
    it('reports the feature is not set up when disabled', async () => {
      const interaction = makeInteraction('status');
      await execute(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("isn't set up") }),
      );
    });

    it('reports no active challenge when enabled but nothing is running', async () => {
      await updateGuildConfig('guild-1', {
        boardGameChallengeEnabled: true,
        boardGameChallengeChannelId: 'channel-1',
      });
      const interaction = makeInteraction('status');
      await execute(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No challenge is active') }),
      );
    });

    it('shows the hints posted so far and the next hint time', async () => {
      await updateGuildConfig('guild-1', {
        boardGameChallengeEnabled: true,
        boardGameChallengeChannelId: 'channel-1',
      });
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['first clue', 'second clue', 'third clue'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      const { recordHintPosted } = await import('../src/utils/boardGameChallengeStorage');
      await recordHintPosted('guild-1', c.id, 1, 'msg-1');

      const interaction = makeInteraction('status');
      await execute(interaction);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toContain('first clue');
      expect(embed.data.description).not.toContain('second clue');
      expect(embed.data.description).toContain('Wednesday 8am');
    });
  });

  describe('handleChallengeConfig', () => {
    it('rejects non-admins', async () => {
      const interaction = makeInteraction('config', { memberPermissions: { has: () => false } });
      await handleChallengeConfig(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Manage Server') }),
      );
    });

    it('shows current config when no options are given', async () => {
      const interaction = makeInteraction('config');
      await handleChallengeConfig(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Current board game challenge config') }),
      );
    });

    it('rejects a non-text channel', async () => {
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => ({ id: 'voice-1', type: ChannelType.GuildVoice }),
          getBoolean: () => null,
        },
      });
      await handleChallengeConfig(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Text Channel') }),
      );
      expect((await getGuildConfig('guild-1')).boardGameChallengeChannelId).toBeNull();
    });

    it('sets the channel and enabled flag', async () => {
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => ({ id: 'channel-1', type: ChannelType.GuildText }),
          getBoolean: () => true,
        },
      });
      await handleChallengeConfig(interaction);

      const config = await getGuildConfig('guild-1');
      expect(config.boardGameChallengeChannelId).toBe('channel-1');
      expect(config.boardGameChallengeEnabled).toBe(true);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('updated') }),
      );
    });
  });
});
