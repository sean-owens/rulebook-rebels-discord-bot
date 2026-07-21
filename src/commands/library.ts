import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import {
  loadLibraryForGuild,
  addGame,
  addGamesBulk,
  removeGame,
  clearUserLibrary,
  getGamesByUser,
  getGamesByUserAndLinked,
  findGamesByName,
  findGameNamesByPartial,
  getGameInfo,
  loadGameInfos,
  upsertGameInfo,
  upsertGameInfosBulk,
  GameInfo,
  GAME_TAGS,
  Complexity,
  addRequest,
  getRequestsForEvent,
  getRequestById,
  removeRequests,
  removeAllRequestsForEvent,
  confirmBring,
  declineBring,
  buildExpansionNote,
  resolveAttendingOwnerIds,
  pickPreferredOwner,
  GameRequest,
} from '../utils/libraryStorage';
import {
  addLibraryLink,
  removeLibraryLink,
  getEffectiveOwnerIds,
  getLibraryLinksForGuild,
} from '../utils/libraryLinkStorage';
import { loadGameNights, findGameNight, GameNight } from '../utils/storage';
import { getGameRoles, getMemberPreferences } from '../utils/gameRoles';
import { updateRequestPin } from '../utils/requestPin';
import { sendBringRequestDm, invalidateBringDm, reconcileRequestCopies } from '../utils/libraryBringDm';
import AdmZip from 'adm-zip';
import { getBGGGame, getBGGGamesBatch, BGGGame, weightTag, fetchBggOwnedCollection } from '../utils/bgg';
import { getGuildConfig } from '../utils/config';
import {
  searchCatalog,
  isCatalogLoaded,
  normalizeName,
  BGGCatalogEntry,
} from '../utils/bggCatalog';
import { getBggAccount } from '../utils/bggAccountStorage';
import { mergeUserCollection, UserCollectionEntry } from '../utils/userCollectionStorage';
import { GENRE_TAG_DEFINITIONS } from '../utils/tagDefinitions';

const HEADER_PATTERNS = new Set(['game', 'name', 'game name', 'title', 'board game', 'boardgame']);

interface PendingAdd {
  gameName: string;
  objectid?: string;
  originalInput?: string; // user's typed name, stored when showing BGG suggestions
}
const pendingAdds = new Map<string, PendingAdd>();
const pendingEdits = new Map<string, string>(); // userId -> canonical gameName

const VALID_TAGS: string[] = GENRE_TAG_DEFINITIONS.map((t) => t.name);

interface PendingFix {
  info: GameInfo;
  unmatchedTagInputs: string[];
}
const pendingEditFixes = new Map<string, PendingFix>();

interface PendingRequestConfirm {
  canonicalName: string;
  eventId: string;
  eventDate: string;
  ownerIds: string[];
  attendingOwnerIds: string[];
}
const pendingRequestConfirms = new Map<string, PendingRequestConfirm>();

function fuzzyMatchComplexity(input: string): Complexity | null {
  const s = input.toLowerCase().trim();
  if (!s) return null;
  const light = ['light', 'lite', 'easy', 'simple', 'beginner'];
  const med = ['medium', 'moderate', 'normal', 'mid', 'intermediate'];
  const heavy = ['heavy', 'hard', 'complex', 'difficult', 'expert', 'advanced'];
  if (s === 'l' || light.some((k) => s.startsWith(k) || k.startsWith(s))) return 'Light';
  if (s === 'm' || med.some((k) => s.startsWith(k) || k.startsWith(s))) return 'Medium';
  if (s === 'h' || heavy.some((k) => s.startsWith(k) || k.startsWith(s))) return 'Heavy';
  return null;
}

function fuzzyMatchTag(input: string): string | null {
  const s = input.toLowerCase().trim();
  if (!s) return null;
  const exact = VALID_TAGS.find((t) => t.toLowerCase() === s);
  if (exact) return exact;
  const stripped = s.replace(/[^a-z]/g, '');
  const strippedMatch = VALID_TAGS.find((t) => t.toLowerCase().replace(/[^a-z]/g, '') === stripped);
  if (strippedMatch) return strippedMatch;
  const partial = VALID_TAGS.find((t) => {
    const tl = t.toLowerCase();
    return tl.startsWith(s) || (s.length >= 3 && tl.split(/[\s/&]+/).some((w) => w.startsWith(s)));
  });
  return partial ?? null;
}

function buildTagSelectRow(gameName: string): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('library_edit_tags_select')
      .setPlaceholder(`Select tags for "${gameName.slice(0, 40)}"...`)
      .setMinValues(0)
      .setMaxValues(VALID_TAGS.length)
      .addOptions(
        VALID_TAGS.map((tag) => new StringSelectMenuOptionBuilder().setLabel(tag).setValue(tag)),
      ),
  );
}

function buildTagSkipRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('library_edit_tags_skip')
      .setLabel('Skip — keep matched tags only')
      .setStyle(ButtonStyle.Secondary),
  );
}

