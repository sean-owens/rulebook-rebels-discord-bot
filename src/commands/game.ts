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
import { loadGames, saveGames, upsertGame, GameSuggestion, GameExpansion, findGamesByChannel } from '../utils/gameStorage';
import { buildGameEmbed, buildGameButtons } from '../utils/gameEmbeds';
import { loadGameNights, GameNight } from '../utils/storage';
import { findGamesByName, findGameNamesByPartial, getGameInfo, addGame, GameInfo } from '../utils/libraryStorage';

const MANUAL_VALUE = '__manual__';
const BGG_VALUE = '__bgg__';

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

async function handleSuggest(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
  if (!gameNight) {
    await interaction.reply({
      content: 'This command can only be used inside an active event channel.',
      ephemeral: true,
    });
    return;
  }

  const title = interaction.options.getString('title', true);
  const withExpansions = interaction.options.getBoolean('with_expansions') ?? false;

  // Check the group library — exact match first
  const libraryMatches = findGamesByName(title);
  if (libraryMatches.length > 0) {
    const info = getGameInfo(title);
    await postLibraryGame(interaction, gameNight, libraryMatches[0].gameName, info ?? null, libraryMatches.map(e => e.userId));
    return;
  }

  // Partial match in library — prompt user to confirm which game
  const partials = findGameNamesByPartial(title);
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

  // Not in library — search BGG
  await interaction.deferReply({ ephemeral: true });

  let results: BGGSearchResult[] = [];
  let bggFailed = false;
  try {
    results = await searchBGG(title);
  } catch {
    bggFailed = true;
  }

  if (results.length === 0) {
    await interaction.editReply({
      content: bggFailed
        ? `Couldn't reach the game database. Enter the details manually:`
        : `No results found for **"${title}"**. Enter the details manually:`,
      components: [manualEntryButton(title)],
    });
    return;
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

  const customId = withExpansions ? 'game_select_exp' : 'game_select';
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Choose the correct game...')
    .addOptions(options);

  await interaction.editReply({
    content: `**"${title}"** wasn't found in the group library. Found **${results.length}** BGG result(s) — pick the one you mean:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
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

// ── List scheduled games ─────────────────────────────────────────────────────

async function handleGameList(interaction: ChatInputCommandInteraction): Promise<void> {
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

  // Delete the original message
  try {
    const channel = await interaction.client.channels.fetch(match.channelId) as TextChannel;
    const msg = await channel.messages.fetch(match.messageId);
    await msg.delete();
  } catch { /* message may already be deleted */ }

  // Remove from storage
  const remaining = loadGames().filter(g => g.id !== match.id);
  saveGames(remaining);

  await interaction.reply({ content: `**${match.title}** has been removed from the lineup.`, ephemeral: true });
}

// ── Library match: post directly ────────────────────────────────────────────

async function postLibraryGame(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  gameNight: GameNight,
  gameName: string,
  info: GameInfo | null,
  ownerIds: string[],
): Promise<void> {
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

  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: interaction.channelId!,
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
    suggestedStartTime: calcStartTime(interaction.channelId!, playTime),
    expansions: [],
    seats: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = await interaction.client.channels.fetch(interaction.channelId!) as TextChannel;
  const owners = ownerIds.map(id => `<@${id}>`).join(', ');
  const msg = await channel.send({
    content: `Owned by: ${owners}`,
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  await interaction.editReply({ content: `**${gameName}** has been added to the lineup!`, components: [] });
}

// ── Library partial-match select ─────────────────────────────────────────────

export async function handleLibrarySuggestSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const value = interaction.values[0];
  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
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
    let results: BGGSearchResult[] = [];
    try { results = await searchBGG(title); } catch { /* fall through */ }

    if (results.length === 0) {
      await interaction.editReply({
        content: `No BGG results for **"${title}"**. Enter details manually:`,
        components: [manualEntryButton(title)],
      });
      return;
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
    const customId = withExpansions ? 'game_select_exp' : 'game_select';
    const select = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose the correct game...')
      .addOptions(options);
    await interaction.editReply({
      content: `Found **${results.length}** BGG result(s) — pick the one you mean:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  // Library game selected
  const libraryMatches = findGamesByName(value);
  const info = getGameInfo(value);
  await postLibraryGame(interaction, gameNight, value, info ?? null, libraryMatches.map(e => e.userId));
}

// ── Select: no expansions ────────────────────────────────────────────────────

export async function handleGameSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
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

// ── Select: with expansions ──────────────────────────────────────────────────

export async function handleGameSelectWithExp(interaction: StringSelectMenuInteraction): Promise<void> {
  const bggId = interaction.values[0];

  if (bggId === MANUAL_VALUE) {
    await showManualEntryModal(interaction, '');
    return;
  }

  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
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

// ── Select: expansions confirmed ─────────────────────────────────────────────

export async function handleExpansionSelect(
  interaction: StringSelectMenuInteraction,
  bggId: string,
): Promise<void> {
  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
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

// ── Manual entry button → show modal ────────────────────────────────────────

export async function handleManualBtn(interaction: ButtonInteraction): Promise<void> {
  const prefill = decodeURIComponent(interaction.customId.slice('game_manual_'.length));
  await showManualEntryModal(interaction, prefill);
}

// ── Modal submission ─────────────────────────────────────────────────────────

export async function handleManualGameSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === interaction.channelId && !gn.cancelled && !gn.archived
  );
  if (!gameNight) {
    await interaction.reply({ content: 'This event channel is no longer active.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const title = interaction.fields.getTextInputValue('title').trim();
  const playersRaw = interaction.fields.getTextInputValue('players').trim();
  const bestWithRaw = interaction.fields.getTextInputValue('best_with').trim();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const link = interaction.fields.getTextInputValue('link').trim();

  const { min: minPlayers, max: maxPlayers } = parseRange(playersRaw, 2, 4);
  const { min: minPlaytime, max: maxPlaytime } = parseRange(durationRaw, 30, 60);
  const suggestedPlayers = bestWithRaw && Number(bestWithRaw)
    ? Number(bestWithRaw)
    : Math.ceil((minPlayers + maxPlayers) / 2);

  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: interaction.channelId!,
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
    suggestedStartTime: calcStartTime(interaction.channelId!, maxPlaytime),
    expansions: [],
    seats: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = await interaction.client.channels.fetch(interaction.channelId!) as TextChannel;
  const msg = await channel.send({
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  pendingBrings.set(interaction.user.id, { gameName: title });
  await interaction.editReply({
    content: `**${title}** has been added to the lineup! Will you be bringing this game?`,
    components: [bringGameRow()],
  });
}

// ── Button: Join / Leave ─────────────────────────────────────────────────────

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

  const nameMap = await resolveNames(interaction, game.seats);
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

  const nameMap = await resolveNames(interaction, game.seats);
  await interaction.update({
    embeds: [buildGameEmbed(game, nameMap)],
    components: [buildGameButtons(gameId, false)],
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const id = randomUUID().slice(0, 8);
  const game: GameSuggestion = {
    id,
    eventId: gameNight.id,
    channelId: interaction.channelId,
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
    suggestedStartTime: calcStartTime(interaction.channelId, bggGame.maxPlaytime),
    expansions: expansions.map(e => ({ id: e.id, name: e.name } as GameExpansion)),
    seats: [],
    createdAt: new Date().toISOString(),
    createdBy: interaction.user.id,
  };

  const channel = interaction.channel as TextChannel;
  const msg = await channel.send({
    embeds: [buildGameEmbed(game, {})],
    components: [buildGameButtons(id, false)],
  });

  game.messageId = msg.id;
  upsertGame(game);

  const expNote = expansions.length > 0 ? ` with ${expansions.length} expansion(s)` : '';
  pendingBrings.set(interaction.user.id, { gameName: bggGame.name, objectid: bggGame.id });
  await interaction.editReply({
    content: `**${bggGame.name}**${expNote} has been added to the lineup! Will you be bringing this game?`,
    components: [bringGameRow()],
  });
}

function calcStartTime(channelId: string, maxPlaytime: number): string | null {
  const gameNight = loadGameNights().find(
    gn => gn.eventChannelId === channelId && !gn.cancelled && !gn.archived
  );
  if (!gameNight?.startTimeISO) return null;

  const existing = loadGames()
    .filter(g => g.channelId === channelId && g.suggestedStartTime)
    .sort((a, b) => new Date(a.suggestedStartTime!).getTime() - new Date(b.suggestedStartTime!).getTime());

  if (existing.length === 0) return gameNight.startTimeISO;

  const last = existing[existing.length - 1];
  const lastEnd = new Date(last.suggestedStartTime!).getTime() + last.maxPlaytime * 60 * 1000;
  return new Date(lastEnd).toISOString();
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
  addGame(interaction.user.id, pending.gameName, pending.objectid);
  await interaction.update({
    content: `Got it! **${pending.gameName}** has been added to your library.`,
    components: [],
  });
}

export async function handleBringCancel(interaction: ButtonInteraction): Promise<void> {
  pendingBrings.delete(interaction.user.id);
  await interaction.update({ content: 'No problem — the game has still been added to the lineup.', components: [] });
}
