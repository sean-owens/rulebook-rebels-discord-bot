import { Client, ChannelType, TextChannel } from 'discord.js';
import { GameNight, loadGameNights, upsertGameNight } from './storage';
import { getGuildConfig } from './config';

const LOCK_DELAY_DAYS = 7;

export async function archiveEventChannel(client: Client, gn: GameNight): Promise<void> {
  if (!gn.eventChannelId || gn.archived) return;

  const guild = await client.guilds.fetch(gn.guildId);
  await guild.channels.fetch();

  const { archiveCategoryName } = getGuildConfig(gn.guildId);
  let archiveCategory = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === archiveCategoryName,
  );
  if (!archiveCategory) {
    archiveCategory = await guild.channels.create({
      name: archiveCategoryName,
      type: ChannelType.GuildCategory,
    });
  }

  const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;

  const me = await guild.members.fetchMe();
  await channel.permissionOverwrites.create(me, {
    ViewChannel: true,
    SendMessages: true,
    ManageMessages: true,
  });

  // Move to Archive category without locking — locking happens after LOCK_DELAY_DAYS
  await channel.setParent(archiveCategory.id, { lockPermissions: false });

  const lockDate = new Date();
  lockDate.setDate(lockDate.getDate() + LOCK_DELAY_DAYS);
  const lockDateStr = lockDate.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  await channel.send(
    `*This event has concluded. The channel has been archived and will become read-only on ${lockDateStr}.*`,
  );

  // Clean up the announcement
  if (gn.messageId && gn.channelId) {
    try {
      const announcementChannel = await client.channels.fetch(gn.channelId);
      if (announcementChannel?.type === ChannelType.GuildForum) {
        const thread = await client.channels.fetch(gn.messageId);
        if (thread?.isThread()) {
          await thread.send('*This event has concluded. The thread is now archived.*');
          await thread.setLocked(true);
          await thread.setArchived(true);
        }
      } else {
        const msg = await (announcementChannel as TextChannel).messages.fetch(gn.messageId);
        await msg.delete();
      }
    } catch {
      /* already deleted/archived */
    }
  }

  gn.archived = true;
  gn.lockAt = lockDate.toISOString();
  upsertGameNight(gn);

  console.log(`Archived channel for game night ${gn.id}, will lock on ${lockDateStr}`);
}

export async function lockEventChannel(client: Client, gn: GameNight): Promise<void> {
  if (!gn.eventChannelId || gn.locked) return;

  try {
    const guild = await client.guilds.fetch(gn.guildId);
    const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;

    await channel.permissionOverwrites.create(guild.roles.everyone, {
      ViewChannel: true,
      SendMessages: false,
      AddReactions: false,
    });

    await channel.send('*This channel is now read-only.*');

    gn.locked = true;
    upsertGameNight(gn);

    console.log(`Locked channel for game night ${gn.id}`);
  } catch (err) {
    console.warn(`Could not lock channel for game night ${gn.id}:`, err);
  }
}

export async function archiveExpiredEvents(client: Client): Promise<void> {
  const now = new Date();
  const expired = loadGameNights().filter(
    (gn) =>
      !gn.cancelled &&
      !gn.archived &&
      gn.endTimeISO &&
      new Date(gn.endTimeISO) <= now,
  );

  for (const gn of expired) {
    console.log(`Auto-archiving expired event ${gn.id} (ended ${gn.endTimeISO})`);
    if (gn.eventChannelId) {
      await archiveEventChannel(client, gn);
    } else {
      // No event channel — just clean up the announcement and mark archived
      if (gn.messageId && gn.channelId) {
        try {
          const announcementChannel = await client.channels.fetch(gn.channelId);
          if (announcementChannel?.type === ChannelType.GuildForum) {
            const thread = await client.channels.fetch(gn.messageId);
            if (thread?.isThread()) {
              await thread.send('*This event has concluded. The thread is now archived.*');
              await thread.setLocked(true);
              await thread.setArchived(true);
            }
          } else {
            const msg = await (announcementChannel as TextChannel).messages.fetch(gn.messageId);
            await msg.delete();
          }
        } catch {
          /* already cleaned up */
        }
      }
      gn.archived = true;
      upsertGameNight(gn);
    }
  }
}

export async function checkPendingLocks(client: Client): Promise<void> {
  const now = new Date();
  const pending = loadGameNights().filter(
    (gn) => gn.archived && !gn.locked && gn.lockAt && new Date(gn.lockAt) <= now,
  );
  for (const gn of pending) {
    await lockEventChannel(client, gn);
  }
}

export async function deleteArchivedChannels(client: Client): Promise<void> {
  const now = new Date();
  const candidates = loadGameNights().filter(
    (gn) => gn.archived && gn.locked && gn.eventChannelId && !gn.channelDeleted && gn.lockAt,
  );
  for (const gn of candidates) {
    const { archivedChannelRetentionDays } = getGuildConfig(gn.guildId);
    if (!archivedChannelRetentionDays) continue; // 0 = disabled

    const retentionAfterLock = Math.max(0, archivedChannelRetentionDays - LOCK_DELAY_DAYS);
    const deleteAt = new Date(gn.lockAt!);
    deleteAt.setDate(deleteAt.getDate() + retentionAfterLock);
    if (deleteAt > now) continue;

    try {
      const channel = await client.channels.fetch(gn.eventChannelId!);
      await channel?.delete();
    } catch {
      /* already deleted or inaccessible */
    }
    gn.channelDeleted = true;
    upsertGameNight(gn);
    console.log(`Auto-deleted archived channel for game night ${gn.id} after ${archivedChannelRetentionDays} days`);
  }
}
