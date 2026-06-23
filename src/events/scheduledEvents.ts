import {
  GuildScheduledEvent,
  GuildScheduledEventStatus,
  PartialGuildScheduledEvent,
  User,
  PartialUser,
  TextChannel,
} from 'discord.js';
import { findGameNightByDiscordEventId, upsertGameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';
import { cleanupCancelledNight } from '../commands/cancelHelper';
import { archiveEventChannel } from '../utils/archive';
import { updateAnnouncementPin } from '../utils/pins';

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

  if (gn.eventChannelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.eventChannelId) as TextChannel;
      await ch.permissionOverwrites.delete(userId);
    } catch { /* channel may not exist */ }
  }

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

  if (gn.eventChannelId) {
    try {
      const ch = await scheduledEvent.client.channels.fetch(gn.eventChannelId) as TextChannel;
      await ch.permissionOverwrites.create(userId, { ViewChannel: true });
    } catch { /* channel may not exist */ }
  }

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
