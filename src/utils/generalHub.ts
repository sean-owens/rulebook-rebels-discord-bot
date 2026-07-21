import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  TextChannel,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config';
import { loadGameNights } from './storage';
import { handleList, handleMine, resolveRandomGames } from '../commands/library';

// ── "Quick Actions" button hub for general chat ─────────────────────────────
// Unlike the per-event/per-room hubs, this is one pinned message per guild —
// mirrors the event hub's plain-message-pin approach (not the marketplace
// hub's forum-thread approach, since general chat is an ordinary text
// channel). "Request a Game to Bring" reuses the *exact* hub_request
// button/modal already built for the event hub — resolveRequestFlow in
// library.ts already falls back to the soonest upcoming event when there's
// no specific event-channel context, which is exactly the situation here.

function buildGeneralHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎮 Quick Actions')
    .setColor(0x57f287)
    .setDescription('Prefer tapping over typing? Use the buttons below instead of slash commands.')
    .addFields(
      { name: '✅ RSVP to Next Event', value: 'Jump to the next event to RSVP.' },
      { name: '📚 Browse Library', value: 'See every game the group owns.' },
      { name: '📋 My Games', value: "See the games you've added to the library." },
      { name: '🎲 Random Game', value: 'Get 3 random picks, tailored to your /myroles if set.' },
      { name: '🙋 Request a Game to Bring', value: 'Ask an owner to bring a specific game.' },
    );
}

function buildGeneralHubButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_general_rsvp').setLabel('✅ RSVP to Next Event').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('hub_general_browse').setLabel('📚 Browse Library').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_general_mine').setLabel('📋 My Games').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub_general_random').setLabel('🎲 Random Game').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub_request').setLabel('🙋 Request a Game to Bring').setStyle(ButtonStyle.Primary),
  );
}

export async function updateGeneralHubPin(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config.generalHubChannelId) return;

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(config.generalHubChannelId)) as TextChannel;
  } catch {
    return;
  }

  const payload = { embeds: [buildGeneralHubEmbed()], components: [buildGeneralHubButtons()] };

  if (config.generalHubPinMessageId) {
    try {
      const msg = await channel.messages.fetch(config.generalHubPinMessageId);
      await msg.edit(payload);
      if (!msg.pinned) {
        try {
          await msg.pin();
        } catch (err) {
          console.warn(`Could not re-pin general hub message in guild ${guildId}:`, err);
        }
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send(payload);
  try {
    await msg.pin();
  } catch (err) {
    console.warn(`Could not pin general hub message in guild ${guildId}:`, err);
  }

  await updateGuildConfig(guildId, { generalHubPinMessageId: msg.id });
}

// ── /admin general config ───────────────────────────────────────────────────

export async function handleGeneralHubConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const channel = interaction.options.getChannel('channel');

  if (!channel) {
    const config = await getGuildConfig(guildId);
    await interaction.editReply({
      content: `**General hub channel:** ${config.generalHubChannelId ? `<#${config.generalHubChannelId}>` : '*not set*'}`,
    });
    return;
  }

  if (channel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: 'The general hub channel must be a regular text channel.' });
    return;
  }

  await updateGuildConfig(guildId, { generalHubChannelId: channel.id });
  await updateGeneralHubPin(interaction.client, guildId).catch(() => null);

  await interaction.editReply({
    content: `General hub channel set to <#${channel.id}> — the "🎮 Quick Actions" panel has been posted/refreshed there.`,
  });
}

// ── Hub buttons ──────────────────────────────────────────────────────────────

export async function handleHubGeneralRsvpButton(interaction: ButtonInteraction): Promise<void> {
  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.reply({ content: "There's no upcoming event to RSVP to yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  const next = upcoming[0];
  const jumpUrl = `https://discord.com/channels/${next.guildId}/${next.channelId}/${next.messageId}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(`Jump to ${next.title ?? 'the event'} — ${next.date}`).setStyle(ButtonStyle.Link).setURL(jumpUrl),
  );
  await interaction.reply({
    content: 'Tap below to RSVP:',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubGeneralBrowseButton(interaction: ButtonInteraction): Promise<void> {
  await handleList(interaction);
}

export async function handleHubGeneralMineButton(interaction: ButtonInteraction): Promise<void> {
  await handleMine(interaction);
}

export async function handleHubGeneralRandomButton(interaction: ButtonInteraction): Promise<void> {
  await resolveRandomGames(interaction, [], null);
}
