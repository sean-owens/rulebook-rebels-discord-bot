import { Client, ChannelType, TextChannel } from 'discord.js';
import { GameNight } from '../utils/storage';
import { findGamesByEvent, removeGamesByEvent } from '../utils/gameStorage';
import { removeAllRequestsForEvent } from '../utils/libraryStorage';

export async function cleanupCancelledNight(client: Client, gn: GameNight): Promise<void> {
  // Delete individual game card messages first (they may be in channels other than eventChannelId)
  const games = await findGamesByEvent(gn.id);
  await Promise.allSettled(
    games.map(async (game) => {
      if (!game.channelId || !game.messageId) return;
      // Skip messages inside the event channel — they'll be gone when the channel is deleted
      if (game.channelId === gn.eventChannelId) return;
      try {
        const ch = (await client.channels.fetch(game.channelId)) as TextChannel;
        const msg = await ch.messages.fetch(game.messageId);
        await msg.delete();
      } catch {
        /* already deleted or channel gone */
      }
    }),
  );

  // Delete the event channel (removes all pinned messages, game cards, and user chat within it)
  if (gn.eventChannelId) {
    try {
      const ch = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;
      await ch.delete('Event cancelled');
    } catch {
      /* already deleted */
    }
  }

  // Delete the RSVP embed in the announcements channel
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
    } catch {
      /* already deleted/archived */
    }
  }

  // Purge all stored game suggestions and library requests for this event
  await removeGamesByEvent(gn.id);
  await removeAllRequestsForEvent(gn.id);
}
