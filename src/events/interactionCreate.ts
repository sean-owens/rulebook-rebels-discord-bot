import { ButtonInteraction, Interaction, StringSelectMenuInteraction, TextChannel, MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { execute as executeHelp } from '../commands/help';
import { execute as executeGettingStarted } from '../commands/gettingStarted';
import { execute as executeGameNight } from '../commands/gamenight';
import {
  execute as executeAdmin,
  handleAutocomplete as handleAdminAutocomplete,
} from '../commands/admin';
import { execute as executeHost } from '../commands/host';
import {
  handleHubGeneralViewButton,
  handleHubGeneralBrowseButton,
  handleHubGeneralMineButton,
  handleHubGeneralRandomButton,
} from '../utils/generalHub';
import {
  execute as executeMyRoles,
  handleMyRolesTag,
  handleMyRolesDiff,
  handleMyRolesNext,
  handleMyRolesBackDiff,
  handleMyRolesPage,
  handleMyRolesSubmit,
} from '../commands/myroles';
import {
  execute as executeLibrary,
  handleAddConfirm,
  handleAddCancel,
  handleAddBggConfirm,
  handleAddBggDismiss,
  handleAddBggSelect,
  handleLibraryAddPartialSelect,
  handleEditModal,
  handleComplexityFix,
  handleTagsFix,
  handleTagsSkip,
  handleRemoveSelect,
  handleLibraryViewSelect,
  handleLibraryRequestSelect,
  handleLibraryRequestCopySelect,
  handleUnrequestEventSelect,
  handleUnrequestSelect,
  handleUnrequestAll,
  handleLibraryListNav,
  handleLibraryMineNav,
  handleLibraryConfirmBring,
  handleLibraryDeclineBring,
  handleHubRequestButton,
  handleHubRequestModal,
  handleHubViewModal,
  handleHubBringButton,
  handleRequestSuggestConfirm,
} from '../commands/library';
import { Complexity } from '../utils/libraryStorage';
import { execute as executeBgg, handleBggLinkImportButton } from '../commands/bgg';
import {
  execute as executeMarketplace,
  handleAutocomplete as handleMarketplaceAutocomplete,
  handleInterestButton,
  handleBuyNowButton,
  handleBuyNowConfirm,
  handleBuyNowCancel,
  handleImportConfirm,
  handleImportCancel,
  handleBidModal,
  handleAcceptBid,
  handleDenyBid,
  handleCounterButton,
  handleCounterModal,
  handleReplyButton,
  handleReplyModal,
  handleMarketplaceEditModal,
  handleBuyerAcceptCounter,
  handlePriceUseSuggested,
  handlePriceNone,
  handlePriceCustomButton,
  handlePriceCustomModal,
  handleLibraryRemove,
  handleLibraryKeep,
  handleAddRefButton,
  handleSkipRefButton,
  handleRefModal,
  handleExpansionSelect as handleMarketplaceExpansionSelect,
  handleSkipExpansions,
  handleIncludeBaseGameYes,
  handleIncludeBaseGameNo,
  handleHubMarketplaceSellButton,
  handleHubMarketplaceSellModal,
  handleHubMarketplaceTradeButton,
  handleHubMarketplaceTradeModal,
  handleHubMarketplaceTradeLookingForModal,
  handleHubMarketplaceConditionSelect,
  handleHubMarketplaceOffersYes,
  handleHubMarketplaceOffersNo,
  handleHubMarketplaceBrowseButton,
  handleHubMarketplaceMyButton,
  handleMatchConfirmYes,
  handleMatchConfirmNotBgg,
  handleMatchConfirmSearchAgain,
  handleMatchResearchModal,
} from '../commands/marketplace';
import {
  execute as executeGame,
  handleGameSelect,
  handleGameSelectWithExp,
  handleExpansionSelect,
  handleLibraryExpansionSelect,
  handleManualBtn,
  handleManualGameSubmit,
  handleGameJoin,
  handleGameLeave,
  handleBringConfirm,
  handleBringCancel,
  handleBGGSearchPage,
  handleLibrarySuggestSelect,
  handleWaitlistJoin,
  handleWaitlistLeave,
  handleEventSelect,
  handleGameTagSelect,
  handleGameTagSkip,
  EVENT_SELECT_PREFIX,
  handleHubSuggestButton,
  handleHubSuggestModal,
  handleGameGuestButton,
  handleGameTeachToggle,
  handleTeachingChoice,
  handleGameGuestModalSubmit,
  handleGuestDuplicateConfirm,
  handleGuestDuplicateCancel,
} from '../commands/game';
import { findGameNight, upsertGameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';
import {
  execute as executeRoom,
  handleHubRoomInviteButton,
  handleHubRoomInviteSelect,
  handleHubRoomKickButton,
  handleHubRoomKickSelect,
  handleHubRoomPersistButton,
  handleHubRoomPersistModal,
} from '../commands/room';
import { execute as executeHub } from '../commands/hub';
import {
  execute as executeSnacks,
  handleSnacksRemoveSelect,
  handleHubSnacksButton,
  handleHubSnacksAddButton,
  handleHubSnacksAddModal,
  handleHubSnacksRemoveButton,
  handleHubSnacksRemoveSelect,
} from '../commands/snacks';
import {
  execute as executeChallenge,
  handleHubChallengeStatusButton,
  handleChallengeDisambiguationSelect,
  handleHubChallengeLeaderboardButton,
} from '../commands/boardgamechallenge';
import { extractCommandUsage, recordCommandUsage } from '../utils/commandUsageStorage';
import { handleWelcomeWaveButton } from './guildMemberAdd';
import { CHALLENGE_DISAMBIG_PREFIX } from './messageCreate';
import { WAVE_BUTTON_PREFIX, waveButtonTargetUserId } from '../utils/welcomeAnnouncement';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  const label = interaction.isChatInputCommand()
    ? `/${interaction.commandName}`
    : interaction.isButton() || interaction.isStringSelectMenu()
      ? `component:${interaction.customId}`
      : `type:${interaction.type}`;
  console.log(`[interaction] ${label} from ${interaction.user?.tag}`);

  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'admin') await handleAdminAutocomplete(interaction);
      else if (interaction.commandName === 'marketplace') await handleMarketplaceAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      if (interaction.guildId) {
        try {
          const { commandPath, paramNames } = extractCommandUsage(interaction);
          await recordCommandUsage(interaction.guildId, commandPath, paramNames);
        } catch (err) {
          console.error('[CommandUsage] Failed to record usage:', err);
        }
      }
      if (interaction.commandName === 'help') await executeHelp(interaction);
      else if (interaction.commandName === 'getting-started') await executeGettingStarted(interaction);
      else if (interaction.commandName === 'event') await executeGameNight(interaction);
      else if (interaction.commandName === 'game') await executeGame(interaction);
      else if (interaction.commandName === 'admin') await executeAdmin(interaction);
      else if (interaction.commandName === 'host') await executeHost(interaction);
      else if (interaction.commandName === 'myroles') await executeMyRoles(interaction);
      else if (interaction.commandName === 'library') await executeLibrary(interaction);
      else if (interaction.commandName === 'bgg') await executeBgg(interaction);
      else if (interaction.commandName === 'marketplace') await executeMarketplace(interaction);
      else if (interaction.commandName === 'room') await executeRoom(interaction);
      else if (interaction.commandName === 'hub') await executeHub(interaction);
      else if (interaction.commandName === 'snacks') await executeSnacks(interaction);
      else if (interaction.commandName === 'challenge') await executeChallenge(interaction);
    } else if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith(EVENT_SELECT_PREFIX)) await handleEventSelect(interaction);
      else if (id === 'library_suggest_select') await handleLibrarySuggestSelect(interaction);
      else if (id === 'library_add_bgg_select') await handleAddBggSelect(interaction);
      else if (id === 'library_add_partial_select')
        await handleLibraryAddPartialSelect(interaction);
      else if (id === 'library_remove_select') await handleRemoveSelect(interaction);
      else if (id === 'library_edit_tags_select') await handleTagsFix(interaction);
      else if (id === 'library_view_select') await handleLibraryViewSelect(interaction);
      else if (id === 'library_request_select') await handleLibraryRequestSelect(interaction);
      else if (id === 'library_request_copy_select')
        await handleLibraryRequestCopySelect(interaction);
      else if (id === 'library_unrequest_event_select')
        await handleUnrequestEventSelect(interaction);
      else if (id.startsWith('library_unrequest_select_'))
        await handleUnrequestSelect(interaction, id.slice('library_unrequest_select_'.length));
      else if (id.startsWith('mp_exp_select_'))
        await handleMarketplaceExpansionSelect(interaction as StringSelectMenuInteraction, id.slice('mp_exp_select_'.length));
      else if (id === 'game_select') await handleGameSelect(interaction);
      else if (id === 'game_select_exp') await handleGameSelectWithExp(interaction);
      else if (id.startsWith('game_exp_lib_'))
        await handleLibraryExpansionSelect(interaction, id.slice('game_exp_lib_'.length));
      else if (id.startsWith('game_exp_'))
        await handleExpansionSelect(interaction, id.slice('game_exp_'.length));
      else if (id.startsWith('game_tags_'))
        await handleGameTagSelect(interaction, id.slice('game_tags_'.length));
      else if (id === 'hub_mp_condition_select') await handleHubMarketplaceConditionSelect(interaction);
      else if (id === 'snacks_remove_select') await handleSnacksRemoveSelect(interaction);
      else if (id === 'hub_snacks_remove_select') await handleHubSnacksRemoveSelect(interaction);
      else if (id.startsWith(CHALLENGE_DISAMBIG_PREFIX))
        await handleChallengeDisambiguationSelect(interaction, id.slice(CHALLENGE_DISAMBIG_PREFIX.length));
    } else if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id === 'hub_room_invite_select') await handleHubRoomInviteSelect(interaction);
      else if (id === 'hub_room_kick_select') await handleHubRoomKickSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'game_manual') await handleManualGameSubmit(interaction);
      else if (interaction.customId === 'library_edit_modal') await handleEditModal(interaction);
      else if (interaction.customId === 'hub_suggest_modal') await handleHubSuggestModal(interaction);
      else if (interaction.customId === 'hub_request_modal') await handleHubRequestModal(interaction);
      else if (interaction.customId === 'hub_view_modal') await handleHubViewModal(interaction);
      else if (interaction.customId === 'hub_room_persist_modal') await handleHubRoomPersistModal(interaction);
      else if (interaction.customId === 'hub_mp_sell_modal') await handleHubMarketplaceSellModal(interaction);
      else if (interaction.customId === 'hub_mp_trade_modal') await handleHubMarketplaceTradeModal(interaction);
      else if (interaction.customId === 'hub_mp_trade_looking_for_modal') await handleHubMarketplaceTradeLookingForModal(interaction);
      else if (interaction.customId === 'hub_snacks_add_modal') await handleHubSnacksAddModal(interaction);
      else if (interaction.customId.startsWith('mp_bid_')) {
        await handleBidModal(interaction as unknown as ModalSubmitInteraction, interaction.customId.slice('mp_bid_'.length));
      } else if (interaction.customId.startsWith('mp_price_modal_')) {
        await handlePriceCustomModal(interaction as unknown as ModalSubmitInteraction, interaction.customId.slice('mp_price_modal_'.length));
      } else if (interaction.customId.startsWith('mp_counter_modal_')) {
        const rest = interaction.customId.slice('mp_counter_modal_'.length);
        const sep = rest.indexOf('_');
        await handleCounterModal(interaction as unknown as ModalSubmitInteraction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (interaction.customId.startsWith('mp_reply_modal_')) {
        const rest = interaction.customId.slice('mp_reply_modal_'.length);
        const sep = rest.indexOf('_');
        await handleReplyModal(interaction as unknown as ModalSubmitInteraction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (interaction.customId.startsWith('mp_edit_modal_')) {
        await handleMarketplaceEditModal(interaction as unknown as ModalSubmitInteraction, interaction.customId.slice('mp_edit_modal_'.length));
      } else if (interaction.customId.startsWith('mp_ref_modal_')) {
        await handleRefModal(interaction as unknown as ModalSubmitInteraction, interaction.customId.slice('mp_ref_modal_'.length));
      } else if (interaction.customId.startsWith('mp_match_research_modal_')) {
        await handleMatchResearchModal(interaction as unknown as ModalSubmitInteraction, interaction.customId.slice('mp_match_research_modal_'.length));
      } else if (interaction.customId.startsWith('game_guestmodal_')) {
        await handleGameGuestModalSubmit(interaction, interaction.customId.slice('game_guestmodal_'.length));
      }
    } else if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'myroles_submit') {
        await handleMyRolesSubmit(interaction);
      } else if (id.startsWith('myroles_tag_')) {
        // Format: myroles_tag_<page>_<roleId>
        const rest = id.slice('myroles_tag_'.length);
        const sep = rest.indexOf('_');
        await handleMyRolesTag(
          interaction,
          parseInt(rest.slice(0, sep), 10) || 0,
          rest.slice(sep + 1),
        );
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
      } else if (id === 'library_mine_prev') {
        await handleLibraryMineNav(interaction, 'prev');
      } else if (id === 'library_mine_next') {
        await handleLibraryMineNav(interaction, 'next');
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
      } else if (id.startsWith('library_suggest_from_request_')) {
        await handleRequestSuggestConfirm(interaction, id.slice('library_suggest_from_request_'.length));
      } else if (id.startsWith('library_confirmbring_')) {
        await handleLibraryConfirmBring(interaction, id.slice('library_confirmbring_'.length));
      } else if (id.startsWith('library_declinebring_')) {
        await handleLibraryDeclineBring(interaction, id.slice('library_declinebring_'.length));
      } else if (id === 'hub_suggest') {
        await handleHubSuggestButton(interaction);
      } else if (id === 'hub_request') {
        await handleHubRequestButton(interaction);
      } else if (id === 'hub_bring') {
        await handleHubBringButton(interaction);
      } else if (id === 'hub_general_view') {
        await handleHubGeneralViewButton(interaction);
      } else if (id === 'hub_general_browse') {
        await handleHubGeneralBrowseButton(interaction);
      } else if (id === 'hub_general_mine') {
        await handleHubGeneralMineButton(interaction);
      } else if (id === 'hub_general_random') {
        await handleHubGeneralRandomButton(interaction);
      } else if (id === 'hub_room_invite') {
        await handleHubRoomInviteButton(interaction);
      } else if (id === 'hub_room_kick') {
        await handleHubRoomKickButton(interaction);
      } else if (id === 'hub_room_persist') {
        await handleHubRoomPersistButton(interaction);
      } else if (id === 'hub_mp_sell') {
        await handleHubMarketplaceSellButton(interaction);
      } else if (id === 'hub_mp_trade') {
        await handleHubMarketplaceTradeButton(interaction);
      } else if (id === 'hub_mp_offers_yes') {
        await handleHubMarketplaceOffersYes(interaction);
      } else if (id === 'hub_mp_offers_no') {
        await handleHubMarketplaceOffersNo(interaction);
      } else if (id === 'hub_mp_browse') {
        await handleHubMarketplaceBrowseButton(interaction);
      } else if (id === 'hub_mp_my') {
        await handleHubMarketplaceMyButton(interaction);
      } else if (id === 'hub_challenge_status') {
        await handleHubChallengeStatusButton(interaction);
      } else if (id === 'hub_challenge_leaderboard') {
        await handleHubChallengeLeaderboardButton(interaction);
      } else if (id === 'hub_snacks') {
        await handleHubSnacksButton(interaction);
      } else if (id === 'hub_snacks_add') {
        await handleHubSnacksAddButton(interaction);
      } else if (id === 'hub_snacks_remove') {
        await handleHubSnacksRemoveButton(interaction);
      } else if (id === 'bgg_link_import') {
        await handleBggLinkImportButton(interaction);
      } else if (id.startsWith('game_tags_skip_')) {
        await handleGameTagSkip(interaction, id.slice('game_tags_skip_'.length));
      } else if (id === 'game_bring_confirm') {
        await handleBringConfirm(interaction);
      } else if (id === 'game_bring_cancel') {
        await handleBringCancel(interaction);
      } else if (id === 'game_guestdupe_confirm') {
        await handleGuestDuplicateConfirm(interaction);
      } else if (id === 'game_guestdupe_cancel') {
        await handleGuestDuplicateCancel(interaction);
      } else if (id === 'game_bgg_prev') {
        await handleBGGSearchPage(interaction, 'prev');
      } else if (id === 'game_bgg_next') {
        await handleBGGSearchPage(interaction, 'next');
      } else if (id.startsWith('game_manual_')) {
        await handleManualBtn(interaction);
      } else if (id.startsWith('rsvp_')) {
        // Format: rsvp_<type>_<gnId>
        const rest = id.slice('rsvp_'.length);
        const sep = rest.indexOf('_');
        await handleRsvp(
          interaction,
          rest.slice(0, sep) as 'yes' | 'maybe' | 'no',
          rest.slice(sep + 1),
        );
      } else if (id.startsWith('game_join_')) {
        await handleGameJoin(interaction, id.slice('game_join_'.length));
      } else if (id.startsWith('game_leave_')) {
        await handleGameLeave(interaction, id.slice('game_leave_'.length));
      } else if (id.startsWith('game_waitlist_join_')) {
        await handleWaitlistJoin(interaction, id.slice('game_waitlist_join_'.length));
      } else if (id.startsWith('game_waitlist_leave_')) {
        await handleWaitlistLeave(interaction, id.slice('game_waitlist_leave_'.length));
      } else if (id.startsWith('game_guestbtn_')) {
        await handleGameGuestButton(interaction, id.slice('game_guestbtn_'.length));
      } else if (id.startsWith('game_teachbtn_')) {
        await handleGameTeachToggle(interaction, id.slice('game_teachbtn_'.length));
      } else if (id.startsWith('game_teach_')) {
        await handleTeachingChoice(interaction, id.slice('game_teach_'.length));
      } else if (id.startsWith('mp_price_use_')) {
        await handlePriceUseSuggested(interaction, id.slice('mp_price_use_'.length));
      } else if (id.startsWith('mp_price_none_')) {
        await handlePriceNone(interaction, id.slice('mp_price_none_'.length));
      } else if (id.startsWith('mp_price_custom_')) {
        await handlePriceCustomButton(interaction, id.slice('mp_price_custom_'.length));
      } else if (id.startsWith('mp_interest_')) {
        await handleInterestButton(interaction, id.slice('mp_interest_'.length));
      } else if (id.startsWith('mp_buynowyes_')) {
        await handleBuyNowConfirm(interaction, id.slice('mp_buynowyes_'.length));
      } else if (id.startsWith('mp_import_yes_')) {
        await handleImportConfirm(interaction, id.slice('mp_import_yes_'.length));
      } else if (id.startsWith('mp_import_no_')) {
        await handleImportCancel(interaction, id.slice('mp_import_no_'.length));
      } else if (id.startsWith('mp_buynowno_')) {
        await handleBuyNowCancel(interaction);
      } else if (id.startsWith('mp_buynow_')) {
        await handleBuyNowButton(interaction, id.slice('mp_buynow_'.length));
      } else if (id.startsWith('mp_accept_')) {
        const rest = id.slice('mp_accept_'.length);
        const sep = rest.indexOf('_');
        await handleAcceptBid(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_deny_')) {
        const rest = id.slice('mp_deny_'.length);
        const sep = rest.indexOf('_');
        await handleDenyBid(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_counter_') && !id.startsWith('mp_counter_modal_')) {
        const rest = id.slice('mp_counter_'.length);
        const sep = rest.indexOf('_');
        await handleCounterButton(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_reply_') && !id.startsWith('mp_reply_modal_')) {
        const rest = id.slice('mp_reply_'.length);
        const sep = rest.indexOf('_');
        await handleReplyButton(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_buyer_accept_')) {
        const rest = id.slice('mp_buyer_accept_'.length);
        const sep = rest.indexOf('_');
        await handleBuyerAcceptCounter(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_buyer_deny_')) {
        const rest = id.slice('mp_buyer_deny_'.length);
        const sep = rest.indexOf('_');
        await handleDenyBid(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_lib_remove_')) {
        const rest = id.slice('mp_lib_remove_'.length);
        const sep = rest.indexOf('_');
        await handleLibraryRemove(interaction, rest.slice(0, sep), rest.slice(sep + 1));
      } else if (id.startsWith('mp_lib_keep_')) {
        await handleLibraryKeep(interaction);
      } else if (id.startsWith('mp_ref_add_')) {
        await handleAddRefButton(interaction, id.slice('mp_ref_add_'.length));
      } else if (id.startsWith('mp_ref_skip_')) {
        await handleSkipRefButton(interaction, id.slice('mp_ref_skip_'.length));
      } else if (id.startsWith('mp_match_yes_')) {
        await handleMatchConfirmYes(interaction, id.slice('mp_match_yes_'.length));
      } else if (id.startsWith('mp_match_search_')) {
        await handleMatchConfirmSearchAgain(interaction, id.slice('mp_match_search_'.length));
      } else if (id.startsWith('mp_match_notbgg_')) {
        await handleMatchConfirmNotBgg(interaction, id.slice('mp_match_notbgg_'.length));
      } else if (id.startsWith('mp_exp_skip_')) {
        await handleSkipExpansions(interaction, id.slice('mp_exp_skip_'.length));
      } else if (id.startsWith('mp_base_yes_')) {
        await handleIncludeBaseGameYes(interaction, id.slice('mp_base_yes_'.length));
      } else if (id.startsWith('mp_base_no_')) {
        await handleIncludeBaseGameNo(interaction, id.slice('mp_base_no_'.length));
      } else if (id.startsWith(WAVE_BUTTON_PREFIX)) {
        await handleWelcomeWaveButton(interaction, waveButtonTargetUserId(id));
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.isRepliable()) {
        const msg = { content: 'Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] as const };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
        else await interaction.reply(msg);
      }
    } catch {
      /* interaction expired — nothing to do */
    }
  }
}

async function handleRsvp(
  interaction: ButtonInteraction,
  type: 'yes' | 'maybe' | 'no',
  gnId: string,
): Promise<void> {
  const gn = await findGameNight(gnId);
  if (!gn || gn.cancelled) {
    await interaction.reply({ content: 'This event is no longer active.', flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = interaction.user.id;
  gn.rsvps.yes = gn.rsvps.yes.filter((id) => id !== userId);
  gn.rsvps.maybe = gn.rsvps.maybe.filter((id) => id !== userId);
  gn.rsvps.no = gn.rsvps.no.filter((id) => id !== userId);
  gn.rsvps[type].push(userId);
  await upsertGameNight(gn);

  if (gn.eventChannelId && !gn.openChannel) {
    try {
      const eventChannel = (await interaction.client.channels.fetch(
        gn.eventChannelId,
      )) as TextChannel;
      if (type === 'yes' || type === 'maybe') {
        await eventChannel.permissionOverwrites.create(userId, { ViewChannel: true });
      } else {
        await eventChannel.permissionOverwrites.delete(userId);
      }
    } catch {
      /* channel may not exist */
    }
  }

  const nameMap: Record<string, string> = {};
  if (interaction.guild) {
    const allIds = [...gn.rsvps.yes, ...gn.rsvps.maybe, ...gn.rsvps.no];
    await Promise.all(
      allIds.map(async (id) => {
        try {
          const member = await interaction.guild!.members.fetch(id);
          nameMap[id] = member.displayName;
        } catch {
          /* fall back to mention */
        }
      }),
    );
  }

  await interaction.update({
    embeds: [buildGameNightEmbed(gn, nameMap)],
    components: [buildGameNightButtons(gn.id)],
  });
}
