import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
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
import { loadGames, upsertGame, GameSuggestion, GameExpansion } from '../utils/gameStorage';
import { buildGameEmbed, buildGameButtons } from '../utils/gameEmbeds';
import { loadGameNights, GameNight } from '../utils/storage';

const MANUAL_VALUE = '__manual__';

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
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'suggest') await handleSuggest(interaction);
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

  await interaction.deferReply({ ephemeral: true });

  let results: BGGSearchResult[] = [];
  let bggFailed = false;
  try {
    results = await searchBGG(title);
  } catch {
    bggFailed = true;
  }

  if (results.length === 0) {
    // BGG unavailable or no results — offer manual entry
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

  // Always append an "Enter manually" fallback option
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
    content: `Found **${results.length}** result(s) for **"${title}"** — pick the one you mean:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
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

  await interaction.editReply({ content: `**${title}** has been added to the lineup!` });
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
  await interaction.editReply({
    content: `**${bggGame.name}**${expNote} has been added to the lineup!`,
    components: [],
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
