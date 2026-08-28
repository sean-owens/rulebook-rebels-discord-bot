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

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Shared with the /admin challenge config option builder in admin.ts so the
// dropdown values and the parsing below can't drift out of sync.
export const WEEKDAY_CHOICES = WEEKDAY_NAMES.map((name) => ({ name, value: name.toLowerCase() }));

function parseWeekday(value: string): number {
  return WEEKDAY_NAMES.findIndex((name) => name.toLowerCase() === value);
}

function formatHour(hour: number): string {
  const period = hour < 12 ? 'am' : 'pm';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}${period}`;
}

function scheduleLine(label: string, weekday: number, hour: number): string {
  return `${label}: **${WEEKDAY_NAMES[weekday]} ${formatHour(hour)}**`;
}

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

  const scheduleOptions: [string, string, string][] = [
    ['clue1_day', 'clue1_hour', 'challengeClue1'],
    ['clue2_day', 'clue2_hour', 'challengeClue2'],
    ['clue3_day', 'clue3_hour', 'challengeClue3'],
    ['reveal_day', 'reveal_hour', 'challengeReveal'],
  ];
  for (const [dayOpt, hourOpt, configPrefix] of scheduleOptions) {
    const day = interaction.options.getString(dayOpt);
    if (day) patch[`${configPrefix}Weekday`] = parseWeekday(day);
    const hour = interaction.options.getInteger(hourOpt);
    if (hour !== null) patch[`${configPrefix}Hour`] = hour;
  }

  if (Object.keys(patch).length > 0) {
    await updateGuildConfig(guildId, patch as Parameters<typeof updateGuildConfig>[1]);
  }

  const config = await getGuildConfig(guildId);
  await interaction.editReply({
    content: [
      Object.keys(patch).length > 0 ? 'Board game challenge config updated.' : '**Current board game challenge config:**',
      `• Channel: ${config.boardGameChallengeChannelId ? `<#${config.boardGameChallengeChannelId}>` : '*not set*'}`,
      `• Enabled: **${config.boardGameChallengeEnabled ? 'Yes' : 'No'}**`,
      `• ${scheduleLine('Hint 1', config.challengeClue1Weekday, config.challengeClue1Hour)}`,
      `• ${scheduleLine('Hint 2', config.challengeClue2Weekday, config.challengeClue2Hour)}`,
      `• ${scheduleLine('Hint 3', config.challengeClue3Weekday, config.challengeClue3Hour)}`,
      `• ${scheduleLine('Reveal', config.challengeRevealWeekday, config.challengeRevealHour)}`,
      `• Timezone: **${config.timezone}** (set via /admin event config)`,
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
      content: `No challenge is active right now — the next one starts ${WEEKDAY_NAMES[config.challengeClue1Weekday]} at ${formatHour(config.challengeClue1Hour)} in <#${config.boardGameChallengeChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const hintLines = challenge.clues
    .slice(0, challenge.hintsPostedCount)
    .map((clue, i) => `**Hint ${i + 1}:** ${clue}`);

  const hintSchedule = [
    `${WEEKDAY_NAMES[config.challengeClue1Weekday]} ${formatHour(config.challengeClue1Hour)}`,
    `${WEEKDAY_NAMES[config.challengeClue2Weekday]} ${formatHour(config.challengeClue2Hour)}`,
    `${WEEKDAY_NAMES[config.challengeClue3Weekday]} ${formatHour(config.challengeClue3Hour)}`,
  ];
  const next =
    challenge.hintsPostedCount < 3
      ? `Next hint: **${hintSchedule[challenge.hintsPostedCount]}**`
      : `All 3 hints are posted — the answer reveals **${WEEKDAY_NAMES[config.challengeRevealWeekday]} ${formatHour(config.challengeRevealHour)}**.`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎲 This Week's Board Game Challenge")
    .setDescription(`${hintLines.join('\n\n')}\n\n${next}\n\nReply with your guess in <#${challenge.channelId}>.`);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
