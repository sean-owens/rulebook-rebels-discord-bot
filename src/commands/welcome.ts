import { ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { handleGuildMemberAdd } from '../events/guildMemberAdd';

export const data = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Manage the new member welcome message')
  .addSubcommand(sub =>
    sub
      .setName('config')
      .setDescription('Set welcome message options (admin only)')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel where welcome messages are posted (e.g. #introductions)').setRequired(false)
      )
      .addChannelOption(opt =>
        opt.setName('rules_channel').setDescription('Channel containing server rules').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('facebook_url').setDescription('Facebook group URL').setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('test')
      .setDescription('Preview the welcome message as if you just joined (admin only)')
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!isAdmin) {
    await interaction.reply({ content: 'Only admins can use welcome commands.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'config') await handleConfig(interaction);
  else if (sub === 'test') await handleTest(interaction);
}

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
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

async function handleTest(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  await handleGuildMemberAdd(member);
  await interaction.editReply('Welcome message sent! Check the welcome channel and your DMs.');
}
