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
import {
  loadLibrary,
  addGame,
  removeGame,
  clearUserLibrary,
  getGamesByUser,
  findGamesByName,
  findGameNamesByPartial,
  getGameInfo,
  upsertGameInfo,
  GameInfo,
  addRequest,
  getRequestsForEvent,
} from '../utils/libraryStorage';
import { loadGameNights } from '../utils/storage';

const HEADER_PATTERNS = new Set(['game', 'name', 'game name', 'title', 'board game', 'boardgame']);

interface PendingAdd {
  gameName: string;
  objectid?: string;
}
const pendingAdds = new Map<string, PendingAdd>();
const pendingEdits = new Map<string, string>(); // userId -> canonical gameName

export const data = new SlashCommandBuilder()
  .setName('library')
  .setDescription('Manage the group game library')
  .addSubcommand(sub =>
    sub.setName('list').setDescription('Browse all games available in the group library')
  )
  .addSubcommand(sub =>
    sub.setName('mine').setDescription('See the games you have added to the library')
  )
  .addSubcommand(sub =>
    sub
      .setName('add')
      .setDescription('Add a game you own to the group library')
      .addStringOption(opt =>
        opt.setName('game').setDescription('Name of the game').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('remove')
      .setDescription('Remove a game from your library')
      .addStringOption(opt =>
        opt.setName('game').setDescription('Name of the game').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('request')
      .setDescription('Request a game be brought to the next event')
      .addStringOption(opt =>
        opt.setName('game').setDescription('Name of the game to request').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('import')
      .setDescription('Import a CSV of games you own into the library')
      .addAttachmentOption(opt =>
        opt.setName('file').setDescription('CSV file — one game per line, or game name in the first column').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('view')
      .setDescription('Get info on a specific game in the library')
      .addStringOption(opt =>
        opt.setName('game').setDescription('Name of the game').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('edit')
      .setDescription('Set details for a game you own (players, play time, type, expansions)')
      .addStringOption(opt =>
        opt.setName('game').setDescription('Name of the game').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('clear')
      .setDescription('Remove all of your games from the library (admins can target another user)')
      .addUserOption(opt =>
        opt.setName('user').setDescription('Admin only: clear a specific user\'s library entries').setRequired(false)
      )
  );

async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser('user');

  if (targetUser && targetUser.id !== interaction.user.id) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Only administrators can clear another user\'s library entries.', ephemeral: true });
      return;
    }
  }

  const userId = targetUser?.id ?? interaction.user.id;
  const displayName = targetUser ? `<@${userId}>` : 'your';
  const count = clearUserLibrary(userId);

  await interaction.reply({
    content: count > 0
      ? `Removed **${count}** game${count !== 1 ? 's' : ''} from ${displayName} library.`
      : `${displayName === 'your' ? 'You have' : `<@${userId}> has`} no games in the library to remove.`,
    ephemeral: true,
  });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') await handleList(interaction);
  else if (sub === 'mine') await handleMine(interaction);
  else if (sub === 'add') await handleAdd(interaction);
  else if (sub === 'remove') await handleRemove(interaction);
  else if (sub === 'request') await handleRequest(interaction);
  else if (sub === 'import') await handleImport(interaction);
  else if (sub === 'view') await handleView(interaction);
  else if (sub === 'edit') await handleEdit(interaction);
  else if (sub === 'clear') await handleClear(interaction);
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const entries = loadLibrary();

  if (entries.length === 0) {
    await interaction.reply({
      content: 'The group library is empty. Add your games with `/library add <game>`.',
      ephemeral: true,
    });
    return;
  }

  // Group entries by normalized game name, preserving original casing from first entry
  const gameMap = new Map<string, { displayName: string; owners: string[] }>();
  for (const entry of entries) {
    const key = entry.gameName.toLowerCase();
    if (!gameMap.has(key)) {
      gameMap.set(key, { displayName: entry.gameName, owners: [] });
    }
    gameMap.get(key)!.owners.push(`<@${entry.userId}>`);
  }

  const sorted = [...gameMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );

  const ownerCount = new Set(entries.map(e => e.userId)).size;
  const lines = sorted.map(g => `**${g.displayName}** — ${g.owners.join(', ')}`);

  // Chunk lines into groups that fit within a single embed's field limit (~900 chars each)
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > 900) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);

  // Discord caps total embed chars per message at 6000; budget ~5500 leaving room for metadata
  const CHAR_BUDGET = 5500;
  const embeds: EmbedBuilder[] = [];
  let totalChars = 'Group Game Library'.length + `${sorted.length} games across ${ownerCount} members`.length;
  let truncated = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (totalChars + chunk.length + 1 > CHAR_BUDGET) { truncated = true; break; }
    totalChars += chunk.length + 1;
    const e = new EmbedBuilder().setColor(0x5865f2).addFields({ name: '​', value: chunk });
    if (i === 0) {
      e.setTitle('Group Game Library')
       .setDescription(`${sorted.length} game${sorted.length !== 1 ? 's' : ''} across ${ownerCount} member${ownerCount !== 1 ? 's' : ''}`);
    }
    embeds.push(e);
  }

  if (embeds.length > 0) {
    embeds[embeds.length - 1].setFooter({
      text: truncated
        ? `Showing partial results — use /library mine to see your games`
        : 'Request a game for the next event with /library request <game>',
    });
  }

  await interaction.reply({ embeds, ephemeral: true });
}

