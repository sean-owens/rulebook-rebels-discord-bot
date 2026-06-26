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
} from 'discord.js';
import { randomUUID } from 'crypto';
import { searchBGG, getBGGGame, BGGGame, BGGExpansion, BGGSearchResult } from '../utils/bgg';
import { searchCatalog, isCatalogLoaded } from '../utils/bggCatalog';
import { loadGames, saveGames, upsertGame, GameSuggestion, GameExpansion, findGamesByChannel } from '../utils/gameStorage';
import { buildGameEmbed, buildGameButtons } from '../utils/gameEmbeds';
import { loadGameNights, GameNight } from '../utils/storage';
import { findGamesByName, findGameNamesByPartial, getGameInfo, upsertGameInfo, addGame, addRequest, updateRequestCopies, GameInfo, GAME_TAGS } from '../utils/libraryStorage';
import { updateRequestPin, updateGameListPin } from '../utils/requestPin';

const MANUAL_VALUE = '__manual__';
const BGG_VALUE = '__bgg__';

function findDuplicateGame(eventId: string, title: string): GameSuggestion | undefined {
  return loadGames().find(
    g => g.eventId === eventId && g.title.toLowerCase() === title.toLowerCase()
  );
}

function duplicateReply(game: GameSuggestion): string {
  const link = `https://discord.com/channels/${game.guildId}/${game.channelId}/${game.messageId}`;
  return `**${game.title}** is already in the lineup! [Jump to the existing card](${link})`;
}

interface PendingBring {
  gameName: string;
  objectid?: string;
}
const pendingBrings = new Map<string, PendingBring>();

interface PendingLibrarySuggest {
  title: string;
  withExpansions: boolean;
}
const pendingLibrarySuggest = new Map<string, PendingLibrarySuggest>();

// Stores the selected eventId for users suggesting from outside an event channel
const pendingEventContext = new Map<string, string>();

// Stores suggest intent while the user picks which event to add to
const pendingEventSuggest = new Map<string, { title: string; withExpansions: boolean }>();

