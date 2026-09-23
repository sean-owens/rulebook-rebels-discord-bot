import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType } from 'discord.js';
import {
  execute,
  handleChallengeConfig,
  handleChallengeResetScores,
  handleHostChallengePoints,
  buildChallengeHubEmbed,
  buildChallengeHubButtons,
  handleHubChallengeStatusButton,
  handleHubChallengeLeaderboardButton,
} from '../src/commands/boardgamechallenge';
import { getGuildConfig, updateGuildConfig } from '../src/utils/config';
import { createWeeklyChallenge, recordCorrectGuess, getLeaderboard } from '../src/utils/boardGameChallengeStorage';
import { mondayOfWeekInTimeZone } from '../src/utils/timezone';

function makeInteraction(sub: string, overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'guild-1',
    client: {},
    options: {
      getSubcommand: () => sub,
      getChannel: () => null,
      getBoolean: () => null,
      getString: () => null,
      getInteger: () => null,
      getUser: () => null,
    },
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
      expect(embed.data.description).toContain("BGG's top 500 ranked base games");
    });

    it('shows just the hour (no weekday) for the next hint time in daily mode', async () => {
      await updateGuildConfig('guild-1', {
        boardGameChallengeEnabled: true,
        boardGameChallengeChannelId: 'channel-1',
        challengeFrequency: 'daily',
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
      expect(embed.data.description).toContain('Next hint: **8am**');
      expect(embed.data.description).not.toMatch(/Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/);
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
          getString: () => null,
          getInteger: () => null,
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
          getString: () => null,
          getInteger: () => null,
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

    it('shows the default schedule when no options are given', async () => {
      const interaction = makeInteraction('config');
      await handleChallengeConfig(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringMatching(/Hint 1: \*\*Monday 8am\*\*[\s\S]*Reveal: \*\*Saturday 6pm\*\*/),
        }),
      );
    });

    it('updates only the requested schedule field, leaving the rest at their defaults', async () => {
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => null,
          getBoolean: () => null,
          getString: (name: string) =>
            name === 'clue1_day' ? 'tuesday' : name === 'clue1_hour' ? '9' : null,
          getInteger: () => null,
        },
      });
      await handleChallengeConfig(interaction);

      const config = await getGuildConfig('guild-1');
      expect(config.challengeClue1Weekday).toBe(2); // Tuesday
      expect(config.challengeClue1Hour).toBe(9);
      expect(config.challengeClue2Weekday).toBe(3); // untouched default (Wednesday)
      expect(config.challengeRevealHour).toBe(18); // untouched default
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Hint 1: **Tuesday 9am**') }),
      );
    });

    it('accepts 12-hour hour input ("8pm") alongside 24-hour', async () => {
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => null,
          getBoolean: () => null,
          getString: (name: string) => (name === 'clue1_hour' ? '8pm' : null),
          getInteger: () => null,
        },
      });
      await handleChallengeConfig(interaction);

      const config = await getGuildConfig('guild-1');
      expect(config.challengeClue1Hour).toBe(20);
    });

    it('rejects an unparseable hour and leaves the config untouched', async () => {
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => null,
          getBoolean: () => null,
          getString: (name: string) => (name === 'clue1_hour' ? 'not-a-time' : null),
          getInteger: () => null,
        },
      });
      await handleChallengeConfig(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Could not parse "not-a-time"') }),
      );
      const config = await getGuildConfig('guild-1');
      expect(config.challengeClue1Hour).toBe(8); // untouched default
    });

    it('sets all four schedule pairs independently in one call, mixing 12h and 24h input', async () => {
      const overrides: Record<string, [string, string]> = {
        clue1: ['sunday', '7am'],
        clue2: ['monday', '12'],
        clue3: ['tuesday', '5pm'],
        reveal: ['wednesday', '20'],
      };
      const interaction = makeInteraction('config', {
        options: {
          getChannel: () => null,
          getBoolean: () => null,
          getString: (name: string) => {
            if (name.endsWith('_day')) return overrides[name.replace('_day', '')]?.[0] ?? null;
            if (name.endsWith('_hour')) return overrides[name.replace('_hour', '')]?.[1] ?? null;
            return null;
          },
          getInteger: () => null,
        },
      });
      await handleChallengeConfig(interaction);

      const config = await getGuildConfig('guild-1');
      expect(config.challengeClue1Weekday).toBe(0);
      expect(config.challengeClue1Hour).toBe(7);
      expect(config.challengeClue2Weekday).toBe(1);
      expect(config.challengeClue2Hour).toBe(12);
      expect(config.challengeClue3Weekday).toBe(2);
      expect(config.challengeClue3Hour).toBe(17);
      expect(config.challengeRevealWeekday).toBe(3);
      expect(config.challengeRevealHour).toBe(20);
    });

    describe('frequency / bi-weekly start_date', () => {
      it('defaults to weekly', async () => {
        const interaction = makeInteraction('config');
        await handleChallengeConfig(interaction);

        const config = await getGuildConfig('guild-1');
        expect(config.challengeFrequency).toBe('weekly');
        expect(interaction.editReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('Frequency: **Weekly**') }),
        );
      });

      it('sets frequency to daily, and the schedule lines drop the weekday (hour only)', async () => {
        const interaction = makeInteraction('config', {
          options: {
            getChannel: () => null,
            getBoolean: () => null,
            getString: (name: string) => (name === 'frequency' ? 'daily' : null),
            getInteger: () => null,
          },
        });
        await handleChallengeConfig(interaction);

        const config = await getGuildConfig('guild-1');
        expect(config.challengeFrequency).toBe('daily');
        expect(interaction.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringMatching(/Frequency: \*\*Daily\*\*[\s\S]*Hint 1: \*\*8am\*\* \(daily\)/),
          }),
        );
        // No weekday name should appear on the schedule lines in daily mode.
        const content = interaction.editReply.mock.calls[0][0].content as string;
        expect(content).not.toMatch(/Hint 1: \*\*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/);
      });

      it('sets frequency to bi-weekly and defaults the anchor to the current week when no start_date is given', async () => {
        const interaction = makeInteraction('config', {
          options: {
            getChannel: () => null,
            getBoolean: () => null,
            getString: (name: string) => (name === 'frequency' ? 'biweekly' : null),
            getInteger: () => null,
          },
        });
        await handleChallengeConfig(interaction);

        const config = await getGuildConfig('guild-1');
        expect(config.challengeFrequency).toBe('biweekly');
        expect(config.challengeCycleAnchor).toBe(mondayOfWeekInTimeZone('UTC'));
        expect(interaction.editReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('On weeks: starting') }),
        );
      });

      it('sets frequency to bi-weekly with an explicit start_date, normalized to that week\'s Monday', async () => {
        const interaction = makeInteraction('config', {
          options: {
            getChannel: () => null,
            getBoolean: () => null,
            getString: (name: string) => {
              if (name === 'frequency') return 'biweekly';
              if (name === 'start_date') return 'August 22 2026'; // a Saturday
              return null;
            },
            getInteger: () => null,
          },
        });
        await handleChallengeConfig(interaction);

        const config = await getGuildConfig('guild-1');
        expect(config.challengeCycleAnchor).toBe('2026-08-17'); // Monday of that week
      });

      it('rejects an unparseable start_date and saves nothing', async () => {
        const interaction = makeInteraction('config', {
          options: {
            getChannel: () => null,
            getBoolean: () => null,
            getString: (name: string) => (name === 'start_date' ? 'not a date' : null),
            getInteger: () => null,
          },
        });
        await handleChallengeConfig(interaction);

        expect(interaction.editReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('Could not parse "not a date"') }),
        );
        const config = await getGuildConfig('guild-1');
        expect(config.challengeCycleAnchor).toBeNull();
      });

      it('does not touch an already-set anchor when just re-saving other bi-weekly config', async () => {
        await updateGuildConfig('guild-1', { challengeFrequency: 'biweekly', challengeCycleAnchor: '2026-01-05' });
        const interaction = makeInteraction('config', {
          options: {
            getChannel: () => null,
            getBoolean: () => null,
            getString: (name: string) => (name === 'clue1_hour' ? '9' : null),
            getInteger: () => null,
          },
        });
        await handleChallengeConfig(interaction);

        const config = await getGuildConfig('guild-1');
        expect(config.challengeCycleAnchor).toBe('2026-01-05');
      });
    });

    describe('auto-creating the channel', () => {
      function makeGuild(existingChannel?: { id: string; type: ChannelType; name: string }) {
        return {
          id: 'guild-1',
          channels: {
            cache: { find: (fn: (c: unknown) => boolean) => (existingChannel && fn(existingChannel) ? existingChannel : undefined) },
            create: vi.fn(async () => ({
              id: 'auto-channel-1',
              type: ChannelType.GuildText,
              permissionOverwrites: { create: vi.fn(async () => {}) },
              send: vi.fn(async () => {}),
            })),
          },
          members: { fetchMe: vi.fn(async () => ({ id: 'bot-1' })) },
        } as any;
      }

      it('creates a channel when enabling with none configured or given', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction('config', {
          guild,
          options: { getChannel: () => null, getBoolean: () => true, getString: () => null, getInteger: () => null },
        });
        await handleChallengeConfig(interaction);

        expect(guild.channels.create).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'board-game-challenge' }),
        );
        const config = await getGuildConfig('guild-1');
        expect(config.boardGameChallengeChannelId).toBe('auto-channel-1');
        expect(config.boardGameChallengeEnabled).toBe(true);
        expect(interaction.editReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('Created <#auto-channel-1>') }),
        );
      });

      it('reuses an existing "board-game-challenge" channel instead of creating a duplicate', async () => {
        const guild = makeGuild({ id: 'existing-1', type: ChannelType.GuildText, name: 'board-game-challenge' });
        const interaction = makeInteraction('config', {
          guild,
          options: { getChannel: () => null, getBoolean: () => true, getString: () => null, getInteger: () => null },
        });
        await handleChallengeConfig(interaction);

        expect(guild.channels.create).not.toHaveBeenCalled();
        const config = await getGuildConfig('guild-1');
        expect(config.boardGameChallengeChannelId).toBe('existing-1');
      });

      it('does not auto-create when a channel is already configured', async () => {
        await updateGuildConfig('guild-1', { boardGameChallengeChannelId: 'channel-1' });
        const guild = makeGuild();
        const interaction = makeInteraction('config', {
          guild,
          options: { getChannel: () => null, getBoolean: () => true, getString: () => null, getInteger: () => null },
        });
        await handleChallengeConfig(interaction);

        expect(guild.channels.create).not.toHaveBeenCalled();
      });

      it('does not auto-create when not enabling (e.g. just viewing config)', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction('config', { guild });
        await handleChallengeConfig(interaction);

        expect(guild.channels.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleChallengeResetScores', () => {
    it('rejects non-admins', async () => {
      const interaction = makeInteraction('reset-scores', { memberPermissions: { has: () => false } });
      await handleChallengeResetScores(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Manage Server') }),
      );
    });

    it('does nothing without confirm:true', async () => {
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c.id, 'user-1', 1);

      const interaction = makeInteraction('reset-scores', {
        options: { getBoolean: () => false },
      });
      await handleChallengeResetScores(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('cancelled') }),
      );
      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-1', points: 100 }]);
    });

    it('clears the leaderboard when confirm:true', async () => {
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c.id, 'user-1', 1);

      const interaction = makeInteraction('reset-scores', {
        options: { getBoolean: () => true },
      });
      await handleChallengeResetScores(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('reset') }),
      );
      expect(await getLeaderboard('guild-1')).toEqual([]);
    });
  });

  describe('handleHostChallengePoints', () => {
    it('adds points to a user with an existing total', async () => {
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c.id, 'user-1', 1); // 100

      const interaction = makeInteraction('points', {
        options: { getUser: () => ({ id: 'user-1' }), getInteger: () => 50 },
      });
      await handleHostChallengePoints(interaction);

      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-1', points: 150 }]);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Added **50 points** to <@user-1>') }),
      );
    });

    it('subtracts points from a user', async () => {
      const c = await createWeeklyChallenge('guild-1', {
        weekStart: '2026-08-24',
        bggId: '13',
        title: 'Catan',
        clues: ['a', 'b', 'c'],
        thumbnail: null,
        bggLink: 'https://boardgamegeek.com/boardgame/13',
        channelId: 'channel-1',
      });
      await recordCorrectGuess('guild-1', c.id, 'user-1', 1); // 100

      const interaction = makeInteraction('points', {
        options: { getUser: () => ({ id: 'user-1' }), getInteger: () => -30 },
      });
      await handleHostChallengePoints(interaction);

      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-1', points: 70 }]);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Subtracted **30 points** from <@user-1>') }),
      );
    });

    it('clamps at 0 and notes it when subtracting more than the user has', async () => {
      const interaction = makeInteraction('points', {
        options: { getUser: () => ({ id: 'user-1' }), getInteger: () => -50 },
      });
      await handleHostChallengePoints(interaction);

      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-1', points: 0 }]);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Clamped at 0") }),
      );
    });

    it('rejects an amount of 0', async () => {
      const interaction = makeInteraction('points', {
        options: { getUser: () => ({ id: 'user-1' }), getInteger: () => 0 },
      });
      await handleHostChallengePoints(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('non-zero') }),
      );
      expect(await getLeaderboard('guild-1')).toEqual([]);
    });

    it('works for a user with no prior leaderboard entry', async () => {
      const interaction = makeInteraction('points', {
        options: { getUser: () => ({ id: 'user-new' }), getInteger: () => 25 },
      });
      await handleHostChallengePoints(interaction);

      expect(await getLeaderboard('guild-1')).toEqual([{ userId: 'user-new', points: 25 }]);
    });
  });

  describe('challenge hub (see /hub)', () => {
    it('embed/buttons match /challenge\'s own two subcommands', () => {
      const embed = buildChallengeHubEmbed().toJSON();
      expect(embed.fields?.map((f) => f.name)).toEqual(
        expect.arrayContaining([expect.stringContaining('Status'), expect.stringContaining('Leaderboard')]),
      );

      const customIds = buildChallengeHubButtons()
        .toJSON()
        .components.map((c: any) => c.custom_id);
      expect(customIds).toEqual(['hub_challenge_status', 'hub_challenge_leaderboard']);
    });

    it('the status hub button behaves exactly like /challenge status', async () => {
      const interaction = makeInteraction('status') as any;
      await handleHubChallengeStatusButton(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("isn't set up") }),
      );
    });

    it('the leaderboard hub button behaves exactly like /challenge leaderboard', async () => {
      const interaction = makeInteraction('leaderboard') as any;
      await handleHubChallengeLeaderboardButton(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No points on the board') }),
      );
    });
  });
});