function buildGameViewEmbed(gameName: string, userId: string): EmbedBuilder | null {
  const matches = findGamesByName(gameName);
  if (matches.length === 0) return null;

  const canonical = matches[0].gameName;
  const objectid = matches[0].objectid;
  const owners = matches.map(e => `<@${e.userId}>`);

  const now = new Date();
  const nextEvent = loadGameNights()
    .filter(gn => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime())[0];

  const isRequested = nextEvent
    ? getRequestsForEvent(nextEvent.id).some(r => r.gameName.toLowerCase() === canonical.toLowerCase())
    : false;

  const info = getGameInfo(canonical);

  const embed = new EmbedBuilder()
    .setTitle(canonical)
    .setColor(0x5865f2)
    .addFields({ name: `Owner${owners.length > 1 ? 's' : ''}`, value: owners.join('\n') });

  if (info?.minPlayers != null && info?.maxPlayers != null) {
    embed.addFields({ name: 'Players', value: `${info.minPlayers}–${info.maxPlayers}`, inline: true });
  }
  if (info?.playTime != null) {
    embed.addFields({ name: 'Play Time', value: `${info.playTime} min`, inline: true });
  }
  if (info?.gameType) {
    embed.addFields({ name: 'Type', value: info.gameType, inline: true });
  }
  if (info?.expansions?.length) {
    embed.addFields({ name: 'Expansions', value: info.expansions.join('\n') });
  }
  if (objectid) {
    embed.addFields({ name: 'BGG ID', value: objectid, inline: true });
  }
  if (nextEvent) {
    embed.addFields({
      name: `Requested for ${nextEvent.date}`,
      value: isRequested ? 'Yes' : 'No — use `/library request` to request it',
      inline: true,
    });
  }

  const isOwner = owners.some(o => o === `<@${userId}>`);
  if (isOwner) embed.setFooter({ text: 'Use /library edit to update game details' });
  return embed;
}

