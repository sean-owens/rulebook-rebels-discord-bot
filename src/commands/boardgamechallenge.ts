import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { getActiveChallenge } from '../utils/boardGameChallengeStorage';
import { getLeaderboard } from '../utils/boardGameChallenge';

export const data = new SlashCommandBuilder()
  .setName('challenge')
  .setDescription('Weekly "Guess the Board Game" challenge')
  .addSubcommand((sub) =>
    sub.setName('leaderboard').setDescription('See who has the most weekly challenge points'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription("See this week's hints so far, and when the next one posts"),
  );

const HINT_SCHEDULE: string[] = ['Monday 8am', 'Wednesday 8am', 'Friday 8am'];

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'leaderboard') await handleLeaderboard(interaction);
  else if (sub === 'status') await handleStatus(interaction);
}

async function handleLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const entries = await getLeaderboard(interaction.guildId!);
  if (entries.length === 0) {
    await interaction.reply({
      content: 'No points on the board yet — guess correctly in the weekly challenge to get started!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = entries
    .slice(0, 10)
    .map((e, i) => `**${i + 1}.** <@${e.userId}> — ${e.points} pt${e.points === 1 ? '' : 's'}`);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🏆 Weekly Board Game Challenge — Leaderboard')
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// /admin challenge config — mirrors the shape of other /admin *.config
// handlers (see handleAdminConfig in marketplace.ts): no options given shows
// the current config, otherwise applies a patch. No channel-permission
// pre-check — like the marketplace/room hubs, setup issues (e.g. missing
// Manage Messages) surface as a logged warning the first time a post/delete
// fails rather than new permission-checking machinery (graceful degradation
// per CLAUDE.md 2).
export async function handleChallengeConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!isAdmin) {
    await interaction.editReply({ content: 'This command requires Manage Server permission.' });
    return;
  }

  const guildId = interaction.guildId!;
  const channel = interaction.options.getChannel('channel');
  const enabled = interaction.options.getBoolean('enabled');

  const patch: Record<string, unknown> = {};
  if (channel) {
    if (channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: 'The challenge channel must be a **Text Channel**.' });
      return;
    }
    patch.boardGameChallengeChannelId = channel.id;
  }
  if (enabled !== null) patch.boardGameChallengeEnabled = enabled;

  if (Object.keys(patch).length > 0) {
    await updateGuildConfig(guildId, patch as Parameters<typeof updateGuildConfig>[1]);
  }

  const config = await getGuildConfig(guildId);
  await interaction.editReply({
    content: [
      Object.keys(patch).length > 0 ? 'Board game challenge config updated.' : '**Current board game challenge config:**',
      `• Channel: ${config.boardGameChallengeChannelId ? `<#${config.boardGameChallengeChannelId}>` : '*not set*'}`,
      `• Enabled: **${config.boardGameChallengeEnabled ? 'Yes' : 'No'}**`,
      !config.boardGameChallengeChannelId
        ? '\n⚠️ Set a channel before enabling — hints have nowhere to post otherwise.'
        : '',
    ].join('\n'),
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getGuildConfig(guildId);
  if (!config.boardGameChallengeEnabled || !config.boardGameChallengeChannelId) {
    await interaction.reply({
      content: 'The weekly board game challenge isn\'t set up on this server yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const challenge = await getActiveChallenge(guildId);
  if (!challenge) {
    await interaction.reply({
      content: `No challenge is active right now — the next one starts Monday at 8am in <#${config.boardGameChallengeChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const hintLines = challenge.clues
    .slice(0, challenge.hintsPostedCount)
    .map((clue, i) => `**Hint ${i + 1}:** ${clue}`);

  const next =
    challenge.hintsPostedCount < 3
      ? `Next hint: **${HINT_SCHEDULE[challenge.hintsPostedCount]}**`
      : 'All 3 hints are posted — the answer reveals **Saturday evening**.';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎲 This Week's Board Game Challenge")
    .setDescription(`${hintLines.join('\n\n')}\n\n${next}\n\nReply with your guess in <#${challenge.channelId}>.`);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
