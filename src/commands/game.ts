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
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { randomUUID } from 'crypto';
import {
  searchBGG,
  getBGGGame,
  BGGGame,
  BGGExpansion,
  BGGSearchResult,
  weightTag,
} from '../utils/bgg';
import { searchCatalog, isCatalogLoaded, matchesFuzzy } from '../utils/bggCatalog';
import {
  loadGames,
  saveGames,
  upsertGame,
  GameSuggestion,
  GameExpansion,
  findGamesByChannel,
  findGamesByEvent,
} from '../utils/gameStorage';
import { buildGameEmbed, buildGameButtons, buildBggAttachment } from '../utils/gameEmbeds';
import { loadGameNights, findGameNight, GameNight } from '../utils/storage';
import { isLineupLocked, LOCK_MESSAGE } from '../utils/scheduler';
import { greeterSeatViolation } from '../utils/greeters';
import { findRoomByChannel, PrivateRoom } from '../utils/roomStorage';
import {
  findGamesByName,
  findGameNamesByPartial,
  getGameInfo,
  upsertGameInfo,
  addGame,
  addRequest,
  updateRequestCopies,
  getRequestsForEvent,
  removeRequests,
  confirmBring,
  GameInfo,
  GAME_TAGS,
} from '../utils/libraryStorage';
import { updateRequestPin, updateGameListPin } from '../utils/requestPin';
import { enrichFromBGG } from './library';
import { getGuildConfig } from '../utils/config';
import {
  buildBgStatsPlayUrl,
  buildBgStatsButton,
  buildBgStatsButtonUrl,
  buildBgStatsQrAttachment,
} from '../utils/bgStats';
import { resolvePlayerNames } from '../utils/playerNames';

const MANUAL_VALUE = '__manual__';
const BGG_VALUE = '__bgg__';

async function findDuplicateGame(eventId: string, title: string): Promise<GameSuggestion | undefined> {
  return (await loadGames()).find(
    (g) => g.eventId === eventId && g.title.toLowerCase() === title.toLowerCase(),
  );
}

function duplicateReply(game: GameSuggestion): string {
  const link = `https://discord.com/channels/${game.guildId}/${game.channelId}/${game.messageId}`;
  return `**${game.title}** is already in the lineup! [Jump to the existing card](${link})`;
}

interface PendingBring {
  gameName: string;
  objectid?: string;
  eventId: string;
}
const pendingBrings = new Map<string, PendingBring>();

interface PendingLibrarySuggest {
  title: string;
  withExpansions: boolean;
}
const pendingLibrarySuggest = new Map<string, PendingLibrarySuggest>();

// Stores the selected eventId for users suggesting from outside an event channel
const pendingEventContext = new Map<string, string>();

// Stores library game context while user picks expansions
const pendingLibraryGame = new Map<
  string,
  { gameName: string; info: GameInfo | null; ownerIds: string[] }
>();

export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Suggest a game to play at a game night event')
  .addSubcommand((sub) =>
    sub
      .setName('suggest')
      .setDescription('Search for a game and add it to this event channel')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Game title to search for').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('with_expansions')
          .setDescription('Include expansions for this game?')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all games scheduled for this event'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Remove a game suggestion from the lineup')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Title of the game to remove').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('bgstats')
      .setDescription('Generate a "Log in BG Stats" button + QR code for a suggested game')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Title of the game to generate a link for').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('location')
          .setDescription('Where you\'re playing (defaults to the event location, blank in private rooms)')
          .setRequired(false),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'suggest') await handleSuggest(interaction);
  else if (sub === 'list') await handleGameList(interaction);
  else if (sub === 'cancel') await handleGameCancel(interaction);
  else if (sub === 'bgstats') await handleGameBgStats(interaction);
}

// Private rooms have no RSVPs/lineup pin/request tracking of their own, but the rest of the
// suggest flow (attendance check, duplicate check, posting, join/leave) only ever reads
// .id/.eventChannelId/.rsvps/.cancelled/.archived/.suggestionsLocked off a GameNight — so a
// room is adapted into a GameNight-shaped object rather than threading a second type through
// every step of suggest/BGG-select/expansion-select/tag-picker. The "room:" id prefix lets
// addRequest/pin calls (which don't apply to a room) be skipped explicitly instead of relying
// on them silently no-op-ing against a lookup that will never match.
const ROOM_GAME_NIGHT_PREFIX = 'room:';

function roomToGameNightAdapter(room: PrivateRoom): GameNight {
  return {
    id: `${ROOM_GAME_NIGHT_PREFIX}${room.id}`,
    title: room.name,
    date: '',
    time: '',
    location: '',
    link: '',
    description: '',
    messageId: '',
    channelId: room.channelId,
    guildId: room.guildId,
    discordEventId: null,
    eventChannelId: room.channelId,
    startTimeISO: room.createdAt,
    endTimeISO: null,
    rsvps: { yes: [room.createdBy, ...room.invitedUserIds], maybe: [], no: [] },
    createdBy: room.createdBy,
    cancelled: false,
    archived: false,
    createdAt: room.createdAt,
  };
}

function isRoomGameNight(gn: Pick<GameNight, 'id'>): boolean {
  return gn.id.startsWith(ROOM_GAME_NIGHT_PREFIX);
}

async function findGameNightForInteraction(
  userId: string,
  channelId: string | null,
): Promise<GameNight | undefined> {
  const active = (await loadGameNights()).filter((gn) => !gn.cancelled && !gn.archived);
  if (channelId) {
    const byChannel = active.find((gn) => gn.eventChannelId === channelId);
    if (byChannel) return byChannel;
    const room = await findRoomByChannel(channelId);
    if (room) return roomToGameNightAdapter(room);
  }
  const storedId = pendingEventContext.get(userId);
  if (storedId) return active.find((gn) => gn.id === storedId);
  return undefined;
}

// ── BGG search helper ─────────────────────────────────────────────────────────

