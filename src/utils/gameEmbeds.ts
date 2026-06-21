import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { GameSuggestion } from './gameStorage';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function buildGameEmbed(game: GameSuggestion, nameMap: Record<string, string>): EmbedBuilder {
  const getName = (id: string) => nameMap[id] ?? `<@${id}>`;

  const seatCount = game.seats.length;
  const totalSeats = game.maxPlayers;
  const seatLines: string[] = [];
  for (let i = 0; i < totalSeats; i++) {
    seatLines.push(i < seatCount ? `${i + 1}. ${getName(game.seats[i])}` : `${i + 1}. *(open)*`);
  }

  const playerInfo = game.minPlayers === game.maxPlayers
    ? `${game.minPlayers}`
    : `${game.minPlayers}–${game.maxPlayers}`;

  const durationInfo = game.minPlaytime === game.maxPlaytime
    ? `~${game.minPlaytime} min`
    : `${game.minPlaytime}–${game.maxPlaytime} min`;

  const embed = new EmbedBuilder()
    .setTitle(game.title)
    .setURL(game.bggLink)
    .setColor(0xe8a838)
    .addFields(
      { name: 'Players', value: `${playerInfo} (best with **${game.suggestedPlayers}**)`, inline: true },
      { name: 'Duration', value: durationInfo, inline: true },
    );

  if (game.suggestedStartTime) {
    embed.addFields({ name: 'Suggested Start', value: formatTime(game.suggestedStartTime), inline: true });
  }

  if (game.expansions.length > 0) {
    embed.addFields({
      name: 'Expansions',
      value: game.expansions.map(e => `• [${e.name}](https://boardgamegeek.com/boardgameexpansion/${e.id})`).join('\n'),
    });
  }

  embed.addFields({
    name: `Seats (${seatCount}/${totalSeats})`,
    value: seatLines.join('\n'),
  });

  embed.setFooter({ text: `Game ID: ${game.id} • Data from BoardGameGeek` });

  return embed;
}

export function buildGameButtons(gameId: string, isFull: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
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
  );
}
