import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import { getGameRoles } from '../utils/gameRoles';

export const data = new SlashCommandBuilder()
  .setName('myroles')
  .setDescription('Set your game genre preferences');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const tags = getGameRoles(interaction.guildId!);

  if (tags.length === 0) {
    await interaction.reply({
      content: 'No game tags have been set up yet. Ask an admin to use `/gametags add` to create some.',
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const currentRoleIds = member.roles.cache;

  const select = new StringSelectMenuBuilder()
    .setCustomId('myroles_select')
    .setPlaceholder('Select the game types you enjoy...')
    .setMinValues(0)
    .setMaxValues(tags.length)
    .addOptions(
      tags.map(t =>
        new StringSelectMenuOptionBuilder()
          .setLabel(t.name)
          .setValue(t.roleId)
          .setDefault(currentRoleIds.has(t.roleId))
      )
    );

  const currentTags = tags.filter(t => currentRoleIds.has(t.roleId));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Your Game Preferences')
    .setDescription('Select all the game types you enjoy. Pick as many as you like — your current selections are pre-checked.')
    .addFields({
      name: 'Current tags',
      value: currentTags.length > 0 ? currentTags.map(t => `<@&${t.roleId}>`).join(' ') : '*None set*',
    });

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    ephemeral: true,
  });
}

export async function handleMyRolesSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferUpdate();

  const tags = getGameRoles(interaction.guildId!);
  const selectedRoleIds = new Set(interaction.values);
  const member = await interaction.guild!.members.fetch(interaction.user.id);

  const toAdd = tags.filter(t => selectedRoleIds.has(t.roleId) && !member.roles.cache.has(t.roleId));
  const toRemove = tags.filter(t => !selectedRoleIds.has(t.roleId) && member.roles.cache.has(t.roleId));

  await Promise.all([
    ...toAdd.map(t => member.roles.add(t.roleId)),
    ...toRemove.map(t => member.roles.remove(t.roleId)),
  ]);

  const newTags = tags.filter(t => selectedRoleIds.has(t.roleId));

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Game Preferences Updated!')
    .addFields({
      name: 'Your tags',
      value: newTags.length > 0 ? newTags.map(t => `<@&${t.roleId}>`).join(' ') : '*None set*',
    });

  await interaction.editReply({ embeds: [embed], components: [] });
}
