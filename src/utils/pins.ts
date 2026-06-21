import { Client, TextChannel } from 'discord.js';
import { loadGameNights } from './storage';
import { getGuildConfig } from './config';

export async function updateAnnouncementPin(client: Client, guildId: string): Promise<void> {
  const config = getGuildConfig(guildId);
  if (!config.announcementsChannelId) return;

  let channel: TextChannel;
  try {
    channel = await client.channels.fetch(config.announcementsChannelId) as TextChannel;
  } catch {
    return;
  }

  // Unpin all existing bot pins in the announcements channel
  const pins = await channel.messages.fetchPinned();
  for (const [, msg] of pins) {
    if (msg.author.id === client.user!.id) await msg.unpin().catch(() => null);
  }

  // Pin the next upcoming event
  const now = Date.now();
  const next = loadGameNights()
    .filter(g =>
      !g.cancelled &&
      !g.archived &&
      g.messageId &&
      g.channelId === config.announcementsChannelId &&
      new Date(g.startTimeISO).getTime() > now
    )
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime())[0];

  if (next?.messageId) {
    const msg = await channel.messages.fetch(next.messageId).catch(() => null);
    await msg?.pin().catch(() => null);
  }
}