interface BGGSearchReply {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

// Discord select menus cap at 25 options; reserve one for "enter manually".
const BGG_RESULTS_PER_PAGE = 24;

interface BGGPageSession {
  results: BGGSearchResult[];
  withExpansions: boolean;
  fromLibraryDismiss: boolean;
  title: string;
  pageIndex: number;
}
const bggPageSessions = new Map<string, BGGPageSession>();

function renderBGGPage(userId: string): BGGSearchReply {
  const session = bggPageSessions.get(userId);
  if (!session) {
    return { content: 'This search has expired. Please run `/game suggest` again.', components: [] };
  }

  const { results, withExpansions, fromLibraryDismiss, title, pageIndex } = session;
  const totalPages = Math.max(1, Math.ceil(results.length / BGG_RESULTS_PER_PAGE));
  const pageResults = results.slice(
    pageIndex * BGG_RESULTS_PER_PAGE,
    (pageIndex + 1) * BGG_RESULTS_PER_PAGE,
  );

  const options = pageResults.map((r) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(r.name.slice(0, 100))
      .setValue(r.id)
      .setDescription(r.yearPublished ? `Published ${r.yearPublished}` : 'Year unknown'),
  );
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('None of these — enter details manually')
      .setValue(MANUAL_VALUE)
      .setDescription('Fill in player count, duration, and a link yourself'),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(withExpansions ? 'game_select_exp' : 'game_select')
    .setPlaceholder('Choose the correct game...')
    .addOptions(options);

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('game_bgg_prev')
          .setLabel('← Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === 0),
        new ButtonBuilder()
          .setCustomId('game_bgg_page')
          .setLabel(`Page ${pageIndex + 1} of ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('game_bgg_next')
          .setLabel('Next →')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === totalPages - 1),
      ),
    );
  }

  const prefix = fromLibraryDismiss ? '' : `**"${title}"** wasn't found in the group library. `;
  return {
    content: `${prefix}Found **${results.length}** BGG result(s), newest first — pick the one you mean:`,
    components,
  };
}

export async function handleBGGSearchPage(
  interaction: ButtonInteraction,
  direction: 'prev' | 'next',
): Promise<void> {
  const session = bggPageSessions.get(interaction.user.id);
  if (!session) {
    await interaction.update({
      content: 'This search has expired. Please run `/game suggest` again.',
      components: [],
    });
    return;
  }
  session.pageIndex += direction === 'next' ? 1 : -1;
  await interaction.update(renderBGGPage(interaction.user.id));
}

async function buildBGGSearchReply(
  userId: string,
  title: string,
  withExpansions: boolean,
  fromLibraryDismiss = false,
): Promise<BGGSearchReply> {
  let results: BGGSearchResult[] = [];
  let bggFailed = false;
  try {
    results = await searchBGG(title);
  } catch {
    bggFailed = true;
  }

  if (results.length === 0) {
    // When BGG is unreachable, fall back to the local catalog before going to manual entry
    if (bggFailed && isCatalogLoaded()) {
      const catalogResults = searchCatalog(title, 10);
      if (catalogResults.length > 0) {
        const options = catalogResults.map((r) => {
          const desc = [
            r.year ? `Published ${r.year}` : 'Year unknown',
            r.isExpansion ? 'Expansion' : '',
          ]
            .filter(Boolean)
            .join(' • ');
          return new StringSelectMenuOptionBuilder()
            .setLabel(r.name.slice(0, 100))
            .setValue(r.id)
            .setDescription(desc.slice(0, 100));
        });
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('None of these — enter details manually')
            .setValue(MANUAL_VALUE)
            .setDescription('Fill in player count, duration, and a link yourself'),
        );
        const select = new StringSelectMenuBuilder()
          .setCustomId(withExpansions ? 'game_select_exp' : 'game_select')
          .setPlaceholder('Choose the correct game...')
          .addOptions(options);
        return {
          content: `Couldn't reach BGG right now, but found **${catalogResults.length}** match(es) in our local catalog — pick the one you mean:`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        };
      }
    }

    const content = fromLibraryDismiss
      ? `No BGG results for **"${title}"**. Enter details manually:`
      : bggFailed
        ? `Couldn't reach the game database. Enter the details manually:`
        : `No results found for **"${title}"**. Enter the details manually:`;
    return { content, components: [manualEntryButton(title)] };
  }

  bggPageSessions.set(userId, {
    results,
    withExpansions,
    fromLibraryDismiss,
    title,
    pageIndex: 0,
  });
  return renderBGGPage(userId);
}

// ── Suggest ───────────────────────────────────────────────────────────────────

async function handleSuggest(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString('title', true);
  const withExpansions = interaction.options.getBoolean('with_expansions') ?? false;

  // Suggesting from inside a private room always uses that room directly — there's no picker
  // (you can't suggest into a room from outside it), and attendance checks against the room's
  // members instead of an event's RSVPs.
  const room = await findRoomByChannel(interaction.channelId!);
  if (room) {
    await resolveSuggestFlow(interaction, roomToGameNightAdapter(room), title, withExpansions);
    return;
  }

  const now = new Date();
  const upcoming = (await loadGameNights())
    .filter(
      (gn) =>
        !gn.cancelled && !gn.archived && gn.eventChannelId && new Date(gn.startTimeISO) > now,
    )
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.reply({
      content: 'There are no upcoming events with channels to add games to.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // If the command is used inside an event channel, skip the picker and use that event directly.
  const channelMatch = upcoming.find((gn) => gn.eventChannelId === interaction.channelId);
  if (channelMatch) {
    pendingEventContext.set(interaction.user.id, channelMatch.id);
    // fall through with channelMatch as the resolved event
  } else {
    // Outside an event channel — always show the picker, even with a single upcoming event.
    // Selecting an option is what records pendingEventContext (see handleEventSelect); skipping
    // this step for the single-event case left later steps (tag picker, expansion select, bring
    // confirm) unable to resolve the event, since they look it up by channel or pendingEventContext.
    //
    // The title/withExpansions the user just typed are encoded directly into this select menu's
    // customId (rather than an in-memory Map keyed by userId) so the flow survives a bot
    // redeploy/restart between "pick a game" and "pick an event" — a plain in-process map has no
    // persisted backing and silently loses the pending suggestion if the process restarts, or if
    // the same user starts a second /game suggest before finishing the first.
    const options = await Promise.all(
      upcoming.map(async (gn) => {
        const alreadySuggested = (await findGamesByEvent(gn.id)).some(
          (g) => g.title.toLowerCase() === title.toLowerCase(),
        );
        const desc = `${alreadySuggested ? '⚠️ already suggested · ' : ''}${gn.time} @ ${gn.location || 'TBD'}`.slice(0, 100);
        return new StringSelectMenuOptionBuilder()
          .setLabel(gn.date.slice(0, 100))
          .setValue(gn.id)
          .setDescription(desc);
      }),
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeEventSelectCustomId(title, withExpansions))
      .setPlaceholder('Choose an event...')
      .addOptions(options);
    await interaction.reply({
      content: `Which event would you like to suggest **"${title}"** for?`,
      flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  const gameNight = channelMatch ?? upcoming[0];
  await resolveSuggestFlow(interaction, gameNight, title, withExpansions);
}

// Shared by both the event-channel/event-picker path and the private-room path above — resolves
// a library match, partial match, or falls through to a BGG search, once we already know which
// GameNight (real or room-adapted) the suggestion is going into.
async function resolveSuggestFlow(
  interaction: ChatInputCommandInteraction,
  gameNight: GameNight,
  title: string,
  withExpansions: boolean,
): Promise<void> {
  if (isLineupLocked(gameNight)) {
    await interaction.reply({ content: LOCK_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  // Check the group library — exact match first
  const libraryMatches = await findGamesByName(interaction.guildId!, title);
  if (libraryMatches.length > 0) {
    const info = await getGameInfo(title);
    const ownerIds = libraryMatches.map((e) => e.userId);
    if (withExpansions && info?.objectid) {
      await showLibraryExpansionPicker(
        interaction,
        gameNight,
        libraryMatches[0].gameName,
        info,
        ownerIds,
      );
    } else {
      await postLibraryGame(
        interaction,
        gameNight,
        libraryMatches[0].gameName,
        info ?? null,
        ownerIds,
        [],
      );
    }
    return;
  }

  // Partial match in library — prompt user to confirm which game
  const partials = await findGameNamesByPartial(interaction.guildId!, title);
  if (partials.length > 0 && partials.length <= 25) {
    const options = partials.map((name) =>
      new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name),
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Search BGG instead')
        .setValue(BGG_VALUE)
        .setDescription('Search the BoardGameGeek database for this title'),
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('library_suggest_select')
      .setPlaceholder('Pick a match from the library...')
      .addOptions(options);
    pendingLibrarySuggest.set(interaction.user.id, { title, withExpansions });
    await interaction.reply({
      content: `**"${title}"** wasn't an exact match — found ${partials.length} partial match${partials.length !== 1 ? 'es' : ''} in the library:`,
      flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildBGGSearchReply(interaction.user.id, title, withExpansions));
}

// ── Event picker: continues suggest flow after user picks which event ─────────

export const EVENT_SELECT_PREFIX = 'game_event_select';

// Encodes the in-progress suggestion directly into the select menu's customId
// instead of a server-side Map, so nothing is lost if the bot restarts between
// interaction steps. Discord customIds cap out at 100 chars; realistic game
// titles fit comfortably, and in the rare case one doesn't, it's truncated the
// same way titles already are elsewhere (e.g. embed labels sliced to 100).
export function encodeEventSelectCustomId(title: string, withExpansions: boolean): string {
  return `${EVENT_SELECT_PREFIX}|${withExpansions ? 1 : 0}|${title}`.slice(0, 100);
}

export function decodeEventSelectCustomId(customId: string): {
  title: string;
  withExpansions: boolean;
} {
  const [, flag, ...titleParts] = customId.split('|');
  return { title: titleParts.join('|'), withExpansions: flag === '1' };
}

export async function handleEventSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const eventId = interaction.values[0];
  const { title, withExpansions } = decodeEventSelectCustomId(interaction.customId);

  const gameNight = (await loadGameNights()).find(
    (gn) => gn.id === eventId && !gn.cancelled && !gn.archived,
  );
  if (!gameNight) {
    await interaction.update({ content: 'That event is no longer available.', components: [] });
    return;
  }
  if (isLineupLocked(gameNight)) {
    await interaction.update({ content: LOCK_MESSAGE, components: [] });
    return;
  }

  pendingEventContext.set(interaction.user.id, eventId);

  const libraryMatches = await findGamesByName(interaction.guildId!, title);
  if (libraryMatches.length > 0) {
    const info = await getGameInfo(title);
    const ownerIds = libraryMatches.map((e) => e.userId);
    if (withExpansions && info?.objectid) {
      await showLibraryExpansionPicker(
        interaction,
        gameNight,
        libraryMatches[0].gameName,
        info,
        ownerIds,
      );
    } else {
      await postLibraryGame(
        interaction,
        gameNight,
        libraryMatches[0].gameName,
        info ?? null,
        ownerIds,
        [],
      );
    }
    return;
  }

  const partials = await findGameNamesByPartial(interaction.guildId!, title);
  if (partials.length > 0 && partials.length <= 25) {
    const options = partials.map((name) =>
      new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name),
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Search BGG instead')
        .setValue(BGG_VALUE)
        .setDescription('Search the BoardGameGeek database for this title'),
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('library_suggest_select')
      .setPlaceholder('Pick a match from the library...')
      .addOptions(options);
    pendingLibrarySuggest.set(interaction.user.id, { title, withExpansions });
    await interaction.update({
      content: `**"${title}"** wasn't an exact match — found ${partials.length} partial match${partials.length !== 1 ? 'es' : ''} in the library:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  await interaction.deferUpdate();
  await interaction.editReply(await buildBGGSearchReply(interaction.user.id, title, withExpansions));
}

function buildTagPickerComponents(gameId: string) {
  const tagOptions = GAME_TAGS.map((tag) =>
    new StringSelectMenuOptionBuilder().setLabel(tag).setValue(tag),
  );
  const tagSelect = new StringSelectMenuBuilder()
    .setCustomId(`game_tags_${gameId}`)
    .setPlaceholder('Select types/mechanics...')
    .setMinValues(1)
    .setMaxValues(GAME_TAGS.length)
    .addOptions(tagOptions);
  const skipBtn = new ButtonBuilder()
    .setCustomId(`game_tags_skip_${gameId}`)
    .setLabel('Skip')
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tagSelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(skipBtn),
  ];
}

function bringGameRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('game_bring_confirm')
      .setLabel("Yes, I'll bring it")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('game_bring_cancel')
      .setLabel('No')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── List scheduled games ──────────────────────────────────────────────────────

async function handleGameList(interaction: ChatInputCommandInteraction): Promise<void> {
  const isEventChannel = (await loadGameNights()).some(
    (gn) => !gn.cancelled && !gn.archived && gn.eventChannelId === interaction.channelId,
  );
  if (!isEventChannel) {
    await interaction.reply({
      content:
        "Use `/game list` inside an event channel to see that event's game lineup. Try `/event list` to see upcoming events.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const games = await findGamesByChannel(interaction.channelId!);

  if (games.length === 0) {
    await interaction.reply({
      content: 'No games have been added to the lineup yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = games.map((g) => {
    const link = `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
    const players = `${g.minPlayers}–${g.maxPlayers}p`;
    const time =
      g.minPlaytime === g.maxPlaytime
        ? `${g.minPlaytime}min`
        : `${g.minPlaytime}–${g.maxPlaytime}min`;
    const seats = g.suggestedPlayers != null ? `${g.seats.length}/${g.suggestedPlayers} seated` : `${g.seats.length} seated`;
    return `**[${g.title}](${link})** — ${players} · ${time} · ${seats}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Game Lineup')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${games.length} game${games.length !== 1 ? 's' : ''} scheduled` });

  await interaction.reply({ embeds: [embed] });
}

// ── Cancel a game suggestion ──────────────────────────────────────────────────

async function handleGameCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString('title', true).trim();
  const games = await findGamesByChannel(interaction.channelId!);
  let match = games.find((g) => g.title.toLowerCase() === title.toLowerCase());

  // Fall back to a fuzzy match against the current lineup (e.g. "catan" for
  // "Settlers of Catan", or a minor typo) when there's no exact title match.
  if (!match) {
    const fuzzyMatches = games.filter((g) => matchesFuzzy(title, g.title));
    if (fuzzyMatches.length === 1) match = fuzzyMatches[0];
    else if (fuzzyMatches.length > 1) {
      const titles = fuzzyMatches.map((g) => `**${g.title}**`).join(', ');
      await interaction.reply({
        content: `**"${title}"** matches more than one game in the lineup: ${titles}. Run \`/game cancel\` again with the exact title.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (!match) {
    const titles = games.map((g) => `**${g.title}**`).join(', ');
    await interaction.reply({
      content: `No game called **"${title}"** found in the lineup.${titles ? ` Current games: ${titles}` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const gameNight = await findGameNight(match.eventId);
  const isSuggester = match.createdBy === interaction.user.id;
  const isHost = gameNight?.createdBy === interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;

  if (!isSuggester && !isHost && !isAdmin) {
    await interaction.reply({
      content: `Only the person who suggested **${match.title}**, the event host, or an admin can remove it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const channel = (await interaction.client.channels.fetch(match.channelId)) as TextChannel;
    const msg = await channel.messages.fetch(match.messageId);
    await msg.delete();
  } catch {
    /* message may already be deleted */
  }

  const remaining = (await loadGames()).filter((g) => g.id !== match.id);
  await saveGames(remaining);
  // Remove the auto-request if the canceller originally created it
  const req = (await getRequestsForEvent(match.eventId)).find(
    (r) => r.gameName.toLowerCase() === match.title.toLowerCase(),
  );
  if (req && req.requestedBy === interaction.user.id) await removeRequests([req.id]);
  try {
    await updateGameListPin(interaction.client, match.eventId);
  } catch {
    /* channel may not be accessible */
  }
  try {
    await updateRequestPin(interaction.client, match.eventId);
  } catch {
    /* channel may not be accessible */
  }

  await interaction.reply({
    content: `**${match.title}** has been removed from the lineup.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Generate a BG Stats "log play" link for a suggested game ─────────────────

async function handleGameBgStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString('title', true).trim();
  const locationOption = interaction.options.getString('location');
  const games = await findGamesByChannel(interaction.channelId!);
  const match = games.find((g) => g.title.toLowerCase() === title.toLowerCase());

  if (!match) {
    const titles = games.map((g) => `**${g.title}**`).join(', ');
    await interaction.reply({
      content: `No game called **"${title}"** found in the lineup.${titles ? ` Current games: ${titles}` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Resolving player names and generating the QR code both take a moment —
  // ack the interaction before Discord's 3-second window elapses.
  await interaction.deferReply();

  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  const location = locationOption ?? gameNight?.location ?? '';

  const nameMap = await resolvePlayerNames(interaction.client, interaction.guildId!, match.seats);
  const url = buildBgStatsPlayUrl({
    gameName: match.title,
    bggId: match.bggId,
    location,
    players: match.seats.map((id) => ({ name: nameMap[id] ?? id, sourcePlayerId: id })),
    sourcePlayId: match.id,
    playDate: new Date(),
  });

  // With SHORT_LINK_BASE_URL configured this always fits (see bgStats.ts);
  // otherwise it falls back to the same length-check as before. The QR code
  // has no length limit either way, so it's the reliable fallback — but it
  // still scans more easily off the short link when one exists.
  const buttonUrl = await buildBgStatsButtonUrl(url);
  const qrFilename = `bgstats-${match.id}.png`;
  const qrAttachment = await buildBgStatsQrAttachment(buttonUrl ?? url, qrFilename);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${match.title}`)
    .setDescription(
      buttonUrl
        ? 'Tap the button or scan the QR code to log this play in BG Stats.'
        : 'Scan the QR code to log this play in BG Stats (too many players for a tappable link).',
    )
    .addFields({
      name: 'Players',
      value: match.seats.map((id) => nameMap[id] ?? id).join('\n') || '*(no seats defined)*',
    })
    .setColor(0xe8a838)
    .setImage(`attachment://${qrFilename}`);

  await interaction.editReply({
    embeds: [embed],
    components: buttonUrl ? [buildBgStatsButton(buttonUrl)] : [],
    files: [qrAttachment],
  });
}

export async function handleHostGameCancel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const title = interaction.options.getString('title', true).trim();
  const games = await findGamesByChannel(interaction.channelId!);
  let match = games.find((g) => g.title.toLowerCase() === title.toLowerCase());

  // Fall back to a fuzzy match against the current lineup (e.g. "catan" for
  // "Settlers of Catan", or a minor typo) when there's no exact title match.
  if (!match) {
    const fuzzyMatches = games.filter((g) => matchesFuzzy(title, g.title));
    if (fuzzyMatches.length === 1) match = fuzzyMatches[0];
    else if (fuzzyMatches.length > 1) {
      const titles = fuzzyMatches.map((g) => `**${g.title}**`).join(', ');
      await interaction.reply({
        content: `**"${title}"** matches more than one game in the lineup: ${titles}. Run \`/host game cancel\` again with the exact title.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (!match) {
    const titles = games.map((g) => `**${g.title}**`).join(', ');
    await interaction.reply({
      content: `No game called **"${title}"** found in the lineup.${titles ? ` Current games: ${titles}` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const channel = (await interaction.client.channels.fetch(match.channelId)) as TextChannel;
    const msg = await channel.messages.fetch(match.messageId);
    await msg.delete();
  } catch {
    /* message may already be deleted */
  }

  const remaining = (await loadGames()).filter((g) => g.id !== match.id);
  await saveGames(remaining);
  // Remove the auto-request if the original suggestor created it
  const hostReq = (await getRequestsForEvent(match.eventId)).find(
    (r) => r.gameName.toLowerCase() === match.title.toLowerCase(),
  );
  if (hostReq && hostReq.requestedBy === match.createdBy) await removeRequests([hostReq.id]);
  try {
    await updateGameListPin(interaction.client, match.eventId);
  } catch {
    /* channel may not be accessible */
  }
  try {
    await updateRequestPin(interaction.client, match.eventId);
  } catch {
    /* channel may not be accessible */
  }

  await interaction.reply({
    content: `**${match.title}** has been removed from the lineup.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Library match: expansion picker ──────────────────────────────────────────

async function showLibraryExpansionPicker(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  gameNight: GameNight,
  gameName: string,
  info: GameInfo,
  ownerIds: string[],
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferUpdate();
  }

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(info.objectid!);
  } catch {
    await postLibraryGame(interaction, gameNight, gameName, info, ownerIds, []);
    return;
  }

  if (bggGame.expansions.length === 0) {
    await postLibraryGame(interaction, gameNight, gameName, info, ownerIds, []);
    return;
  }

  pendingLibraryGame.set(interaction.user.id, { gameName, info, ownerIds });

  const options = bggGame.expansions.map((exp) =>
    new StringSelectMenuOptionBuilder().setLabel(exp.name.slice(0, 100)).setValue(exp.id),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`game_exp_lib_${info.objectid}`)
    .setPlaceholder('Select one or more expansions...')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);
  await interaction.editReply({
    content: `**${gameName}** has **${bggGame.expansions.length}** expansion(s). Select any to include:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

export async function handleLibraryExpansionSelect(
  interaction: StringSelectMenuInteraction,
  bggId: string,
): Promise<void> {
  const pending = pendingLibraryGame.get(interaction.user.id);
  pendingLibraryGame.delete(interaction.user.id);

  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({
      content: 'This event channel is no longer active.',
      components: [],
    });
    return;
  }
  if (!pending) {
    await interaction.update({
      content: 'Session expired. Please try suggesting the game again.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  let selectedExpansions: GameExpansion[] = [];
  if (interaction.values.length > 0) {
    try {
      const bggGame = await getBGGGame(bggId);
      selectedExpansions = bggGame.expansions
        .filter((e) => interaction.values.includes(e.id))
        .map((e) => ({ id: e.id, name: e.name }));
    } catch {
      /* proceed without expansions if BGG is unreachable */
    }
  }

  await postLibraryGame(
    interaction,
    gameNight,
    pending.gameName,
    pending.info,
    pending.ownerIds,
    selectedExpansions,
  );
}

// ── Library match: post directly ──────────────────────────────────────────────

async function postLibraryGame(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  gameNight: GameNight,
  gameName: string,
  info: GameInfo | null,
  ownerIds: string[],
  expansions: GameExpansion[],
): Promise<void> {
  const duplicate = await findDuplicateGame(gameNight.id, gameName);
  if (duplicate) {
    const msg = duplicateReply(duplicate);
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.update({ content: msg, components: [] });
    }
    return;
  }

  const ownerAttending = ownerIds.some(
    (id) => gameNight.rsvps.yes.includes(id) || gameNight.rsvps.maybe.includes(id),
  );
  if (!ownerAttending) {
    const msg = `None of the owners of **${gameName}** are attending this event, so it can't be suggested.`;
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.update({ content: msg, components: [] });
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferUpdate();
    }
  }

  if (info?.objectid) {
    await enrichFromBGG(gameName, false);
    info = (await getGameInfo(gameName)) ?? info;
  }

  const complexity = info?.complexity ?? undefined;
  const violation = greeterSeatViolation(gameNight, { complexity, seats: [], waitlist: [] }, interaction.user.id);
  if (violation) {
    await interaction.editReply({ content: violation, components: [] });
    return;
  }

  const minPlayers = info?.minPlayers ?? 2;
  const maxPlayers = info?.maxPlayers ?? 4;
  const playTime = info?.playTime ?? 60;
  const objectid = info?.objectid;
  const bggLink = objectid ? `https://boardgamegeek.com/boardgame/${objectid}` : '';

  const eventChannelId = gameNight.eventChannelId ?? interaction.channelId!;
  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: eventChannelId,
    messageId: '',
    guildId: interaction.guildId!,
    bggId: objectid ?? '',
    title: gameName,
    bggLink,
    minPlayers,
    maxPlayers,
    suggestedPlayers: Math.ceil((minPlayers + maxPlayers) / 2),
    minPlaytime: playTime,
    maxPlaytime: playTime,
    suggestedStartTime: null,
    tags: info?.tags ?? [],
    complexity,
    howToPlayUrl: info?.howToPlayUrl ?? null,
    thumbnail: info?.thumbnail ?? null,
    expansions,
    seats: [interaction.user.id],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = (await interaction.client.channels.fetch(eventChannelId)) as TextChannel;
  const owners = ownerIds.map((id) => `<@${id}>`).join(', ');
  const msg = await channel.send({
    content: `Owned by: ${owners}`,
    embeds: [await buildGameEmbed(game, {})],
    files: [buildBggAttachment()],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  await upsertGame(game);

  // "Bring to event"/lineup-pin tracking doesn't apply to a private room — it's an ad-hoc
  // space happening now, not a future event to request games for.
  if (!isRoomGameNight(gameNight)) {
    await addRequest(gameNight.id, gameName, interaction.user.id);
    try {
      await updateRequestPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
    try {
      await updateGameListPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
  }
  pendingEventContext.delete(interaction.user.id);

  if (!game.tags?.length) {
    await interaction.editReply({
      content: `**${gameName}** has been added! Optionally tag the game type to help players find it:`,
      components: buildTagPickerComponents(id),
    });
  } else {
    await interaction.editReply({
      content: `**${gameName}** has been added to the lineup!`,
      components: [],
    });
  }
}

// ── Library partial-match select ──────────────────────────────────────────────

export async function handleLibrarySuggestSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const value = interaction.values[0];
  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({
      content: 'This event channel is no longer active.',
      components: [],
    });
    return;
  }

  if (value === BGG_VALUE) {
    const pending = pendingLibrarySuggest.get(interaction.user.id);
    pendingLibrarySuggest.delete(interaction.user.id);
    const title = pending?.title ?? '';
    const withExpansions = pending?.withExpansions ?? false;
    await interaction.deferUpdate();
    await interaction.editReply(await buildBGGSearchReply(interaction.user.id, title, withExpansions, true));
    return;
  }

  // Library game selected
  const libPending = pendingLibrarySuggest.get(interaction.user.id);
  pendingLibrarySuggest.delete(interaction.user.id);
  const withExpansions = libPending?.withExpansions ?? false;

  const libraryMatches = await findGamesByName(interaction.guildId!, value);
  const info = await getGameInfo(value);
  const ownerIds = libraryMatches.map((e) => e.userId);

  if (withExpansions && info?.objectid) {
    await showLibraryExpansionPicker(interaction, gameNight, value, info, ownerIds);
  } else {
    await postLibraryGame(interaction, gameNight, value, info ?? null, ownerIds, []);
  }
}

// ── Select: no expansions ─────────────────────────────────────────────────────

export async function handleGameSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({
      content: 'This event channel is no longer active.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(bggId);
  } catch {
    await interaction.editReply({
      content: 'Could not fetch game details. Try entering manually.',
      components: [],
    });
    return;
  }

  await postBGGGame(interaction, gameNight, bggGame, []);
}

// ── Select: with expansions ───────────────────────────────────────────────────

export async function handleGameSelectWithExp(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({
      content: 'This event channel is no longer active.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(bggId);
  } catch {
    await interaction.editReply({
      content: 'Could not fetch game details. Try entering manually.',
      components: [],
    });
    return;
  }

  if (bggGame.expansions.length === 0) {
    await postBGGGame(interaction, gameNight, bggGame, []);
    return;
  }

  const options = bggGame.expansions.map((exp) =>
    new StringSelectMenuOptionBuilder().setLabel(exp.name.slice(0, 100)).setValue(exp.id),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`game_exp_${bggId}`)
    .setPlaceholder('Select one or more expansions...')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);

  await interaction.editReply({
    content: `**${bggGame.name}** has **${bggGame.expansions.length}** expansion(s). Select any to include:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

// ── Select: expansions confirmed ──────────────────────────────────────────────

export async function handleExpansionSelect(
  interaction: StringSelectMenuInteraction,
  bggId: string,
): Promise<void> {
  const gameNight = await findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({
      content: 'This event channel is no longer active.',
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(bggId);
  } catch {
    await interaction.editReply({ content: 'Could not fetch game details.', components: [] });
    return;
  }

  const selectedExpansions = bggGame.expansions.filter((e) => interaction.values.includes(e.id));
  await postBGGGame(interaction, gameNight, bggGame, selectedExpansions);
}

// ── Manual entry button → show modal ─────────────────────────────────────────

export async function handleManualBtn(interaction: ButtonInteraction): Promise<void> {
  const prefill = decodeURIComponent(interaction.customId.slice('game_manual_'.length));
  await showManualEntryModal(interaction, prefill);
}

// ── Modal submission ──────────────────────────────────────────────────────────

export async function handleManualGameSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const active = (await loadGameNights()).filter((gn) => !gn.cancelled && !gn.archived);
  const gameNight =
    active.find((gn) => gn.eventChannelId === interaction.channelId) ??
    active.find((gn) => gn.id === pendingEventContext.get(interaction.user.id));
  if (!gameNight) {
    await interaction.reply({
      content: 'This event channel is no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.fields.getTextInputValue('title').trim();

  const duplicate = await findDuplicateGame(gameNight.id, title);
  if (duplicate) {
    await interaction.editReply({ content: duplicateReply(duplicate), components: [] });
    return;
  }

  const playersRaw = interaction.fields.getTextInputValue('players').trim();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const bggLink = interaction.fields.getTextInputValue('link_rules').trim();
  const howToPlayUrl = interaction.fields.getTextInputValue('link_howtoplay').trim() || null;

  const { min: minPlayers, max: maxPlayers } = parseRange(playersRaw, 2, 4);
  const { min: minPlaytime, max: maxPlaytime } = parseRange(durationRaw, 30, 60);

  const eventChannelId = gameNight.eventChannelId ?? interaction.channelId!;
  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: eventChannelId,
    messageId: '',
    guildId: interaction.guildId!,
    bggId: '',
    title,
    bggLink,
    howToPlayUrl,
    minPlayers,
    maxPlayers,
    suggestedPlayers: null,
    minPlaytime,
    maxPlaytime,
    suggestedStartTime: null,
    tags: [],
    expansions: [],
    seats: [interaction.user.id],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = (await interaction.client.channels.fetch(eventChannelId)) as TextChannel;
  const msg = await channel.send({
    embeds: [await buildGameEmbed(game, {})],
    files: [buildBggAttachment()],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  await upsertGame(game);

  if (!isRoomGameNight(gameNight)) {
    await addRequest(gameNight.id, title, interaction.user.id);
    try {
      await updateRequestPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
    try {
      await updateGameListPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
  }
  pendingEventContext.delete(interaction.user.id);

  pendingBrings.set(interaction.user.id, { gameName: title, eventId: gameNight.id });
  await interaction.editReply({
    content: `**${title}** has been added! Optionally tag the game type to help players find it:`,
    components: buildTagPickerComponents(id),
  });
}

// ── Button: Join / Leave ──────────────────────────────────────────────────────

export async function handleGameJoin(
  interaction: ButtonInteraction,
  gameId: string,
): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = await findGame(gameId);
  if (!game) {
    await interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
    return;
  }
  const gameNight = await findGameNight(game.eventId);
  if (gameNight && isLineupLocked(gameNight)) {
    await interaction.reply({ content: LOCK_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = interaction.user.id;
  if (gameNight) {
    const violation = greeterSeatViolation(gameNight, game, userId);
    if (violation) {
      await interaction.reply({ content: violation, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  if (game.seats.includes(userId)) {
    await interaction.reply({ content: "You're already in this game.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (game.seats.length >= game.maxPlayers) {
    await interaction.reply({ content: 'This game is full.', flags: MessageFlags.Ephemeral });
    return;
  }

  game.seats.push(userId);
  await save(game);
  try {
    await updateGameListPin(interaction.client, game.eventId);
  } catch {
    /* no event channel */
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...(game.waitlist ?? [])]);
  await interaction.update({
    embeds: [await buildGameEmbed(game, nameMap)],
    files: [buildBggAttachment()],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

export async function handleGameLeave(
  interaction: ButtonInteraction,
  gameId: string,
): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = await findGame(gameId);
  if (!game) {
    await interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
    return;
  }
  const gameNight = await findGameNight(game.eventId);
  if (gameNight && isLineupLocked(gameNight)) {
    await interaction.reply({ content: LOCK_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = interaction.user.id;
  if (!game.seats.includes(userId)) {
    await interaction.reply({ content: "You're not in this game.", flags: MessageFlags.Ephemeral });
    return;
  }

  game.seats = game.seats.filter((id) => id !== userId);

  const waitlist = game.waitlist ?? [];
  const prevHadGroup2 = waitlist.length >= game.minPlayers;
  const promotedUserId = game.seats.length < game.maxPlayers ? waitlist[0] : undefined;
  if (promotedUserId) {
    game.seats.push(promotedUserId);
    game.waitlist = waitlist.slice(1);
  }
  await save(game);

  if (promotedUserId) {
    const nowHasGroup2 = (game.waitlist ?? []).length >= game.minPlayers;
    if (prevHadGroup2 && !nowHasGroup2) {
      await updateRequestCopies(game.eventId, game.title, 1);
      try {
        await updateRequestPin(interaction.client, game.eventId);
      } catch {
        /* no event channel */
      }
    }
    try {
      const promotedUser = await interaction.client.users.fetch(promotedUserId);
      await promotedUser.send(`A seat opened up in **${game.title}** — you've been moved off the waitlist and into the game!`);
    } catch {
      /* DMs disabled */
    }
  }

  try {
    await updateGameListPin(interaction.client, game.eventId);
  } catch {
    /* no event channel */
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...(game.waitlist ?? [])]);
  await interaction.update({
    embeds: [await buildGameEmbed(game, nameMap)],
    files: [buildBggAttachment()],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function handleWaitlistJoin(
  interaction: ButtonInteraction,
  gameId: string,
): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = await findGame(gameId);
  if (!game) {
    await interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
    return;
  }
  const gameNight = await findGameNight(game.eventId);
  if (gameNight && isLineupLocked(gameNight)) {
    await interaction.reply({ content: LOCK_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = interaction.user.id;
  const waitlist = game.waitlist ?? [];

  if (gameNight) {
    const violation = greeterSeatViolation(gameNight, game, userId);
    if (violation) {
      await interaction.reply({ content: violation, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  if (game.seats.includes(userId)) {
    await interaction.reply({ content: "You're already in this game.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (waitlist.includes(userId)) {
    await interaction.reply({ content: "You're already on the waitlist.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (game.seats.length < game.maxPlayers) {
    await interaction.reply({
      content: "There's still an open seat — use **Join** instead.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const prevHadGroup2 = waitlist.length >= game.minPlayers;
  game.waitlist = [...waitlist, userId];
  await save(game);

  const nowHasGroup2 = game.waitlist.length >= game.minPlayers;
  if (nowHasGroup2 && !prevHadGroup2) {
    await updateRequestCopies(game.eventId, game.title, 2);
    try {
      await updateRequestPin(interaction.client, game.eventId);
    } catch {
      /* no event channel */
    }
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...game.waitlist]);
  await interaction.update({
    embeds: [await buildGameEmbed(game, nameMap)],
    files: [buildBggAttachment()],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

export async function handleWaitlistLeave(
  interaction: ButtonInteraction,
  gameId: string,
): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = await findGame(gameId);
  if (!game) {
    await interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
    return;
  }
  const gameNight = await findGameNight(game.eventId);
  if (gameNight && isLineupLocked(gameNight)) {
    await interaction.reply({ content: LOCK_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = interaction.user.id;
  const waitlist = game.waitlist ?? [];

  if (!waitlist.includes(userId)) {
    await interaction.reply({ content: "You're not on the waitlist.", flags: MessageFlags.Ephemeral });
    return;
  }

  const prevHadGroup2 = waitlist.length >= game.minPlayers;
  game.waitlist = waitlist.filter((id) => id !== userId);
  await save(game);

  const nowHasGroup2 = game.waitlist.length >= game.minPlayers;
  if (prevHadGroup2 && !nowHasGroup2) {
    await updateRequestCopies(game.eventId, game.title, 1);
    try {
      await updateRequestPin(interaction.client, game.eventId);
    } catch {
      /* no event channel */
    }
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...game.waitlist]);
  await interaction.update({
    embeds: [await buildGameEmbed(game, nameMap)],
    files: [buildBggAttachment()],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function manualEntryButton(title: string): ActionRowBuilder<ButtonBuilder> {
  const encoded = encodeURIComponent(title).slice(0, 80);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`game_manual_${encoded}`)
      .setLabel('Enter Game Details Manually')
      .setStyle(ButtonStyle.Primary),
  );
}

async function showManualEntryModal(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  prefillTitle: string,
): Promise<void> {
  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Game Title')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Wingspan')
    .setRequired(true);

  if (prefillTitle) titleInput.setValue(prefillTitle.slice(0, 100));

  const modal = new ModalBuilder()
    .setCustomId('game_manual')
    .setTitle('Add a Game to the Lineup')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('players')
          .setLabel('Player count (e.g. 2-5 or 4)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('2-5')
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Duration in minutes (e.g. 45-90 or 60)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('45-90')
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('link_rules')
          .setLabel('Rules / BGG link (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://boardgamegeek.com/...')
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('link_howtoplay')
          .setLabel('How-to-play video (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://youtube.com/...')
          .setRequired(false),
      ),
    );

  await interaction.showModal(modal);
}

async function postBGGGame(
  interaction: StringSelectMenuInteraction,
  gameNight: GameNight,
  bggGame: BGGGame,
  expansions: BGGExpansion[],
): Promise<void> {
  const duplicate = await findDuplicateGame(gameNight.id, bggGame.name);
  if (duplicate) {
    await interaction.editReply({ content: duplicateReply(duplicate), components: [] });
    return;
  }

  const complexity = bggGame.weight != null ? weightTag(bggGame.weight) : undefined;
  const violation = greeterSeatViolation(gameNight, { complexity, seats: [], waitlist: [] }, interaction.user.id);
  if (violation) {
    await interaction.editReply({ content: violation, components: [] });
    return;
  }

  const eventChannelId = gameNight.eventChannelId ?? interaction.channelId;
  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: eventChannelId,
    messageId: '',
    guildId: interaction.guildId!,
    bggId: bggGame.id,
    title: bggGame.name,
    bggLink: bggGame.bggLink,
    minPlayers: bggGame.minPlayers,
    maxPlayers: bggGame.maxPlayers,
    suggestedPlayers: bggGame.suggestedPlayers,
    minPlaytime: bggGame.minPlaytime,
    maxPlaytime: bggGame.maxPlaytime,
    suggestedStartTime: null,
    tags: bggGame.tags,
    complexity,
    howToPlayUrl: bggGame.howToPlayUrl,
    thumbnail: bggGame.thumbnail,
    expansions: expansions.map((e) => ({ id: e.id, name: e.name }) as GameExpansion),
    seats: [interaction.user.id],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = (await interaction.client.channels.fetch(eventChannelId)) as TextChannel;
  const msg = await channel.send({
    embeds: [await buildGameEmbed(game, {})],
    files: [buildBggAttachment()],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  await upsertGame(game);

  // Persist auto-detected BGG tags to GameInfo so future suggestions of this game get tags
  if (bggGame.tags.length > 0) {
    const existingInfo = await getGameInfo(bggGame.name);
    if (!existingInfo?.tags?.length) {
      await upsertGameInfo({
        gameName: bggGame.name,
        objectid: bggGame.id,
        minPlayers: existingInfo?.minPlayers ?? bggGame.minPlayers,
        maxPlayers: existingInfo?.maxPlayers ?? bggGame.maxPlayers,
        playTime: existingInfo?.playTime ?? bggGame.maxPlaytime,
        tags: bggGame.tags,
        expansions: existingInfo?.expansions,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (!isRoomGameNight(gameNight)) {
    await addRequest(gameNight.id, bggGame.name, interaction.user.id);
    try {
      await updateRequestPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
    try {
      await updateGameListPin(interaction.client, gameNight.id);
    } catch {
      /* channel may not be accessible */
    }
  }
  pendingEventContext.delete(interaction.user.id);

  const expNote = expansions.length > 0 ? ` with ${expansions.length} expansion(s)` : '';
  pendingBrings.set(interaction.user.id, { gameName: bggGame.name, objectid: bggGame.id, eventId: gameNight.id });
  if (bggGame.tags.length === 0) {
    await interaction.editReply({
      content: `**${bggGame.name}**${expNote} has been added! Tag the game type to help players find it:`,
      components: buildTagPickerComponents(id),
    });
  } else {
    await interaction.editReply({
      content: `**${bggGame.name}**${expNote} has been added to the lineup! Will you be bringing this game?`,
      components: [bringGameRow()],
    });
  }
}

// ── Tag picker handlers ───────────────────────────────────────────────────────

export async function handleGameTagSelect(
  interaction: StringSelectMenuInteraction,
  gameId: string,
): Promise<void> {
  const tags = interaction.values;
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = await findGame(gameId);
  if (game) {
    game.tags = tags;
    await save(game);
    const existingInfo = await getGameInfo(game.title);
    await upsertGameInfo({
      gameName: game.title,
      objectid: existingInfo?.objectid ?? (game.bggId || undefined),
      minPlayers: existingInfo?.minPlayers,
      maxPlayers: existingInfo?.maxPlayers,
      playTime: existingInfo?.playTime,
      tags,
      expansions: existingInfo?.expansions,
      updatedAt: new Date().toISOString(),
    });
    try {
      const cardChannel = (await interaction.client.channels.fetch(game.channelId)) as TextChannel;
      const cardMsg = await cardChannel.messages.fetch(game.messageId);
      await cardMsg.edit({
        embeds: [await buildGameEmbed(game, {})],
        files: [buildBggAttachment()],
        components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
      });
    } catch {
      /* card may have been deleted */
    }
  }
  const pending = pendingBrings.get(interaction.user.id);
  if (pending) {
    await interaction.update({
      content: `Tags saved! Will you be bringing **${pending.gameName}**?`,
      components: [bringGameRow()],
    });
  } else {
    await interaction.update({ content: 'Tags added to the game card!', components: [] });
  }
}

export async function handleGameTagSkip(
  interaction: ButtonInteraction,
  _gameId: string,
): Promise<void> {
  const pending = pendingBrings.get(interaction.user.id);
  if (pending) {
    await interaction.update({
      content: `Will you be bringing **${pending.gameName}**?`,
      components: [bringGameRow()],
    });
  } else {
    await interaction.update({ content: 'All done!', components: [] });
  }
}

function parseRange(
  input: string,
  defaultMin: number,
  defaultMax: number,
): { min: number; max: number } {
  const rangeMatch = input.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const singleMatch = input.match(/(\d+)/);
  if (singleMatch) {
    const n = Number(singleMatch[1]);
    return { min: n, max: n };
  }
  return { min: defaultMin, max: defaultMax };
}

async function resolveNames(
  interaction: ButtonInteraction,
  userIds: string[],
): Promise<Record<string, string>> {
  const nameMap: Record<string, string> = {};
  if (!interaction.guild) return nameMap;
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const member = await interaction.guild!.members.fetch(id);
        nameMap[id] = member.displayName;
      } catch {
        /* fall back to mention */
      }
    }),
  );
  return nameMap;
}

export async function handleBringConfirm(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingBrings.get(interaction.user.id);
  if (!pending) {
    await interaction.update({ content: 'This prompt has expired.', components: [] });
    return;
  }
  pendingBrings.delete(interaction.user.id);
  await addGame(interaction.guildId!, interaction.user.id, pending.gameName, pending.objectid);
  // confirmBring checks library ownership — addGame above ensures it passes
  const confirmed = await confirmBring(interaction.guildId!, pending.eventId, pending.gameName, interaction.user.id);
  if (confirmed === 'confirmed') {
    try {
      await updateRequestPin(interaction.client, pending.eventId);
    } catch {
      /* channel may not be accessible */
    }
  }
  await interaction.update({
    content: `Got it! **${pending.gameName}** has been added to your library and you're confirmed to bring it.`,
    components: [],
  });
}

export async function handleBringCancel(interaction: ButtonInteraction): Promise<void> {
  pendingBrings.delete(interaction.user.id);
  await interaction.update({
    content: 'No problem — the game has still been added to the lineup.',
    components: [],
  });
}
