import {
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
  ChannelType,
  TextChannel,
  MessageFlags,
  PermissionFlagsBits,
  Guild,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { parseDateTime } from './gamenight';
import { upsertRoom, findRoomByChannel, removeRoom, loadRooms, PrivateRoom } from '../utils/roomStorage';

// Rooms expire at the end of the given day rather than a specific clock time —
// the /room create command only asks for a date, not a time.
const EXPIRY_TIME_OF_DAY = '11:59pm';

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
  .setName('room')
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
        opt
          .setName('date')
          .setDescription('Expiration date (e.g. "August 22") — the room auto-closes at the end of that day')
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
  const rawDate = interaction.options.getString('date', true);
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

  let expiresAt: Date;
  try {
    expiresAt = parseDateTime(rawDate, EXPIRY_TIME_OF_DAY);
  } catch {
    await interaction.reply({
      content: `Could not parse "${rawDate}" as a date. Try something like "August 22" or "aug 22".`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (expiresAt.getTime() <= Date.now()) {
    await interaction.reply({
      content: 'That date has already passed — pick a date in the future for the room to expire on.',
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
    // ManageChannels deliberately left off: Discord rejects granting a permission via
    // overwrite that the actor (the bot) doesn't already hold at the role level, and the
    // bot's base role already has ManageChannels guild-wide (see discord link.md) -- an
    // explicit overwrite for it isn't needed and 403s if the bot's role ever lacks it.
    // /host event create's channel setup follows the same pattern.
    await channel.permissionOverwrites.create(me, {
      ViewChannel: true,
      SendMessages: true,
      ManageMessages: true,
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

  const expiresDateStr = expiresAt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const mentions = validMembers.map((m) => `<@${m.id}>`).join(' ');
  await channel.send(
    `🔒 **Private room** — ${mentions}\n` +
      `You've been added to a private room by <@${interaction.user.id}>. Only the people mentioned here, plus hosts and admins, can see this channel.\n` +
      `This room closes automatically at the end of **${expiresDateStr}** — use \`/room close\` in here if you're done sooner.`,
  );

  const room: PrivateRoom = {
    id: randomUUID().slice(0, 8),
    guildId: guild.id,
    channelId: channel.id,
    name,
    createdBy: interaction.user.id,
    invitedUserIds: validMembers.map((m) => m.id),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await upsertRoom(room);

  const skippedNote =
    skippedCount > 0
      ? ` (${skippedCount} mentioned ${skippedCount !== 1 ? 'people' : 'person'} couldn't be found and ${skippedCount !== 1 ? 'were' : 'was'} skipped)`
      : '';
  await interaction.editReply(`Private room created: ${channel} — expires ${expiresDateStr}${skippedNote}`);
}

async function handleClose(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findRoomByChannel(interaction.channelId);
  if (!room) {
    await interaction.reply({
      content: 'This command must be run inside a private room channel created by `/room create`.',
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
  await closeRoom(interaction.client, room, 'Private room closed');
}

async function closeRoom(client: Client, room: PrivateRoom, reason: string): Promise<void> {
  await removeRoom(room.id);
  try {
    const channel = await client.channels.fetch(room.channelId);
    await channel?.delete(reason);
  } catch (err) {
    console.warn(`Could not delete private room channel ${room.channelId}:`, err);
  }
}

export async function checkExpiredRooms(client: Client): Promise<void> {
  const now = Date.now();
  const expired = (await loadRooms()).filter((room) => new Date(room.expiresAt).getTime() <= now);
  for (const room of expired) {
    console.log(`Auto-closing expired private room ${room.id} (expired ${room.expiresAt})`);
    await closeRoom(client, room, 'Private room expired');
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
