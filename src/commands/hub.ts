import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { loadGameNights } from '../utils/storage';
import { findRoomByChannel } from '../utils/roomStorage';
import { getGuildConfig } from '../utils/config';
import { buildHubEmbed, buildHubButtons } from '../utils/requestPin';
import { buildRoomHubEmbed, buildRoomHubButtons } from './room';
import { buildGeneralHubEmbed, buildGeneralHubButtons } from '../utils/generalHub';
import { buildMarketplaceHubEmbed, buildMarketplaceHubButtons } from './marketplace';

export const data = new SlashCommandBuilder()
  .setName('hub')
  .setDescription('Get the "Quick Actions" buttons for this channel, ephemerally');

// A standing pinned hub only exists per event/room/marketplace/general-chat
// instance — this command reuses those same embeds/buttons on demand for
// anyone who's scrolled past the pin (or is on a client where pinned messages
// are awkward to reach), via the same channel-context resolution the pinned
// hubs' own buttons already use elsewhere (findRoomByChannel, eventChannelId
// matching, etc.). Always ephemeral — this is a personal shortcut, not
// something that needs to repost into the channel for everyone.
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;

  const room = await findRoomByChannel(channelId);
  if (room) {
    await interaction.reply({
      embeds: [buildRoomHubEmbed()],
      components: [buildRoomHubButtons()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nights = await loadGameNights();
  const eventNight = nights.find(
    (gn) => gn.eventChannelId === channelId && !gn.cancelled && !gn.archived,
  );
  if (eventNight) {
    await interaction.reply({
      embeds: [buildHubEmbed()],
      components: [buildHubButtons()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await getGuildConfig(interaction.guildId!);

  if (config.marketplaceHubThreadId && channelId === config.marketplaceHubThreadId) {
    await interaction.reply({
      embeds: [buildMarketplaceHubEmbed()],
      components: [buildMarketplaceHubButtons()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (config.generalHubChannelId && channelId === config.generalHubChannelId) {
    await interaction.reply({
      embeds: [buildGeneralHubEmbed()],
      components: [buildGeneralHubButtons()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      "There's no Quick Actions hub for this channel — try this in an event channel, a private room, the marketplace, or general chat.",
    flags: MessageFlags.Ephemeral,
  });
}
