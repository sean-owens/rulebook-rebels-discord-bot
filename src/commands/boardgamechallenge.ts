import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig, GuildConfig } from '../utils/config';
import { getActiveChallenge, resetLeaderboard, adjustUserPoints } from '../utils/boardGameChallengeStorage';
import {
  getLeaderboard,
  buildLeaderboardEmbed,
  updateChallengeLeaderboardPin,
  awardCorrectGuess,
} from '../utils/boardGameChallenge';
import { parseHourInput, mondayOfWeekInTimeZone, mondayOfDateInTimeZone } from '../utils/timezone';
import { parseDateTime } from './gamenight';

// Name used when auto-creating the challenge channel (see
// findOrCreateChallengeChannel) — checked against existing channels first so
// re-running /admin challenge config never creates a duplicate.
const CHALLENGE_CHANNEL_NAME = 'board-game-challenge';

export const data = new SlashCommandBuilder()
  .setName('challenge')
  .setDescription('"Guess the Board Game" challenge')
  .addSubcommand((sub) =>
    sub.setName('leaderboard').setDescription('See who has the most challenge points'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription("See this cycle's hints so far, and when the next one posts"),
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

// Daily mode has no "day of week" of its own — every stage falls on
// whatever day the cycle itself starts on, so only the hour is meaningful
// there (see stageDayOffset in utils/boardGameChallenge.ts).
function describeStage(weekday: number, hour: number, frequency: GuildConfig['challengeFrequency']): string {
  return frequency === 'daily' ? formatHour(hour) : `${WEEKDAY_NAMES[weekday]} ${formatHour(hour)}`;
}

function scheduleLine(label: string, weekday: number, hour: number, frequency: GuildConfig['challengeFrequency']): string {
  const when = describeStage(weekday, hour, frequency);
  return frequency === 'daily' ? `${label}: **${when}** (daily)` : `${label}: **${when}**`;
}

const FREQUENCY_LABELS: Record<GuildConfig['challengeFrequency'], string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
};

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'leaderboard') await handleLeaderboard(interaction);
  else if (sub === 'status') await handleStatus(interaction);
}

// ── "Quick Actions" hub for the challenge channel (see /hub, commands/hub.ts) ──
// No standing pinned message here (unlike event/room/marketplace/general
// chat) — just the same two things /challenge already offers, as buttons for
// anyone who'd rather tap than type.
export function buildChallengeHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎲 Quick Actions')
    .setDescription('Prefer tapping over typing? Use the buttons below instead of slash commands.')
    .addFields(
      { name: '📊 Status', value: "See this cycle's hints so far, and when the next one posts." },
      { name: '🏆 Leaderboard', value: 'See who has the most challenge points.' },
    );
}

export function buildChallengeHubButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_challenge_status').setLabel('📊 Status').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_challenge_leaderboard').setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Secondary),
  );
}

