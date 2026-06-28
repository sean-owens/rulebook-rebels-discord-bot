import { ButtonInteraction, Interaction, TextChannel } from 'discord.js';
import { execute as executeHelp } from '../commands/help';
import { execute as executeGameNight } from '../commands/gamenight';
import { execute as executeWelcome } from '../commands/welcome';
import { execute as executeGameTags, handleAutocomplete as handleGameTagsAutocomplete } from '../commands/gametags';
import { execute as executeMyRoles, handleMyRolesTag, handleMyRolesDiff, handleMyRolesNext, handleMyRolesBackDiff, handleMyRolesPage, handleMyRolesSubmit } from '../commands/myroles';
import { execute as executeLibrary, handleAddConfirm, handleAddCancel, handleAddBggConfirm, handleAddBggDismiss, handleAddBggSelect, handleLibraryAddPartialSelect, handleEditModal, handleComplexityFix, handleTagsFix, handleTagsSkip, handleRemoveSelect, handleLibraryViewSelect, handleLibraryRequestSelect, handleLibraryRequestCopySelect, handleUnrequestEventSelect, handleUnrequestSelect, handleUnrequestAll, handleLibraryListNav } from '../commands/library';
import { Complexity } from '../utils/libraryStorage';
import { execute as executeBgg } from '../commands/bgg';
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
  handleWaitlistJoin,
  handleWaitlistLeave,
  handleEventSelect,
  handleGameTagSelect,
  handleGameTagSkip,
} from '../commands/game';
import { findGameNight, upsertGameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'gametags') await handleGameTagsAutocomplete(interaction);

    } else if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'help') await executeHelp(interaction);
      else if (interaction.commandName === 'event') await executeGameNight(interaction);
      else if (interaction.commandName === 'game') await executeGame(interaction);
      else if (interaction.commandName === 'welcome') await executeWelcome(interaction);
      else if (interaction.commandName === 'gametags') await executeGameTags(interaction);
      else if (interaction.commandName === 'myroles') await executeMyRoles(interaction);
      else if (interaction.commandName === 'library') await executeLibrary(interaction);
      else if (interaction.commandName === 'bgg') await executeBgg(interaction);

    } else if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      if (id === 'game_event_select') await handleEventSelect(interaction);
      else if (id === 'library_suggest_select') await handleLibrarySuggestSelect(interaction);
      else if (id === 'library_add_bgg_select') await handleAddBggSelect(interaction);
      else if (id === 'library_add_partial_select') await handleLibraryAddPartialSelect(interaction);
      else if (id === 'library_remove_select') await handleRemoveSelect(interaction);
      else if (id === 'library_edit_tags_select') await handleTagsFix(interaction);
      else if (id === 'library_view_select') await handleLibraryViewSelect(interaction);
      else if (id === 'library_request_select') await handleLibraryRequestSelect(interaction);
      else if (id === 'library_request_copy_select') await handleLibraryRequestCopySelect(interaction);
      else if (id === 'library_unrequest_event_select') await handleUnrequestEventSelect(interaction);
      else if (id.startsWith('library_unrequest_select_')) await handleUnrequestSelect(interaction, id.slice('library_unrequest_select_'.length));
      else if (id === 'game_select') await handleGameSelect(interaction);
      else if (id === 'game_select_exp') await handleGameSelectWithExp(interaction);
      else if (id.startsWith('game_exp_')) await handleExpansionSelect(interaction, id.slice('game_exp_'.length));
      else if (id.startsWith('game_tags_')) await handleGameTagSelect(interaction, id.slice('game_tags_'.length));

    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'game_manual') await handleManualGameSubmit(interaction);
      else if (interaction.customId === 'library_edit_modal') await handleEditModal(interaction);

    } else if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'myroles_submit') {
        await handleMyRolesSubmit(interaction);
      } else if (id.startsWith('myroles_tag_')) {
        // Format: myroles_tag_<page>_<roleId>
        const rest = id.slice('myroles_tag_'.length);
        const sep = rest.indexOf('_');
        await handleMyRolesTag(interaction, parseInt(rest.slice(0, sep), 10) || 0, rest.slice(sep + 1));
      } else if (id.startsWith('myroles_diff_')) {
        // Format: myroles_diff_<roleId>
        await handleMyRolesDiff(interaction, id.slice('myroles_diff_'.length));
      } else if (id === 'myroles_next') {
        await handleMyRolesNext(interaction);
      } else if (id === 'myroles_back_diff') {
        await handleMyRolesBackDiff(interaction);
      } else if (id.startsWith('myroles_page_')) {
        await handleMyRolesPage(interaction, parseInt(id.slice('myroles_page_'.length), 10) || 0);
      } else if (id === 'library_list_prev') {
        await handleLibraryListNav(interaction, 'prev');
      } else if (id === 'library_list_next') {
        await handleLibraryListNav(interaction, 'next');
      } else if (id === 'library_add_confirm') {
        await handleAddConfirm(interaction);
      } else if (id === 'library_add_cancel') {
        await handleAddCancel(interaction);
      } else if (id === 'library_add_bgg_confirm') {
        await handleAddBggConfirm(interaction);
      } else if (id === 'library_add_bgg_dismiss') {
        await handleAddBggDismiss(interaction);
      } else if (id === 'library_edit_complexity_light') {
        await handleComplexityFix(interaction, 'Light' as Complexity);
      } else if (id === 'library_edit_complexity_medium') {
        await handleComplexityFix(interaction, 'Medium' as Complexity);
      } else if (id === 'library_edit_complexity_heavy') {
        await handleComplexityFix(interaction, 'Heavy' as Complexity);
      } else if (id === 'library_edit_tags_skip') {
        await handleTagsSkip(interaction);
      } else if (id.startsWith('library_unrequest_all_')) {
        await handleUnrequestAll(interaction, id.slice('library_unrequest_all_'.length));
      } else if (id.startsWith('game_tags_skip_')) {
        await handleGameTagSkip(interaction, id.slice('game_tags_skip_'.length));
      } else if (id === 'game_bring_confirm') {
        await handleBringConfirm(interaction);
      } else if (id === 'game_bring_cancel') {
        await handleBringCancel(interaction);
      } else if (id.startsWith('game_manual_')) {
        await handleManualBtn(interaction);
      } else if (id.startsWith('rsvp_')) {
        // Format: rsvp_<type>_<gnId>
        const rest = id.slice('rsvp_'.length);
        const sep = rest.indexOf('_');
        await handleRsvp(interaction, rest.slice(0, sep) as 'yes' | 'maybe' | 'no', rest.slice(sep + 1));
      } else if (id.startsWith('game_join_')) {
        await handleGameJoin(interaction, id.slice('game_join_'.length));
      } else if (id.startsWith('game_leave_')) {
        await handleGameLeave(interaction, id.slice('game_leave_'.length));
      } else if (id.startsWith('game_waitlist_join_')) {
        await handleWaitlistJoin(interaction, id.slice('game_waitlist_join_'.length));
      } else if (id.startsWith('game_waitlist_leave_')) {
        await handleWaitlistLeave(interaction, id.slice('game_waitlist_leave_'.length));
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

  if (gn.eventChannelId && !gn.openChannel) {
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
