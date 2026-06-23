import { ButtonInteraction, Interaction, TextChannel } from 'discord.js';
import { execute as executeGameNight } from '../commands/gamenight';
import { execute as executeWelcome } from '../commands/welcome';
import { execute as executeGameTags, handleAutocomplete as handleGameTagsAutocomplete } from '../commands/gametags';
import { execute as executeMyRoles, handleMyRolesSelect } from '../commands/myroles';
import { execute as executeLibrary, handleAddConfirm, handleAddCancel, handleEditModal, handleLibraryViewSelect, handleLibraryRequestSelect } from '../commands/library';
import {
  execute as executeGame,
  handleGameSelect,
  handleGameSelectWithExp,
  handleExpansionSelect,
  handleManualBtn,
  handleManualGameSubmit,
  handleGameJoin,
  handleGameLeave,
  handleBringConfirm,
  handleBringCancel,
  handleLibrarySuggestSelect,
} from '../commands/game';
import { findGameNight, upsertGameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'gametags') await handleGameTagsAutocomplete(interaction);

    } else if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'event') await executeGameNight(interaction);
      else if (interaction.commandName === 'game') await executeGame(interaction);
      else if (interaction.commandName === 'welcome') await executeWelcome(interaction);
      else if (interaction.commandName === 'gametags') await executeGameTags(interaction);
      else if (interaction.commandName === 'myroles') await executeMyRoles(interaction);
      else if (interaction.commandName === 'library') await executeLibrary(interaction);

    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'myroles_select') {
        await handleMyRolesSelect(interaction);
      } else if (interaction.customId === 'library_suggest_select') {
        await handleLibrarySuggestSelect(interaction);
      } else if (interaction.customId === 'library_view_select') {
        await handleLibraryViewSelect(interaction);
      } else if (interaction.customId === 'library_request_select') {
        await handleLibraryRequestSelect(interaction);
      } else if (interaction.customId === 'game_select') {
        await handleGameSelect(interaction);
      } else if (interaction.customId === 'game_select_exp') {
        await handleGameSelectWithExp(interaction);
      } else if (interaction.customId.startsWith('game_exp_')) {
        await handleExpansionSelect(interaction, interaction.customId.slice('game_exp_'.length));
      }

    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'game_manual') {
        await handleManualGameSubmit(interaction);
      } else if (interaction.customId === 'library_edit_modal') {
        await handleEditModal(interaction);
      }

    } else if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'library_add_confirm') {
        await handleAddConfirm(interaction);
      } else if (id === 'library_add_cancel') {
        await handleAddCancel(interaction);
      } else if (id === 'game_bring_confirm') {
        await handleBringConfirm(interaction);
      } else if (id === 'game_bring_cancel') {
        await handleBringCancel(interaction);
      } else if (id.startsWith('game_manual_')) {
        await handleManualBtn(interaction);
      } else {
        const parts = id.split('_');
        if (parts[0] === 'rsvp' && parts.length === 3) {
          await handleRsvp(interaction, parts[1] as 'yes' | 'maybe' | 'no', parts[2]);
        } else if (parts[0] === 'game' && parts[1] === 'join' && parts[2]) {
          await handleGameJoin(interaction, parts[2]);
        } else if (parts[0] === 'game' && parts[1] === 'leave' && parts[2]) {
          await handleGameLeave(interaction, parts[2]);
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const reply = { content: 'Something went wrong. Please try again.', ephemeral: true };
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
        else await interaction.reply(reply);
      }
    } catch { /* interaction expired — nothing to do */ }
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
  gn.rsvps.yes = gn.rsvps.yes.filter(id => id !== userId);
  gn.rsvps.maybe = gn.rsvps.maybe.filter(id => id !== userId);
  gn.rsvps.no = gn.rsvps.no.filter(id => id !== userId);
  gn.rsvps[type].push(userId);
  upsertGameNight(gn);

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

  const nameMap: Record<string, string> = {};
  if (interaction.guild) {
    const allIds = [...gn.rsvps.yes, ...gn.rsvps.maybe, ...gn.rsvps.no];
    await Promise.all(
      allIds.map(async id => {
        try {
          const member = await interaction.guild!.members.fetch(id);
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
