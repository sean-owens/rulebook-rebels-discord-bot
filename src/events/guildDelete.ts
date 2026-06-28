import { Guild } from 'discord.js';
import { markGuildDeleted } from '../utils/guildLifecycle';

export function handleGuildDelete(guild: Guild): void {
  markGuildDeleted(guild.id, guild.name);
  console.log(
    `[GuildDelete] Bot removed from "${guild.name}" — data marked for deletion in 30 days`,
  );
}