// Handles the "which game did you mean?" dropdown sent for an ambiguous
// base-only guess (see messageCreate.ts). `encoded` is "<challengeId>_<guesserId>".
// Only the original guesser may answer; a pick is compared by BGG id, not text.
export async function handleChallengeDisambiguationSelect(
  interaction: StringSelectMenuInteraction,
  encoded: string,
): Promise<void> {
  const sep = encoded.lastIndexOf('_');
  const challengeId = encoded.slice(0, sep);
  const guesserId = encoded.slice(sep + 1);

  if (interaction.user.id !== guesserId) {
    await interaction.reply({ content: "This isn't your guess to answer.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.guildId) return;

  const challenge = await getActiveChallenge(interaction.guildId);
  if (!challenge || challenge.id !== challengeId) {
    await interaction.update({ content: 'This challenge has already ended.', components: [] });
    return;
  }
  if (challenge.correctGuesses.some((g) => g.userId === guesserId)) {
    await interaction.update({ content: 'You already scored on this challenge.', components: [] });
    return;
  }

  if (interaction.values[0] !== challenge.bggId) {
    await interaction.update({ content: '❌ Not quite — try guessing again in the channel!', components: [] });
    return;
  }

  await interaction.update({ content: '✅ Correct!', components: [] });
  await awardCorrectGuess(
    interaction.client,
    interaction.guildId,
    challenge,
    guesserId,
    interaction.channel as TextChannel,
  );
}

export async function handleHubChallengeStatusButton(interaction: ButtonInteraction): Promise<void> {
  await handleStatus(interaction);
}

export async function handleHubChallengeLeaderboardButton(interaction: ButtonInteraction): Promise<void> {
  await handleLeaderboard(interaction);
}

async function handleLeaderboard(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const entries = await getLeaderboard(interaction.guildId!);
  if (entries.length === 0) {
    await interaction.reply({
      content: 'No points on the board yet — guess correctly in the board game challenge to get started!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ embeds: [buildLeaderboardEmbed(entries)], flags: MessageFlags.Ephemeral });
}

const FREQUENCY_CADENCE_TEXT: Record<GuildConfig['challengeFrequency'], string> = {
  daily: 'Each day a new mystery game gets hinted here',
  weekly: 'Each week a new mystery game gets hinted here across the week',
  biweekly: 'Every other week a new mystery game gets hinted here across the week',
};

// Finds an existing "board-game-challenge" text channel or creates one, so an
// admin turning the feature on doesn't have to go create a channel by hand
// first. Best-effort: a creation failure (e.g. missing Manage Channels) is
// logged and swallowed, leaving the channel unset same as before this existed.
async function findOrCreateChallengeChannel(
  guild: Guild,
  frequency: GuildConfig['challengeFrequency'],
): Promise<TextChannel | undefined> {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === CHALLENGE_CHANNEL_NAME,
  );
  if (existing) return existing as TextChannel;

  try {
    const created = (await guild.channels.create({
      name: CHALLENGE_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: '"Guess the Board Game" challenge — hints post here, reply with your guess!',
    })) as TextChannel;

    const me = await guild.members.fetchMe();
    await created.permissionOverwrites.create(me, {
      ViewChannel: true,
      SendMessages: true,
      ManageMessages: true,
      PinMessages: true,
    });

    await created
      .send(
        [
          '🎲 **Board Game Challenge** is set up in this channel!',
          `${FREQUENCY_CADENCE_TEXT[frequency]} — reply with your guess any time, no command needed.`,
          "A correct guess is deleted and confirmed privately by DM so the answer stays secret for everyone else until the reveal.",
        ].join('\n'),
      )
      .catch((err) => console.warn(`[BoardGameChallenge] Failed to post welcome message in guild ${guild.id}:`, err));

    return created;
  } catch (err) {
    console.warn(`[BoardGameChallenge] Failed to auto-create challenge channel for guild ${guild.id}:`, err);
    return undefined;
  }
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
  const currentConfig = await getGuildConfig(guildId);
  const channel = interaction.options.getChannel('channel');
  const enabled = interaction.options.getBoolean('enabled');
  const frequencyRaw = interaction.options.getString('frequency') as GuildConfig['challengeFrequency'] | null;
  const startDateRaw = interaction.options.getString('start_date');
  const cleanupOldPosts = interaction.options.getBoolean('cleanup_old_posts');

  const patch: Record<string, unknown> = {};
  let autoCreatedChannel: TextChannel | undefined;
  // The frequency this call will leave in effect — used below to decide the
  // auto-create welcome message's wording and the bi-weekly anchor default,
  // even when frequency itself isn't being changed this call.
  const effectiveFrequency = frequencyRaw ?? currentConfig.challengeFrequency;

  if (frequencyRaw) patch.challengeFrequency = frequencyRaw;

  if (startDateRaw) {
    try {
      const parsed = parseDateTime(startDateRaw, '12:00am', currentConfig.timezone);
      patch.challengeCycleAnchor = mondayOfDateInTimeZone(parsed, currentConfig.timezone);
    } catch {
      await interaction.editReply({
        content: `Could not parse "${startDateRaw}" as a date. Try something like "August 22".`,
      });
      return;
    }
  } else if (effectiveFrequency === 'biweekly' && !currentConfig.challengeCycleAnchor) {
    // Switching to bi-weekly (or already bi-weekly) with no anchor set and
    // none given this call — default to "starting this week" so bi-weekly
    // works without requiring the extra option.
    patch.challengeCycleAnchor = mondayOfWeekInTimeZone(currentConfig.timezone);
  }

  if (channel) {
    if (channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: 'The challenge channel must be a **Text Channel**.' });
      return;
    }
    patch.boardGameChallengeChannelId = channel.id;
  } else if (enabled === true && !currentConfig.boardGameChallengeChannelId) {
    // Turning the feature on with no channel set (and none given this call) —
    // auto-create one instead of blocking the admin with a "set a channel first" error.
    autoCreatedChannel = await findOrCreateChallengeChannel(interaction.guild!, effectiveFrequency);
    if (autoCreatedChannel) patch.boardGameChallengeChannelId = autoCreatedChannel.id;
  }
  if (enabled !== null) patch.boardGameChallengeEnabled = enabled;
  if (cleanupOldPosts !== null) patch.challengeCleanupOldPosts = cleanupOldPosts;

  const scheduleOptions: [string, string, string][] = [
    ['clue1_day', 'clue1_hour', 'challengeClue1'],
    ['clue2_day', 'clue2_hour', 'challengeClue2'],
    ['clue3_day', 'clue3_hour', 'challengeClue3'],
    ['reveal_day', 'reveal_hour', 'challengeReveal'],
  ];
  for (const [dayOpt, hourOpt, configPrefix] of scheduleOptions) {
    const day = interaction.options.getString(dayOpt);
    if (day) patch[`${configPrefix}Weekday`] = parseWeekday(day);
    const hourRaw = interaction.options.getString(hourOpt);
    if (hourRaw !== null) {
      try {
        patch[`${configPrefix}Hour`] = parseHourInput(hourRaw);
      } catch {
        await interaction.editReply({
          content: `Could not parse "${hourRaw}" as an hour. Try 12-hour ("8am", "8pm") or 24-hour ("20").`,
        });
        return;
      }
    }
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
      `• Frequency: **${FREQUENCY_LABELS[config.challengeFrequency]}**`,
      config.challengeFrequency === 'biweekly' && config.challengeCycleAnchor
        ? `• On weeks: starting **${config.challengeCycleAnchor}**, then every other week`
        : '',
      `• ${scheduleLine('Hint 1', config.challengeClue1Weekday, config.challengeClue1Hour, config.challengeFrequency)}`,
      `• ${scheduleLine('Hint 2', config.challengeClue2Weekday, config.challengeClue2Hour, config.challengeFrequency)}`,
      `• ${scheduleLine('Hint 3', config.challengeClue3Weekday, config.challengeClue3Hour, config.challengeFrequency)}`,
      `• ${scheduleLine('Reveal', config.challengeRevealWeekday, config.challengeRevealHour, config.challengeFrequency)}`,
      `• Timezone: **${config.timezone}** (set via /admin event config)`,
      `• Cleanup old posts on new cycle: **${config.challengeCleanupOldPosts ? 'Yes' : 'No'}**`,
      autoCreatedChannel ? `\n📌 Created <#${autoCreatedChannel.id}> since no channel was configured.` : '',
      !config.boardGameChallengeChannelId
        ? '\n⚠️ Set a channel before enabling — hints have nowhere to post otherwise.'
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });
}

// /admin challenge reset-scores — admin-only (see CLAUDE.md 1c: this is a
// breaking, irreversible action, so it requires an explicit confirm:true
// rather than running off just the subcommand name). Only clears the
// cumulative leaderboard totals — see resetLeaderboard's own comment for why
// past challenges' correctGuesses records are left alone.
export async function handleChallengeResetScores(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!isAdmin) {
    await interaction.editReply({ content: 'This command requires Manage Server permission.' });
    return;
  }

  const confirm = interaction.options.getBoolean('confirm', true);
  if (!confirm) {
    await interaction.editReply({
      content: 'Scoreboard reset cancelled — run again with `confirm:true` to actually reset it.',
    });
    return;
  }

  const guildId = interaction.guildId!;
  await resetLeaderboard(guildId);
  await updateChallengeLeaderboardPin(interaction.client, guildId);

  await interaction.editReply({ content: '🔄 The board game challenge scoreboard has been reset for everyone.' });
}

// /host challenge points — host-level (see /host's own ManageEvents default
// permission, which gates this whole command already). A positive amount
// adds, a negative amount subtracts; the result is clamped at 0 by
// adjustUserPoints, which this surfaces to the host rather than leaving a
// silent 0 unexplained.
export async function handleHostChallengePoints(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);

  if (amount === 0) {
    await interaction.reply({ content: 'Amount must be non-zero.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId!;
  const { total, clamped } = await adjustUserPoints(guildId, targetUser.id, amount);
  await updateChallengeLeaderboardPin(interaction.client, guildId);

  const verb = amount > 0 ? 'Added' : 'Subtracted';
  const preposition = amount > 0 ? 'to' : 'from';
  const pts = (n: number) => `${n} point${n === 1 ? '' : 's'}`;
  await interaction.reply({
    content: [
      `${verb} **${pts(Math.abs(amount))}** ${preposition} <@${targetUser.id}>. New total: **${pts(total)}**.`,
      clamped ? "-# Clamped at 0 — this would've gone negative." : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getGuildConfig(guildId);
  if (!config.boardGameChallengeEnabled || !config.boardGameChallengeChannelId) {
    await interaction.reply({
      content: 'The board game challenge isn\'t set up on this server yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const challenge = await getActiveChallenge(guildId);
  if (!challenge) {
    await interaction.reply({
      content: `No challenge is active right now — the next one starts ${describeStage(config.challengeClue1Weekday, config.challengeClue1Hour, config.challengeFrequency)} in <#${config.boardGameChallengeChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const hintLines = challenge.clues
    .slice(0, challenge.hintsPostedCount)
    .map((clue, i) => `**Hint ${i + 1}:** ${clue}`);

  const hintSchedule = [
    describeStage(config.challengeClue1Weekday, config.challengeClue1Hour, config.challengeFrequency),
    describeStage(config.challengeClue2Weekday, config.challengeClue2Hour, config.challengeFrequency),
    describeStage(config.challengeClue3Weekday, config.challengeClue3Hour, config.challengeFrequency),
  ];
  const next =
    challenge.hintsPostedCount < 3
      ? `Next hint: **${hintSchedule[challenge.hintsPostedCount]}**`
      : `All 3 hints are posted — the answer reveals **${describeStage(config.challengeRevealWeekday, config.challengeRevealHour, config.challengeFrequency)}**.`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎲 Current Board Game Challenge')
    .setDescription(
      `${hintLines.join('\n\n')}\n\n${next}\n\nReply with your guess in <#${challenge.channelId}>.\n\n-# The mystery game is always one of BGG's top 500 ranked base games — never an expansion.`,
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
