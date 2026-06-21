import { Client, TextChannel } from 'discord.js';
import { GameNight } from '../utils/storage';

export async function cleanupCancelledNight(client: Client, gn: GameNight): Promise<void> {
  if (gn.eventChannelId) {
    try {
      const ch = await client.channels.fetch(gn.eventChannelId) as TextChannel;
      await ch.delete('Event cancelled');
    } catch { /* already deleted */ }
  }

  if (gn.messageId && gn.channelId) {
    try {
      const ch = await client.channels.fetch(gn.channelId) as TextChannel;
      const msg = await ch.messages.fetch(gn.messageId);
      await msg.delete();
    } catch { /* already deleted */ }
  }
}
