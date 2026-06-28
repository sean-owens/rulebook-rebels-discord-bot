import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../utils/config';

export async function handleVideoUploadersAdd(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const handle = interaction.options.getString('uploader', true).trim().toLowerCase();
  const config = getGuildConfig(interaction.guildId!);
  const current = config.trustedVideoUploaders ?? [];

  if (current.includes(handle)) {
    await interaction.reply({
      content: `**${handle}** is already in the trusted uploaders list.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  updateGuildConfig(interaction.guildId!, { trustedVideoUploaders: [...current, handle] });
  await interaction.reply({
    content: `Added **${handle}** to trusted video uploaders. New games suggested will prefer videos from this account.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleVideoUploadersRemove(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const handle = interaction.options.getString('uploader', true).trim().toLowerCase();
  const config = getGuildConfig(interaction.guildId!);
  const current = config.trustedVideoUploaders ?? [];

  if (!current.includes(handle)) {
    await interaction.reply({
      content: `**${handle}** is not in the trusted uploaders list.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  updateGuildConfig(interaction.guildId!, {
    trustedVideoUploaders: current.filter((u) => u !== handle),
  });
  await interaction.reply({
    content: `Removed **${handle}** from trusted video uploaders.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleVideoUploadersList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = getGuildConfig(interaction.guildId!);
  const list = config.trustedVideoUploaders ?? [];

  if (list.length === 0) {
    await interaction.reply({
      content:
        'No trusted video uploaders configured. Videos are selected by title keywords only.\nUse `/admin video uploaders add` to add BGG uploader handles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `**Trusted video uploaders (${list.length}):**\n${list.map((u) => `• ${u}`).join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}
