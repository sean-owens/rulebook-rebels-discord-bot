import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { handleGuildMemberAdd } from '../events/guildMemberAdd';

export async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const patch: Record<string, string> = {};
  const channel = interaction.options.getChannel('channel');
  const announcementChannel = interaction.options.getChannel('announcement_channel');
  const rulesChannel = interaction.options.getChannel('rules_channel');
  const facebookUrl = interaction.options.getString('facebook_url');
  const bggUrl = interaction.options.getString('bgg_url');

  if (channel !== null) patch.welcomeChannelId = channel.id;
  if (announcementChannel !== null) patch.memberAnnouncementChannelId = announcementChannel.id;
  if (rulesChannel !== null) patch.rulesChannelId = rulesChannel.id;
  if (facebookUrl !== null) patch.facebookGroupUrl = facebookUrl;
  if (bggUrl !== null) patch.bggGroupUrl = bggUrl;

  const ch = (id: string) => (id ? `<#${id}>` : '*not set*');

  if (Object.keys(patch).length === 0) {
    const c = await getGuildConfig(interaction.guildId!);
    await interaction.reply({
      content: [
        '**Welcome config:**',
        `> Welcome channel: ${ch(c.welcomeChannelId)}`,
        `> Announcement channel: ${ch(c.memberAnnouncementChannelId)}`,
        `> Rules channel: ${ch(c.rulesChannelId)}`,
        `> Facebook group: ${c.facebookGroupUrl || '*not set*'}`,
        `> BGG group: ${c.bggGroupUrl || '*not set*'}`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updated = await updateGuildConfig(interaction.guildId!, patch);
  await interaction.reply({
    content: [
      '**Welcome config updated:**',
      `> Welcome channel: ${ch(updated.welcomeChannelId)}`,
      `> Announcement channel: ${ch(updated.memberAnnouncementChannelId)}`,
      `> Rules channel: ${ch(updated.rulesChannelId)}`,
      `> Facebook group: ${updated.facebookGroupUrl || '*not set*'}`,
      `> BGG group: ${updated.bggGroupUrl || '*not set*'}`,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleTest(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  await handleGuildMemberAdd(member);
  await interaction.editReply(
    'Welcome message sent! Check the welcome channel, announcement channel, and your DMs.',
  );
}

export async function handleGreet(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('member', true);
  const member = await interaction.guild!.members.fetch(user.id);
  await handleGuildMemberAdd(member);
  await interaction.editReply(`Welcome message sent to ${member}!`);
}