function buildPartialMatchSelect(
  partials: string[],
  customId: string,
  placeholder: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = partials.map(name =>
    new StringSelectMenuOptionBuilder().setLabel(name.slice(0, 100)).setValue(name)
  );
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('None of these')
      .setValue('__none__')
      .setDescription('Dismiss and search again with a different term')
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

async function handleView(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  const embed = buildGameViewEmbed(gameName, interaction.user.id);
  if (embed) {
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const partials = findGameNamesByPartial(gameName);
  if (partials.length > 0 && partials.length <= 25) {
    await interaction.reply({
      content: `**"${gameName}"** wasn't an exact match — did you mean one of these?`,
      ephemeral: true,
      components: [buildPartialMatchSelect(partials, 'library_view_select', 'Pick a game to view...')],
    });
    return;
  }

  await interaction.reply({
    content: partials.length > 25
      ? `Too many matches for **"${gameName}"** — try a more specific name.`
      : `**${gameName}** wasn't found in the library. Check the full list with \`/library list\`.`,
    ephemeral: true,
  });
}

export async function handleLibraryViewSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const gameName = interaction.values[0];

  if (gameName === '__none__') {
    await interaction.update({ content: 'No problem — try `/library view` again with a different term.', components: [] });
    return;
  }

  const embed = buildGameViewEmbed(gameName, interaction.user.id);
  if (!embed) {
    await interaction.update({ content: 'That game is no longer in the library.', components: [] });
    return;
  }
  await interaction.update({ content: '', embeds: [embed], components: [] });
}

async function handleMine(interaction: ChatInputCommandInteraction): Promise<void> {
  const entries = getGamesByUser(interaction.user.id);

  if (entries.length === 0) {
    await interaction.reply({
      content: "You haven't added any games yet. Use `/library add <game>` to add one.",
      ephemeral: true,
    });
    return;
  }

  const sorted = [...entries].sort((a, b) => a.gameName.localeCompare(b.gameName));

  const embed = new EmbedBuilder()
    .setTitle('Your Games')
    .setColor(0x5865f2)
    .setDescription(sorted.map(e => `• ${e.gameName}`).join('\n'))
    .setFooter({ text: `${sorted.length} game${sorted.length !== 1 ? 's' : ''}` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  if (!gameName) {
    await interaction.reply({ content: 'Please provide a game name.', ephemeral: true });
    return;
  }

  // Check if user already owns this game before touching storage
  const userGames = getGamesByUser(interaction.user.id);
  const alreadyOwns = userGames.some(e => e.gameName.toLowerCase() === gameName.toLowerCase());
  if (alreadyOwns) {
    await interaction.reply({ content: `**${gameName}** is already in your library.`, ephemeral: true });
    return;
  }

  // Check if anyone else in the group owns a game by this name
  const existing = findGamesByName(gameName).filter(e => e.userId !== interaction.user.id);
  if (existing.length > 0) {
    const canonical = existing[0].gameName;
    const objectid = existing[0].objectid;
    const owners = [...new Set(existing.map(e => `<@${e.userId}>`))].join(', ');

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

    await interaction.reply({
      content: `**${canonical}** is already in the group library (owned by ${owners}). Are you adding your own copy?`,
      components: [row],
      ephemeral: true,
    });
    return;
  }

  addGame(interaction.user.id, gameName);
  await interaction.reply({
    content: `Added **${gameName}** to your library. Other members can now request it for events.`,
    ephemeral: true,
  });
}

export async function handleAddConfirm(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingAdds.get(interaction.user.id);
  if (!pending) {
    await interaction.update({ content: 'This confirmation has expired. Please run `/library add` again.', components: [] });
    return;
  }
  pendingAdds.delete(interaction.user.id);
  addGame(interaction.user.id, pending.gameName, pending.objectid);
  await interaction.update({
    content: `Added **${pending.gameName}** to your library. Other members can now request it for events.`,
    components: [],
  });
}

export async function handleAddCancel(interaction: ButtonInteraction): Promise<void> {
  pendingAdds.delete(interaction.user.id);
  await interaction.update({ content: 'Cancelled. No changes were made to your library.', components: [] });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();
  const result = removeGame(interaction.user.id, gameName);

  if (result === 'not_found') {
    await interaction.reply({
      content: `**${gameName}** wasn't found in your library. Check your games with \`/library mine\`.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `Removed **${gameName}** from your library.`,
    ephemeral: true,
  });
}

async function handleRequest(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  // Check the game exists in the library (someone must own it)
  const library = loadLibrary();
  const matches = library.filter(e => e.gameName.toLowerCase() === gameName.toLowerCase());

  if (matches.length === 0) {
    const partials = findGameNamesByPartial(gameName);
    if (partials.length > 0 && partials.length <= 25) {
      await interaction.reply({
        content: `**"${gameName}"** wasn't an exact match — did you mean one of these?`,
        ephemeral: true,
        components: [buildPartialMatchSelect(partials, 'library_request_select', 'Pick a game to request...')],
      });
      return;
    }
    await interaction.reply({
      content: partials.length > 25
        ? `Too many matches for **"${gameName}"** — try a more specific name.`
        : `**${gameName}** isn't in the group library. Check what's available with \`/library list\`.`,
      ephemeral: true,
    });
    return;
  }

  // Find the next upcoming event
  const now = new Date();
  const upcoming = loadGameNights()
    .filter(gn => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.reply({
      content: "There's no upcoming event to request games for.",
      ephemeral: true,
    });
    return;
  }

  const event = upcoming[0];

  const ownerIds = matches.map(e => e.userId);
  const ownerAttending = ownerIds.some(
    id => event.rsvps.yes.includes(id) || event.rsvps.maybe.includes(id)
  );
  if (!ownerAttending) {
    await interaction.reply({
      content: `None of the owners of **${matches[0].gameName}** are attending the next event, so it can't be requested.`,
      ephemeral: true,
    });
    return;
  }

  const result = addRequest(event.id, gameName, interaction.user.id);

  if (result === 'duplicate') {
    await interaction.reply({
      content: `**${gameName}** has already been requested for the next event.`,
      ephemeral: true,
    });
    return;
  }

  // Use the canonical casing from the library
  const canonicalName = matches[0].gameName;
  const owners = matches.map(e => `<@${e.userId}>`);

  await interaction.reply({
    content: `<@${interaction.user.id}> requested **${canonicalName}** for the next event (${event.date}). Owner${owners.length > 1 ? 's' : ''}: ${owners.join(', ')}`,
  });

  // Post in the event channel if it exists
  if (event.eventChannelId) {
    try {
      const eventChannel = await interaction.client.channels.fetch(event.eventChannelId) as TextChannel;
      const allRequests = getRequestsForEvent(event.id);
      const requestLines = allRequests.map(r => `• **${r.gameName}** (requested by <@${r.requestedBy}>)`).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('Requested Games')
        .setColor(0x5865f2)
        .setDescription(requestLines)
        .setFooter({ text: 'Request games with /library request <game>' });

      await eventChannel.send({ embeds: [embed] });
    } catch { /* event channel may not be accessible */ }
  }
}

export async function handleLibraryRequestSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const gameName = interaction.values[0];

  if (gameName === '__none__') {
    await interaction.update({ content: 'No problem — try `/library request` again with a different term.', components: [] });
    return;
  }

  const library = loadLibrary();
  const matches = library.filter(e => e.gameName.toLowerCase() === gameName.toLowerCase());

  const now = new Date();
  const upcoming = loadGameNights()
    .filter(gn => !gn.cancelled && !gn.archived && new Date(gn.startTimeISO) > now)
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime());

  if (upcoming.length === 0) {
    await interaction.update({ content: "There's no upcoming event to request games for.", components: [] });
    return;
  }

  const event = upcoming[0];

  const ownerIds = matches.map(e => e.userId);
  const ownerAttending = ownerIds.some(
    id => event.rsvps.yes.includes(id) || event.rsvps.maybe.includes(id)
  );
  if (!ownerAttending) {
    await interaction.update({
      content: `None of the owners of **${matches[0]?.gameName ?? gameName}** are attending the next event, so it can't be requested.`,
      components: [],
    });
    return;
  }

  const result = addRequest(event.id, gameName, interaction.user.id);
  const canonicalName = matches[0]?.gameName ?? gameName;
  const owners = matches.map(e => `<@${e.userId}>`);

  if (result === 'duplicate') {
    await interaction.update({ content: `**${canonicalName}** has already been requested for the next event.`, components: [] });
    return;
  }

  // Dismiss the ephemeral select menu, then post a public confirmation
  await interaction.update({ content: '✓ Request submitted!', components: [] });
  await interaction.followUp({
    content: `<@${interaction.user.id}> requested **${canonicalName}** for the next event (${event.date}). Owner${owners.length !== 1 ? 's' : ''}: ${owners.join(', ')}`,
    ephemeral: false,
  });

  if (event.eventChannelId) {
    try {
      const eventChannel = await interaction.client.channels.fetch(event.eventChannelId) as TextChannel;
      const allRequests = getRequestsForEvent(event.id);
      const requestLines = allRequests.map(r => `• **${r.gameName}** (requested by <@${r.requestedBy}>)`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Requested Games')
        .setColor(0x5865f2)
        .setDescription(requestLines)
        .setFooter({ text: 'Request games with /library request <game>' });
      await eventChannel.send({ embeds: [embed] });
    } catch { /* event channel may not be accessible */ }
  }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
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

async function handleImport(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment('file', true);

  if (attachment.size > 512_000) {
    await interaction.editReply('That file is too large. Please upload a CSV under 500 KB.');
    return;
  }

  let text: string;
  try {
    const res = await fetch(attachment.url);
    text = await res.text();
  } catch {
    await interaction.editReply('Failed to download the file. Please try again.');
    return;
  }

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) {
    await interaction.editReply('No games were found in that file. Make sure it has one game name per line.');
    return;
  }

  // Detect BGG format by checking header row for known BGG columns
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const isBgg = headers.includes('own') && headers.includes('objectname');
  const nameIdx = isBgg ? headers.indexOf('objectname') : 0;
  const idIdx = isBgg ? headers.indexOf('objectid') : -1;
  const ownIdx = isBgg ? headers.indexOf('own') : -1;
  const typeIdx = isBgg ? headers.indexOf('itemtype') : -1;
  const minPlayersIdx = isBgg ? headers.indexOf('minplayers') : -1;
  const maxPlayersIdx = isBgg ? headers.indexOf('maxplayers') : -1;
  const playTimeIdx = isBgg ? headers.indexOf('playingtime') : -1;

  const userId = interaction.user.id;
  let added = 0;
  let skipped = 0;
  let expansions = 0;

  const dataLines = isBgg ? lines.slice(1) : lines;

  for (const rawLine of dataLines) {
    const fields = parseCsvLine(rawLine);
    const gameName = fields[nameIdx]?.trim();

    if (!gameName || HEADER_PATTERNS.has(gameName.toLowerCase())) continue;

    if (ownIdx !== -1 && fields[ownIdx] !== '1') continue;
    if (typeIdx !== -1 && fields[typeIdx] === 'expansion') { expansions++; continue; }

    const objectid = idIdx !== -1 ? fields[idIdx]?.trim() || undefined : undefined;
    const result = addGame(userId, gameName, objectid);
    if (result === 'added') added++;
    else skipped++;

    if (isBgg) {
      const minPlayers = minPlayersIdx !== -1 ? parseInt(fields[minPlayersIdx], 10) || undefined : undefined;
      const maxPlayers = maxPlayersIdx !== -1 ? parseInt(fields[maxPlayersIdx], 10) || undefined : undefined;
      const playTime = playTimeIdx !== -1 ? parseInt(fields[playTimeIdx], 10) || undefined : undefined;
      const existing = getGameInfo(gameName);
      upsertGameInfo({
        gameName,
        objectid,
        minPlayers: existing?.minPlayers ?? minPlayers,
        maxPlayers: existing?.maxPlayers ?? maxPlayers,
        playTime: existing?.playTime ?? playTime,
        gameType: existing?.gameType,
        expansions: existing?.expansions,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (added === 0 && skipped === 0 && expansions === 0) {
    await interaction.editReply('No games were found in that file. Make sure it has one game name per line.');
    return;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`**${added}** game${added !== 1 ? 's' : ''} added`);
  if (skipped > 0) parts.push(`**${skipped}** already in your library`);
  if (expansions > 0) parts.push(`**${expansions}** expansion${expansions !== 1 ? 's' : ''} skipped`);
  await interaction.editReply(`Import complete — ${parts.join(', ')}.`);
}

async function handleEdit(interaction: ChatInputCommandInteraction): Promise<void> {
  const gameName = interaction.options.getString('game', true).trim();

  // Must be in the library (owned by someone)
  const matches = findGamesByName(gameName);
  if (matches.length === 0) {
    await interaction.reply({
      content: `**${gameName}** isn't in the group library. Only games in the library can be edited.`,
      ephemeral: true,
    });
    return;
  }

  // Only owners can edit
  const isOwner = matches.some(e => e.userId === interaction.user.id);
  if (!isOwner) {
    const owners = matches.map(e => `<@${e.userId}>`).join(', ');
    await interaction.reply({
      content: `Only owners of **${matches[0].gameName}** can edit its details (${owners}).`,
      ephemeral: true,
    });
    return;
  }

  const canonical = matches[0].gameName;
  const existing = getGameInfo(canonical);

  pendingEdits.set(interaction.user.id, canonical);

  const modal = new ModalBuilder()
    .setCustomId('library_edit_modal')
    .setTitle(`Edit: ${canonical}`.slice(0, 45));

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
            : existing?.minPlayers != null ? String(existing.minPlayers) : ''
        )
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('playtime')
        .setLabel('Play time (minutes, e.g. 90)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(existing?.playTime != null ? String(existing.playTime) : '')
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('gametype')
        .setLabel('Game type (e.g. strategy, party, co-op)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(existing?.gameType ?? '')
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('expansions')
        .setLabel('Expansions (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(existing?.expansions?.join(', ') ?? '')
    ),
  );

  await interaction.showModal(modal);
}

export async function handleEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  const gameName = pendingEdits.get(interaction.user.id);
  if (!gameName) {
    await interaction.reply({ content: 'This edit session has expired. Please run `/library edit` again.', ephemeral: true });
    return;
  }
  pendingEdits.delete(interaction.user.id);

  const playersRaw = interaction.fields.getTextInputValue('players').trim();
  const playtimeRaw = interaction.fields.getTextInputValue('playtime').trim();
  const gameType = interaction.fields.getTextInputValue('gametype').trim() || undefined;
  const expansionsRaw = interaction.fields.getTextInputValue('expansions').trim();

  const existing = getGameInfo(gameName);

  let minPlayers: number | undefined = existing?.minPlayers;
  let maxPlayers: number | undefined = existing?.maxPlayers;
  if (playersRaw) {
    const parts = playersRaw.split('-').map(p => parseInt(p.trim(), 10));
    if (!isNaN(parts[0])) minPlayers = parts[0];
    if (parts[1] != null && !isNaN(parts[1])) maxPlayers = parts[1];
    else if (!isNaN(parts[0])) maxPlayers = parts[0];
  }

  const playTime = playtimeRaw ? parseInt(playtimeRaw, 10) || existing?.playTime : existing?.playTime;
  const expansions = expansionsRaw
    ? expansionsRaw.split(',').map(e => e.trim()).filter(Boolean)
    : existing?.expansions;

  const info: GameInfo = {
    gameName,
    objectid: existing?.objectid,
    minPlayers,
    maxPlayers,
    playTime,
    gameType,
    expansions,
    updatedAt: new Date().toISOString(),
  };

  upsertGameInfo(info);

  await interaction.reply({
    content: `Updated details for **${gameName}**.`,
    ephemeral: true,
  });
}