export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Suggest a game to play at a game night event')
  .addSubcommand(sub =>
    sub
      .setName('suggest')
      .setDescription('Search for a game and add it to this event channel')
      .addStringOption(opt =>
        opt.setName('title').setDescription('Game title to search for').setRequired(true)
      )
      .addBooleanOption(opt =>
        opt.setName('with_expansions').setDescription('Include expansions for this game?').setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName('list').setDescription('List all games scheduled for this event')
  )
  .addSubcommand(sub =>
    sub
      .setName('cancel')
      .setDescription('Remove a game suggestion from the lineup')
      .addStringOption(opt =>
        opt.setName('title').setDescription('Title of the game to remove').setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'suggest') await handleSuggest(interaction);
  else if (sub === 'list') await handleGameList(interaction);
  else if (sub === 'cancel') await handleGameCancel(interaction);
}

function findGameNightForInteraction(userId: string, channelId: string | null): GameNight | undefined {
  const active = loadGameNights().filter(gn => !gn.cancelled && !gn.archived);
  if (channelId) {
    const byChannel = active.find(gn => gn.eventChannelId === channelId);
    if (byChannel) return byChannel;
  }
  const storedId = pendingEventContext.get(userId);
  if (storedId) return active.find(gn => gn.id === storedId);
  return undefined;
}

// ── BGG search helper ─────────────────────────────────────────────────────────

interface BGGSearchReply {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

async function buildBGGSearchReply(
  title: string,
  withExpansions: boolean,
  fromLibraryDismiss = false,
): Promise<BGGSearchReply> {
  let results: BGGSearchResult[] = [];
  let bggFailed = false;
  try { results = await searchBGG(title); } catch { bggFailed = true; }

  if (results.length === 0) {
    // When BGG is unreachable, fall back to the local catalog before going to manual entry
    if (bggFailed && isCatalogLoaded()) {
      const catalogResults = searchCatalog(title, 5);
      if (catalogResults.length > 0) {
        const options = catalogResults.map(r => {
          const desc = [r.year ? `Published ${r.year}` : 'Year unknown', r.isExpansion ? 'Expansion' : '']
            .filter(Boolean).join(' • ');
          return new StringSelectMenuOptionBuilder()
            .setLabel(r.name.slice(0, 100))
            .setValue(r.id)
            .setDescription(desc.slice(0, 100));
        });
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('None of these — enter details manually')
            .setValue(MANUAL_VALUE)
            .setDescription('Fill in player count, duration, and a link yourself')
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

  const options = results.map(r =>
    new StringSelectMenuOptionBuilder()
      .setLabel(r.name.slice(0, 100))
      .setValue(r.id)
      .setDescription(r.yearPublished ? `Published ${r.yearPublished}` : 'Year unknown')
  );
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('None of these — enter details manually')
      .setValue(MANUAL_VALUE)
      .setDescription('Fill in player count, duration, and a link yourself')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(withExpansions ? 'game_select_exp' : 'game_select')
    .setPlaceholder('Choose the correct game...')
    .addOptions(options);

  const prefix = fromLibraryDismiss ? '' : `**"${title}"** wasn't found in the group library. `;
  return {
    content: `${prefix}Found **${results.length}** BGG result(s) — pick the one you mean:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

// ── Suggest ───────────────────────────────────────────────────────────────────

async function handleSuggest(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString('title', true);
  const withExpansions = interaction.options.getBoolean('with_expansions') ?? false;

  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );

  if (!gameNight) {
    const now = new Date();
    const upcoming = loadGameNights()
      .filter(gn => !gn.cancelled && !gn.archived && gn.eventChannelId && new Date(gn.startTimeISO) > now)
      .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

    if (upcoming.length === 0) {
      await interaction.reply({
        content: 'There are no upcoming events with channels to add games to.',
        ephemeral: true,
      });
      return;
    }

    pendingEventSuggest.set(interaction.user.id, { title, withExpansions });
    const options = upcoming.map(gn =>
      new StringSelectMenuOptionBuilder()
        .setLabel(gn.date.slice(0, 100))
        .setValue(gn.id)
        .setDescription(`${gn.time} @ ${gn.location || 'TBD'}`.slice(0, 100))
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('game_event_select')
      .setPlaceholder('Choose an event...')
      .addOptions(options);
    await interaction.reply({
      content: `Which event would you like to suggest **"${title}"** for?`,
      ephemeral: true,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  // Check the group library — exact match first
  const libraryMatches = findGamesByName(interaction.guildId!, title);
  if (libraryMatches.length > 0) {
    const info = getGameInfo(title);
    await postLibraryGame(interaction, gameNight, libraryMatches[0].gameName, info ?? null, libraryMatches.map(e => e.userId));
    return;
  }

  // Partial match in library — prompt user to confirm which game
  const partials = findGameNamesByPartial(interaction.guildId!, title);
  if (partials.length > 0 && partials.length <= 25) {
    const options = partials.map(name =>
      new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name)
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Search BGG instead')
        .setValue(BGG_VALUE)
        .setDescription('Search the BoardGameGeek database for this title')
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('library_suggest_select')
      .setPlaceholder('Pick a match from the library...')
      .addOptions(options);
    pendingLibrarySuggest.set(interaction.user.id, { title, withExpansions });
    await interaction.reply({
      content: `**"${title}"** wasn't an exact match — found ${partials.length} partial match${partials.length !== 1 ? 'es' : ''} in the library:`,
      ephemeral: true,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(await buildBGGSearchReply(title, withExpansions));
}

// ── Event picker: continues suggest flow after user picks which event ─────────

export async function handleEventSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const eventId = interaction.values[0];
  const pending = pendingEventSuggest.get(interaction.user.id);
  pendingEventSuggest.delete(interaction.user.id);

  const gameNight = loadGameNights().find(gn => gn.id === eventId && !gn.cancelled && !gn.archived);
  if (!gameNight) {
    await interaction.update({ content: 'That event is no longer available.', components: [] });
    return;
  }

  pendingEventContext.set(interaction.user.id, eventId);

  const title = pending?.title ?? '';
  const withExpansions = pending?.withExpansions ?? false;

  const libraryMatches = findGamesByName(interaction.guildId!, title);
  if (libraryMatches.length > 0) {
    const info = getGameInfo(title);
    await postLibraryGame(interaction, gameNight, libraryMatches[0].gameName, info ?? null, libraryMatches.map(e => e.userId));
    return;
  }

  const partials = findGameNamesByPartial(interaction.guildId!, title);
  if (partials.length > 0 && partials.length <= 25) {
    const options = partials.map(name =>
      new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name)
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Search BGG instead')
        .setValue(BGG_VALUE)
        .setDescription('Search the BoardGameGeek database for this title')
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
  await interaction.editReply(await buildBGGSearchReply(title, withExpansions));
}

function buildTagPickerComponents(gameId: string) {
  const tagOptions = GAME_TAGS.map(tag =>
    new StringSelectMenuOptionBuilder().setLabel(tag).setValue(tag)
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
  const isEventChannel = loadGameNights().some(
    gn => !gn.cancelled && !gn.archived && gn.eventChannelId === interaction.channelId
  );
  if (!isEventChannel) {
    await interaction.reply({
      content: 'Use `/game list` inside an event channel to see that event\'s game lineup. Try `/event list` to see upcoming events.',
      ephemeral: true,
    });
    return;
  }

  const games = findGamesByChannel(interaction.channelId!);

  if (games.length === 0) {
    await interaction.reply({ content: 'No games have been added to the lineup yet.', ephemeral: true });
    return;
  }

  const lines = games.map(g => {
    const link = `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
    const players = `${g.minPlayers}–${g.maxPlayers}p`;
    const time = g.minPlaytime === g.maxPlaytime ? `${g.minPlaytime}min` : `${g.minPlaytime}–${g.maxPlaytime}min`;
    const seats = `${g.seats.length}/${g.suggestedPlayers} seated`;
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
  const games = findGamesByChannel(interaction.channelId!);
  const match = games.find(g => g.title.toLowerCase() === title.toLowerCase());

  if (!match) {
    const titles = games.map(g => `**${g.title}**`).join(', ');
    await interaction.reply({
      content: `No game called **"${title}"** found in the lineup.${titles ? ` Current games: ${titles}` : ''}`,
      ephemeral: true,
    });
    return;
  }

  const canCancel =
    match.createdBy === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);

  if (!canCancel) {
    await interaction.reply({
      content: `Only the person who suggested **${match.title}** (or a moderator) can remove it.`,
      ephemeral: true,
    });
    return;
  }

  try {
    const channel = await interaction.client.channels.fetch(match.channelId) as TextChannel;
    const msg = await channel.messages.fetch(match.messageId);
    await msg.delete();
  } catch { /* message may already be deleted */ }

  const remaining = loadGames().filter(g => g.id !== match.id);
  saveGames(remaining);
  try { await updateGameListPin(interaction.client, match.eventId); } catch { /* channel may not be accessible */ }

  await interaction.reply({ content: `**${match.title}** has been removed from the lineup.`, ephemeral: true });
}

// ── Library match: post directly ──────────────────────────────────────────────

async function postLibraryGame(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  gameNight: GameNight,
  gameName: string,
  info: GameInfo | null,
  ownerIds: string[],
): Promise<void> {
  const duplicate = findDuplicateGame(gameNight.id, gameName);
  if (duplicate) {
    const msg = duplicateReply(duplicate);
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: msg, ephemeral: true });
    } else {
      await interaction.update({ content: msg, components: [] });
    }
    return;
  }

  const ownerAttending = ownerIds.some(
    id => gameNight.rsvps.yes.includes(id) || gameNight.rsvps.maybe.includes(id)
  );
  if (!ownerAttending) {
    const msg = `None of the owners of **${gameName}** are attending this event, so it can't be suggested.`;
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: msg, ephemeral: true });
    } else {
      await interaction.update({ content: msg, components: [] });
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ ephemeral: true });
  } else {
    await interaction.deferUpdate();
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
    expansions: [],
    seats: [interaction.user.id],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = await interaction.client.channels.fetch(eventChannelId) as TextChannel;
  const owners = ownerIds.map(id => `<@${id}>`).join(', ');
  const msg = await channel.send({
    content: `Owned by: ${owners}`,
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  addRequest(gameNight.id, gameName, interaction.user.id);
  try { await updateRequestPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  try { await updateGameListPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  pendingEventContext.delete(interaction.user.id);

  if (!game.tags?.length) {
    await interaction.editReply({
      content: `**${gameName}** has been added! Optionally tag the game type to help players find it:`,
      components: buildTagPickerComponents(id),
    });
  } else {
    await interaction.editReply({ content: `**${gameName}** has been added to the lineup!`, components: [] });
  }
}

// ── Library partial-match select ──────────────────────────────────────────────

export async function handleLibrarySuggestSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const value = interaction.values[0];
  const gameNight = findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({ content: 'This event channel is no longer active.', components: [] });
    return;
  }

  if (value === BGG_VALUE) {
    const pending = pendingLibrarySuggest.get(interaction.user.id);
    pendingLibrarySuggest.delete(interaction.user.id);
    const title = pending?.title ?? '';
    const withExpansions = pending?.withExpansions ?? false;
    await interaction.deferUpdate();
    await interaction.editReply(await buildBGGSearchReply(title, withExpansions, true));
    return;
  }

  // Library game selected
  const libraryMatches = findGamesByName(interaction.guildId!, value);
  const info = getGameInfo(value);
  await postLibraryGame(interaction, gameNight, value, info ?? null, libraryMatches.map(e => e.userId));
}

// ── Select: no expansions ─────────────────────────────────────────────────────

export async function handleGameSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({ content: 'This event channel is no longer active.', components: [] });
    return;
  }

  await interaction.deferUpdate();

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(bggId);
  } catch {
    await interaction.editReply({ content: 'Could not fetch game details. Try entering manually.', components: [] });
    return;
  }

  await postBGGGame(interaction, gameNight, bggGame, []);
}

// ── Select: with expansions ───────────────────────────────────────────────────

export async function handleGameSelectWithExp(interaction: StringSelectMenuInteraction): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({ content: 'This event channel is no longer active.', components: [] });
    return;
  }

  await interaction.deferUpdate();

  let bggGame: BGGGame;
  try {
    bggGame = await getBGGGame(bggId);
  } catch {
    await interaction.editReply({ content: 'Could not fetch game details. Try entering manually.', components: [] });
    return;
  }

  if (bggGame.expansions.length === 0) {
    await postBGGGame(interaction, gameNight, bggGame, []);
    return;
  }

  const options = bggGame.expansions.map(exp =>
    new StringSelectMenuOptionBuilder()
      .setLabel(exp.name.slice(0, 100))
      .setValue(exp.id)
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
  const gameNight = findGameNightForInteraction(interaction.user.id, interaction.channelId);
  if (!gameNight) {
    await interaction.update({ content: 'This event channel is no longer active.', components: [] });
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

  const selectedExpansions = bggGame.expansions.filter(e => interaction.values.includes(e.id));
  await postBGGGame(interaction, gameNight, bggGame, selectedExpansions);
}

// ── Manual entry button → show modal ─────────────────────────────────────────

export async function handleManualBtn(interaction: ButtonInteraction): Promise<void> {
  const prefill = decodeURIComponent(interaction.customId.slice('game_manual_'.length));
  await showManualEntryModal(interaction, prefill);
}

// ── Modal submission ──────────────────────────────────────────────────────────

export async function handleManualGameSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const active = loadGameNights().filter(gn => !gn.cancelled && !gn.archived);
  const gameNight = active.find(gn => gn.eventChannelId === interaction.channelId)
    ?? active.find(gn => gn.id === pendingEventContext.get(interaction.user.id));
  if (!gameNight) {
    await interaction.reply({ content: 'This event channel is no longer active.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const title = interaction.fields.getTextInputValue('title').trim();

  const duplicate = findDuplicateGame(gameNight.id, title);
  if (duplicate) {
    await interaction.editReply({ content: duplicateReply(duplicate), components: [] });
    return;
  }

  const playersRaw = interaction.fields.getTextInputValue('players').trim();
  const bestWithRaw = interaction.fields.getTextInputValue('best_with').trim();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const link = interaction.fields.getTextInputValue('link').trim();

  const { min: minPlayers, max: maxPlayers } = parseRange(playersRaw, 2, 4);
  const { min: minPlaytime, max: maxPlaytime } = parseRange(durationRaw, 30, 60);
  const suggestedPlayers = bestWithRaw && Number(bestWithRaw)
    ? Number(bestWithRaw)
    : Math.ceil((minPlayers + maxPlayers) / 2);

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
    bggLink: link,
    minPlayers,
    maxPlayers,
    suggestedPlayers,
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

  const channel = await interaction.client.channels.fetch(eventChannelId) as TextChannel;
  const msg = await channel.send({
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  addRequest(gameNight.id, title, interaction.user.id);
  try { await updateRequestPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  try { await updateGameListPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  pendingEventContext.delete(interaction.user.id);

  pendingBrings.set(interaction.user.id, { gameName: title });
  await interaction.editReply({
    content: `**${title}** has been added! Optionally tag the game type to help players find it:`,
    components: buildTagPickerComponents(id),
  });
}

// ── Button: Join / Leave ──────────────────────────────────────────────────────

export async function handleGameJoin(interaction: ButtonInteraction, gameId: string): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = findGame(gameId);
  if (!game) { await interaction.reply({ content: 'Game not found.', ephemeral: true }); return; }

  const userId = interaction.user.id;
  if (game.seats.includes(userId)) {
    await interaction.reply({ content: "You're already in this game.", ephemeral: true });
    return;
  }
  if (game.seats.length >= game.maxPlayers) {
    await interaction.reply({ content: 'This game is full.', ephemeral: true });
    return;
  }

  game.seats.push(userId);
  save(game);
  try { await updateGameListPin(interaction.client, game.eventId); } catch { /* no event channel */ }

  const nameMap = await resolveNames(interaction, [...game.seats, ...(game.waitlist ?? [])]);
  await interaction.update({
    embeds: [buildGameEmbed(game, nameMap)],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

export async function handleGameLeave(interaction: ButtonInteraction, gameId: string): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = findGame(gameId);
  if (!game) { await interaction.reply({ content: 'Game not found.', ephemeral: true }); return; }

  const userId = interaction.user.id;
  if (!game.seats.includes(userId)) {
    await interaction.reply({ content: "You're not in this game.", ephemeral: true });
    return;
  }

  game.seats = game.seats.filter(id => id !== userId);
  save(game);
  try { await updateGameListPin(interaction.client, game.eventId); } catch { /* no event channel */ }

  const nameMap = await resolveNames(interaction, [...game.seats, ...(game.waitlist ?? [])]);
  await interaction.update({
    embeds: [buildGameEmbed(game, nameMap)],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function handleWaitlistJoin(interaction: ButtonInteraction, gameId: string): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = findGame(gameId);
  if (!game) { await interaction.reply({ content: 'Game not found.', ephemeral: true }); return; }

  const userId = interaction.user.id;
  const waitlist = game.waitlist ?? [];

  if (game.seats.includes(userId)) {
    await interaction.reply({ content: "You're already in this game.", ephemeral: true });
    return;
  }
  if (waitlist.includes(userId)) {
    await interaction.reply({ content: "You're already on the waitlist.", ephemeral: true });
    return;
  }
  if (game.seats.length < game.maxPlayers) {
    await interaction.reply({ content: "There's still an open seat — use **Join** instead.", ephemeral: true });
    return;
  }

  const prevHadGroup2 = waitlist.length >= game.minPlayers;
  game.waitlist = [...waitlist, userId];
  save(game);

  const nowHasGroup2 = game.waitlist.length >= game.minPlayers;
  if (nowHasGroup2 && !prevHadGroup2) {
    updateRequestCopies(game.eventId, game.title, 2);
    try { await updateRequestPin(interaction.client, game.eventId); } catch { /* no event channel */ }
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...game.waitlist]);
  await interaction.update({
    embeds: [buildGameEmbed(game, nameMap)],
    components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
  });
}

export async function handleWaitlistLeave(interaction: ButtonInteraction, gameId: string): Promise<void> {
  const { findGame, upsertGame: save } = await import('../utils/gameStorage');
  const game = findGame(gameId);
  if (!game) { await interaction.reply({ content: 'Game not found.', ephemeral: true }); return; }

  const userId = interaction.user.id;
  const waitlist = game.waitlist ?? [];

  if (!waitlist.includes(userId)) {
    await interaction.reply({ content: "You're not on the waitlist.", ephemeral: true });
    return;
  }

  const prevHadGroup2 = waitlist.length >= game.minPlayers;
  game.waitlist = waitlist.filter(id => id !== userId);
  save(game);

  const nowHasGroup2 = game.waitlist.length >= game.minPlayers;
  if (prevHadGroup2 && !nowHasGroup2) {
    updateRequestCopies(game.eventId, game.title, 1);
    try { await updateRequestPin(interaction.client, game.eventId); } catch { /* no event channel */ }
  }

  const nameMap = await resolveNames(interaction, [...game.seats, ...game.waitlist]);
  await interaction.update({
    embeds: [buildGameEmbed(game, nameMap)],
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
      .setStyle(ButtonStyle.Primary)
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
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('best_with')
          .setLabel('Best with (optional, e.g. 4)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank to auto-calculate')
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Duration in minutes (e.g. 45-90 or 60)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('45-90')
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('link')
          .setLabel('Link — rules, how-to-play, or BGG (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://...')
          .setRequired(false)
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
  const duplicate = findDuplicateGame(gameNight.id, bggGame.name);
  if (duplicate) {
    await interaction.editReply({ content: duplicateReply(duplicate), components: [] });
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
    expansions: expansions.map(e => ({ id: e.id, name: e.name } as GameExpansion)),
    seats: [interaction.user.id],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = await interaction.client.channels.fetch(eventChannelId) as TextChannel;
  const msg = await channel.send({
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  // Persist auto-detected BGG tags to GameInfo so future suggestions of this game get tags
  if (bggGame.tags.length > 0) {
    const existingInfo = getGameInfo(bggGame.name);
    if (!existingInfo?.tags?.length) {
      upsertGameInfo({
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

  addRequest(gameNight.id, bggGame.name, interaction.user.id);
  try { await updateRequestPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  try { await updateGameListPin(interaction.client, gameNight.id); } catch { /* channel may not be accessible */ }
  pendingEventContext.delete(interaction.user.id);

  const expNote = expansions.length > 0 ? ` with ${expansions.length} expansion(s)` : '';
  pendingBrings.set(interaction.user.id, { gameName: bggGame.name, objectid: bggGame.id });
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
  const game = findGame(gameId);
  if (game) {
    game.tags = tags;
    save(game);
    const existingInfo = getGameInfo(game.title);
    upsertGameInfo({
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
      const cardChannel = await interaction.client.channels.fetch(game.channelId) as TextChannel;
      const cardMsg = await cardChannel.messages.fetch(game.messageId);
      await cardMsg.edit({
        embeds: [buildGameEmbed(game, {})],
        components: [buildGameButtons(gameId, game.seats.length >= game.maxPlayers)],
      });
    } catch { /* card may have been deleted */ }
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

function parseRange(input: string, defaultMin: number, defaultMax: number): { min: number; max: number } {
  const rangeMatch = input.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const singleMatch = input.match(/(\d+)/);
  if (singleMatch) { const n = Number(singleMatch[1]); return { min: n, max: n }; }
  return { min: defaultMin, max: defaultMax };
}

async function resolveNames(
  interaction: ButtonInteraction,
  userIds: string[],
): Promise<Record<string, string>> {
  const nameMap: Record<string, string> = {};
  if (!interaction.guild) return nameMap;
  await Promise.all(
    userIds.map(async id => {
      try {
        const member = await interaction.guild!.members.fetch(id);
        nameMap[id] = member.displayName;
      } catch { /* fall back to mention */ }
    })
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
  addGame(interaction.guildId!, interaction.user.id, pending.gameName, pending.objectid);
  await interaction.update({
    content: `Got it! **${pending.gameName}** has been added to your library.`,
    components: [],
  });
}

export async function handleBringCancel(interaction: ButtonInteraction): Promise<void> {
  pendingBrings.delete(interaction.user.id);
  await interaction.update({ content: 'No problem — the game has still been added to the lineup.', components: [] });
}
