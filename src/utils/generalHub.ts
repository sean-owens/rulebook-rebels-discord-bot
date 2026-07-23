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
  ModalBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config';
import { handleList, handleMine, resolveRandomGames } from '../commands/library';
import { pinWithRetry } from './discordPin';

// ── "Quick Actions" button hub for general chat ─────────────────────────────
// Unlike the per-event/per-room hubs, this is one pinned message per guild —
// mirrors the event hub's plain-message-pin approach (not the marketplace
// hub's forum-thread approach, since general chat is an ordinary text
// channel). "Request a Game to Bring" reuses the *exact* hub_request
// button/modal already built for the event hub — resolveRequestFlow in
// library.ts already falls back to the soonest upcoming event when there's
// no specific event-channel context, which is exactly the situation here.

export function buildGeneralHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎮 Quick Actions')
    .setColor(0x57f287)
    .setDescription('Prefer tapping over typing? Use the buttons below instead of slash commands.')
    .addFields(
      { name: '🔍 View a Game', value: 'Look up any game in the library.' },
      { name: '📚 Browse Library', value: 'See every game the group owns.' },
      { name: '📋 My Games', value: "See the games you've added to the library." },
      { name: '🎲 Random Game', value: 'Get 3 random picks, tailored to your /myroles if set.' },
      { name: '🙋 Request a Game to Bring', value: 'Ask an owner to bring a specific game.' },
    );
}

export function buildGeneralHubButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_general_view').setLabel('🔍 View a Game').setStyle(ButtonStyle.Success),
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
        await pinWithRetry(msg, `re-pin general hub message in guild ${guildId}`);
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send(payload);
  await pinWithRetry(msg, `general hub message in guild ${guildId}`);

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

export async function handleHubGeneralViewButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('hub_view_modal')
    .setTitle('View a Game')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('game')
          .setLabel('Game name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Catan')
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
  await interaction.showModal(modal);
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
