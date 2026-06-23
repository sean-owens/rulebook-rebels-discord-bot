import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { GameSuggestion } from './gameStorage';

export function buildGameEmbed(game: GameSuggestion, nameMap: Record<string, string>): EmbedBuilder {
  const getName = (id: string) => nameMap[id] ?? `<@${id}>`;
  const waitlist = game.waitlist ?? [];

  const seatCount = game.seats.length;
  const maxSeats = game.maxPlayers;
  const isFull = seatCount >= maxSeats;

  const playerInfo = game.minPlayers === game.maxPlayers
    ? `${game.minPlayers}`
    : `${game.minPlayers}–${game.maxPlayers}`;

  const durationInfo = game.minPlaytime === game.maxPlaytime
    ? `~${game.minPlaytime} min`
    : `${game.minPlaytime}–${game.maxPlaytime} min`;

  const embed = new EmbedBuilder()
    .setTitle(game.title)
    .setURL(game.bggLink || null)
    .setColor(0xe8a838)
    .addFields(
      { name: 'Players', value: `${playerInfo} (best with **${game.suggestedPlayers}**)`, inline: true },
      { name: 'Duration', value: durationInfo, inline: true },
    );

  if (game.tags?.length) {
    embed.addFields({ name: 'Tags', value: game.tags.join(' • ') });
  }

  if (game.expansions.length > 0) {
    embed.addFields({
      name: 'Expansions',
      value: game.expansions.map(e => `• [${e.name}](https://boardgamegeek.com/boardgameexpansion/${e.id})`).join('\n'),
    });
  }

  // Multi-group view when waitlist has enough for a second group
  const group2Ready = isFull && waitlist.length >= game.minPlayers;

  if (group2Ready) {
    const g1Lines = game.seats.map((id, i) => `${i + 1}. ${getName(id)}`);
    embed.addFields({ name: `Group 1 (${seatCount}/${maxSeats})`, value: g1Lines.join('\n') });

    const g2Players = waitlist.slice(0, maxSeats);
    const g2Open = maxSeats - g2Players.length;
    const g2Lines = g2Players.map((id, i) => `${i + 1}. ${getName(id)}`);
    if (g2Open > 0) g2Lines.push(`*(${g2Open} open slot${g2Open !== 1 ? 's' : ''})*`);
    embed.addFields({ name: `Group 2 (${g2Players.length}/${maxSeats})`, value: g2Lines.join('\n') });

    const overflow = waitlist.slice(maxSeats);
    if (overflow.length > 0) {
      embed.addFields({
        name: `Waitlist for Group 3+ (${overflow.length})`,
        value: overflow.map((id, i) => `${i + 1}. ${getName(id)}`).join('\n'),
      });
    }
  } else {
    // Standard single-group view
    const seatLines = game.seats.map((id, i) => `${i + 1}. ${getName(id)}`);
    const openCount = maxSeats - seatCount;
    if (openCount > 0) seatLines.push(`*(${openCount} open slot${openCount !== 1 ? 's' : ''})*`);
    embed.addFields({ name: `Seats (${seatCount}/${maxSeats})`, value: seatLines.join('\n') || '*(no seats defined)*' });

    if (isFull && waitlist.length > 0) {
      const needed = game.minPlayers - waitlist.length;
      embed.addFields({
        name: `Waitlist — Group 2 forming (${waitlist.length}/${game.minPlayers} min needed)`,
        value: waitlist.map((id, i) => `${i + 1}. ${getName(id)}`).join('\n')
          + (needed > 0 ? `\n*(${needed} more needed to split into a second group)*` : ''),
      });
    }
  }

  embed.setFooter({ text: `Game ID: ${game.id} • Data from BoardGameGeek` });

  return embed;
}

export function buildGameButtons(gameId: string, isFull: boolean): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(`game_join_${gameId}`)
      .setLabel('Join')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isFull),
    new ButtonBuilder()
      .setCustomId(`game_leave_${gameId}`)
      .setLabel('Leave')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary),
  ];

  if (isFull) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`game_waitlist_join_${gameId}`)
        .setLabel('Join Waitlist')
        .setEmoji('⏳')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`game_waitlist_leave_${gameId}`)
        .setLabel('Leave Waitlist')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}
