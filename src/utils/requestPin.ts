import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { loadGameNights, upsertGameNight } from './storage';
import { getRequestsForEvent, loadLibraryForGuild, GameRequest } from './libraryStorage';
import { findGamesByChannel, GameSuggestion } from './gameStorage';

export function buildRequestEmbed(guildId: string, requests: GameRequest[], nameMap: Record<string, string> = {}): EmbedBuilder {
  const library = loadLibraryForGuild(guildId);

  // Group by owner — a game with multiple owners appears under each
  const ownerMap = new Map<string, string[]>();
  const noOwnerGames: string[] = [];

  for (const req of requests) {
    const copies = req.copiesNeeded ?? 1;
    const confirmed = req.confirmedBy ? ' ✅' : '';
    const label = copies > 1
      ? `${req.gameName} *(${copies} copies needed)*${confirmed}`
      : `${req.gameName}${confirmed}`;
    const owners = [...new Set(
      library
        .filter(e => e.gameName.toLowerCase() === req.gameName.toLowerCase())
        .map(e => e.userId)
    )];

    if (owners.length === 0) {
      noOwnerGames.push(label);
    } else {
      for (const ownerId of owners) {
        if (!ownerMap.has(ownerId)) ownerMap.set(ownerId, []);
        if (!ownerMap.get(ownerId)!.includes(label)) {
          ownerMap.get(ownerId)!.push(label);
        }
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('Games to Bring')
    .setColor(0x5865f2)
    .setFooter({ text: 'Request games with /library request <game> • Confirm with /library bring game:<name>' });

  for (const [userId, games] of ownerMap) {
    const displayName = nameMap[userId] ?? `User ${userId.slice(0, 6)}…`;
    embed.addFields({ name: displayName, value: games.map(g => `• ${g}`).join('\n') });
  }

  if (noOwnerGames.length > 0) {
    embed.addFields({ name: 'Owner not in library', value: noOwnerGames.map(g => `• ${g}`).join('\n') });
  }

  if (ownerMap.size === 0 && noOwnerGames.length === 0) {
    embed.setDescription('No games have been requested yet.');
  }

  return embed;
}

function buildGameListEmbed(games: GameSuggestion[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Game Lineup').setColor(0x57f287);
  if (games.length === 0) {
    return embed.setDescription('No games scheduled yet.');
  }
  const lines = games.map(g => {
    const link = `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
    const players = `${g.minPlayers}–${g.maxPlayers}p`;
    const time = g.minPlaytime === g.maxPlaytime ? `${g.minPlaytime}min` : `${g.minPlaytime}–${g.maxPlaytime}min`;
    const seats = `${g.seats.length}/${g.suggestedPlayers} seated`;
    return `**[${g.title}](${link})** — ${players} · ${time} · ${seats}`;
  });
  return embed
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${games.length} game${games.length !== 1 ? 's' : ''} scheduled · Join via the linked card` });
}

export async function updateGameListPin(client: Client, eventId: string): Promise<void> {
  const all = loadGameNights();
  const gameNight = all.find(gn => gn.id === eventId);
  if (!gameNight?.eventChannelId) return;

  const games = findGamesByChannel(gameNight.eventChannelId);
  const embed = buildGameListEmbed(games);

  let channel: TextChannel;
  try {
    channel = await client.channels.fetch(gameNight.eventChannelId) as TextChannel;
  } catch { return; }

  if (gameNight.gameListPinMessageId) {
    try {
      const msg = await channel.messages.fetch(gameNight.gameListPinMessageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch { /* message was deleted — fall through and repost */ }
  }

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch { /* may lack ManageMessages — embed still posts */ }

  gameNight.gameListPinMessageId = msg.id;
  upsertGameNight(gameNight);
}

export async function updateRequestPin(client: Client, eventId: string): Promise<void> {
  const all = loadGameNights();
  const gameNight = all.find(gn => gn.id === eventId);
  if (!gameNight?.eventChannelId) return;

  const requests = getRequestsForEvent(eventId);
  if (requests.length === 0 && !gameNight.requestPinMessageId) return;

  // Resolve display names for all library owners of the requested games
  const library = loadLibraryForGuild(gameNight.guildId);
  const ownerIds = [...new Set(requests.flatMap(r =>
    library.filter(e => e.gameName.toLowerCase() === r.gameName.toLowerCase()).map(e => e.userId)
  ))];
  const nameMap: Record<string, string> = {};
  try {
    const guild = await client.guilds.fetch(gameNight.guildId);
    await Promise.all(ownerIds.map(async uid => {
      try {
        nameMap[uid] = (await guild.members.fetch(uid)).displayName;
      } catch {
        nameMap[uid] = client.users.cache.get(uid)?.username ?? `User ${uid.slice(0, 6)}…`;
      }
    }));
  } catch { /* guild unavailable — names fall back inside buildRequestEmbed */ }

  const embed = buildRequestEmbed(gameNight.guildId, requests, nameMap);

  let channel: TextChannel;
  try {
    channel = await client.channels.fetch(gameNight.eventChannelId) as TextChannel;
  } catch { return; }

  if (gameNight.requestPinMessageId) {
    try {
      const msg = await channel.messages.fetch(gameNight.requestPinMessageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch { /* message was deleted — fall through and repost */ }
  }

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch { /* may lack ManageMessages — embed still posts */ }

  gameNight.requestPinMessageId = msg.id;
  upsertGameNight(gameNight);
}
