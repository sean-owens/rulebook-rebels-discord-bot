import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { bggAutoSyncDaysFor, DEFAULT_BGG_AUTO_SYNC_DAYS, getGuildConfig, updateGuildConfig } from '../utils/config';

export function describeAutoSync(days: number): string {
  return days > 0
    ? `Automatic BoardGameGeek library re-sync: every **${days} day${days !== 1 ? 's' : ''}**.`
    : 'Automatic BoardGameGeek library re-sync: **off**.';
}

// /admin library autosync [days] — shows the server's setting, or changes it.
// 0 turns automatic re-sync off; members can still run /library import bgg themselves.
export async function handleAutoSyncConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const days = interaction.options.getInteger('days');

  if (days === null) {
    const current = bggAutoSyncDaysFor(await getGuildConfig(guildId));
    await interaction.reply({
      content: `${describeAutoSync(current)}\nChange it with \`/admin library autosync days:<number>\` (0 = off, default ${DEFAULT_BGG_AUTO_SYNC_DAYS}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await updateGuildConfig(guildId, { bggAutoSyncDays: days });
  await interaction.reply({
    content: `✅ ${describeAutoSync(days)}${days > 0 ? ' Only members who have linked BGG and imported at least once are synced.' : ''}`,
    flags: MessageFlags.Ephemeral,
  });
}
