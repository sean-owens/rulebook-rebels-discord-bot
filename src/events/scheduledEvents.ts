import {
  GuildScheduledEvent,
  GuildScheduledEventStatus,
  PartialGuildScheduledEvent,
  User,
  PartialUser,
  ChannelType,
  TextChannel,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { findGameNightByDiscordEventId, upsertGameNight, GameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';
import { cleanupCancelledNight } from '../commands/cancelHelper';
import { archiveEventChannel } from '../utils/archive';
import { updateAnnouncementPin } from '../utils/pins';

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export async function handleScheduledEventCreate(scheduledEvent: GuildScheduledEvent): Promise<void> {
  const guild = scheduledEvent.guild;
  if (!guild || !scheduledEvent.scheduledStartAt) return;

  const date = formatDate(scheduledEvent.scheduledStartAt);
  const time = formatTime(scheduledEvent.scheduledStartAt);
  const location = scheduledEvent.entityMetadata?.location ?? 'TBD';
  const description = scheduledEvent.description ?? '';
  const id = randomUUID().slice(0, 8);

  // Find or create "Game Nights" category
  let categoryId: string | undefined;
  try {
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === 'Game Nights'
    );
    if (!category) {
      category = await guild.channels.create({ name: 'Game Nights', type: ChannelType.GuildCategory });
    }
    categoryId = category.id;
  } catch (err) {
    console.warn('Could not create Game Nights category:', err);
  }

  // Create event-specific channel
  let eventChannelId: string | null = null;
  let eventChannel: TextChannel | null = null;
  try {
    const channelName = `monthly-${slugify(scheduledEvent.scheduledStartAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))}`;
    eventChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `${scheduledEvent.name} — ${date} at ${time} | ${location}`,
    }) as TextChannel;
    eventChannelId = eventChannel.id;
  } catch (err) {
    console.warn('Could not create event channel:', err);
  }

  const gn: GameNight = {
    id,
    date,
    time,
    location,
    link: '',
    description,
    messageId: '',
    channelId: eventChannelId ?? '',
    guildId: guild.id,
    discordEventId: scheduledEvent.id,
    eventChannelId,
    startTimeISO: scheduledEvent.scheduledStartAt.toISOString(),
    endTimeISO: scheduledEvent.scheduledEndAt?.toISOString() ?? null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: scheduledEvent.creatorId ?? '',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
  };

  if (eventChannel) {
    try {
      const msg = await eventChannel.send({
        content: `**${scheduledEvent.name}** has been scheduled! RSVP below.`,
        embeds: [buildGameNightEmbed(gn, {})],
        components: [buildGameNightButtons(id)],
      });
      gn.messageId = msg.id;
      await msg.pin().catch(() => null);
    } catch (err) {
      console.warn('Could not post RSVP embed:', err);
    }
  }

  upsertGameNight(gn);
  console.log(`Game night created: ${id} for event "${scheduledEvent.name}"`);
}

export async function handleScheduledEventDelete(
  scheduledEvent: GuildScheduledEvent | PartialGuildScheduledEvent,
): Promise<void> {
  const gn = findGameNightByDiscordEventId(scheduledEvent.id);
  if (!gn || gn.cancelled) return;
  gn.cancelled = true;
  upsertGameNight(gn);
  await cleanupCancelledNight(scheduledEvent.client, gn);
}

export async function handleScheduledEventUpdate(
  _old: GuildScheduledEvent | PartialGuildScheduledEvent | null,
  newEvent: GuildScheduledEvent | PartialGuildScheduledEvent,
): Promise<void> {
  const gn = findGameNightByDiscordEventId(newEvent.id);
  if (!gn) return;

  if (newEvent.status === GuildScheduledEventStatus.Canceled && !gn.cancelled) {
    gn.cancelled = true;
    upsertGameNight(gn);
    await cleanupCancelledNight(newEvent.client, gn);
    await updateAnnouncementPin(newEvent.client, gn.guildId).catch(() => null);
  }

  if (newEvent.status === GuildScheduledEventStatus.Completed && !gn.archived) {
    await archiveEventChannel(newEvent.client, gn).catch(err =>
      console.warn('Could not archive event channel:', err)
    );
    await updateAnnouncementPin(newEvent.client, gn.guildId).catch(() => null);
  }
}

// When someone removes "Interested" on the native Discord event, mark them Can't Go in the bot
export async function handleScheduledEventUserRemove(
  scheduledEvent: GuildScheduledEvent | PartialGuildScheduledEvent,
  user: User | PartialUser,
): Promise<void> {
  const gn = findGameNightByDiscordEventId(scheduledEvent.id);
  if (!gn || gn.cancelled || gn.archived) return;

  const userId = user.id;
  if (gn.rsvps.no.includes(userId)) return;

  gn.rsvps.yes = gn.rsvps.yes.filter(id => id !== userId);
  gn.rsvps.maybe = gn.rsvps.maybe.filter(id => id !== userId);
  gn.rsvps.no.push(userId);
  upsertGameNight(gn);

  // Revoke access to the private event channel
  if (gn.eventChannelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.eventChannelId) as TextChannel;
      await ch.permissionOverwrites.delete(userId);
    } catch { /* channel may not exist */ }
  }

  // Update the RSVP embed
  if (gn.messageId && gn.channelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.channelId) as TextChannel;
      const msg = await ch.messages.fetch(gn.messageId);
      await msg.edit({
        embeds: [buildGameNightEmbed(gn, {})],
        components: [buildGameNightButtons(gn.id)],
      });
    } catch { /* message deleted */ }
  }
}

// When someone clicks "Interested" on the native Discord event, mark them Going in the bot
export async function handleScheduledEventUserAdd(
  scheduledEvent: GuildScheduledEvent | PartialGuildScheduledEvent,
  user: User | PartialUser,
): Promise<void> {
  const gn = findGameNightByDiscordEventId(scheduledEvent.id);
  if (!gn || gn.cancelled || gn.archived) return;

  const userId = user.id;
  if (gn.rsvps.yes.includes(userId)) return;

  gn.rsvps.maybe = gn.rsvps.maybe.filter(id => id !== userId);
  gn.rsvps.no = gn.rsvps.no.filter(id => id !== userId);
  gn.rsvps.yes.push(userId);
  upsertGameNight(gn);

  // Grant access to the private event channel
  if (gn.eventChannelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.eventChannelId) as TextChannel;
      await ch.permissionOverwrites.create(userId, { ViewChannel: true });
    } catch { /* channel may not exist */ }
  }

  // Update the RSVP embed
  if (gn.messageId && gn.channelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.channelId) as TextChannel;
      const msg = await ch.messages.fetch(gn.messageId);
      await msg.edit({
        embeds: [buildGameNightEmbed(gn, {})],
        components: [buildGameNightButtons(gn.id)],
      });
    } catch { /* message deleted */ }
  }
}

