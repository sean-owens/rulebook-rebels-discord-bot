import { ChatInputCommandInteraction } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { handleGuildMemberAdd } from '../events/guildMemberAdd';

export async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const patch: Record<string, string> = {};
  const channel = interaction.options.getChannel('channel');
  const rulesChannel = interaction.options.getChannel('rules_channel');
  const facebookUrl = interaction.options.getString('facebook_url');

  if (channel !== null) patch.welcomeChannelId = channel.id;
  if (rulesChannel !== null) patch.rulesChannelId = rulesChannel.id;
  if (facebookUrl !== null) patch.facebookGroupUrl = facebookUrl;

  const ch = (id: string) => id ? `<#${id}>` : '*not set*';

  if (Object.keys(patch).length === 0) {
    const c = getGuildConfig(interaction.guildId!);
    await interaction.reply({
      content: [
        '**Welcome config:**',
        `> Welcome channel: ${ch(c.welcomeChannelId)}`,
        `> Rules channel: ${ch(c.rulesChannelId)}`,
        `> Facebook group: ${c.facebookGroupUrl || '*not set*'}`,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  const updated = updateGuildConfig(interaction.guildId!, patch);
  await interaction.reply({
    content: [
      '**Welcome config updated:**',
      `> Welcome channel: ${ch(updated.welcomeChannelId)}`,
      `> Rules channel: ${ch(updated.rulesChannelId)}`,
      `> Facebook group: ${updated.facebookGroupUrl || '*not set*'}`,
    ].join('\n'),
    ephemeral: true,
  });
}

export async function handleTest(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  await handleGuildMemberAdd(member);
  await interaction.editReply('Welcome message sent! Check the welcome channel and your DMs.');
}

export async function handleGreet(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('member', true);
  const member = await interaction.guild!.members.fetch(user.id);
  await handleGuildMemberAdd(member);
  await interaction.editReply(`Welcome message sent to ${member}!`);
}
