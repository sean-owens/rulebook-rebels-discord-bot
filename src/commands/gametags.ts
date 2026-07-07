import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { GENRE_TAG_DEFINITIONS, DIFFICULTY_TAG_DEFINITIONS } from '../utils/tagDefinitions';

const COLOR_PALETTE = [
  { name: 'Red', value: '#e74c3c' },
  { name: 'Orange', value: '#e67e22' },
  { name: 'Yellow', value: '#f1c40f' },
  { name: 'Green', value: '#2ecc71' },
  { name: 'Teal', value: '#1abc9c' },
  { name: 'Cyan', value: '#00bcd4' },
  { name: 'Blue', value: '#3498db' },
  { name: 'Blurple', value: '#5865f2' },
  { name: 'Purple', value: '#9b59b6' },
  { name: 'Pink', value: '#e91e8c' },
  { name: 'Rose', value: '#e06c75' },
  { name: 'Gold', value: '#f0b232' },
  { name: 'Light Grey', value: '#95a5a6' },
  { name: 'Dark Grey', value: '#607d8b' },
  { name: 'White', value: '#ffffff' },
];
import { getGameRoles, addGameRole, removeGameRole, clearGameRoles } from '../utils/gameRoles';

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = COLOR_PALETTE.filter(
    (c) => c.name.toLowerCase().includes(focused) || c.value.includes(focused),
  )
    .slice(0, 25)
    .map((c) => ({ name: `${c.name} — ${c.value}`, value: c.value }));
  await interaction.respond(matches);
}

export async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const colorStr = interaction.options.getString('color') ?? '#5865F2';
  const colorNum = parseInt(colorStr.replace('#', ''), 16);

  const existing = await getGameRoles(interaction.guildId!);
  if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    await interaction.reply({
      content: `A tag named **${name}** already exists.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordRole = await interaction.guild!.roles.create({
    name,
    color: isNaN(colorNum) ? 0x5865f2 : colorNum,
    mentionable: false,
    reason: `Game tag added by ${interaction.user.tag}`,
  });

  const type = (interaction.options.getString('type') ?? 'genre') as 'genre' | 'difficulty';
  await addGameRole(interaction.guildId!, { roleId: discordRole.id, name, type, botCreated: true });
  await interaction.editReply(`Tag **${name}** created! Members can select it with \`/myroles\`.`);
}

