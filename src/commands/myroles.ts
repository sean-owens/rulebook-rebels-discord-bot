import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getGameRoles, GameRole } from '../utils/gameRoles';

const PAGE_SIZE = 20; // 4 rows × 5 tag buttons, leaving row 5 for nav + submit

// Pending selections: userId → set of roleIds the user has toggled ON
const pendingSelections = new Map<string, Set<string>>();

export const data = new SlashCommandBuilder()
  .setName('myroles')
  .setDescription('Set your game genre preferences');

function buildRolesPage(
  tags: GameRole[],
  selected: Set<string>,
  page: number,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const totalPages = Math.ceil(tags.length / PAGE_SIZE);
  const pageRoles = tags.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Tag toggle buttons — up to 4 rows of 5
  const tagRows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < pageRoles.length; i += 5) {
    tagRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        pageRoles.slice(i, i + 5).map(t =>
          new ButtonBuilder()
            .setCustomId(`myroles_tag_${page}_${t.roleId}`)
            .setLabel(t.name)
            .setStyle(selected.has(t.roleId) ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
      )
    );
  }

  // Row 5: nav buttons (if multi-page) + Submit
  const controlRow: ButtonBuilder[] = [];
  if (totalPages > 1 && page > 0) {
    controlRow.push(
      new ButtonBuilder()
        .setCustomId(`myroles_page_${page - 1}`)
        .setLabel('← Back')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (totalPages > 1 && page < totalPages - 1) {
    controlRow.push(
      new ButtonBuilder()
        .setCustomId(`myroles_page_${page + 1}`)
        .setLabel('Next →')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  controlRow.push(
    new ButtonBuilder()
      .setCustomId('myroles_submit')
      .setLabel('Save')
      .setStyle(ButtonStyle.Primary)
  );
  tagRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...controlRow));

  const currentSelected = tags.filter(t => selected.has(t.roleId));
  const pageNote = totalPages > 1 ? ` — page ${page + 1}/${totalPages}` : '';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Your Game Preferences${pageNote}`)
    .setDescription('Toggle your game types, then hit **Save** when you\'re done.')
    .addFields({
      name: 'Selected',
      value: currentSelected.length > 0 ? currentSelected.map(t => `<@&${t.roleId}>`).join(' ') : '*None selected*',
    });

  return { embeds: [embed], components: tagRows };
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const tags = getGameRoles(interaction.guildId!);

  if (tags.length === 0) {
    await interaction.reply({
      content: 'No game tags have been set up yet. Ask an admin to run `/gametags sync`.',
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const tagRoleIds = new Set(tags.map(t => t.roleId));
  const selected = new Set([...member.roles.cache.keys()].filter(id => tagRoleIds.has(id)));
  pendingSelections.set(interaction.user.id, selected);

  await interaction.reply({ ...buildRolesPage(tags, selected, 0), ephemeral: true });
}

export async function handleMyRolesTag(
  interaction: ButtonInteraction,
  page: number,
  roleId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const tags = getGameRoles(interaction.guildId!);

  // Initialise pending state if bot restarted mid-session
  if (!pendingSelections.has(interaction.user.id)) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const tagRoleIds = new Set(tags.map(t => t.roleId));
    pendingSelections.set(
      interaction.user.id,
      new Set([...member.roles.cache.keys()].filter(id => tagRoleIds.has(id))),
    );
  }

  const selected = pendingSelections.get(interaction.user.id)!;
  if (selected.has(roleId)) selected.delete(roleId);
  else selected.add(roleId);

  await interaction.editReply(buildRolesPage(tags, selected, page));
}

export async function handleMyRolesPage(
  interaction: ButtonInteraction,
  page: number,
): Promise<void> {
  await interaction.deferUpdate();
  const tags = getGameRoles(interaction.guildId!);

  if (!pendingSelections.has(interaction.user.id)) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const tagRoleIds = new Set(tags.map(t => t.roleId));
    pendingSelections.set(
      interaction.user.id,
      new Set([...member.roles.cache.keys()].filter(id => tagRoleIds.has(id))),
    );
  }

  const selected = pendingSelections.get(interaction.user.id)!;
  await interaction.editReply(buildRolesPage(tags, selected, page));
}

export async function handleMyRolesSubmit(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const tags = getGameRoles(interaction.guildId!);
  const member = await interaction.guild!.members.fetch(interaction.user.id);

  const selected = pendingSelections.get(interaction.user.id)
    ?? new Set([...member.roles.cache.keys()].filter(id => tags.some(t => t.roleId === id)));
  pendingSelections.delete(interaction.user.id);

  const toAdd = tags.filter(t => selected.has(t.roleId) && !member.roles.cache.has(t.roleId));
  const toRemove = tags.filter(t => !selected.has(t.roleId) && member.roles.cache.has(t.roleId));

  await Promise.all([
    ...toAdd.map(t => member.roles.add(t.roleId)),
    ...toRemove.map(t => member.roles.remove(t.roleId)),
  ]);

  const newTags = tags.filter(t => selected.has(t.roleId));
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Game Preferences Saved!')
    .addFields({
      name: 'Your tags',
      value: newTags.length > 0 ? newTags.map(t => `<@&${t.roleId}>`).join(' ') : '*None selected*',
    });

  await interaction.editReply({ embeds: [embed], components: [] });
}
