import { Client, ChannelType, TextChannel } from 'discord.js';
import { loadGameNights } from './storage';
import { getGuildConfig } from './config';

export async function updateAnnouncementPin(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config.announcementsChannelId) return;

  let channel: TextChannel;
  try {
    const fetched = await client.channels.fetch(config.announcementsChannelId);
    if (!fetched || fetched.type === ChannelType.GuildForum) return; // forum threads manage their own pins
    channel = fetched as TextChannel;
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
  const next = (await loadGameNights())
    .filter(
      (g) =>
        !g.cancelled &&
        !g.archived &&
        g.messageId &&
        g.channelId === config.announcementsChannelId &&
        new Date(g.startTimeISO).getTime() > now,
    )
    .sort((a, b) => new Date(a.startTimeISO).getTime() - new Date(b.startTimeISO).getTime())[0];

  if (next?.messageId) {
    const msg = await channel.messages.fetch(next.messageId).catch(() => null);
    await msg?.pin().catch(() => null);
  }
}
