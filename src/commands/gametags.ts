import { AutocompleteInteraction, ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GAME_TAGS } from '../utils/libraryStorage';

const COLOR_PALETTE = [
  { name: 'Red',         value: '#e74c3c' },
  { name: 'Orange',      value: '#e67e22' },
  { name: 'Yellow',      value: '#f1c40f' },
  { name: 'Green',       value: '#2ecc71' },
  { name: 'Teal',        value: '#1abc9c' },
  { name: 'Cyan',        value: '#00bcd4' },
  { name: 'Blue',        value: '#3498db' },
  { name: 'Blurple',     value: '#5865f2' },
  { name: 'Purple',      value: '#9b59b6' },
  { name: 'Pink',        value: '#e91e8c' },
  { name: 'Rose',        value: '#e06c75' },
  { name: 'Gold',        value: '#f0b232' },
  { name: 'Light Grey',  value: '#95a5a6' },
  { name: 'Dark Grey',   value: '#607d8b' },
  { name: 'White',       value: '#ffffff' },
];
import { getGameRoles, addGameRole, removeGameRole, clearGameRoles } from '../utils/gameRoles';

export const data = new SlashCommandBuilder()
  .setName('gametags')
  .setDescription('Manage game genre tags that members can assign to themselves (admin only)')
  .addSubcommand(sub =>
    sub
      .setName('add')
      .setDescription('Create a new game genre tag')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Tag name (e.g. "Trick-Taking", "Euro", "Strategy")').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('color').setDescription('Role color — pick from the list or type a hex code (e.g. #5865F2)').setRequired(false).setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('type').setDescription('Role type (default: genre)').setRequired(false)
          .addChoices(
            { name: 'Genre', value: 'genre' },
            { name: 'Difficulty', value: 'difficulty' },
          )
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('remove')
      .setDescription('Delete a game genre tag')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Exact tag name to remove (use /gametags list to see names)').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('list').setDescription('List all current game genre tags')
  )
  .addSubcommand(sub =>
    sub.setName('sync').setDescription('Create server roles for all built-in game tags at once (skips existing)')
  )
  .addSubcommand(sub =>
    sub.setName('clear').setDescription('Remove all game tags and their Discord roles from this server (admin only)')
  );

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = COLOR_PALETTE
    .filter(c => c.name.toLowerCase().includes(focused) || c.value.includes(focused))
    .slice(0, 25)
    .map(c => ({ name: `${c.name} — ${c.value}`, value: c.value }));
  await interaction.respond(matches);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
  if (!isAdmin) {
    await interaction.reply({ content: 'Only admins can manage game tags.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'add') await handleAdd(interaction);
  else if (sub === 'remove') await handleRemove(interaction);
  else if (sub === 'list') await handleList(interaction);
  else if (sub === 'sync') await handleSync(interaction);
  else if (sub === 'clear') await handleClear(interaction);
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const colorStr = interaction.options.getString('color') ?? '#5865F2';
  const colorNum = parseInt(colorStr.replace('#', ''), 16);

  const existing = getGameRoles(interaction.guildId!);
  if (existing.some(r => r.name.toLowerCase() === name.toLowerCase())) {
    await interaction.reply({ content: `A tag named **${name}** already exists.`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const discordRole = await interaction.guild!.roles.create({
    name,
    color: isNaN(colorNum) ? 0x5865f2 : colorNum,
    mentionable: false,
    reason: `Game tag added by ${interaction.user.tag}`,
  });

  const type = (interaction.options.getString('type') ?? 'genre') as 'genre' | 'difficulty';
  addGameRole(interaction.guildId!, { roleId: discordRole.id, name, type });
  await interaction.editReply(`Tag **${name}** created! Members can select it with \`/myroles\`.`);
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const tags = getGameRoles(interaction.guildId!);
  const tag = tags.find(r => r.name.toLowerCase() === name.toLowerCase());

  if (!tag) {
    await interaction.reply({ content: `No tag named **${name}** found. Use \`/gametags list\` to see available tags.`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const discordRole = await interaction.guild!.roles.fetch(tag.roleId);
    if (discordRole) await discordRole.delete(`Game tag removed by ${interaction.user.tag}`);
  } catch {
    // Role may have already been manually deleted
  }

  removeGameRole(interaction.guildId!, tag.roleId);
  await interaction.editReply(`Tag **${name}** removed.`);
}

const DIFFICULTY_TAGS = [
  { name: 'Light',  color: '#95a5a6' },
  { name: 'Medium', color: '#f0b232' },
  { name: 'Heavy',  color: '#e74c3c' },
];

async function handleSync(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const existing = getGameRoles(interaction.guildId!);
  const existingNames = new Set(existing.map(r => r.name.toLowerCase()));

  const genreToCreate = GAME_TAGS.filter(tag => !existingNames.has(tag.toLowerCase()));
  const diffToCreate = DIFFICULTY_TAGS.filter(tag => !existingNames.has(tag.name.toLowerCase()));

  if (genreToCreate.length === 0 && diffToCreate.length === 0) {
    await interaction.editReply(`All ${GAME_TAGS.length} genre tags and ${DIFFICULTY_TAGS.length} difficulty roles already exist.`);
    return;
  }

  let created = 0;
  const failed: string[] = [];

  for (let i = 0; i < genreToCreate.length; i++) {
    const tag = genreToCreate[i];
    const color = parseInt(COLOR_PALETTE[i % COLOR_PALETTE.length].value.replace('#', ''), 16);
    try {
      const discordRole = await interaction.guild!.roles.create({
        name: tag,
        color,
        mentionable: false,
        reason: `Game tag sync by ${interaction.user.tag}`,
      });
      addGameRole(interaction.guildId!, { roleId: discordRole.id, name: tag, type: 'genre' });
      created++;
    } catch {
      failed.push(tag);
    }
  }

  for (const diff of diffToCreate) {
    const color = parseInt(diff.color.replace('#', ''), 16);
    try {
      const discordRole = await interaction.guild!.roles.create({
        name: diff.name,
        color,
        mentionable: false,
        reason: `Difficulty role sync by ${interaction.user.tag}`,
      });
      addGameRole(interaction.guildId!, { roleId: discordRole.id, name: diff.name, type: 'difficulty' });
      created++;
    } catch {
      failed.push(diff.name);
    }
  }

  const skippedGenre = GAME_TAGS.length - genreToCreate.length;
  const skippedDiff = DIFFICULTY_TAGS.length - diffToCreate.length;
  const skipped = skippedGenre + skippedDiff;
  const parts: string[] = [];
  if (created > 0) parts.push(`**${created}** role${created !== 1 ? 's' : ''} created`);
  if (skipped > 0) parts.push(`**${skipped}** already existed`);
  if (failed.length > 0) parts.push(`**${failed.length}** failed: ${failed.join(', ')}`);

  await interaction.editReply(`Sync complete — ${parts.join(', ')}. Members can assign these with \`/myroles\`.`);
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const tags = getGameRoles(interaction.guildId!);

  if (tags.length === 0) {
    await interaction.reply({
      content: 'No game tags set up yet. Use `/gametags add` to create some.',
      ephemeral: true,
    });
    return;
  }

  const genre = tags.filter(t => t.type !== 'difficulty');
  const difficulty = tags.filter(t => t.type === 'difficulty');
  const lines: string[] = [`**Game tags (${tags.length}):**`];
  if (difficulty.length > 0) {
    lines.push('**Difficulty:**', ...difficulty.map(t => `> <@&${t.roleId}>`));
  }
  if (genre.length > 0) {
    lines.push('**Genre:**', ...genre.map(t => `> <@&${t.roleId}>`));
  }
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const removed = clearGameRoles(interaction.guildId!);
  if (removed.length === 0) {
    await interaction.editReply('No game tags to remove.');
    return;
  }

  let deleted = 0;
  for (const tag of removed) {
    try {
      const discordRole = await interaction.guild!.roles.fetch(tag.roleId);
      if (discordRole) await discordRole.delete(`Game tags cleared by ${interaction.user.tag}`);
      deleted++;
    } catch {
      // Role may have already been manually deleted
    }
  }

  await interaction.editReply(`Cleared **${deleted}** game tag role${deleted !== 1 ? 's' : ''}. Use \`/gametags sync\` to recreate them.`);
}
