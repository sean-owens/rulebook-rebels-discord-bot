import { Client, ChannelType, TextChannel } from 'discord.js';
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
      const ch = await client.channels.fetch(gn.channelId);
      if (ch?.type === ChannelType.GuildForum) {
        const thread = await client.channels.fetch(gn.messageId);
        if (thread?.isThread()) {
          await thread.send('*This event has been cancelled. The thread is now archived.*');
          await thread.setLocked(true);
          await thread.setArchived(true);
        }
      } else {
        const msg = await (ch as TextChannel).messages.fetch(gn.messageId);
        await msg.delete();
      }
    } catch { /* already deleted/archived */ }
  }
}
