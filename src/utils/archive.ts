import { Client, ChannelType, TextChannel } from 'discord.js';
import { GameNight, upsertGameNight } from './storage';

export async function archiveEventChannel(client: Client, gn: GameNight): Promise<void> {
  if (!gn.eventChannelId || gn.archived) return;

  const guild = await client.guilds.fetch(gn.guildId);

  // Ensure bot's own channels cache is populated
  await guild.channels.fetch();

  // Find or create Archive category
  let archiveCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === 'Archive'
  );
  if (!archiveCategory) {
    archiveCategory = await guild.channels.create({
      name: 'Archive',
      type: ChannelType.GuildCategory,
    });
  }

  const channel = await client.channels.fetch(gn.eventChannelId) as TextChannel;

  // Ensure bot has explicit access to the channel before trying to modify it
  const me = await guild.members.fetchMe();
  await channel.permissionOverwrites.create(me, { ViewChannel: true, SendMessages: true, ManageMessages: true });

  // Make read-only for everyone (using create() to hit PUT endpoint, not PATCH)
  await channel.permissionOverwrites.create(guild.roles.everyone, {
    ViewChannel: true,
    SendMessages: false,
    AddReactions: false,
  });

  // Move to Archive category
  await channel.setParent(archiveCategory.id, { lockPermissions: false });

  await channel.send('*This event has concluded. The channel is now archived and read-only.*');

  // Remove the RSVP embed from the announcements channel
  if (gn.messageId && gn.channelId) {
    try {
      const announcementChannel = await client.channels.fetch(gn.channelId) as TextChannel;
      const msg = await announcementChannel.messages.fetch(gn.messageId);
      await msg.delete();
    } catch { /* already deleted */ }
  }

  gn.archived = true;
  upsertGameNight(gn);

  console.log(`Archived channel for game night ${gn.id}`);
}
