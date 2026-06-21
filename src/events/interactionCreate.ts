import { ButtonInteraction, Interaction, TextChannel } from 'discord.js';
import { execute as executeGameNight } from '../commands/gamenight';
import { findGameNight, upsertGameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'event') {
        await executeGameNight(interaction);
      }
    } else if (interaction.isButton()) {
      const parts = interaction.customId.split('_');
      if (parts[0] === 'rsvp' && parts.length === 3) {
        await handleRsvp(interaction, parts[1] as 'yes' | 'maybe' | 'no', parts[2]);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const reply = { content: 'Something went wrong. Please try again.', ephemeral: true };
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }
}

async function handleRsvp(
  interaction: ButtonInteraction,
  type: 'yes' | 'maybe' | 'no',
  gnId: string,
): Promise<void> {
  const gn = findGameNight(gnId);

  if (!gn || gn.cancelled) {
    await interaction.reply({ content: 'This event is no longer active.', ephemeral: true });
    return;
  }

  const userId = interaction.user.id;

  // Remove from all lists, then add to the chosen one
  gn.rsvps.yes = gn.rsvps.yes.filter(id => id !== userId);
  gn.rsvps.maybe = gn.rsvps.maybe.filter(id => id !== userId);
  gn.rsvps.no = gn.rsvps.no.filter(id => id !== userId);
  gn.rsvps[type].push(userId);

  upsertGameNight(gn);

  // Grant or revoke access to the private event channel
  if (gn.eventChannelId) {
    try {
      const eventChannel = await interaction.client.channels.fetch(gn.eventChannelId) as TextChannel;
      if (type === 'yes' || type === 'maybe') {
        await eventChannel.permissionOverwrites.create(userId, { ViewChannel: true });
      } else {
        await eventChannel.permissionOverwrites.delete(userId);
      }
    } catch { /* channel may not exist */ }
  }

  // Resolve display names for updated embed
  const nameMap: Record<string, string> = {};
  const guild = interaction.guild;
  if (guild) {
    const allIds = [...gn.rsvps.yes, ...gn.rsvps.maybe, ...gn.rsvps.no];
    await Promise.all(
      allIds.map(async id => {
        try {
          const member = await guild.members.fetch(id);
          nameMap[id] = member.displayName;
        } catch { /* fall back to mention */ }
      })
    );
  }

  await interaction.update({
    embeds: [buildGameNightEmbed(gn, nameMap)],
    components: [buildGameNightButtons(gn.id)],
  });
}
