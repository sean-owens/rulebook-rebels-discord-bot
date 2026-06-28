import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { getGameRoles, GameRole } from '../utils/gameRoles';

const GENRE_PAGE_SIZE = 20; // 4 rows of genre buttons, row 5 for controls
const MAX_GENRE_TAGS = 5;

const pendingSelections = new Map<string, Set<string>>();

export const data = new SlashCommandBuilder()
  .setName('myroles')
  .setDescription('Set your game genre preferences and difficulty level');

function splitTags(tags: GameRole[]): { genreTags: GameRole[]; difficultyTags: GameRole[] } {
  return {
    genreTags: tags.filter((t) => t.type !== 'difficulty'),
    difficultyTags: tags.filter((t) => t.type === 'difficulty'),
  };
}

function buildDifficultyStep(
  difficultyTags: GameRole[],
  selected: Set<string>,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const selectedDiff = difficultyTags.filter((t) => selected.has(t.roleId));

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  if (difficultyTags.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        difficultyTags.map((t) =>
          new ButtonBuilder()
            .setCustomId(`myroles_diff_${t.roleId}`)
            .setLabel(`⚖️ ${t.name}`)
            .setStyle(selected.has(t.roleId) ? ButtonStyle.Success : ButtonStyle.Primary),
        ),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('myroles_next')
        .setLabel('Next: Pick Genres →')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Your Game Preferences — Step 1 of 2')
    .setDescription(
      'How complex do you like your games? Pick a difficulty level that fits your style best.',
    )
    .addFields({
      name: 'Selected Difficulty',
      value:
        selectedDiff.length > 0
          ? selectedDiff.map((t) => `<@&${t.roleId}>`).join(' ')
          : '*None — skip if you have no preference*',
    });

  return { embeds: [embed], components: rows };
}

function buildGenreStep(
  genreTags: GameRole[],
  difficultyTags: GameRole[],
  selected: Set<string>,
  page: number,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const totalPages = Math.ceil(genreTags.length / GENRE_PAGE_SIZE);
  const pageRoles = genreTags.slice(page * GENRE_PAGE_SIZE, (page + 1) * GENRE_PAGE_SIZE);

  const selectedDiff = difficultyTags.filter((t) => selected.has(t.roleId));
  const selectedGenre = genreTags.filter((t) => selected.has(t.roleId));
  const selectedGenreCount = selectedGenre.length;
  const atLimit = selectedGenreCount >= MAX_GENRE_TAGS;

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Genre tag rows (up to 4 rows × 5 buttons)
  for (let i = 0; i < pageRoles.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        pageRoles.slice(i, i + 5).map((t) => {
          const isSelected = selected.has(t.roleId);
          return new ButtonBuilder()
            .setCustomId(`myroles_tag_${page}_${t.roleId}`)
            .setLabel(t.name)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(atLimit && !isSelected);
        }),
      ),
    );
  }

  // Control row: back to difficulty, pagination, save
  const controlRow: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId('myroles_back_diff')
      .setLabel('← Difficulty')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (totalPages > 1 && page > 0) {
    controlRow.push(
      new ButtonBuilder()
        .setCustomId(`myroles_page_${page - 1}`)
        .setLabel('← Back')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (totalPages > 1 && page < totalPages - 1) {
    controlRow.push(
      new ButtonBuilder()
        .setCustomId(`myroles_page_${page + 1}`)
        .setLabel('Next →')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  controlRow.push(
    new ButtonBuilder()
      .setCustomId('myroles_submit')
      .setLabel('Save')
      .setStyle(ButtonStyle.Primary),
  );
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...controlRow));

  const pageNote = totalPages > 1 ? ` — page ${page + 1}/${totalPages}` : '';
  const genreLabel = `Genres (${selectedGenreCount}/${MAX_GENRE_TAGS})${atLimit ? ' — limit reached' : ''}`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Your Game Preferences — Step 2 of 2${pageNote}`)
    .setDescription(
      'Pick up to **5 genre tags** that best describe the types of games you enjoy most.',
    )
    .addFields(
      {
        name: 'Difficulty',
        value:
          selectedDiff.length > 0
            ? selectedDiff.map((t) => `<@&${t.roleId}>`).join(' ')
            : '*None selected*',
        inline: true,
      },
      {
        name: genreLabel,
        value:
          selectedGenre.length > 0
            ? selectedGenre.map((t) => `<@&${t.roleId}>`).join(' ')
            : '*None selected*',
        inline: true,
      },
    );

  return { embeds: [embed], components: rows };
}

async function initPending(
  interaction: ButtonInteraction,
  allTags: GameRole[],
): Promise<Set<string>> {
  if (!pendingSelections.has(interaction.user.id)) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const tagRoleIds = new Set(allTags.map((t) => t.roleId));
    pendingSelections.set(
      interaction.user.id,
      new Set([...member.roles.cache.keys()].filter((id) => tagRoleIds.has(id))),
    );
  }
  return pendingSelections.get(interaction.user.id)!;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const allTags = getGameRoles(interaction.guildId!);

  if (allTags.length === 0) {
    await interaction.reply({
      content: 'No game tags have been set up yet. Ask an admin to run `/gametags sync`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { difficultyTags } = splitTags(allTags);
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const tagRoleIds = new Set(allTags.map((t) => t.roleId));
  const selected = new Set([...member.roles.cache.keys()].filter((id) => tagRoleIds.has(id)));
  pendingSelections.set(interaction.user.id, selected);

  if (difficultyTags.length > 0) {
    await interaction.reply({ ...buildDifficultyStep(difficultyTags, selected), flags: MessageFlags.Ephemeral });
  } else {
    const { genreTags } = splitTags(allTags);
    await interaction.reply({ ...buildGenreStep(genreTags, [], selected, 0), flags: MessageFlags.Ephemeral });
  }
}

export async function handleMyRolesDiff(
  interaction: ButtonInteraction,
  roleId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const allTags = getGameRoles(interaction.guildId!);
  const { difficultyTags } = splitTags(allTags);
  const selected = await initPending(interaction, allTags);

  const wasSelected = selected.has(roleId);
  for (const diff of difficultyTags) selected.delete(diff.roleId);
  if (!wasSelected) selected.add(roleId);

  await interaction.editReply(buildDifficultyStep(difficultyTags, selected));
}

export async function handleMyRolesNext(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const allTags = getGameRoles(interaction.guildId!);
  const { genreTags, difficultyTags } = splitTags(allTags);
  const selected = await initPending(interaction, allTags);

  await interaction.editReply(buildGenreStep(genreTags, difficultyTags, selected, 0));
}

export async function handleMyRolesBackDiff(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const allTags = getGameRoles(interaction.guildId!);
  const { difficultyTags } = splitTags(allTags);
  const selected = await initPending(interaction, allTags);

  await interaction.editReply(buildDifficultyStep(difficultyTags, selected));
}

export async function handleMyRolesTag(
  interaction: ButtonInteraction,
  page: number,
  roleId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const allTags = getGameRoles(interaction.guildId!);
  const { genreTags, difficultyTags } = splitTags(allTags);
  const selected = await initPending(interaction, allTags);

  if (selected.has(roleId)) {
    selected.delete(roleId);
  } else {
    const currentGenreCount = genreTags.filter((t) => selected.has(t.roleId)).length;
    if (currentGenreCount < MAX_GENRE_TAGS) selected.add(roleId);
  }

  await interaction.editReply(buildGenreStep(genreTags, difficultyTags, selected, page));
}

export async function handleMyRolesPage(
  interaction: ButtonInteraction,
  page: number,
): Promise<void> {
  await interaction.deferUpdate();
  const allTags = getGameRoles(interaction.guildId!);
  const { genreTags, difficultyTags } = splitTags(allTags);
  const selected = await initPending(interaction, allTags);

  await interaction.editReply(buildGenreStep(genreTags, difficultyTags, selected, page));
}

export async function handleMyRolesSubmit(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const allTags = getGameRoles(interaction.guildId!);
  const { genreTags, difficultyTags } = splitTags(allTags);
  const member = await interaction.guild!.members.fetch(interaction.user.id);

  const selected =
    pendingSelections.get(interaction.user.id) ??
    new Set([...member.roles.cache.keys()].filter((id) => allTags.some((t) => t.roleId === id)));
  pendingSelections.delete(interaction.user.id);

  const toAdd = allTags.filter((t) => selected.has(t.roleId) && !member.roles.cache.has(t.roleId));
  const toRemove = allTags.filter(
    (t) => !selected.has(t.roleId) && member.roles.cache.has(t.roleId),
  );

  await Promise.all([
    ...toAdd.map((t) => member.roles.add(t.roleId)),
    ...toRemove.map((t) => member.roles.remove(t.roleId)),
  ]);

  const selectedDiff = difficultyTags.filter((t) => selected.has(t.roleId));
  const selectedGenre = genreTags.filter((t) => selected.has(t.roleId));

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Game Preferences Saved!')
    .addFields(
      {
        name: 'Difficulty',
        value:
          selectedDiff.length > 0
            ? selectedDiff.map((t) => `<@&${t.roleId}>`).join(' ')
            : '*None selected*',
        inline: true,
      },
      {
        name: 'Genres',
        value:
          selectedGenre.length > 0
            ? selectedGenre.map((t) => `<@&${t.roleId}>`).join(' ')
            : '*None selected*',
        inline: true,
      },
    );

  await interaction.editReply({ embeds: [embed], components: [] });
}
