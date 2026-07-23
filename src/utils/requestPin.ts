import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, TextChannel } from 'discord.js';
import { loadGameNights, upsertGameNight } from './storage';
import { getRequestsForEvent, loadLibraryForGuild, GameRequest } from './libraryStorage';
import { findGamesByChannel, GameSuggestion } from './gameStorage';

export async function buildRequestEmbed(
  guildId: string,
  requests: GameRequest[],
  nameMap: Record<string, string> = {},
): Promise<EmbedBuilder> {
  const library = await loadLibraryForGuild(guildId);

  // Group by owner — a game with multiple owners appears under each
  const ownerMap = new Map<string, string[]>();
  const noOwnerGames: string[] = [];

  for (const req of requests) {
    const copies = req.copiesNeeded ?? 1;
    const label =
      copies > 1
        ? `${req.gameName} *(${req.confirmations.length}/${copies} copies confirmed)*`
        : `${req.gameName}${req.confirmations.length > 0 ? ' ✅' : ''}`;
    const owners = [
      ...new Set(
        library
          .filter((e) => e.gameName.toLowerCase() === req.gameName.toLowerCase())
          .map((e) => e.userId),
      ),
    ];

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
    .setFooter({
      text: 'Request games with /library request <game> • Confirm with /library bring game:<name>',
    });

  for (const [userId, games] of ownerMap) {
    const displayName = nameMap[userId] ?? `User ${userId.slice(0, 6)}…`;
    embed.addFields({ name: displayName, value: games.map((g) => `• ${g}`).join('\n') });
  }

  if (noOwnerGames.length > 0) {
    embed.addFields({
      name: 'Owner not in library',
      value: noOwnerGames.map((g) => `• ${g}`).join('\n'),
    });
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
  return embed
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `${games.length} game${games.length !== 1 ? 's' : ''} scheduled · Join via the linked card`,
    });
}

export async function updateGameListPin(client: Client, eventId: string): Promise<void> {
  const all = await loadGameNights();
  const gameNight = all.find((gn) => gn.id === eventId);
  if (!gameNight?.eventChannelId) return;

  const games = await findGamesByChannel(gameNight.eventChannelId);
  const embed = buildGameListEmbed(games);

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(gameNight.eventChannelId)) as TextChannel;
  } catch {
    return;
  }

  if (gameNight.gameListPinMessageId) {
    try {
      const msg = await channel.messages.fetch(gameNight.gameListPinMessageId);
      await msg.edit({ embeds: [embed] });
      if (!msg.pinned) {
        try {
          await msg.pin();
        } catch (err) {
          console.warn(`Could not re-pin game list message in channel ${gameNight.eventChannelId}:`, err);
        }
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  try {
    await msg.pin();
  } catch (err) {
    console.warn(`Could not pin game list message in channel ${gameNight.eventChannelId}:`, err);
  }

  gameNight.gameListPinMessageId = msg.id;
  await upsertGameNight(gameNight);
}

export async function updateRequestPin(client: Client, eventId: string): Promise<void> {
  const all = await loadGameNights();
  const gameNight = all.find((gn) => gn.id === eventId);
  if (!gameNight?.eventChannelId) return;

  const requests = await getRequestsForEvent(eventId);

  // Resolve display names for all library owners of the requested games
  const library = await loadLibraryForGuild(gameNight.guildId);
  const ownerIds = [
    ...new Set(
      requests.flatMap((r) =>
        library
          .filter((e) => e.gameName.toLowerCase() === r.gameName.toLowerCase())
          .map((e) => e.userId),
      ),
    ),
  ];
  const nameMap: Record<string, string> = {};
  try {
    const guild = await client.guilds.fetch(gameNight.guildId);
    await Promise.all(
      ownerIds.map(async (uid) => {
        try {
          nameMap[uid] = (await guild.members.fetch(uid)).displayName;
        } catch {
          nameMap[uid] = client.users.cache.get(uid)?.username ?? `User ${uid.slice(0, 6)}…`;
        }
      }),
    );
  } catch {
    /* guild unavailable — names fall back inside buildRequestEmbed */
  }

  const embed = await buildRequestEmbed(gameNight.guildId, requests, nameMap);

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(gameNight.eventChannelId)) as TextChannel;
  } catch {
    return;
  }

  if (gameNight.requestPinMessageId) {
    try {
      const msg = await channel.messages.fetch(gameNight.requestPinMessageId);
      await msg.edit({ embeds: [embed] });
      if (!msg.pinned) {
        try {
          await msg.pin();
        } catch (err) {
          console.warn(`Could not re-pin request message in channel ${gameNight.eventChannelId}:`, err);
        }
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  try {
    await msg.pin();
  } catch (err) {
    console.warn(`Could not pin request message in channel ${gameNight.eventChannelId}:`, err);
  }

  gameNight.requestPinMessageId = msg.id;
  await upsertGameNight(gameNight);
}

export function buildHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎮 Quick Actions')
    .setColor(0x57f287)
    .setDescription(
      "Prefer tapping over typing? Use the buttons below instead of slash commands.",
    )
    .addFields(
      { name: '🎲 Suggest a Game', value: "Add a game to this event's lineup." },
      { name: '🙋 Request a Game to Bring', value: 'Ask an owner to bring a specific game.' },
      { name: '📋 My Games to Bring', value: "See which of your games have been requested." },
      { name: '🍿 Snacks', value: 'See or add to the snacks list.' },
    );
}

export function buildHubButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_suggest').setLabel('🎲 Suggest a Game').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_request').setLabel('🙋 Request a Game to Bring').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_bring').setLabel('📋 My Games to Bring').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub_snacks').setLabel('🍿 Snacks').setStyle(ButtonStyle.Secondary),
  );
}

// Posted once at event-channel creation (see handleCreate in gamenight.ts) —
// unlike the other pins here, this doesn't wait for a suggest/request to
// happen first, since its whole purpose is to be the discovery mechanism for
// members who wouldn't otherwise know those commands exist.
export async function updateHubPin(client: Client, eventId: string): Promise<void> {
  const all = await loadGameNights();
  const gameNight = all.find((gn) => gn.id === eventId);
  if (!gameNight?.eventChannelId) return;

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(gameNight.eventChannelId)) as TextChannel;
  } catch {
    return;
  }

  const payload = { embeds: [buildHubEmbed()], components: [buildHubButtons()] };

  if (gameNight.hubPinMessageId) {
    try {
      const msg = await channel.messages.fetch(gameNight.hubPinMessageId);
      await msg.edit(payload);
      if (!msg.pinned) {
        try {
          await msg.pin();
        } catch (err) {
          console.warn(`Could not re-pin hub message in channel ${gameNight.eventChannelId}:`, err);
        }
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send(payload);
  try {
    await msg.pin();
  } catch (err) {
    console.warn(`Could not pin hub message in channel ${gameNight.eventChannelId}:`, err);
  }

  gameNight.hubPinMessageId = msg.id;
  await upsertGameNight(gameNight);
}
