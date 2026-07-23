import {
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
  ChannelType,
  TextChannel,
  MessageFlags,
  PermissionFlagsBits,
  Guild,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { parseDateTime } from './gamenight';
import { upsertRoom, findRoomByChannel, removeRoom, loadRooms, PrivateRoom } from '../utils/roomStorage';
import { pinWithRetry } from '../utils/discordPin';

// Rooms expire at the end of the given day rather than a specific clock time —
// the /room create command only asks for a date, not a time.
const EXPIRY_TIME_OF_DAY = '11:59pm';

// Prefixed onto the channel name and mentioned in the topic so hosts/admins can
// tell at a glance, from the channel list alone, that a room won't auto-expire.
const PERSISTENT_ICON = '📌';

function slugify(str: string, maxLength = 100): string {
  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
  return slug || 'room';
}

function channelNameFor(name: string, persistent: boolean): string {
  const prefix = persistent ? `${PERSISTENT_ICON}-` : '';
  return `${prefix}${slugify(name, 100 - prefix.length)}`;
}

function formatExpiryDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function buildRoomTopic(persistent: boolean, expiresAt: Date | null): string {
  if (persistent) {
    return `${PERSISTENT_ICON} Persistent private room — no auto-expiration. Close it with /room close, or set one with /room persist enabled:false.`;
  }
  return expiresAt
    ? `Private room — expires ${formatExpiryDate(expiresAt)}. Close early with /room close.`
    : 'Private room.';
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
          .setDescription('Expiration date (e.g. "August 22") — required unless persist:true')
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('persist')
          .setDescription('If true, the room never auto-expires — close it manually with /room close')
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Room name (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close and delete this private room — run inside the room channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('persist')
      .setDescription('Turn this room\'s auto-expiration on or off — run inside the room channel')
      .addBooleanOption((opt) =>
        opt
          .setName('enabled')
          .setDescription('true = never auto-expire, false = set/restore an expiration date')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('date')
          .setDescription('New expiration date (e.g. "August 22") — required when enabled:false')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('invite')
      .setDescription('Add more people to this private room — run inside the room channel')
      .addStringOption((opt) =>
        opt
          .setName('people')
          .setDescription('Mention everyone to add (e.g. @Alice @Bob)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Remove someone from this private room — run inside the room channel')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The person to remove').setRequired(true),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') await handleCreate(interaction);
  else if (sub === 'close') await handleClose(interaction);
  else if (sub === 'persist') await handlePersist(interaction);
  else if (sub === 'invite') await handleInvite(interaction);
  else if (sub === 'kick') await handleKick(interaction);
}

async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const peopleText = interaction.options.getString('people', true);
  const rawDate = interaction.options.getString('date');
  const persist = interaction.options.getBoolean('persist') ?? false;
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

  let expiresAt: Date | null = null;
  if (!persist) {
    if (!rawDate) {
      await interaction.reply({
        content: 'Provide a `date` (e.g. `date:August 22`), or set `persist:true` for a room that never expires.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const parsed = parseExpirationDate(rawDate);
    if (!parsed.ok) {
      await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
      return;
    }
    expiresAt = parsed.date;
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
      name: channelNameFor(name, persist),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: buildRoomTopic(persist, expiresAt),
    })) as TextChannel;

    // Bot's own overwrite must be created before denying @everyone below -- if @everyone
    // is denied first and the bot has no explicit allow overwrite of its own yet, its
    // effective permissions in this brand-new channel can transiently drop with it,
    // which then fails the "you can't grant a permission you don't currently hold" check
    // on this very call. /host event create's channel setup follows this same order.
    // ManageChannels is deliberately left off: the bot's base role already has it
    // guild-wide, and granting it here isn't otherwise necessary. PinMessages is its
    // own permission split off from ManageMessages (see discord link.md) — both are
    // required to actually pin the room's Quick Actions/Snacks List messages.
    await channel.permissionOverwrites.create(me, {
      ViewChannel: true,
      SendMessages: true,
      ManageMessages: true,
      PinMessages: true,
    });
    await channel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
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

  const expiresDateStr = expiresAt ? formatExpiryDate(expiresAt) : null;

  const mentions = validMembers.map((m) => `<@${m.id}>`).join(' ');
  const lifespanNote = expiresDateStr
    ? `This room closes automatically at the end of **${expiresDateStr}** — use \`/room close\` in here if you're done sooner.`
    : `${PERSISTENT_ICON} This room does not auto-expire — use \`/room close\` in here when you're done, or \`/room persist enabled:false\` to give it an expiration date.`;
  await channel.send(
    `🔒 **Private room** — ${mentions}\n` +
      `You've been added to a private room by <@${interaction.user.id}>. Only the people mentioned here, plus hosts and admins, can see this channel.\n` +
      lifespanNote,
  );

  const room: PrivateRoom = {
    id: randomUUID().slice(0, 8),
    guildId: guild.id,
    channelId: channel.id,
    name,
    createdBy: interaction.user.id,
    invitedUserIds: validMembers.map((m) => m.id),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
    persistent: persist,
  };
  await upsertRoom(room);
  await updateRoomHubPin(interaction.client, room.id).catch(() => null);

  const skippedNote =
    skippedCount > 0
      ? ` (${skippedCount} mentioned ${skippedCount !== 1 ? 'people' : 'person'} couldn't be found and ${skippedCount !== 1 ? 'were' : 'was'} skipped)`
      : '';
  const expirySummary = expiresDateStr ? `expires ${expiresDateStr}` : 'persists until closed';
  await interaction.editReply(`Private room created: ${channel} — ${expirySummary}${skippedNote}`);
}

function canManageRoom(
  interaction: ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
  room: PrivateRoom,
): boolean {
  const isCreator = room.createdBy === interaction.user.id;
  const isPrivileged =
    (interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false) ||
    (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false);
  return isCreator || isPrivileged;
}

function parseExpirationDate(rawDate: string): { ok: true; date: Date } | { ok: false; error: string } {
  let date: Date;
  try {
    date = parseDateTime(rawDate, EXPIRY_TIME_OF_DAY);
  } catch {
    return {
      ok: false,
      error: `Could not parse "${rawDate}" as a date. Try something like "August 22" or "aug 22".`,
    };
  }
  if (date.getTime() <= Date.now()) {
    return {
      ok: false,
      error: 'That date has already passed — pick a date in the future for the room to expire on.',
    };
  }
  return { ok: true, date };
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

  if (!canManageRoom(interaction, room)) {
    await interaction.reply({
      content: "Only the room's creator or a host/admin can close this room.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: 'Closing this room…', flags: MessageFlags.Ephemeral });
  await closeRoom(interaction.client, room, 'Private room closed');
}

async function handlePersist(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findRoomByChannel(interaction.channelId);
  if (!room) {
    await interaction.reply({
      content: 'This command must be run inside a private room channel created by `/room create`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canManageRoom(interaction, room)) {
    await interaction.reply({
      content: "Only the room's creator or a host/admin can change this room's expiration.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const enabled = interaction.options.getBoolean('enabled', true);

  if (enabled) {
    room.persistent = true;
    await upsertRoom(room);
    // Reply before touching the Discord channel (rename + topic) below -- those are
    // real API calls that can take long enough to blow past Discord's 3-second ack
    // window, which shows the user "The application did not respond" even though the
    // underlying change still goes through. /room close follows this same ack-first order.
    await interaction.reply({
      content:
        `${PERSISTENT_ICON} This room will no longer auto-expire — use \`/room close\` (or \`/room persist enabled:false\`) when you're done.`,
      flags: MessageFlags.Ephemeral,
    });
    await updateRoomChannelDisplay(interaction.client, room);
    return;
  }

  const rawDate = interaction.options.getString('date');
  if (!rawDate) {
    await interaction.reply({
      content: 'Provide a `date` to set when turning off persistence (e.g. `date:August 22`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const parsed = parseExpirationDate(rawDate);
  if (!parsed.ok) {
    await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
    return;
  }

  room.persistent = false;
  room.expiresAt = parsed.date.toISOString();
  await upsertRoom(room);

  await interaction.reply({
    content: `This room will now expire at the end of **${formatExpiryDate(parsed.date)}**.`,
    flags: MessageFlags.Ephemeral,
  });
  await updateRoomChannelDisplay(interaction.client, room);
}

async function handleInvite(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findRoomByChannel(interaction.channelId);
  if (!room) {
    await interaction.reply({
      content: 'This command must be run inside a private room channel created by `/room create`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canManageRoom(interaction, room)) {
    await interaction.reply({
      content: "Only the room's creator or a host/admin can invite people to this room.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const peopleText = interaction.options.getString('people', true);
  const alreadyIn = new Set([room.createdBy, ...room.invitedUserIds]);
  const userIds = parseMentionedUserIds(peopleText).filter((id) => !alreadyIn.has(id));
  if (userIds.length === 0) {
    await interaction.reply({
      content: "Mention at least one person who isn't already in this room (e.g. `people:@Alice @Bob`).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const resolvedMembers = await Promise.all(
    userIds.map((id) => interaction.guild!.members.fetch(id).catch(() => null)),
  );
  const validMembers = resolvedMembers.filter((m): m is NonNullable<typeof m> => m !== null);
  const skippedCount = userIds.length - validMembers.length;

  if (validMembers.length === 0) {
    await interaction.editReply("Couldn't find any of the mentioned people in this server.");
    return;
  }

  const channel = await interaction.client.channels.fetch(room.channelId);
  if (!channel || !('permissionOverwrites' in channel) || !('send' in channel)) {
    await interaction.editReply("Couldn't find this room's channel.");
    return;
  }
  const textChannel = channel as TextChannel;

  try {
    for (const member of validMembers) {
      await textChannel.permissionOverwrites.create(member.id, { ViewChannel: true, SendMessages: true });
    }
  } catch (err) {
    console.warn(`Could not grant access to invited members for room channel ${room.channelId}:`, err);
    await interaction.editReply(
      'Could not update channel permissions — check that the bot has Manage Roles/Channels permission.',
    );
    return;
  }

  room.invitedUserIds = [...room.invitedUserIds, ...validMembers.map((m) => m.id)];
  await upsertRoom(room);

  const mentions = validMembers.map((m) => `<@${m.id}>`).join(' ');
  await textChannel.send(`${mentions} You've been added to this private room by <@${interaction.user.id}>.`);

  const skippedNote =
    skippedCount > 0
      ? ` (${skippedCount} mentioned ${skippedCount !== 1 ? 'people' : 'person'} couldn't be found and ${skippedCount !== 1 ? 'were' : 'was'} skipped)`
      : '';
  await interaction.editReply(`Added ${mentions} to this room${skippedNote}.`);
}

async function handleKick(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findRoomByChannel(interaction.channelId);
  if (!room) {
    await interaction.reply({
      content: 'This command must be run inside a private room channel created by `/room create`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canManageRoom(interaction, room)) {
    await interaction.reply({
      content: "Only the room's creator or a host/admin can remove people from this room.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getUser('user', true);

  if (target.id === room.createdBy) {
    await interaction.reply({
      content: "You can't remove the room's creator — use `/room close` to close the room instead.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!room.invitedUserIds.includes(target.id)) {
    await interaction.reply({
      content: `${target.username} hasn't been individually invited to this room (they may only have access through a host/admin role, which this command can't remove).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await interaction.client.channels.fetch(room.channelId);
  if (!channel || !('permissionOverwrites' in channel) || !('send' in channel)) {
    await interaction.editReply("Couldn't find this room's channel.");
    return;
  }
  const textChannel = channel as TextChannel;

  try {
    await textChannel.permissionOverwrites.delete(target.id);
  } catch (err) {
    console.warn(`Could not remove permission overwrite for ${target.id} in room channel ${room.channelId}:`, err);
    await interaction.editReply(
      'Could not update channel permissions — check that the bot has Manage Roles/Channels permission.',
    );
    return;
  }

  room.invitedUserIds = room.invitedUserIds.filter((id) => id !== target.id);
  await upsertRoom(room);

  await textChannel.send(`<@${target.id}> has been removed from this private room by <@${interaction.user.id}>.`);
  await interaction.editReply(`Removed ${target.username} from this room.`);
}

async function updateRoomChannelDisplay(client: Client, room: PrivateRoom): Promise<void> {
  let channel;
  try {
    channel = await client.channels.fetch(room.channelId);
  } catch (err) {
    console.warn(`Could not fetch room channel ${room.channelId} to update its display:`, err);
    return;
  }
  if (!channel || !('setName' in channel) || !('setTopic' in channel)) return;
  const textChannel = channel as TextChannel;

  // Renaming and re-topicing are independent try/catches -- Discord's channel-rename
  // rate limit (2 renames per 10 minutes) is easy to hit when toggling persistence
  // rapidly, and a failed rename must not also block the topic (which carries the
  // authoritative expiration info) from updating.
  const newName = channelNameFor(room.name, !!room.persistent);
  if (textChannel.name !== newName) {
    try {
      await textChannel.setName(newName);
    } catch (err) {
      console.warn(`Could not rename room channel ${room.channelId} (possibly Discord's rename rate limit):`, err);
    }
  }

  try {
    await textChannel.setTopic(
      buildRoomTopic(!!room.persistent, room.expiresAt ? new Date(room.expiresAt) : null),
    );
  } catch (err) {
    console.warn(`Could not update topic for room channel ${room.channelId}:`, err);
  }
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

// ── "Quick Actions" button hub ────────────────────────────────────────────────
// Mirrors the event-channel hub (see updateHubPin in requestPin.ts) — posted
// once at room creation for members who'd rather tap a button than type a
// command. The 🎲 Suggest a Game button is shared with the event hub (same
// `hub_suggest` customId, routed to the same handler in game.ts, which is
// already room-aware via findRoomByChannel/roomToGameNightAdapter).

export function buildRoomHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎮 Quick Actions')
    .setColor(0x57f287)
    .setDescription('Prefer tapping over typing? Use the buttons below instead of slash commands.')
    .addFields(
      { name: '🎲 Suggest a Game', value: 'Add a game to play in this room.' },
      { name: '➕ Invite', value: 'Add more people to this room.' },
      { name: '👢 Kick', value: 'Remove someone from this room.' },
      { name: '📌 Toggle Auto-Expire', value: 'Make this room persistent, or set a new expiration date.' },
      { name: '🍿 Snacks', value: 'See or add to the snacks list.' },
    );
}

// Close Room isn't on this panel — it's the one destructive action here, and
// with the row already full (Discord caps an action row at 5 buttons) it's
// left as a deliberate typed command (`/room close`) rather than a tap target.
export function buildRoomHubButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('hub_suggest').setLabel('🎲 Suggest a Game').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('hub_room_invite').setLabel('➕ Invite').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hub_room_kick').setLabel('👢 Kick').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hub_room_persist').setLabel('📌 Toggle Auto-Expire').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hub_snacks').setLabel('🍿 Snacks').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function updateRoomHubPin(client: Client, roomId: string): Promise<void> {
  const rooms = await loadRooms();
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return;

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(room.channelId)) as TextChannel;
  } catch {
    return;
  }

  const payload = { embeds: [buildRoomHubEmbed()], components: buildRoomHubButtons() };

  if (room.hubPinMessageId) {
    try {
      const msg = await channel.messages.fetch(room.hubPinMessageId);
      await msg.edit(payload);
      if (!msg.pinned) {
        await pinWithRetry(msg, `re-pin hub message in room channel ${room.channelId}`);
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send(payload);
  await pinWithRetry(msg, `hub message in room channel ${room.channelId}`);

  room.hubPinMessageId = msg.id;
  await upsertRoom(room);
}

async function requireManageableRoom(
  interaction: ButtonInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
  deniedMessage: string,
): Promise<PrivateRoom | undefined> {
  const room = await findRoomByChannel(interaction.channelId!);
  if (!room) {
    await interaction.reply({
      content: 'This must be used inside a private room channel created by `/room create`.',
      flags: MessageFlags.Ephemeral,
    });
    return undefined;
  }
  if (!canManageRoom(interaction, room)) {
    await interaction.reply({ content: deniedMessage, flags: MessageFlags.Ephemeral });
    return undefined;
  }
  return room;
}

export async function handleHubRoomInviteButton(interaction: ButtonInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can invite people to this room.",
  );
  if (!room) return;

  const select = new UserSelectMenuBuilder()
    .setCustomId('hub_room_invite_select')
    .setPlaceholder('Select people to invite…')
    .setMinValues(1)
    .setMaxValues(10);
  await interaction.reply({
    content: 'Who would you like to invite?',
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubRoomInviteSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can invite people to this room.",
  );
  if (!room) return;

  const alreadyIn = new Set([room.createdBy, ...room.invitedUserIds]);
  const userIds = interaction.values.filter((id) => !alreadyIn.has(id));
  if (userIds.length === 0) {
    await interaction.update({ content: 'Everyone selected is already in this room.', components: [] });
    return;
  }

  await interaction.deferUpdate();

  const resolvedMembers = await Promise.all(
    userIds.map((id) => interaction.guild!.members.fetch(id).catch(() => null)),
  );
  const validMembers = resolvedMembers.filter((m): m is NonNullable<typeof m> => m !== null);
  if (validMembers.length === 0) {
    await interaction.editReply({ content: "Couldn't find any of the selected people in this server.", components: [] });
    return;
  }

  const channel = await interaction.client.channels.fetch(room.channelId);
  if (!channel || !('permissionOverwrites' in channel) || !('send' in channel)) {
    await interaction.editReply({ content: "Couldn't find this room's channel.", components: [] });
    return;
  }
  const textChannel = channel as TextChannel;

  try {
    for (const member of validMembers) {
      await textChannel.permissionOverwrites.create(member.id, { ViewChannel: true, SendMessages: true });
    }
  } catch (err) {
    console.warn(`Could not grant access to invited members for room channel ${room.channelId}:`, err);
    await interaction.editReply({
      content: 'Could not update channel permissions — check that the bot has Manage Roles/Channels permission.',
      components: [],
    });
    return;
  }

  room.invitedUserIds = [...room.invitedUserIds, ...validMembers.map((m) => m.id)];
  await upsertRoom(room);

  const mentions = validMembers.map((m) => `<@${m.id}>`).join(' ');
  await textChannel.send(`${mentions} You've been added to this private room by <@${interaction.user.id}>.`);
  await interaction.editReply({ content: `Added ${mentions} to this room.`, components: [] });
}

export async function handleHubRoomKickButton(interaction: ButtonInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can remove people from this room.",
  );
  if (!room) return;

  if (room.invitedUserIds.length === 0) {
    await interaction.reply({
      content: "Nobody has been individually invited to this room (anyone else here only has access through a host/admin role, which this can't remove).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const select = new UserSelectMenuBuilder()
    .setCustomId('hub_room_kick_select')
    .setPlaceholder('Select someone to remove…')
    .setMinValues(1)
    .setMaxValues(1);
  await interaction.reply({
    content: 'Who would you like to remove?',
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubRoomKickSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can remove people from this room.",
  );
  if (!room) return;

  const targetId = interaction.values[0];
  const target = interaction.users.get(targetId);

  if (targetId === room.createdBy) {
    await interaction.update({
      content: "You can't remove the room's creator — use the 🔒 Close Room button instead.",
      components: [],
    });
    return;
  }

  if (!room.invitedUserIds.includes(targetId)) {
    await interaction.update({
      content: `${target?.username ?? 'That person'} hasn't been individually invited to this room (they may only have access through a host/admin role, which this can't remove).`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const channel = await interaction.client.channels.fetch(room.channelId);
  if (!channel || !('permissionOverwrites' in channel) || !('send' in channel)) {
    await interaction.editReply({ content: "Couldn't find this room's channel.", components: [] });
    return;
  }
  const textChannel = channel as TextChannel;

  try {
    await textChannel.permissionOverwrites.delete(targetId);
  } catch (err) {
    console.warn(`Could not remove permission overwrite for ${targetId} in room channel ${room.channelId}:`, err);
    await interaction.editReply({
      content: 'Could not update channel permissions — check that the bot has Manage Roles/Channels permission.',
      components: [],
    });
    return;
  }

  room.invitedUserIds = room.invitedUserIds.filter((id) => id !== targetId);
  await upsertRoom(room);

  await textChannel.send(`<@${targetId}> has been removed from this private room by <@${interaction.user.id}>.`);
  await interaction.editReply({ content: `Removed ${target?.username ?? 'that person'} from this room.`, components: [] });
}

export async function handleHubRoomPersistButton(interaction: ButtonInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can change this room's expiration.",
  );
  if (!room) return;

  if (!room.persistent) {
    room.persistent = true;
    await upsertRoom(room);
    await interaction.reply({
      content: `${PERSISTENT_ICON} This room will no longer auto-expire — use the 🔒 Close Room button (or this button again) when you're done.`,
      flags: MessageFlags.Ephemeral,
    });
    await updateRoomChannelDisplay(interaction.client, room);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('hub_room_persist_modal')
    .setTitle('Set Expiration Date')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('date')
          .setLabel('New expiration date')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. August 22')
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleHubRoomPersistModal(interaction: ModalSubmitInteraction): Promise<void> {
  const room = await requireManageableRoom(
    interaction,
    "Only the room's creator or a host/admin can change this room's expiration.",
  );
  if (!room) return;

  const rawDate = interaction.fields.getTextInputValue('date');
  const parsed = parseExpirationDate(rawDate);
  if (!parsed.ok) {
    await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
    return;
  }

  room.persistent = false;
  room.expiresAt = parsed.date.toISOString();
  await upsertRoom(room);

  await interaction.reply({
    content: `This room will now expire at the end of **${formatExpiryDate(parsed.date)}**.`,
    flags: MessageFlags.Ephemeral,
  });
  await updateRoomChannelDisplay(interaction.client, room);
}


export async function checkExpiredRooms(client: Client): Promise<void> {
  const now = Date.now();
  const expired = (await loadRooms()).filter(
    (room) => !room.persistent && room.expiresAt && new Date(room.expiresAt).getTime() <= now,
  );
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
