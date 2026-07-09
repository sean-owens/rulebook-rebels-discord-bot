import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
  TextChannel,
  MessageFlags,
  PermissionFlagsBits,
  Guild,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { upsertRoom, findRoomByChannel, removeRoom, PrivateRoom } from '../utils/roomStorage';

function slugify(str: string): string {
  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return slug || 'room';
}

function parseMentionedUserIds(text: string): string[] {
  const ids = new Set<string>();
  const regex = /<@!?(\d+)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

async function findPrivilegedRoleIds(guild: Guild): Promise<string[]> {
  await guild.roles.fetch();
  return guild.roles.cache
    .filter(
      (role) =>
        role.permissions.has(PermissionFlagsBits.ManageEvents) ||
        role.permissions.has(PermissionFlagsBits.ManageGuild),
    )
    .map((role) => role.id);
}

export const data = new SlashCommandBuilder()
  .setName('getaroom')
  .setDescription('Create a private channel with just you and the people you invite')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new private room, hidden from everyone except invitees, hosts, and admins')
      .addStringOption((opt) =>
        opt
          .setName('people')
          .setDescription('Mention everyone to invite (e.g. @Alice @Bob)')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Room name (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close and delete this private room — run inside the room channel'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') await handleCreate(interaction);
  else if (sub === 'close') await handleClose(interaction);
}

async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const peopleText = interaction.options.getString('people', true);
  const roomName = interaction.options.getString('name');
  const guild = interaction.guild!;

  const userIds = parseMentionedUserIds(peopleText).filter((id) => id !== interaction.user.id);
  if (userIds.length === 0) {
    await interaction.reply({
      content: 'Mention at least one other person to invite (e.g. `people:@Alice @Bob`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Resolve mentions to actual guild members, dropping anyone not found (left server, bad mention, etc.)
  const resolvedMembers = await Promise.all(
    userIds.map((id) => guild.members.fetch(id).catch(() => null)),
  );
  const validMembers = resolvedMembers.filter((m): m is NonNullable<typeof m> => m !== null);
  const skippedCount = userIds.length - validMembers.length;

  if (validMembers.length === 0) {
    await interaction.editReply("Couldn't find any of the mentioned people in this server.");
    return;
  }

  const config = await getGuildConfig(guild.id);

  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === config.privateRoomCategoryName,
  );
  if (!category) {
    category = await guild.channels.create({
      name: config.privateRoomCategoryName,
      type: ChannelType.GuildCategory,
    });
  }

  const me = await guild.members.fetchMe();
  const privilegedRoleIds = await findPrivilegedRoleIds(guild);

  const name = roomName?.trim() || `room-${randomUUID().slice(0, 6)}`;
  let channel: TextChannel;
  try {
    channel = (await guild.channels.create({
      name: slugify(name),
      type: ChannelType.GuildText,
      parent: category.id,
    })) as TextChannel;

    await channel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
    await channel.permissionOverwrites.create(me, {
      ViewChannel: true,
      SendMessages: true,
      ManageMessages: true,
      ManageChannels: true,
    });
    await channel.permissionOverwrites.create(interaction.user, {
      ViewChannel: true,
      SendMessages: true,
    });
    for (const member of validMembers) {
      await channel.permissionOverwrites.create(member.id, { ViewChannel: true, SendMessages: true });
    }
    for (const roleId of privilegedRoleIds) {
      await channel.permissionOverwrites.create(roleId, { ViewChannel: true, SendMessages: true });
    }
  } catch (err) {
    console.warn('Could not create private room channel:', err);
    await interaction.editReply('Could not create the private room — check that the bot has Manage Channels permission.');
    return;
  }

  const mentions = validMembers.map((m) => `<@${m.id}>`).join(' ');
  await channel.send(
    `🔒 **Private room** — ${mentions}\n` +
      `You've been added to a private room by <@${interaction.user.id}>. Only the people mentioned here, plus hosts and admins, can see this channel.`,
  );

  const room: PrivateRoom = {
    id: randomUUID().slice(0, 8),
    guildId: guild.id,
    channelId: channel.id,
    name,
    createdBy: interaction.user.id,
    invitedUserIds: validMembers.map((m) => m.id),
    createdAt: new Date().toISOString(),
  };
  await upsertRoom(room);

  const skippedNote =
    skippedCount > 0
      ? ` (${skippedCount} mentioned ${skippedCount !== 1 ? 'people' : 'person'} couldn't be found and ${skippedCount !== 1 ? 'were' : 'was'} skipped)`
      : '';
  await interaction.editReply(`Private room created: ${channel}${skippedNote}`);
}

async function handleClose(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findRoomByChannel(interaction.channelId);
  if (!room) {
    await interaction.reply({
      content: 'This command must be run inside a private room channel created by `/getaroom create`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isCreator = room.createdBy === interaction.user.id;
  const isPrivileged =
    (interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false) ||
    (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false);
  if (!isCreator && !isPrivileged) {
    await interaction.reply({
      content: "Only the room's creator or a host/admin can close this room.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: 'Closing this room…', flags: MessageFlags.Ephemeral });
  await removeRoom(room.id);
  try {
    const channel = await interaction.client.channels.fetch(interaction.channelId);
    await channel?.delete('Private room closed');
  } catch (err) {
    console.warn(`Could not delete private room channel ${interaction.channelId}:`, err);
  }
}

export async function handleRoomConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const category = interaction.options.getString('category');
  if (category === null) {
    const config = await getGuildConfig(interaction.guildId!);
    await interaction.reply({
      content: `**Private room category:** ${config.privateRoomCategoryName}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updated = await updateGuildConfig(interaction.guildId!, { privateRoomCategoryName: category });
  await interaction.reply({
    content: `**Private room category updated:** ${updated.privateRoomCategoryName}`,
    flags: MessageFlags.Ephemeral,
  });
}