export const data = new SlashCommandBuilder()
  .setName('library')
  .setDescription('Manage the group game library')
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Browse all games available in the group library'),
  )
  .addSubcommand((sub) =>
    sub.setName('mine').setDescription('See the games you have added to the library'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a game you own to the group library')
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Name of the game').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a game from your library')
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Name of the game').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('request')
      .setDescription('Request a game be brought to the next event')
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Name of the game to request').setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('import')
      .setDescription('Import your game collection')
      .addSubcommand((sub) =>
        sub.setName('bgg').setDescription('Import your owned collection from BoardGameGeek'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('csv')
          .setDescription('Import games from a CSV file')
          .addAttachmentOption((opt) =>
            opt
              .setName('file')
              .setDescription('CSV file — one game per line, or game name in the first column')
              .setRequired(true),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Get info on a specific game in the library')
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Name of the game').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Set details for a game you own (players, play time, type, expansions)')
      .addStringOption((opt) =>
        opt.setName('game').setDescription('Name of the game').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('clear').setDescription('Remove all of your own games from the library'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription("Share your library with another member — they can view it, request from it, and bring your games")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The member to give access to your library').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unlink')
      .setDescription('Remove a library link with another member (works either direction)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The member to unlink').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('bring')
      .setDescription("See which of your games are requested — or confirm you're bringing one")
      .addStringOption((opt) =>
        opt
          .setName('game')
          .setDescription('Confirm you will bring this game to the event')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('unrequest').setDescription('Remove games from the request list for an event'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('random')
      .setDescription('Pick 3 random games from the library, optionally filtered by tag')
      .addStringOption((opt) =>
        opt
          .setName('tag')
          .setDescription('Game type or mechanic')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('tag2')
          .setDescription('Additional tag (OR logic)')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('tag3')
          .setDescription('Additional tag (OR logic)')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('complexity')
          .setDescription('Game complexity (from BGG weight)')
          .setRequired(false)
          .addChoices(
            { name: 'Light', value: 'Light' },
            { name: 'Medium', value: 'Medium' },
            { name: 'Heavy', value: 'Heavy' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription(
        'Find games by player count, tag, or play time (all filters optional but at least one required)',
      )
      .addStringOption((opt) =>
        opt
          .setName('players')
          .setDescription('Number of players — separate multiple with , or / (e.g. 2,4)')
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('tag')
          .setDescription('Game type or mechanic')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('tag2')
          .setDescription('Additional tag (OR logic — game needs any one of the tags)')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('tag3')
          .setDescription('Additional tag (OR logic — game needs any one of the tags)')
          .setRequired(false)
          .addChoices(...GAME_TAGS.map((t) => ({ name: t, value: t }))),
      )
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription(
            'Target play time in minutes (±15 min) — separate multiple with , or / (e.g. 60,90)',
          )
          .setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min_duration')
          .setDescription('Minimum play time in minutes')
          .setRequired(false)
          .setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('max_duration')
          .setDescription('Maximum play time in minutes')
          .setRequired(false)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('complexity')
          .setDescription('Game complexity (from BGG weight)')
          .setRequired(false)
          .addChoices(
            { name: 'Light', value: 'Light' },
            { name: 'Medium', value: 'Medium' },
            { name: 'Heavy', value: 'Heavy' },
          ),
      ),
  );

async function buildBringLines(
  guildId: string,
  requests: GameRequest[],
  userId: string,
): Promise<string[]> {
  const effectiveOwnerIds = await getEffectiveOwnerIds(guildId, userId);
  const filtered: GameRequest[] = [];
  for (const req of requests) {
    if (!(await findGamesByName(guildId, req.gameName)).some((e) => effectiveOwnerIds.includes(e.userId))) continue;
    if (req.preferredOwnerId && !effectiveOwnerIds.includes(req.preferredOwnerId)) continue;
    filtered.push(req);
  }

  const lines: string[] = [];
  for (const req of filtered) {
    const copies = req.copiesNeeded ?? 1;
    const confirmed = req.confirmations.some((c) => c.ownerId === userId) ? ' ✅ confirmed' : '';
    const copiesNote = copies > 1 ? ` *(${req.confirmations.length}/${copies} copies confirmed)*` : '';
    const expansionNote =
      req.preferredOwnerId && effectiveOwnerIds.includes(req.preferredOwnerId)
        ? await buildExpansionNote(guildId, userId, req.gameName)
        : '';
    lines.push(`• **${req.gameName}**${expansionNote}${copiesNote}${confirmed}`);
  }
  return lines;
}

// Shared by /library bring's view mode (no game param) and the hub's
// "📋 My Games to Bring" button (handleHubBringButton below) — both already
// know exactly which event's channel they're in, so neither needs the
// no-channel-context "loop over every upcoming event" fallback that plain
// `/library bring` (run outside any event channel) falls back to.
async function showBringViewForChannelEvent(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  channelEvent: GameNight,
): Promise<void> {
  const lines = await buildBringLines(
    interaction.guildId!,
    await getRequestsForEvent(channelEvent.id),
    interaction.user.id,
  );
  if (lines.length === 0) {
    await interaction.reply({
      content: `None of your games have been requested for this event (${channelEvent.date}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(`Your Games to Bring — ${channelEvent.date}`)
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Confirm with /library bring game:<name>' });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleBring(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game')?.trim();
  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  const channelEvent = upcoming.find((gn) => gn.eventChannelId === interaction.channelId);

  // ── Confirm mode: /library bring game:<name> ─────────────────────────────
  if (gameName) {
    if (upcoming.length === 0) {
      await interaction.reply({ content: 'There are no upcoming events.', flags: MessageFlags.Ephemeral });
      return;
    }

    const event = channelEvent ?? upcoming[0];

    // Support partial/punctuation-tolerant lookup
    const requests = await getRequestsForEvent(event.id);
    const match =
      requests.find((r) => r.gameName.toLowerCase() === gameName.toLowerCase()) ??
      requests.find((r) => {
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalize(r.gameName).includes(normalize(gameName));
      });

    if (!match) {
      await interaction.reply({
        content: `**${gameName}** hasn't been requested for the event on ${event.date}. Check the request pin or use \`/library request\` first.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await confirmBring(
      interaction.guildId!,
      event.id,
      match.gameName,
      interaction.user.id,
    );

    if (result.status === 'not_owner') {
      await interaction.reply({
        content: `You can only confirm bring for games you own. **${match.gameName}** isn't in your library.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.status === 'not_requested') {
      await interaction.reply({
        content: `**${match.gameName}** is no longer requested for the event on ${event.date}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // result.status === 'confirmed'
    const expansionNote = await buildExpansionNote(
      interaction.guildId!,
      interaction.user.id,
      match.gameName,
    );
    await interaction.reply({
      content: `✅ Got it — you're confirmed to bring **${match.gameName}**${expansionNote} to the event on ${event.date}!`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      await updateRequestPin(interaction.client, event.id);
    } catch {
      /* channel may not be accessible */
    }

    if (result.invalidatedAsk) {
      await invalidateBringDm(interaction.client, result.invalidatedAsk, 'Confirmed via /library bring — thanks!');
    }

    const updatedReq = await getRequestById(match.id);
    if (updatedReq) {
      await reconcileRequestCopies(interaction.client, interaction.guildId!, event.rsvps, updatedReq, event.date);
    }
    return;
  }

  // ── View mode: /library bring (no game param) ────────────────────────────
  if (channelEvent) {
    await showBringViewForChannelEvent(interaction, channelEvent);
    return;
  }

  if (upcoming.length === 0) {
    await interaction.reply({ content: 'There are no upcoming events.', flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = new EmbedBuilder().setTitle('Your Games to Bring').setColor(0x5865f2);
  let hasAny = false;

  for (const gn of upcoming) {
    const lines = await buildBringLines(
      interaction.guildId!,
      await getRequestsForEvent(gn.id),
      interaction.user.id,
    );
    if (lines.length === 0) continue;
    embed.addFields({ name: gn.date, value: lines.join('\n') });
    hasAny = true;
  }

  if (!hasAny) {
    await interaction.reply({
      content: 'None of your games have been requested for any upcoming events.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  embed.setFooter({ text: 'Confirm with /library bring game:<name>' });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** Handles the "✅ Confirm bringing" button on a "please bring this" DM. */
export async function handleLibraryConfirmBring(
  interaction: ButtonInteraction,
  requestId: string,
): Promise<void> {
  const req = await getRequestById(requestId);
  if (!req) {
    await interaction.update({
      content: `${interaction.message.content}\n\n_This request no longer exists — it may have been dropped since nobody signed up to play it._`,
      components: [],
    });
    return;
  }

  const gameNight = await findGameNight(req.eventId);
  if (!gameNight) {
    await interaction.reply({ content: 'Could not find the event this request belongs to.' });
    return;
  }

  const result = await confirmBring(gameNight.guildId, req.eventId, req.gameName, interaction.user.id);

  if (result.status === 'not_owner') {
    await interaction.reply({
      content: `You can only confirm bringing games you own. **${req.gameName}** isn't in your library.`,
    });
    return;
  }

  if (result.status === 'not_requested') {
    await interaction.update({
      content: `${interaction.message.content}\n\n_This request no longer exists._`,
      components: [],
    });
    return;
  }

  // result.status === 'confirmed'
  const expansionNote = await buildExpansionNote(gameNight.guildId, interaction.user.id, req.gameName);
  await interaction.update({
    content: `✅ Confirmed — you're bringing **${req.gameName}**${expansionNote} to the event on ${gameNight.date}!`,
    components: [],
  });

  try {
    await updateRequestPin(interaction.client, req.eventId);
  } catch {
    /* channel may not be accessible */
  }

  const updatedReq = await getRequestById(requestId);
  if (updatedReq) {
    await reconcileRequestCopies(interaction.client, gameNight.guildId, gameNight.rsvps, updatedReq, gameNight.date);
  }
}

/** Handles the "❌ Can't bring it" button on a "please bring this" DM. */
export async function handleLibraryDeclineBring(
  interaction: ButtonInteraction,
  requestId: string,
): Promise<void> {
  const req = await getRequestById(requestId);
  if (!req) {
    await interaction.update({
      content: `${interaction.message.content}\n\n_This request no longer exists — it may have been dropped since nobody signed up to play it._`,
      components: [],
    });
    return;
  }

  const gameNight = await findGameNight(req.eventId);
  if (!gameNight) {
    await interaction.reply({ content: 'Could not find the event this request belongs to.' });
    return;
  }

  const result = await declineBring(requestId, interaction.user.id);

  if (result === 'not_requested') {
    await interaction.update({
      content: `${interaction.message.content}\n\n_This request no longer exists._`,
      components: [],
    });
    return;
  }

  if (result === 'not_asked') {
    await interaction.reply({ content: "You weren't asked to bring this one." });
    return;
  }

  // result === 'declined'
  await interaction.update({
    content: `${interaction.message.content}\n\n_No problem — thanks for letting us know._`,
    components: [],
  });

  const updatedReq = await getRequestById(requestId);
  if (updatedReq) {
    await reconcileRequestCopies(interaction.client, gameNight.guildId, gameNight.rsvps, updatedReq, gameNight.date);
  }
}

async function buildUnrequestUI(
  requests: GameRequest[],
  eventId: string,
  isMod: boolean,
  guild: import('discord.js').Guild | null,
): Promise<{
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}> {
  const nameMap: Record<string, string> = {};
  if (isMod && guild) {
    const uniqueIds = [...new Set(requests.map((r) => r.requestedBy))];
    await Promise.all(
      uniqueIds.map(async (uid) => {
        try {
          nameMap[uid] = (await guild.members.fetch(uid)).displayName;
        } catch {
          nameMap[uid] = uid;
        }
      }),
    );
  }

  const options = requests.slice(0, 25).map((r) => {
    const label = isMod
      ? `${r.gameName} — ${nameMap[r.requestedBy] ?? r.requestedBy}`.slice(0, 100)
      : r.gameName.slice(0, 100);
    return new StringSelectMenuOptionBuilder().setLabel(label).setValue(r.id);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`library_unrequest_select_${eventId}`)
    .setPlaceholder('Pick games to remove...')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  const removeAllBtn = new ButtonBuilder()
    .setCustomId(`library_unrequest_all_${eventId}`)
    .setLabel(isMod ? 'Remove All' : 'Remove All Mine')
    .setStyle(ButtonStyle.Danger);

  const content = isMod
    ? `**${requests.length}** game${requests.length !== 1 ? 's' : ''} requested for this event — pick which to remove:`
    : `You've requested **${requests.length}** game${requests.length !== 1 ? 's' : ''} — pick which to remove:`;

  return {
    content,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(removeAllBtn),
    ],
  };
}

export async function handleUnrequest(
  interaction: ChatInputCommandInteraction,
  forHost = false,
): Promise<void> {
  const isMod =
    forHost || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false);
  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  const channelEvent = upcoming.find((gn) => gn.eventChannelId === interaction.channelId);

  if (!channelEvent) {
    if (upcoming.length === 0) {
      await interaction.reply({ content: 'There are no upcoming events.', flags: MessageFlags.Ephemeral });
      return;
    }
    const options = upcoming.map((gn) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(gn.date.slice(0, 100))
        .setValue(gn.id)
        .setDescription(`${gn.time} @ ${gn.location || 'TBD'}`.slice(0, 100)),
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('library_unrequest_event_select')
      .setPlaceholder('Choose an event...')
      .addOptions(options);
    await interaction.reply({
      content: 'Which event do you want to manage requests for?',
      flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  const allRequests = await getRequestsForEvent(channelEvent.id);
  const visible = isMod
    ? allRequests
    : allRequests.filter((r) => r.requestedBy === interaction.user.id);

  if (visible.length === 0) {
    await interaction.reply({
      content: isMod
        ? 'No games have been requested for this event.'
        : "You haven't requested any games for this event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ui = await buildUnrequestUI(visible, channelEvent.id, isMod, interaction.guild);
  await interaction.reply({ ...ui, flags: MessageFlags.Ephemeral });
}

export async function handleUnrequestEventSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const eventId = interaction.values[0];
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const allRequests = await getRequestsForEvent(eventId);
  const visible = isMod
    ? allRequests
    : allRequests.filter((r) => r.requestedBy === interaction.user.id);

  if (visible.length === 0) {
    await interaction.update({
      content: isMod
        ? 'No games have been requested for this event.'
        : "You haven't requested any games for this event.",
      components: [],
    });
    return;
  }

  const ui = await buildUnrequestUI(visible, eventId, isMod, interaction.guild);
  await interaction.update(ui);
}

export async function handleUnrequestSelect(
  interaction: StringSelectMenuInteraction,
  eventId: string,
): Promise<void> {
  const removed = await removeRequests(interaction.values);
  try {
    await updateRequestPin(interaction.client, eventId);
  } catch {
    /* ok */
  }
  await interaction.update({
    content: `Removed **${removed}** game request${removed !== 1 ? 's' : ''} from the list.`,
    components: [],
  });
}

export async function handleUnrequestAll(
  interaction: ButtonInteraction,
  eventId: string,
): Promise<void> {
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const removed = await removeAllRequestsForEvent(eventId, isMod ? undefined : interaction.user.id);
  try {
    await updateRequestPin(interaction.client, eventId);
  } catch {
    /* ok */
  }

  let msg: string;
  if (removed === 0) {
    msg = isMod ? 'There were no requests to clear.' : 'You had no requests to remove.';
  } else if (isMod) {
    msg = `Cleared all **${removed}** request${removed !== 1 ? 's' : ''} for this event.`;
  } else {
    msg = `Removed all **${removed}** of your request${removed !== 1 ? 's' : ''} for this event.`;
  }

  await interaction.update({ content: msg, components: [] });
}

async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const count = await clearUserLibrary(interaction.guildId!, interaction.user.id);
  await interaction.reply({
    content:
      count > 0
        ? `Removed **${count}** game${count !== 1 ? 's' : ''} from your library.`
        : 'You have no games in the library to remove.',
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleAdminLibraryClear(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const count = await clearUserLibrary(interaction.guildId!, targetUser.id);
  await interaction.reply({
    content:
      count > 0
        ? `Removed **${count}** game${count !== 1 ? 's' : ''} from <@${targetUser.id}>'s library.`
        : `<@${targetUser.id}> has no games in the library to remove.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Library account linking ──────────────────────────────────────────────────
//
// One-directional grant: linking gives the other member delegate access to
// YOUR library (viewing, request/bring eligibility) — it never touches their
// data, so no accept/confirm step is needed. For two people to fully share
// with each other (e.g. a couple), each runs /library link once naming the
// other. Write operations (add/remove/edit/clear) always stay scoped to
// whoever literally owns the row, link or no link.

async function handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  if (target.id === userId) {
    await interaction.reply({ content: "You can't link your own account to itself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot) {
    await interaction.reply({ content: "You can't link a bot account.", flags: MessageFlags.Ephemeral });
    return;
  }

  const existingLinks = await getLibraryLinksForGuild(guildId);
  const alreadyLinked = existingLinks.some((l) => l.ownerId === userId && l.delegateId === target.id);
  if (alreadyLinked) {
    await interaction.reply({
      content: `<@${target.id}> can already view and manage bringing for your library.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await addLibraryLink(guildId, userId, target.id);
  await interaction.reply({
    content:
      `<@${target.id}> can now see your games in their \`/library mine\`, and can request/confirm bringing them. ` +
      `This only shares *your* library with them — if you'd like the same access to theirs, they'll need to run \`/library link user:@you\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUnlink(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const removed = await removeLibraryLink(guildId, userId, target.id);
  await interaction.reply({
    content: removed
      ? `Library link with <@${target.id}> removed.`
      : `You don't have a library link with <@${target.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === 'import') {
    if (sub === 'bgg') await handleImportBgg(interaction);
    else if (sub === 'csv') await handleImportCsv(interaction);
    return;
  }

  if (sub === 'list') await handleList(interaction);
  else if (sub === 'mine') await handleMine(interaction);
  else if (sub === 'add') await handleAdd(interaction);
  else if (sub === 'remove') await handleRemove(interaction);
  else if (sub === 'request') await handleRequest(interaction);
  else if (sub === 'view') await handleView(interaction);
  else if (sub === 'edit') await handleEdit(interaction);
  else if (sub === 'clear') await handleClear(interaction);
  else if (sub === 'bring') await handleBring(interaction);
  else if (sub === 'unrequest') await handleUnrequest(interaction);
  else if (sub === 'search') await handleSearch(interaction);
  else if (sub === 'random') await handleRandom(interaction);
  else if (sub === 'link') await handleLink(interaction);
  else if (sub === 'unlink') await handleUnlink(interaction);
}

interface ListSession {
  pages: string[];
  totalGames: number;
  ownerCount: number;
  pageIndex: number;
}
const listSessions = new Map<string, ListSession>();

const COMPLEXITY_ICON: Record<string, string> = { Light: '🟢', Medium: '🟡', Heavy: '🔴' };

function buildListEmbed(
  pages: string[],
  pageIdx: number,
  totalGames: number,
  ownerCount: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Group Game Library')
    .setDescription(
      `${totalGames} game${totalGames !== 1 ? 's' : ''} across ${ownerCount} member${ownerCount !== 1 ? 's' : ''}\n🟢 Light  🟡 Medium  🔴 Heavy`,
    )
    .addFields({ name: '​', value: pages[pageIdx] })
    .setFooter({
      text:
        pages.length > 1
          ? `Page ${pageIdx + 1} of ${pages.length} • /library request <game> to request a game`
          : '/library request <game> to request a game',
    });
}

function buildListButtons(pageIdx: number, totalPages: number): ActionRowBuilder<ButtonBuilder>[] {
  if (totalPages <= 1) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('library_list_prev')
        .setLabel('← Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIdx === 0),
      new ButtonBuilder()
        .setCustomId('library_list_page')
        .setLabel(`Page ${pageIdx + 1} of ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('library_list_next')
        .setLabel('Next →')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIdx === totalPages - 1),
    ),
  ];
}

// Each page holds up to this many characters — safely under Discord's 1024-char field limit.
const LIST_PAGE_CHARS = 1000;

export async function handleList(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const entries = (await loadLibraryForGuild(interaction.guildId!)).filter((e) => !e.isExpansion);

  if (entries.length === 0) {
    await interaction.reply({
      content: 'The group library is empty. Add your games with `/library add <game>`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const infos = await loadGameInfos();

  // Group entries by normalized game name, preserving original casing from first entry
  const gameMap = new Map<string, { displayName: string; owners: string[] }>();
  for (const entry of entries) {
    const key = entry.gameName.toLowerCase();
    if (!gameMap.has(key)) gameMap.set(key, { displayName: entry.gameName, owners: [] });
    gameMap.get(key)!.owners.push(`<@${entry.userId}>`);
  }

  const sorted = [...gameMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const ownerCount = new Set(entries.map((e) => e.userId)).size;

  // Build pages by character budget so each page is always a single embed field.
  const pages: string[] = [];
  let current = '';
  for (const g of sorted) {
    const info = infos.find((inf) => inf.gameName.toLowerCase() === g.displayName.toLowerCase());
    const icon = info?.complexity ? `${COMPLEXITY_ICON[info.complexity]} ` : '';
    const line = `${icon}**${g.displayName}** — ${g.owners.join(', ')}`;
    if (current && current.length + line.length + 1 > LIST_PAGE_CHARS) {
      pages.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) pages.push(current);

  listSessions.set(interaction.user.id, {
    pages,
    totalGames: sorted.length,
    ownerCount,
    pageIndex: 0,
  });

  await interaction.reply({
    embeds: [buildListEmbed(pages, 0, sorted.length, ownerCount)],
    components: buildListButtons(0, pages.length),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleLibraryListNav(
  interaction: ButtonInteraction,
  direction: 'prev' | 'next',
): Promise<void> {
  const session = listSessions.get(interaction.user.id);
  if (!session) {
    await interaction.update({
      content: 'This list has expired — run `/library list` again.',
      embeds: [],
      components: [],
    });
    return;
  }

  const newPage = direction === 'next' ? session.pageIndex + 1 : session.pageIndex - 1;
  if (newPage < 0 || newPage >= session.pages.length) {
    await interaction.deferUpdate();
    return;
  }

  session.pageIndex = newPage;
  await interaction.update({
    embeds: [buildListEmbed(session.pages, newPage, session.totalGames, session.ownerCount)],
    components: buildListButtons(newPage, session.pages.length),
  });
}

export async function handleSync(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Only admins can sync game data.', flags: MessageFlags.Ephemeral });
    return;
  }

  const input = interaction.options.getString('game', true).trim();
  const guildId = interaction.guildId!;

  const exact = await findGamesByName(guildId, input);
  const canonical = exact.length > 0 ? exact[0].gameName : null;

  if (!canonical) {
    const partials = await findGameNamesByPartial(guildId, input);
    const hint =
      partials.length > 0
        ? `\nDid you mean: ${partials
            .slice(0, 5)
            .map((n) => `**${n}**`)
            .join(', ')}?`
        : '';
    await interaction.reply({
      content: `No game called **"${input}"** found in the library.${hint}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const info = await getGameInfo(canonical);
  if (!info?.objectid) {
    await interaction.reply({
      content: `**${canonical}** has no BGG ID — nothing to sync.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await enrichFromBGG(canonical, true);
  } catch {
    await interaction.editReply(
      'Could not reach BoardGameGeek right now. Please try again in a moment.',
    );
    return;
  }

  const embed = await buildGameViewEmbed(
    guildId,
    canonical,
    interaction.user.id,
    await resolveComplexityMention(canonical, guildId),
  );
  if (embed) {
    await interaction.editReply({
      content: `✅ **${canonical}** synced from BoardGameGeek.`,
      embeds: [embed],
    });
  } else {
    await interaction.editReply(`✅ **${canonical}** synced from BoardGameGeek.`);
  }
}

async function applyBGGDataToGameInfo(info: GameInfo, bggGame: BGGGame, force: boolean): Promise<void> {
  await upsertGameInfo({
    ...info,
    minPlayers: info.minPlayers ?? bggGame.minPlayers,
    maxPlayers: info.maxPlayers ?? bggGame.maxPlayers,
    playTime: info.playTime ?? bggGame.maxPlaytime,
    complexity: info.complexity ?? (bggGame.weight ? weightTag(bggGame.weight) : null),
    tags: bggGame.tags.length > 0 ? bggGame.tags : (info.tags ?? []),
    bestPlayers: force
      ? bggGame.suggestedPlayers || undefined
      : (info.bestPlayers ?? (bggGame.suggestedPlayers || undefined)),
    weight: force ? (bggGame.weight ?? undefined) : (info.weight ?? bggGame.weight ?? undefined),
    bggExpansions: force
      ? bggGame.expansions.map((e) => e.name)
      : (info.bggExpansions ?? bggGame.expansions.map((e) => e.name)),
    howToPlayUrl: force
      ? bggGame.howToPlayUrl
      : info.howToPlayUrl !== undefined
        ? info.howToPlayUrl
        : bggGame.howToPlayUrl,
    thumbnail: force
      ? bggGame.thumbnail
      : info.thumbnail !== undefined
        ? info.thumbnail
        : bggGame.thumbnail,
    updatedAt: new Date().toISOString(),
  });
}

function isFullyEnriched(info: GameInfo): boolean {
  return (
    info.tags !== undefined &&
    info.bggExpansions !== undefined &&
    info.bestPlayers !== undefined &&
    info.complexity !== undefined &&
    info.howToPlayUrl !== undefined &&
    info.thumbnail !== undefined
  );
}

export async function handleSyncAll(interaction: ChatInputCommandInteraction): Promise<void> {
  const force = interaction.options.getBoolean('force') ?? true;
  const allInfos = (await loadGameInfos()).filter((i) => !!i.objectid && (force || !isFullyEnriched(i)));

  if (allInfos.length === 0) {
    await interaction.reply({
      content: force
        ? 'No library games with a BGG ID found — nothing to sync.'
        : 'No library games are missing BGG data — nothing to enrich.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const BATCH_SIZE = 20;
  const VIDEO_DELAY_MS = 500;
  const BATCH_DELAY_MS = 1000;
  const batches: GameInfo[][] = [];
  for (let i = 0; i < allInfos.length; i += BATCH_SIZE) batches.push(allInfos.slice(i, i + BATCH_SIZE));

  // 1 XMLAPI2 call per batch of 20 + 500ms per game for video API
  const estimatedSecs = Math.ceil(batches.length * (BATCH_DELAY_MS / 1000) + allInfos.length * (VIDEO_DELAY_MS / 1000));
  await interaction.reply({
    content: `${force ? 'Syncing' : 'Enriching'} **${allInfos.length}** game(s) in **${batches.length}** BGG batch(es) — estimated **${estimatedSecs}s**. Do not run again until this completes.`,
    flags: MessageFlags.Ephemeral,
  });

  const idToInfo = new Map(allInfos.map((i) => [i.objectid!, i]));
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    const ids = batches[i].map((info) => info.objectid!);
    try {
      const games = await getBGGGamesBatch(ids, VIDEO_DELAY_MS);
      for (const bggGame of games) {
        const info = idToInfo.get(bggGame.id);
        if (!info) continue;
        await applyBGGDataToGameInfo(info, bggGame, force);
        updated++;
      }
    } catch {
      failed += batches[i].length;
    }
  }

  await interaction.followUp({
    content: `${force ? 'Sync' : 'Enrich'} complete — **${updated}** updated, **${failed}** failed.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function enrichFromBGG(canonical: string, force = false): Promise<void> {
  const info = await getGameInfo(canonical);
  if (!info?.objectid) return;
  if (!force && isFullyEnriched(info)) return;
  try {
    const bggGame = await getBGGGame(info.objectid);
    await applyBGGDataToGameInfo(info, bggGame, force);
  } catch (err) {
    if (force) throw err;
    // BGG unavailable — show game without enrichment (lazy enrichment, non-fatal)
  }
}

async function resolveComplexityMention(
  gameName: string,
  guildId: string | null,
): Promise<string | undefined> {
  if (!guildId) return undefined;
  const info = await getGameInfo(gameName);
  if (!info?.complexity) return undefined;
  const role = (await getGameRoles(guildId)).find(
    (r) => r.type === 'difficulty' && r.name.toLowerCase() === info.complexity!.toLowerCase(),
  );
  return role ? `<@&${role.roleId}>` : info.complexity;
}

async function buildGameViewEmbed(
  guildId: string,
  gameName: string,
  userId: string,
  complexityMention?: string,
): Promise<EmbedBuilder | null> {
  const matches = await findGamesByName(guildId, gameName);
  if (matches.length === 0) return null;

  const canonical = matches[0].gameName;
  const objectid = matches[0].objectid;
  const owners = matches.map((e) => `<@${e.userId}>`);

  const now = new Date();
  const upcomingEvents = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());
  const nextEvent = upcomingEvents[0] ?? null;

  const requestedEvents: typeof upcomingEvents = [];
  for (const gn of upcomingEvents) {
    if ((await getRequestsForEvent(gn.id)).some((r) => r.gameName.toLowerCase() === canonical.toLowerCase())) {
      requestedEvents.push(gn);
    }
  }

  const info = await getGameInfo(canonical);

  const embed = new EmbedBuilder().setTitle(canonical).setColor(0x5865f2);
  if (info?.thumbnail) embed.setThumbnail(info.thumbnail);
  embed.addFields({ name: `Owner${owners.length > 1 ? 's' : ''}`, value: owners.join('\n') });

  if (info?.minPlayers != null && info?.maxPlayers != null) {
    embed.addFields({
      name: 'Players',
      value: `${info.minPlayers}–${info.maxPlayers}`,
      inline: true,
    });
  }
  if (info?.bestPlayers != null) {
    embed.addFields({ name: 'Best With', value: `${info.bestPlayers}`, inline: true });
  }
  if (info?.playTime != null) {
    embed.addFields({ name: 'Play Time', value: `${info.playTime} min`, inline: true });
  }
  if (info?.complexity) {
    embed.addFields({
      name: 'Complexity',
      value: complexityMention ?? info.complexity,
      inline: true,
    });
  }
  if (info?.tags?.length) {
    embed.addFields({ name: 'Tags', value: info.tags.join(' • ') });
  }
  if (info?.bggExpansions?.length) {
    const guildLibrary = await loadLibraryForGuild(guildId);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ownerMap = new Map<string, string[]>();
    for (const e of guildLibrary) {
      const key = norm(e.gameName);
      if (!ownerMap.has(key)) ownerMap.set(key, []);
      ownerMap.get(key)!.push(e.userId);
    }
    const ownedExpansions = info.bggExpansions
      .map((name) => ({ name, owners: ownerMap.get(norm(name)) }))
      .filter(({ owners }) => !!owners);
    const value =
      ownedExpansions.length > 0
        ? ownedExpansions
            .map(({ name, owners }) => {
              const mentions = [...new Set(owners!)].map((id) => `<@${id}>`).join(', ');
              return `${name} — ${mentions}`;
            })
            .join('\n')
        : '*None in library*';
    embed.addFields({
      name: 'Expansions in Library',
      value: value.length > 1024 ? value.slice(0, 1021) + '…' : value,
    });
  } else if (info?.expansions?.length) {
    embed.addFields({ name: 'Expansions', value: info.expansions.join('\n') });
  }
  const resourceParts: string[] = [];
  if (info?.howToPlayUrl) resourceParts.push(`[📹 How to Play](${info.howToPlayUrl})`);
  if (objectid)
    resourceParts.push(`[📖 Rules & Files](https://boardgamegeek.com/boardgame/${objectid}/files)`);
  if (resourceParts.length > 0) {
    embed.addFields({ name: 'Resources', value: resourceParts.join(' • ') });
  }

  if (objectid) {
    embed.addFields({ name: 'BGG ID', value: objectid, inline: true });
  }
  if (requestedEvents.length > 0) {
    embed.addFields({
      name: 'Requested for',
      value: requestedEvents.map((gn) => gn.date).join('\n'),
      inline: true,
    });
  } else if (nextEvent) {
    embed.addFields({
      name: `Next event: ${nextEvent.date}`,
      value: 'Not requested — use `/library request` to request it',
      inline: true,
    });
  }

  const isOwner = owners.some((o) => o === `<@${userId}>`);
  if (isOwner) embed.setFooter({ text: 'Use /library edit to update game details' });
  return embed;
}

function buildPartialMatchSelect(
  partials: string[],
  customId: string,
  placeholder: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = partials.map((name) =>
    new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name),
  );
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('None of these')
      .setValue('__none__')
      .setDescription('Dismiss and search again with a different term'),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

async function handleView(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await enrichFromBGG(gameName, false);

  const embed = await buildGameViewEmbed(
    interaction.guildId!,
    gameName,
    interaction.user.id,
    await resolveComplexityMention(gameName, interaction.guildId),
  );
  if (embed) {
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const partials = await findGameNamesByPartial(interaction.guildId!, gameName);
  if (partials.length > 0 && partials.length <= 25) {
    await interaction.editReply({
      content: `**"${gameName}"** wasn't an exact match — did you mean one of these?`,
      components: [
        buildPartialMatchSelect(partials, 'library_view_select', 'Pick a game to view...'),
      ],
    });
    return;
  }

  await interaction.editReply({
    content:
      partials.length > 25
        ? `Too many matches for **"${gameName}"** — try a more specific name.`
        : `**${gameName}** wasn't found in the library. Check the full list with \`/library list\`.`,
  });
}

export async function handleLibraryViewSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const gameName = interaction.values[0];

  if (gameName === '__none__') {
    await interaction.update({
      content: 'No problem — try `/library view` again with a different term.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();
  await enrichFromBGG(gameName, false);
  const embed = await buildGameViewEmbed(
    interaction.guildId!,
    gameName,
    interaction.user.id,
    await resolveComplexityMention(gameName, interaction.guildId),
  );
  if (!embed) {
    await interaction.editReply({
      content: 'That game is no longer in the library.',
      components: [],
    });
    return;
  }
  await interaction.editReply({ content: '', embeds: [embed], components: [] });
}

export async function handleMine(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const entries = (await getGamesByUserAndLinked(guildId, userId)).filter((e) => !e.isExpansion);

  if (entries.length === 0) {
    await interaction.reply({
      content: "You haven't added any games yet. Use `/library add <game>` to add one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sorted = [...entries].sort((a, b) => a.gameName.localeCompare(b.gameName));

  const embed = new EmbedBuilder()
    .setTitle('Your Games')
    .setColor(0x5865f2)
    .setDescription(
      sorted
        .map((e) => `• ${e.gameName}${e.userId !== userId ? ` *(shared from <@${e.userId}>)*` : ''}`)
        .join('\n'),
    )
    .setFooter({ text: `${sorted.length} game${sorted.length !== 1 ? 's' : ''}` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function buildEditModal(
  gameName: string,
  existing?: GameInfo | null,
  titlePrefix = 'Edit',
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId('library_edit_modal')
    .setTitle(`${titlePrefix}: ${gameName}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('players')
        .setLabel('Players (e.g. 2-5)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(
          existing?.minPlayers != null && existing?.maxPlayers != null
            ? `${existing.minPlayers}-${existing.maxPlayers}`
            : existing?.minPlayers != null
              ? String(existing.minPlayers)
              : '',
        ),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('playtime')
        .setLabel('Play time (minutes, e.g. 90)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(existing?.playTime != null ? String(existing.playTime) : ''),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('tags')
        .setLabel('Tags (e.g. Co-op, Deck Building, Party)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Co-op, Deck Building, Worker Placement, Party...')
        .setRequired(false)
        .setValue(existing?.tags?.join(', ') ?? ''),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('expansions')
        .setLabel('Expansions You Own (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(existing?.expansions?.join(', ') ?? '')
        .setPlaceholder(
          existing?.bggExpansions?.length
            ? `BGG has: ${existing.bggExpansions.slice(0, 3).join(', ')}${existing.bggExpansions.length > 3 ? '…' : ''}`
            : 'Seafarers, Cities & Knights…',
        ),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('complexity')
        .setLabel('Complexity (Light, Medium, or Heavy)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(existing?.complexity ?? '')
        .setPlaceholder('Light, Medium, or Heavy'),
    ),
  );

  return modal;
}

// Shared helper: builds and sends the BGG catalog match UI for partial/multiple matches.
// Works for both the initial slash command reply and a select-menu update.
async function showCatalogUI(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  gameName: string,
  catalogResults: BGGCatalogEntry[],
  userId: string,
): Promise<void> {
  const top = catalogResults[0];
  const isChatCmd = interaction.isChatInputCommand();
  const send = async (
    content: string,
    components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[],
  ) => {
    if (isChatCmd)
      await (interaction as ChatInputCommandInteraction).reply({
        content,
        components,
        flags: MessageFlags.Ephemeral,
      });
    else await (interaction as StringSelectMenuInteraction).update({ content, components });
  };

  if (catalogResults.length === 1) {
    const yearNote = top.year ? ` (${top.year})` : '';
    const expNote = top.isExpansion ? ' — expansion' : '';
    pendingAdds.set(userId, { gameName: top.name, objectid: top.id, originalInput: gameName });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('library_add_bgg_confirm')
        .setLabel(`Yes, use "${top.name.slice(0, 55)}"`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('library_add_bgg_dismiss')
        .setLabel('No, add as typed')
        .setStyle(ButtonStyle.Secondary),
    );
    await send(`Found **${top.name}**${yearNote}${expNote} on BGG — is that the game you mean?`, [
      row,
    ]);
    return;
  }

  pendingAdds.set(userId, { gameName, originalInput: gameName });
  const options = catalogResults.map((r) => {
    const desc = [r.year ? `Published ${r.year}` : 'Year unknown', r.isExpansion ? 'Expansion' : '']
      .filter(Boolean)
      .join(' • ');
    return new StringSelectMenuOptionBuilder()
      .setLabel(r.name.slice(0, 100))
      .setValue(`${r.id}|${r.name.slice(0, 90)}`)
      .setDescription(desc.slice(0, 100));
  });
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('None of these — add as typed')
      .setValue('__none__')
      .setDescription(`Add as "${gameName.slice(0, 80)}"`),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId('library_add_bgg_select')
    .setPlaceholder('Choose the correct game...')
    .addOptions(options);
  await send(
    `Found **${catalogResults.length}** possible matches for **"${gameName}"** on BGG — which did you mean?`,
    [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  );
}

async function addGameWithBGGDetails(
  guildId: string,
  userId: string,
  gameName: string,
  objectid: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  await addGame(guildId, userId, gameName, objectid);
  let msg = `Added **${gameName}** to your library!`;
  try {
    const bggGame = await getBGGGame(objectid);
    const info: GameInfo = {
      gameName,
      objectid,
      minPlayers: bggGame.minPlayers,
      maxPlayers: bggGame.maxPlayers,
      bestPlayers: bggGame.suggestedPlayers,
      playTime: bggGame.maxPlaytime,
      weight: bggGame.weight ?? undefined,
      complexity: bggGame.weight ? weightTag(bggGame.weight) : undefined,
      tags: bggGame.tags.length > 0 ? bggGame.tags : undefined,
      bggExpansions: bggGame.expansions.map((e) => e.name),
      updatedAt: new Date().toISOString(),
    };
    await upsertGameInfo(info);
    msg = `Added **${gameName}** to your library with details from BGG!`;
  } catch {
    // BGG fetch failed — game still added, details can be filled in with /library edit
  }
  await interaction.editReply({ content: msg, components: [] });
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();
  if (!gameName) {
    await interaction.reply({ content: 'Please provide a game name.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const userGames = await getGamesByUserAndLinked(guildId, userId);
  const library = await loadLibraryForGuild(guildId);

  // 1a. Exact match in the user's own (or linked) library
  const ownMatch = userGames.find((e) => e.gameName.toLowerCase() === gameName.toLowerCase());
  if (ownMatch) {
    const sharedNote = ownMatch.userId !== userId ? ` (shared from <@${ownMatch.userId}>'s library)` : '';
    await interaction.reply({
      content: `**${gameName}** is already in your library${sharedNote}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 1b. Exact match in guild library owned by others
  const exactOthers = library.filter(
    (e) => e.gameName.toLowerCase() === gameName.toLowerCase() && e.userId !== userId,
  );
  if (exactOthers.length > 0) {
    const canonical = exactOthers[0].gameName;
    const owners = [...new Set(exactOthers.map((e) => `<@${e.userId}>`))].join(', ');
    pendingAdds.set(userId, { gameName: canonical, objectid: exactOthers[0].objectid });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('library_add_confirm')
        .setLabel('Yes, I own it too')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('library_add_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: `**${canonical}** is already in the group library (owned by ${owners}). Are you adding your own copy?`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 2. Partial/fuzzy match in guild library — confirm before going to BGG
  const partials = await findGameNamesByPartial(guildId, gameName);
  if (partials.length > 0 && partials.length <= 25) {
    pendingAdds.set(userId, { gameName, originalInput: gameName });
    const options = partials.map((name) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(name.slice(0, 100))
        .setValue(`lib|${name.slice(0, 90)}`),
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('None of these — search BGG')
        .setValue('__bgg__')
        .setDescription(`Search BGG for "${gameName.slice(0, 80)}"`),
    );
    await interaction.reply({
      content: `Found similar games in the group library — is this what you're adding?`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('library_add_partial_select')
            .setPlaceholder('Choose a game from the library...')
            .addOptions(options),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 3. BGG catalog search
  if (isCatalogLoaded()) {
    const catalogResults = searchCatalog(gameName, 5);
    if (catalogResults.length > 0) {
      const top = catalogResults[0];
      if (normalizeName(top.name) === normalizeName(gameName)) {
        // Exact canonical match — re-check library with resolved name (catches punctuation differences like "brass birmingham" → "Brass: Birmingham")
        const canonicalOwnMatch = userGames.find((e) => e.gameName.toLowerCase() === top.name.toLowerCase());
        if (canonicalOwnMatch) {
          const sharedNote = canonicalOwnMatch.userId !== userId ? ` (shared from <@${canonicalOwnMatch.userId}>'s library)` : '';
          await interaction.reply({
            content: `**${top.name}** is already in your library${sharedNote}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const canonicalOthers = library.filter(
          (e) => e.gameName.toLowerCase() === top.name.toLowerCase() && e.userId !== userId,
        );
        if (canonicalOthers.length > 0) {
          const canonical = canonicalOthers[0].gameName;
          const owners = [...new Set(canonicalOthers.map((e) => `<@${e.userId}>`))].join(', ');
          pendingAdds.set(userId, {
            gameName: canonical,
            objectid: canonicalOthers[0].objectid ?? top.id,
          });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('library_add_confirm')
              .setLabel('Yes, I own it too')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('library_add_cancel')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary),
          );
          await interaction.reply({
            content: `**${canonical}** is already in the group library (owned by ${owners}). Are you adding your own copy?`,
            components: [row],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await showCatalogUI(interaction, gameName, [top], userId);
        return;
      }
      await showCatalogUI(interaction, gameName, catalogResults, userId);
      return;
    }
  }

  // 4. No matches anywhere — add as custom game
  await addGame(guildId, userId, gameName);
  pendingEdits.set(userId, gameName);
  await interaction.showModal(buildEditModal(gameName, undefined, 'Add Details'));
}

export async function handleLibraryAddPartialSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const value = interaction.values[0];
  const pending = pendingAdds.get(interaction.user.id);
  const originalInput = pending?.originalInput ?? pending?.gameName ?? '';
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  pendingAdds.delete(userId);

  if (value === '__bgg__') {
    if (isCatalogLoaded()) {
      const catalogResults = searchCatalog(originalInput, 5);
      if (catalogResults.length > 0) {
        const top = catalogResults[0];
        if (normalizeName(top.name) === normalizeName(originalInput)) {
          await showCatalogUI(interaction, originalInput, [top], userId);
          return;
        }
        await showCatalogUI(interaction, originalInput, catalogResults, userId);
        return;
      }
    }
    // No BGG match — add as custom
    await addGame(guildId, userId, originalInput);
    pendingEdits.set(userId, originalInput);
    await interaction.showModal(buildEditModal(originalInput, undefined, 'Add Details'));
    return;
  }

  // User picked a game from the library partial list — add their copy
  const name = value.startsWith('lib|') ? value.slice(4) : value;
  const userGames = await getGamesByUserAndLinked(guildId, userId);
  const ownMatch = userGames.find((e) => e.gameName.toLowerCase() === name.toLowerCase());
  if (ownMatch) {
    const sharedNote = ownMatch.userId !== userId ? ` (shared from <@${ownMatch.userId}>'s library)` : '';
    await interaction.update({
      content: `**${name}** is already in your library${sharedNote}.`,
      components: [],
    });
    return;
  }
  const libGames = (await loadLibraryForGuild(guildId)).filter(
    (e) => e.gameName.toLowerCase() === name.toLowerCase() && e.userId !== userId,
  );
  await addGame(guildId, userId, name, libGames[0]?.objectid);
  pendingEdits.set(userId, name);
  await interaction.showModal(buildEditModal(name, await getGameInfo(name), 'Add Details'));
}

export async function handleAddConfirm(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingAdds.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This confirmation has expired. Please run `/library add` again.',
      components: [],
    });
    return;
  }
  pendingAdds.delete(interaction.user.id);
  await addGame(interaction.guildId!, interaction.user.id, pending.gameName, pending.objectid);
  await interaction.update({
    content: `Added **${pending.gameName}** to your library. Other members can now request it for events.`,
    components: [],
  });
}

export async function handleAddCancel(interaction: ButtonInteraction): Promise<void> {
  pendingAdds.delete(interaction.user.id);
  await interaction.update({
    content: 'Cancelled. No changes were made to your library.',
    components: [],
  });
}

export async function handleAddBggConfirm(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingAdds.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This confirmation has expired. Please run `/library add` again.',
      components: [],
    });
    return;
  }
  pendingAdds.delete(interaction.user.id);
  if (pending.objectid) {
    await addGameWithBGGDetails(
      interaction.guildId!,
      interaction.user.id,
      pending.gameName,
      pending.objectid,
      interaction,
    );
  } else {
    await addGame(interaction.guildId!, interaction.user.id, pending.gameName);
    pendingEdits.set(interaction.user.id, pending.gameName);
    await interaction.showModal(buildEditModal(pending.gameName, undefined, 'Add Details'));
  }
}

export async function handleAddBggDismiss(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingAdds.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This confirmation has expired. Please run `/library add` again.',
      components: [],
    });
    return;
  }
  pendingAdds.delete(interaction.user.id);
  const nameToAdd = pending.originalInput ?? pending.gameName;
  await addGame(interaction.guildId!, interaction.user.id, nameToAdd);
  pendingEdits.set(interaction.user.id, nameToAdd);
  await interaction.showModal(buildEditModal(nameToAdd, undefined, 'Add Details'));
}

export async function handleAddBggSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const value = interaction.values[0];
  const pending = pendingAdds.get(interaction.user.id);
  const originalInput = pending?.originalInput ?? pending?.gameName ?? '';
  pendingAdds.delete(interaction.user.id);

  if (value === '__none__') {
    if (originalInput) {
      await addGame(interaction.guildId!, interaction.user.id, originalInput);
      pendingEdits.set(interaction.user.id, originalInput);
      await interaction.showModal(buildEditModal(originalInput, undefined, 'Add Details'));
    } else {
      await interaction.update({
        content: 'Cancelled. No changes were made to your library.',
        components: [],
      });
    }
    return;
  }

  const [id, name] = value.split('|', 2);

  // Check if user already owns (or has linked access to) the selected game
  const userGames = await getGamesByUserAndLinked(interaction.guildId!, interaction.user.id);
  const ownMatch = userGames.find((e) => e.gameName.toLowerCase() === name.toLowerCase());
  if (ownMatch) {
    const sharedNote = ownMatch.userId !== interaction.user.id ? ` (shared from <@${ownMatch.userId}>'s library)` : '';
    await interaction.update({
      content: `**${name}** is already in your library${sharedNote}.`,
      components: [],
    });
    return;
  }

  // Check if others own the selected game
  const existing = (await findGamesByName(interaction.guildId!, name)).filter(
    (e) => e.userId !== interaction.user.id,
  );
  if (existing.length > 0) {
    const canonical = existing[0].gameName;
    const objectid = existing[0].objectid ?? id;
    const owners = [...new Set(existing.map((e) => `<@${e.userId}>`))].join(', ');
    pendingAdds.set(interaction.user.id, { gameName: canonical, objectid });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('library_add_confirm')
        .setLabel('Yes, I own it too')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('library_add_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: `**${canonical}** is already in the group library (owned by ${owners}). Are you adding your own copy?`,
      components: [row],
    });
    return;
  }

  await addGameWithBGGDetails(interaction.guildId!, interaction.user.id, name, id, interaction);
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const result = await removeGame(guildId, userId, gameName);

  if (result === 'not_found') {
    const userGameNames = new Set(
      (await getGamesByUser(guildId, userId)).map((e) => e.gameName.toLowerCase()),
    );
    const partials = (await findGameNamesByPartial(guildId, gameName)).filter((name) =>
      userGameNames.has(name.toLowerCase()),
    );

    if (partials.length > 0) {
      await interaction.reply({
        content: `**"${gameName}"** wasn't an exact match. Did you mean one of these?`,
        components: [
          buildPartialMatchSelect(partials, 'library_remove_select', 'Pick a game to remove...'),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `**${gameName}** wasn't found in your library. Check your games with \`/library mine\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Removed **${gameName}** from your library.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleRemoveSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const gameName = interaction.values[0];
  if (gameName === '__none__') {
    await interaction.update({
      content: 'No game removed. Try again with a different name.',
      components: [],
    });
    return;
  }
  const result = await removeGame(interaction.guildId!, interaction.user.id, gameName);
  if (result === 'not_found') {
    await interaction.update({
      content: `**${gameName}** wasn't found in your library.`,
      components: [],
    });
    return;
  }
  await interaction.update({
    content: `Removed **${gameName}** from your library.`,
    components: [],
  });
}

async function showCopySelect(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  canonicalName: string,
  eventId: string,
  eventDate: string,
  ownerIds: string[],
  attendingOwnerIds: string[],
  guildId: string,
): Promise<boolean> {
  if (attendingOwnerIds.length <= 1) return false;

  const gameInfo = await getGameInfo(canonicalName);
  if (!gameInfo?.bggExpansions?.length) return false;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const guildLibrary = await loadLibraryForGuild(guildId);

  const hasExpansions = attendingOwnerIds.some((ownerId) =>
    guildLibrary.some(
      (e) =>
        e.userId === ownerId &&
        e.isExpansion &&
        gameInfo.bggExpansions!.some((exp) => norm(exp) === norm(e.gameName)),
    ),
  );
  if (!hasExpansions) return false;

  const displayNames = new Map<string, string>();
  await Promise.all(
    attendingOwnerIds.map(async (ownerId) => {
      try {
        const member = await interaction.guild?.members.fetch(ownerId);
        displayNames.set(ownerId, member?.displayName ?? `User …${ownerId.slice(-4)}`);
      } catch {
        displayNames.set(ownerId, `User …${ownerId.slice(-4)}`);
      }
    }),
  );

  const options = attendingOwnerIds.map((ownerId) => {
    const ownerExps = gameInfo.bggExpansions!.filter((name) =>
      guildLibrary.some(
        (e) => e.userId === ownerId && e.isExpansion && norm(e.gameName) === norm(name),
      ),
    );
    const desc =
      ownerExps.length > 0 ? `Base + ${ownerExps.join(', ')}`.slice(0, 100) : 'Base game only';
    return new StringSelectMenuOptionBuilder()
      .setValue(ownerId)
      .setLabel(`${displayNames.get(ownerId)}'s copy`.slice(0, 100))
      .setDescription(desc);
  });
  options.push(
    new StringSelectMenuOptionBuilder()
      .setValue('__bot__')
      .setLabel('Bot decides')
      .setDescription('Spread game-bringing load evenly among attending owners'),
  );

  pendingRequestConfirms.set(interaction.user.id, {
    canonicalName,
    eventId,
    eventDate,
    ownerIds,
    attendingOwnerIds,
  });

  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('library_request_copy_select')
      .setPlaceholder('Choose which copy to request...')
      .addOptions(options),
  );

  const content = `**${canonicalName}** is available for the event on ${eventDate}. Which copy would you like?`;
  if (interaction.isChatInputCommand()) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, components: [select] });
  } else {
    await (interaction as StringSelectMenuInteraction).update({ content, components: [select] });
  }
  return true;
}

async function handleRequest(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();
  await resolveRequestFlow(interaction, gameName);
}

// Shared by the slash command above and the hub's "🙋 Request a Game to Bring"
// button/modal (see handleHubRequestModal below) — everything after the typed
// game name is resolved identically regardless of how that name was collected.
async function resolveRequestFlow(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  gameName: string,
): Promise<void> {
  // Check the game exists in the library (someone must own it)
  const library = await loadLibraryForGuild(interaction.guildId!);
  const matches = library.filter((e) => e.gameName.toLowerCase() === gameName.toLowerCase());

  if (matches.length === 0) {
    const partials = await findGameNamesByPartial(interaction.guildId!, gameName);
    if (partials.length > 0 && partials.length <= 25) {
      await interaction.reply({
        content: `**"${gameName}"** wasn't an exact match — did you mean one of these?`,
        flags: MessageFlags.Ephemeral,
        components: [
          buildPartialMatchSelect(partials, 'library_request_select', 'Pick a game to request...'),
        ],
      });
      return;
    }
    if (partials.length > 25) {
      await interaction.reply({
        content: `Too many matches for **"${gameName}"** — try a more specific name.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Check the BGG catalog to give a more helpful "not in library" message
    let notFoundMsg = `**${gameName}** isn't in the group library.`;
    if (isCatalogLoaded()) {
      const catalogResults = searchCatalog(gameName, 1);
      if (catalogResults.length > 0) {
        const top = catalogResults[0];
        if (normalizeName(top.name) === normalizeName(gameName)) {
          notFoundMsg = `**${top.name}** isn't in the group library yet — ask someone who owns it to add it with \`/library add\`.`;
        } else {
          notFoundMsg = `**${gameName}** isn't in the group library. Did you mean **${top.name}**? Check \`/library list\` for what's available.`;
        }
      } else {
        notFoundMsg += " Check what's available with `/library list`.";
      }
    } else {
      notFoundMsg += " Check what's available with `/library list`.";
    }

    await interaction.reply({ content: notFoundMsg, flags: MessageFlags.Ephemeral });
    return;
  }

  // Find the target event — prefer the event channel we're currently in
  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.reply({
      content: "There's no upcoming event to request games for.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const event = upcoming.find((gn) => gn.eventChannelId === interaction.channelId) ?? upcoming[0];

  const canonicalName = matches[0].gameName;
  const ownerIds = matches.map((e) => e.userId);
  const attendingOwnerIds = await resolveAttendingOwnerIds(interaction.guildId!, ownerIds, event.rsvps);

  if (attendingOwnerIds.length === 0) {
    await interaction.reply({
      content: `None of the owners of **${canonicalName}** are attending the event on ${event.date}, so it can't be requested.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const showed = await showCopySelect(
    interaction,
    canonicalName,
    event.id,
    event.date,
    ownerIds,
    attendingOwnerIds,
    interaction.guildId!,
  );
  if (showed) return;

  const result = await addRequest(event.id, canonicalName, interaction.user.id);

  if (result === 'duplicate') {
    await interaction.reply({
      content: `**${canonicalName}** has already been requested for the event on ${event.date}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const owners = ownerIds.map((id) => `<@${id}>`);
  await interaction.reply({
    content: `<@${interaction.user.id}> requested **${canonicalName}** for the event on ${event.date}. Owner${owners.length > 1 ? 's' : ''}: ${owners.join(', ')}`,
  });

  try {
    await updateRequestPin(interaction.client, event.id);
  } catch {
    /* channel may not be accessible */
  }

  const dmOwnerId = await pickPreferredOwner(event.id, attendingOwnerIds);
  if (dmOwnerId) {
    const expansionNote = await buildExpansionNote(interaction.guildId!, dmOwnerId, canonicalName);
    await sendBringRequestDm(interaction.client, result, dmOwnerId, event.date, expansionNote);
  }
}

// ── Hub button: "🙋 Request a Game to Bring" ───────────────────────────────

export async function handleHubRequestButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('hub_request_modal')
    .setTitle('Request a Game to Bring')
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

export async function handleHubRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
  const gameName = interaction.fields.getTextInputValue('game').trim();
  await resolveRequestFlow(interaction, gameName);
}

// ── Hub button: "📋 My Games to Bring" ─────────────────────────────────────

export async function handleHubBringButton(interaction: ButtonInteraction): Promise<void> {
  const gameNight = (await loadGameNights()).find(
    (gn) => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived,
  );
  if (!gameNight) {
    await interaction.reply({
      content: "Could not find this event — it may have been cancelled or archived.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await showBringViewForChannelEvent(interaction, gameNight);
}

export async function handleLibraryRequestSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const gameName = interaction.values[0];

  if (gameName === '__none__') {
    await interaction.update({
      content: 'No problem — try `/library request` again with a different term.',
      components: [],
    });
    return;
  }

  const library = await loadLibraryForGuild(interaction.guildId!);
  const matches = library.filter((e) => e.gameName.toLowerCase() === gameName.toLowerCase());

  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter((gn) => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.update({
      content: "There's no upcoming event to request games for.",
      components: [],
    });
    return;
  }

  const event = upcoming.find((gn) => gn.eventChannelId === interaction.channelId) ?? upcoming[0];

  const canonicalName = matches[0]?.gameName ?? gameName;
  const ownerIds = matches.map((e) => e.userId);
  const attendingOwnerIds = await resolveAttendingOwnerIds(interaction.guildId!, ownerIds, event.rsvps);

  if (attendingOwnerIds.length === 0) {
    await interaction.update({
      content: `None of the owners of **${canonicalName}** are attending the event on ${event.date}, so it can't be requested.`,
      components: [],
    });
    return;
  }

  const showed = await showCopySelect(
    interaction,
    canonicalName,
    event.id,
    event.date,
    ownerIds,
    attendingOwnerIds,
    interaction.guildId!,
  );
  if (showed) return;

  const result = await addRequest(event.id, canonicalName, interaction.user.id);

  if (result === 'duplicate') {
    await interaction.update({
      content: `**${canonicalName}** has already been requested for the event on ${event.date}.`,
      components: [],
    });
    return;
  }

  const owners = ownerIds.map((id) => `<@${id}>`);
  await interaction.update({ content: '✅ Request submitted!', components: [] });
  await interaction.followUp({
    content: `<@${interaction.user.id}> requested **${canonicalName}** for the event on ${event.date}. Owner${owners.length !== 1 ? 's' : ''}: ${owners.join(', ')}`,
    ephemeral: false,
  });

  try {
    await updateRequestPin(interaction.client, event.id);
  } catch {
    /* channel may not be accessible */
  }

  const dmOwnerId = await pickPreferredOwner(event.id, attendingOwnerIds);
  if (dmOwnerId) {
    const expansionNote = await buildExpansionNote(interaction.guildId!, dmOwnerId, canonicalName);
    await sendBringRequestDm(interaction.client, result, dmOwnerId, event.date, expansionNote);
  }
}

export async function handleLibraryRequestCopySelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const pending = pendingRequestConfirms.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This prompt has expired — try `/library request` again.',
      components: [],
    });
    return;
  }
  pendingRequestConfirms.delete(interaction.user.id);

  const selected = interaction.values[0];
  const preferredOwnerId =
    selected === '__bot__'
      ? await pickPreferredOwner(pending.eventId, pending.attendingOwnerIds)
      : selected;

  const result = await addRequest(
    pending.eventId,
    pending.canonicalName,
    interaction.user.id,
    preferredOwnerId,
  );

  if (result === 'duplicate') {
    await interaction.update({
      content: `**${pending.canonicalName}** has already been requested for the event on ${pending.eventDate}.`,
      components: [],
    });
    return;
  }

  const owners = pending.ownerIds.map((id) => `<@${id}>`);
  await interaction.update({ content: '✅ Request submitted!', components: [] });
  await interaction.followUp({
    content: `<@${interaction.user.id}> requested **${pending.canonicalName}** for the event on ${pending.eventDate}. Owner${owners.length !== 1 ? 's' : ''}: ${owners.join(', ')} — bringing: <@${preferredOwnerId}>`,
    ephemeral: false,
  });

  try {
    await updateRequestPin(interaction.client, pending.eventId);
  } catch {
    /* channel not accessible */
  }

  if (preferredOwnerId) {
    const expansionNote = await buildExpansionNote(interaction.guildId!, preferredOwnerId, pending.canonicalName);
    await sendBringRequestDm(interaction.client, result, preferredOwnerId, pending.eventDate, expansionNote);
  }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function handleImportBgg(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const bggAccount = await getBggAccount(guildId, userId);
  if (!bggAccount) {
    await interaction.reply({
      content:
        "You don't have a BoardGameGeek account linked on this server. Use `/bgg link` to connect one, then run `/library import bgg`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply('Fetching your BoardGameGeek collection…');

  let games;
  try {
    games = await fetchBggOwnedCollection(bggAccount.bggUsername);
  } catch (err) {
    console.error('[library import bgg] fetchBggOwnedCollection failed:', err);
    games = null;
  }

  if (!games) {
    await interaction.editReply(
      'Could not reach BoardGameGeek right now. Please try again in a moment, or use `/library import csv` instead.',
    );
    return;
  }

  const validGames = games.filter((g) => !!g.gameName);

  // Batch the library-add and game-info upserts into one read + one write
  // each, rather than one round trip per game — with a large BGG collection
  // (100s of games) that per-game pattern made this command take minutes.
  const addResults = await addGamesBulk(
    guildId,
    userId,
    validGames.map((g) => ({ gameName: g.gameName, objectid: g.bggGameId, isExpansion: g.isExpansion })),
  );

  const existingInfos = await loadGameInfos();
  const existingByName = new Map(existingInfos.map((i) => [i.gameName.toLowerCase(), i]));

  let addedGames = 0;
  let addedExpansions = 0;
  let skipped = 0;
  const collectionEntries: UserCollectionEntry[] = [];
  const infosToUpsert: GameInfo[] = [];

  for (let i = 0; i < validGames.length; i++) {
    const game = validGames[i];
    if (addResults[i] === 'added') {
      if (game.isExpansion) addedExpansions++;
      else addedGames++;
    } else {
      skipped++;
    }

    const existing = existingByName.get(game.gameName.toLowerCase());
    infosToUpsert.push({
      gameName: game.gameName,
      objectid: game.bggGameId,
      minPlayers: existing?.minPlayers ?? game.minPlayers ?? undefined,
      maxPlayers: existing?.maxPlayers ?? game.maxPlayers ?? undefined,
      playTime: existing?.playTime ?? game.playingTime ?? undefined,
      weight: existing?.weight,
      complexity: existing?.complexity,
      tags: existing?.tags,
      expansions: existing?.expansions,
      updatedAt: new Date().toISOString(),
    });

    collectionEntries.push({
      bggGameId: game.bggGameId,
      gameName: game.gameName,
      bggOwn: game.own,
      bggForTrade: game.forTrade,
      bggWantToPlay: game.wantToPlay,
      bggWishlisted: game.wishlisted,
      bggUserRating: game.userRating,
      bggNumPlays: game.numPlays,
      bggSyncedAt: new Date().toISOString(),
    });
  }

  await upsertGameInfosBulk(infosToUpsert);
  await mergeUserCollection(guildId, userId, collectionEntries);

  const parts: string[] = [];
  if (addedGames > 0) parts.push(`**${addedGames}** game${addedGames !== 1 ? 's' : ''} added`);
  if (addedExpansions > 0)
    parts.push(`**${addedExpansions}** expansion${addedExpansions !== 1 ? 's' : ''} added`);
  if (skipped > 0) parts.push(`**${skipped}** already in your library`);
  await interaction.editReply(`BoardGameGeek import complete — ${parts.join(', ')}.`);
}

async function handleImportCsv(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const attachment = interaction.options.getAttachment('file', true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (attachment.size > 512_000) {
    await interaction.editReply('That file is too large. Please upload a CSV under 500 KB.');
    return;
  }

  let buffer: Buffer;
  try {
    const res = await fetch(attachment.url);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    await interaction.editReply('Failed to download the file. Please try again.');
    return;
  }

  const isZip = attachment.name.toLowerCase().endsWith('.zip');
  let csvTexts: string[];

  if (isZip) {
    try {
      const zip = new AdmZip(buffer);
      csvTexts = zip
        .getEntries()
        .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.csv'))
        .map((e) => e.getData().toString('utf8'));
    } catch {
      await interaction.editReply(
        "Could not read that ZIP file. Make sure it's a valid ZIP containing CSV files.",
      );
      return;
    }
    if (csvTexts.length === 0) {
      await interaction.editReply('No CSV files were found inside that ZIP.');
      return;
    }
  } else {
    csvTexts = [buffer.toString('utf8')];
  }

  let added = 0;
  let skipped = 0;
  let expansions = 0;

  for (const text of csvTexts) {
    const result = await processCsvText(text, guildId, userId);
    added += result.added;
    skipped += result.skipped;
    expansions += result.expansions;
  }

  if (added === 0 && skipped === 0 && expansions === 0) {
    await interaction.editReply(
      'No games were found in that file. Make sure it has one game name per line.',
    );
    return;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`**${added}** game${added !== 1 ? 's' : ''} added`);
  if (skipped > 0) parts.push(`**${skipped}** already in your library`);
  if (expansions > 0)
    parts.push(`**${expansions}** expansion${expansions !== 1 ? 's' : ''} skipped`);
  await interaction.editReply(`Import complete — ${parts.join(', ')}.`);
}

async function processCsvText(
  text: string,
  guildId: string,
  userId: string,
): Promise<{ added: number; skipped: number; expansions: number }> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let expansions = 0;

  if (lines.length === 0) return { added: 0, skipped: 0, expansions };

  // Detect BGG CSV format by checking header row for known BGG columns
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const isBgg = headers.includes('own') && headers.includes('objectname');
  const nameIdx = isBgg ? headers.indexOf('objectname') : 0;
  const idIdx = isBgg ? headers.indexOf('objectid') : -1;
  const ownIdx = isBgg ? headers.indexOf('own') : -1;
  const typeIdx = isBgg ? headers.indexOf('itemtype') : -1;
  const minPlayersIdx = isBgg ? headers.indexOf('minplayers') : -1;
  const maxPlayersIdx = isBgg ? headers.indexOf('maxplayers') : -1;
  const bestPlayersIdx = isBgg ? headers.indexOf('bggbestplayers') : -1;
  const playTimeIdx = isBgg ? headers.indexOf('playingtime') : -1;
  const weightIdx = isBgg ? headers.indexOf('avgweight') : -1;

  const dataLines = isBgg ? lines.slice(1) : lines;

  interface Row {
    gameName: string;
    objectid?: string;
    minPlayers?: number;
    maxPlayers?: number;
    bestPlayers?: number;
    playTime?: number;
    weight?: number;
  }
  const rows: Row[] = [];

  for (const rawLine of dataLines) {
    const fields = parseCsvLine(rawLine);
    const gameName = fields[nameIdx]?.trim();

    if (!gameName || HEADER_PATTERNS.has(gameName.toLowerCase())) continue;

    if (ownIdx !== -1 && fields[ownIdx] !== '1') continue;
    if (typeIdx !== -1 && fields[typeIdx] === 'expansion') {
      expansions++;
      continue;
    }

    const objectid = idIdx !== -1 ? fields[idIdx]?.trim() || undefined : undefined;
    const row: Row = { gameName, objectid };

    if (isBgg) {
      row.minPlayers =
        minPlayersIdx !== -1 ? parseInt(fields[minPlayersIdx], 10) || undefined : undefined;
      row.maxPlayers =
        maxPlayersIdx !== -1 ? parseInt(fields[maxPlayersIdx], 10) || undefined : undefined;
      row.bestPlayers =
        bestPlayersIdx !== -1 ? parseInt(fields[bestPlayersIdx], 10) || undefined : undefined;
      row.playTime =
        playTimeIdx !== -1 ? parseInt(fields[playTimeIdx], 10) || undefined : undefined;
      const rawWeight = weightIdx !== -1 ? parseFloat(fields[weightIdx]) : NaN;
      row.weight = !isNaN(rawWeight) && rawWeight > 0 ? rawWeight : undefined;
    }

    rows.push(row);
  }

  if (rows.length === 0) return { added: 0, skipped: 0, expansions };

  // Batch the library-add and game-info upserts into one read + one write
  // each, rather than one round trip per CSV row.
  const addResults = await addGamesBulk(
    guildId,
    userId,
    rows.map((r) => ({ gameName: r.gameName, objectid: r.objectid })),
  );
  const added = addResults.filter((r) => r === 'added').length;
  const skipped = addResults.filter((r) => r === 'duplicate').length;

  if (isBgg) {
    const existingInfos = await loadGameInfos();
    const existingByName = new Map(existingInfos.map((i) => [i.gameName.toLowerCase(), i]));
    const infosToUpsert: GameInfo[] = rows.map((r) => {
      const existing = existingByName.get(r.gameName.toLowerCase());
      return {
        gameName: r.gameName,
        objectid: r.objectid,
        minPlayers: existing?.minPlayers ?? r.minPlayers,
        maxPlayers: existing?.maxPlayers ?? r.maxPlayers,
        bestPlayers: existing?.bestPlayers ?? r.bestPlayers,
        playTime: existing?.playTime ?? r.playTime,
        weight: existing?.weight ?? r.weight,
        complexity: existing?.complexity ?? (r.weight ? weightTag(r.weight) : undefined),
        tags: existing?.tags,
        expansions: existing?.expansions,
        updatedAt: new Date().toISOString(),
      };
    });
    await upsertGameInfosBulk(infosToUpsert);
  }

  return { added, skipped, expansions };
}

async function handleEdit(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  // Must be in the library (owned by someone)
  const matches = await findGamesByName(interaction.guildId!, gameName);
  if (matches.length === 0) {
    await interaction.reply({
      content: `**${gameName}** isn't in the group library. Only games in the library can be edited.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Only owners can edit
  const isOwner = matches.some((e) => e.userId === interaction.user.id);
  if (!isOwner) {
    const owners = matches.map((e) => `<@${e.userId}>`).join(', ');
    await interaction.reply({
      content: `Only owners of **${matches[0].gameName}** can edit its details (${owners}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const canonical = matches[0].gameName;
  const existing = await getGameInfo(canonical);

  pendingEdits.set(interaction.user.id, canonical);
  await interaction.showModal(buildEditModal(canonical, existing));
}

export async function handleEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  const gameName = pendingEdits.get(interaction.user.id);
  if (!gameName) {
    await interaction.reply({
      content: 'This edit session has expired. Please run `/library edit` again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  pendingEdits.delete(interaction.user.id);

  const playersRaw = interaction.fields.getTextInputValue('players').trim();
  const playtimeRaw = interaction.fields.getTextInputValue('playtime').trim();
  const tagsRaw = interaction.fields.getTextInputValue('tags').trim();
  const expansionsRaw = interaction.fields.getTextInputValue('expansions').trim();
  const complexityRaw = interaction.fields.getTextInputValue('complexity').trim();

  const existing = await getGameInfo(gameName);

  // The modal always pre-fills each field with its current value, so a blank
  // field here means the user deliberately cleared it, not "leave unchanged".
  let minPlayers: number | undefined;
  let maxPlayers: number | undefined;
  if (playersRaw) {
    const parts = playersRaw.split('-').map((p) => parseInt(p.trim(), 10));
    if (!isNaN(parts[0])) minPlayers = parts[0];
    if (parts[1] != null && !isNaN(parts[1])) maxPlayers = parts[1];
    else if (!isNaN(parts[0])) maxPlayers = parts[0];
  }

  const playTime = playtimeRaw ? parseInt(playtimeRaw, 10) || existing?.playTime : undefined;

  // Fuzzy-match each tag; collect unrecognized inputs for follow-up
  const unmatchedTagInputs: string[] = [];
  const resolvedTags: string[] = tagsRaw
    ? tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .reduce<string[]>((acc, raw) => {
          const matched = fuzzyMatchTag(raw);
          if (matched) {
            if (!acc.includes(matched)) acc.push(matched);
          } else unmatchedTagInputs.push(raw);
          return acc;
        }, [])
    : [];

  const expansions = expansionsRaw
    ? expansionsRaw
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
    : undefined;

  // Fuzzy-match complexity; fall back to existing if input unrecognized
  const resolvedComplexity: Complexity | null | undefined = complexityRaw
    ? (fuzzyMatchComplexity(complexityRaw) ?? existing?.complexity)
    : undefined;
  const complexityNeedsPrompt = !!(complexityRaw && !fuzzyMatchComplexity(complexityRaw));

  const info: GameInfo = {
    gameName,
    objectid: existing?.objectid,
    minPlayers,
    maxPlayers,
    bestPlayers: existing?.bestPlayers,
    playTime,
    weight: existing?.weight,
    complexity: resolvedComplexity,
    tags: resolvedTags,
    expansions,
    bggExpansions: existing?.bggExpansions,
    howToPlayUrl: existing?.howToPlayUrl,
    thumbnail: existing?.thumbnail,
    updatedAt: new Date().toISOString(),
  };

  // Complexity unrecognized — prompt for selection; defer tag fix to afterward if needed
  if (complexityNeedsPrompt) {
    pendingEditFixes.set(interaction.user.id, { info, unmatchedTagInputs });
    const tagNote =
      unmatchedTagInputs.length > 0
        ? `\n\nSome tags also weren't recognized (**${unmatchedTagInputs.join(', ')}**) — you'll pick from available tags next.`
        : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('library_edit_complexity_light')
        .setLabel('Light')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('library_edit_complexity_medium')
        .setLabel('Medium')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('library_edit_complexity_heavy')
        .setLabel('Heavy')
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content: `**"${complexityRaw}"** didn't match a complexity — which best fits **${gameName}**?${tagNote}`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Unrecognized tags — prompt with full tag select
  if (unmatchedTagInputs.length > 0) {
    pendingEditFixes.set(interaction.user.id, { info, unmatchedTagInputs });
    await interaction.reply({
      content: `Some tags weren't recognized: **${unmatchedTagInputs.join(', ')}**\nSelect from available tags to add them (or skip):`,
      components: [buildTagSelectRow(gameName), buildTagSkipRow()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await upsertGameInfo(info);
  await interaction.reply({ content: `Details saved for **${gameName}**.`, flags: MessageFlags.Ephemeral });
}

export async function handleComplexityFix(
  interaction: ButtonInteraction,
  complexity: Complexity,
): Promise<void> {
  const pending = pendingEditFixes.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This session has expired. Please run `/library edit` again.',
      components: [],
    });
    return;
  }
  const updatedInfo = { ...pending.info, complexity };
  if (pending.unmatchedTagInputs.length > 0) {
    pendingEditFixes.set(interaction.user.id, {
      info: updatedInfo,
      unmatchedTagInputs: pending.unmatchedTagInputs,
    });
    await interaction.update({
      content: `Got it — **${complexity}** for **${updatedInfo.gameName}**.\nSome tags weren't recognized: **${pending.unmatchedTagInputs.join(', ')}**\nSelect from available tags to add them (or skip):`,
      components: [buildTagSelectRow(updatedInfo.gameName), buildTagSkipRow()],
    });
    return;
  }
  pendingEditFixes.delete(interaction.user.id);
  await upsertGameInfo(updatedInfo);
  await interaction.update({
    content: `Details saved for **${updatedInfo.gameName}**.`,
    components: [],
  });
}

export async function handleTagsFix(interaction: StringSelectMenuInteraction): Promise<void> {
  const pending = pendingEditFixes.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This session has expired. Please run `/library edit` again.',
      components: [],
    });
    return;
  }
  pendingEditFixes.delete(interaction.user.id);
  const selected = interaction.values;
  const merged = [
    ...(pending.info.tags ?? []),
    ...selected.filter((t) => !pending.info.tags?.includes(t)),
  ];
  await upsertGameInfo({ ...pending.info, tags: merged.length > 0 ? merged : pending.info.tags });
  await interaction.update({
    content: `Details saved for **${pending.info.gameName}**.`,
    components: [],
  });
}

export async function handleTagsSkip(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingEditFixes.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This session has expired. Please run `/library edit` again.',
      components: [],
    });
    return;
  }
  pendingEditFixes.delete(interaction.user.id);
  await upsertGameInfo(pending.info);
  await interaction.update({
    content: `Details saved for **${pending.info.gameName}**.`,
    components: [],
  });
}

async function handleRandom(interaction: ChatInputCommandInteraction): Promise<void> {
  const tags = [
    interaction.options.getString('tag'),
    interaction.options.getString('tag2'),
    interaction.options.getString('tag3'),
  ].filter((t): t is string => t !== null);
  const complexity = interaction.options.getString('complexity') as Complexity | null;
  await resolveRandomGames(interaction, tags, complexity);
}

// Shared by the slash command above and the general hub's "🎲 Random Game"
// button (see handleHubGeneralRandomButton in generalHub.ts), which always
// calls this with empty filters — same as running /library random with no
// options, including the personalization fallback to the user's /myroles
// preferences when no tags/complexity are given.
export async function resolveRandomGames(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  initialTags: string[],
  initialComplexity: Complexity | null,
): Promise<void> {
  let tags = initialTags;
  let complexity = initialComplexity;

  let personalized = false;
  if (tags.length === 0 && !complexity) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const prefs = await getMemberPreferences(interaction.guildId!, member);
    if (prefs.tags.length > 0 || prefs.complexity) {
      tags = prefs.tags;
      complexity = prefs.complexity as Complexity | null;
      personalized = true;
    }
  }

  const library = await loadLibraryForGuild(interaction.guildId!);
  const infos = await loadGameInfos();

  // Deduplicate to one entry per game
  const seen = new Set<string>();
  const allGames: Array<{ displayName: string; owners: string[]; info: GameInfo | undefined }> = [];
  for (const entry of library) {
    const key = entry.gameName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const gameInfo = infos.find((i) => i.gameName.toLowerCase() === key);
    const owners = library
      .filter((e) => e.gameName.toLowerCase() === key)
      .map((e) => `<@${e.userId}>`);
    allGames.push({ displayName: entry.gameName, info: gameInfo, owners });
  }

  // Filter by tags and complexity if provided
  let pool = allGames.filter((g) => {
    if (
      tags.length > 0 &&
      !g.info?.tags?.some((t) => tags.some((ft) => ft.toLowerCase() === t.toLowerCase()))
    )
      return false;
    if (complexity && g.info?.complexity !== complexity) return false;
    return true;
  });
  let fallback = false;
  if ((tags.length > 0 || complexity) && pool.length === 0) {
    pool = allGames;
    fallback = true;
  }

  if (pool.length === 0) {
    await interaction.reply({ content: 'The library is empty.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Fisher-Yates shuffle and take up to 3
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  const picks = shuffled.slice(0, 3);

  const filterLabels = [tags.length > 0 ? tags.join(' or ') : '', complexity ?? '']
    .filter(Boolean)
    .join(', ');
  const sourceNote = personalized ? ' (from your /myroles)' : '';
  const title = fallback
    ? `No **${filterLabels}**${sourceNote} games found — here are 3 random picks instead`
    : `3 Random Game${picks.length !== 3 ? '' : 's'}${filterLabels ? ` — ${filterLabels}${sourceNote}` : ''}`;

  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2);

  for (const pick of picks) {
    const meta: string[] = [];
    if (pick.info?.minPlayers != null && pick.info?.maxPlayers != null)
      meta.push(`${pick.info.minPlayers}–${pick.info.maxPlayers} players`);
    if (pick.info?.playTime != null) meta.push(`${pick.info.playTime} min`);
    if (pick.info?.complexity) meta.push(pick.info.complexity);
    if (pick.info?.tags?.length) meta.push(pick.info.tags.join(', '));
    const value = [
      `Owner${pick.owners.length !== 1 ? 's' : ''}: ${pick.owners.join(', ')}`,
      ...(meta.length ? [meta.join(' • ')] : []),
    ].join('\n');
    embed.addFields({ name: pick.displayName, value });
  }

  const footerTip = tags.length === 0 && !complexity
    ? ' • Set your preferences with /myroles to get picks tailored to you'
    : '';
  embed.setFooter({
    text: `Use /library view <game> for full details • Run again for different picks${footerTip}`,
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function parseInts(raw: string): number[] {
  return raw
    .split(/[,/]/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

async function handleSearch(interaction: ChatInputCommandInteraction): Promise<void> {
  const playersRaw = interaction.options.getString('players') ?? undefined;
  let tags = [
    interaction.options.getString('tag'),
    interaction.options.getString('tag2'),
    interaction.options.getString('tag3'),
  ].filter((t): t is string => t !== null);
  const durationRaw = interaction.options.getString('duration') ?? undefined;
  const minDuration = interaction.options.getInteger('min_duration') ?? undefined;
  const maxDuration = interaction.options.getInteger('max_duration') ?? undefined;
  let complexity = interaction.options.getString('complexity') as Complexity | null;

  const playerCounts = playersRaw ? parseInts(playersRaw) : [];
  const durations = durationRaw ? parseInts(durationRaw) : [];

  let personalized = false;
  if (tags.length === 0 && !complexity) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const prefs = await getMemberPreferences(interaction.guildId!, member);
    if (prefs.tags.length > 0 || prefs.complexity) {
      tags = prefs.tags;
      complexity = prefs.complexity as Complexity | null;
      personalized = true;
    }
  }

  if (
    playerCounts.length === 0 &&
    tags.length === 0 &&
    durations.length === 0 &&
    minDuration === undefined &&
    maxDuration === undefined &&
    !complexity
  ) {
    await interaction.reply({
      content:
        'Provide at least one valid filter: `players`, `tag`, or `duration` — or set your preferences with `/myroles` to search based on those.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const library = await loadLibraryForGuild(interaction.guildId!);
  const infos = await loadGameInfos();

  const seen = new Set<string>();
  const matches: Array<{ displayName: string; owners: string[]; info: GameInfo | undefined }> = [];

  for (const entry of library) {
    const key = entry.gameName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const gameInfo = infos.find((i) => i.gameName.toLowerCase() === key);

    if (playerCounts.length > 0) {
      if (gameInfo?.minPlayers == null || gameInfo?.maxPlayers == null) continue;
      if (!playerCounts.some((p) => p >= gameInfo.minPlayers! && p <= gameInfo.maxPlayers!))
        continue;
    }

    if (tags.length > 0) {
      if (!gameInfo?.tags?.some((t) => tags.some((ft) => ft.toLowerCase() === t.toLowerCase())))
        continue;
    }

    if (durations.length > 0) {
      if (gameInfo?.playTime == null) continue;
      if (!durations.some((d) => Math.abs(gameInfo.playTime! - d) <= 15)) continue;
    }
    if (minDuration !== undefined) {
      if (gameInfo?.playTime == null || gameInfo.playTime < minDuration) continue;
    }
    if (maxDuration !== undefined) {
      if (gameInfo?.playTime == null || gameInfo.playTime > maxDuration) continue;
    }
    if (complexity) {
      if (gameInfo?.complexity !== complexity) continue;
    }

    const owners = library
      .filter((e) => e.gameName.toLowerCase() === key)
      .map((e) => `<@${e.userId}>`);
    matches.push({ displayName: entry.gameName, info: gameInfo, owners });
  }

  if (playerCounts.length > 0) {
    matches.sort((a, b) => {
      const refA =
        a.info?.bestPlayers ?? ((a.info?.minPlayers ?? 0) + (a.info?.maxPlayers ?? 0)) / 2;
      const refB =
        b.info?.bestPlayers ?? ((b.info?.minPlayers ?? 0) + (b.info?.maxPlayers ?? 0)) / 2;
      const distA = Math.min(...playerCounts.map((p) => Math.abs(p - refA)));
      const distB = Math.min(...playerCounts.map((p) => Math.abs(p - refB)));
      return distA !== distB ? distA - distB : a.displayName.localeCompare(b.displayName);
    });
  } else {
    matches.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  const durationRangePart =
    minDuration !== undefined || maxDuration !== undefined
      ? `**${minDuration ?? 0}–${maxDuration ?? '∞'} min**`
      : '';
  const filterParts = [
    playerCounts.length > 0 ? `**${playerCounts.join(' or ')} players**` : '',
    tags.length > 0 ? `tag **${tags.join(' or ')}**${personalized ? ' (from your /myroles)' : ''}` : '',
    durations.length > 0 ? `**${durations.join(' or ')} min** (±15 min)` : '',
    durationRangePart,
    complexity ? `**${complexity}**${personalized && tags.length === 0 ? ' (from your /myroles)' : ''}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  if (matches.length === 0) {
    await interaction.reply({
      content: `No games found matching ${filterParts}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const totalCount = matches.length;
  const CHAR_BUDGET = 5200;
  const shown: string[] = [];
  let charCount = 0;

  for (const m of matches) {
    const meta: string[] = [];
    if (m.info?.minPlayers != null && m.info?.maxPlayers != null)
      meta.push(`${m.info.minPlayers}–${m.info.maxPlayers}p`);
    if (playerCounts.length > 0 && m.info?.bestPlayers != null)
      meta.push(`best: ${m.info.bestPlayers}p`);
    if (m.info?.playTime != null) meta.push(`${m.info.playTime} min`);
    if (m.info?.complexity) meta.push(m.info.complexity);
    if (m.info?.tags?.length) meta.push(m.info.tags.join(', '));
    const metaStr = meta.length ? ` *(${meta.join(' • ')})*` : '';
    const line = `**${m.displayName}**${metaStr} — ${m.owners.join(', ')}`;
    if (charCount + line.length + 1 > CHAR_BUDGET) break;
    shown.push(line);
    charCount += line.length + 1;
  }

  const truncated = shown.length < totalCount;
  const embed = new EmbedBuilder()
    .setTitle('Library Search')
    .setDescription(
      `${truncated ? `Showing ${shown.length} of ${totalCount}` : totalCount} game${totalCount !== 1 ? 's' : ''} matching ${filterParts}`,
    )
    .setColor(0x5865f2);

  const chunks: string[] = [];
  let current = '';
  for (const line of shown) {
    if (current && current.length + line.length + 1 > 900) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    embed.addFields({ name: '​', value: chunk });
  }

  const sortNote =
    playerCounts.length > 0
      ? `Sorted by closest to ${playerCounts.join(' or ')} player${playerCounts.length > 1 || playerCounts[0] !== 1 ? 's' : ''} (by best player count)`
      : 'Sorted alphabetically';
  embed.setFooter({
    text: truncated
      ? `${sortNote} • Add more filters to narrow results`
      : `${sortNote} • /library view <game> for full details`,
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