export async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const tags = await getGameRoles(interaction.guildId!);
  const tag = tags.find((r) => r.name.toLowerCase() === name.toLowerCase());

  if (!tag) {
    await interaction.reply({
      content: `No tag named **${name}** found. Use \`/admin tags list\` to see available tags.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Only delete the Discord role itself if the bot created it. Roles that were
  // linked to a pre-existing role (via sync finding a same-named role) aren't
  // owned by the bot and must not be deleted out from under the server.
  let deletedRole = false;
  if (tag.botCreated !== false) {
    try {
      const discordRole = await interaction.guild!.roles.fetch(tag.roleId);
      if (discordRole) {
        await discordRole.delete(`Game tag removed by ${interaction.user.tag}`);
        deletedRole = true;
      }
    } catch {
      // Role may have already been manually deleted
    }
  }

  await removeGameRole(interaction.guildId!, tag.roleId);
  await interaction.editReply(
    deletedRole
      ? `Tag **${name}** removed.`
      : `Tag **${name}** untracked. The Discord role was linked from an existing role (not created by the bot) and was left in place — delete it manually if you want it gone.`,
  );
}

export async function handleSync(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = await getGameRoles(interaction.guildId!);
  const existingNames = new Set(existing.map((r) => r.name.toLowerCase()));

  const genreToCreate = GENRE_TAG_DEFINITIONS.filter(
    (tag) => !existingNames.has(tag.name.toLowerCase()),
  );
  const diffToCreate = DIFFICULTY_TAG_DEFINITIONS.filter(
    (tag) => !existingNames.has(tag.name.toLowerCase()),
  );

  if (genreToCreate.length === 0 && diffToCreate.length === 0) {
    await interaction.editReply(
      `All ${GENRE_TAG_DEFINITIONS.length} genre tags and ${DIFFICULTY_TAG_DEFINITIONS.length} difficulty roles already exist.`,
    );
    return;
  }

  // Look up the server's actual Discord roles so we can reuse a same-named
  // role instead of creating a duplicate.
  const guildRoles = await interaction.guild!.roles.fetch();
  const rolesByName = new Map(guildRoles.map((role) => [role.name.toLowerCase(), role]));

  let created = 0;
  let linked = 0;
  const failed: string[] = [];

  const syncTag = async (
    tag: { name: string; color: string },
    type: 'genre' | 'difficulty',
  ): Promise<void> => {
    const existingDiscordRole = rolesByName.get(tag.name.toLowerCase());
    if (existingDiscordRole) {
      await addGameRole(interaction.guildId!, {
        roleId: existingDiscordRole.id,
        name: tag.name,
        type,
        botCreated: false,
      });
      linked++;
      return;
    }

    const color = parseInt(tag.color.replace('#', ''), 16);
    try {
      const discordRole = await interaction.guild!.roles.create({
        name: tag.name,
        color,
        mentionable: false,
        reason: `Game tag sync by ${interaction.user.tag}`,
      });
      await addGameRole(interaction.guildId!, {
        roleId: discordRole.id,
        name: tag.name,
        type,
        botCreated: true,
      });
      created++;
    } catch {
      failed.push(tag.name);
    }
  };

  for (const tag of genreToCreate) await syncTag(tag, 'genre');
  for (const tag of diffToCreate) await syncTag(tag, 'difficulty');

  const skipped =
    GENRE_TAG_DEFINITIONS.length -
    genreToCreate.length +
    (DIFFICULTY_TAG_DEFINITIONS.length - diffToCreate.length);
  const parts: string[] = [];
  if (created > 0) parts.push(`**${created}** role${created !== 1 ? 's' : ''} created`);
  if (linked > 0)
    parts.push(`**${linked}** existing role${linked !== 1 ? 's' : ''} linked (already on the server)`);
  if (skipped > 0) parts.push(`**${skipped}** already synced`);
  if (failed.length > 0) parts.push(`**${failed.length}** failed: ${failed.join(', ')}`);

  await interaction.editReply(
    `Sync complete — ${parts.join(', ')}. Members can assign these with \`/myroles\`.`,
  );
}

export async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const tags = await getGameRoles(interaction.guildId!);

  if (tags.length === 0) {
    await interaction.reply({
      content: 'No game tags set up yet. Use `/gametags add` to create some.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const genre = tags.filter((t) => t.type !== 'difficulty');
  const difficulty = tags.filter((t) => t.type === 'difficulty');
  const lines: string[] = [`**Game tags (${tags.length}):**`];
  if (difficulty.length > 0) {
    lines.push('**Difficulty:**', ...difficulty.map((t) => `> <@&${t.roleId}>`));
  }
  if (genre.length > 0) {
    lines.push('**Genre:**', ...genre.map((t) => `> <@&${t.roleId}>`));
  }
  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

export async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const removed = await clearGameRoles(interaction.guildId!);
  if (removed.length === 0) {
    await interaction.editReply('No game tags to remove.');
    return;
  }

  // Only delete Discord roles the bot actually created. Roles linked from a
  // pre-existing same-named role (via sync) are not owned by the bot and must
  // not be deleted — they're just untracked.
  let deleted = 0;
  let kept = 0;
  for (const tag of removed) {
    if (tag.botCreated === false) {
      kept++;
      continue;
    }
    try {
      const discordRole = await interaction.guild!.roles.fetch(tag.roleId);
      if (discordRole) await discordRole.delete(`Game tags cleared by ${interaction.user.tag}`);
      deleted++;
    } catch {
      // Role may have already been manually deleted
    }
  }

  const parts: string[] = [`**${deleted}** role${deleted !== 1 ? 's' : ''} deleted`];
  if (kept > 0)
    parts.push(
      `**${kept}** linked role${kept !== 1 ? 's' : ''} untracked but left in place (not created by the bot)`,
    );

  await interaction.editReply(
    `Cleared ${parts.join(', ')}. Use \`/admin tags sync\` to recreate/relink them.`,
  );
}
