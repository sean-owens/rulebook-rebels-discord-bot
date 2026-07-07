import { Guild, PermissionFlagsBits } from 'discord.js';
import { restoreGuild } from '../utils/guildLifecycle';

const SETUP_ROLES = [
  {
    name: 'Admin',
    colors: { primaryColor: '#e74c3c' as `#${string}` },
    permissions: [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageEvents,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageChannels,
    ],
    reason: 'Rulebook Rebels Bot setup — required for /admin commands',
  },
  {
    name: 'Host',
    colors: { primaryColor: '#3498db' as `#${string}` },
    permissions: [PermissionFlagsBits.ManageEvents, PermissionFlagsBits.ManageMessages],
    reason: 'Rulebook Rebels Bot setup — required for /host commands',
  },
];

export async function handleGuildCreate(guild: Guild): Promise<void> {
  const restored = await restoreGuild(guild.id);
  if (restored) {
    console.log(
      `[GuildCreate] Bot re-added to "${guild.name}" — data restored (was pending deletion)`,
    );
  }

  let existing;
  try {
    existing = await guild.roles.fetch();
  } catch (err) {
    console.error(`[GuildCreate] Failed to fetch roles in ${guild.name}:`, err);
    return;
  }

  const existingNames = new Set(existing.map((r) => r.name.toLowerCase()));

  for (const role of SETUP_ROLES) {
    if (existingNames.has(role.name.toLowerCase())) {
      console.log(`[GuildCreate] "${role.name}" role already exists in ${guild.name} — skipping`);
      continue;
    }
    try {
      await guild.roles.create({
        name: role.name,
        colors: role.colors,
        permissions: role.permissions,
        reason: role.reason,
      });
      console.log(`[GuildCreate] Created "${role.name}" role in ${guild.name}`);
    } catch (err) {
      console.error(`[GuildCreate] Failed to create "${role.name}" role in ${guild.name}:`, err);
    }
  }
}
