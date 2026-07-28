import {
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ForumChannel,
  TextChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  Message,
  MessageFlags,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { loadGameNights, findGameNight, upsertGameNight, GameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';
import { cleanupCancelledNight } from './cancelHelper';
import { getGuildConfig, updateGuildConfig, GuildConfig } from '../utils/config';
import { isValidTimeZone, zonedTimeToUtc } from '../utils/timezone';
import { archiveEventChannel } from '../utils/archive';
import { ensureGameNightTags, resolvedGameNightTag } from '../utils/gameNightTags';
import { updateAnnouncementPin } from '../utils/pins';
import { updateGameListPin, updateRequestPin, updateHubPin } from '../utils/requestPin';
import { findGamesByEvent, upsertGame, GameSuggestion } from '../utils/gameStorage';
import { buildGameEmbed, buildGameButtons, buildBggAttachment } from '../utils/gameEmbeds';
import { MAX_GREETERS } from '../utils/greeters';

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('View upcoming game night events')
  .addSubcommand((sub) => sub.setName('list').setDescription('List upcoming game nights'));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') await handleList(interaction);
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// `timeZone` is the IANA zone (e.g. "America/New_York") the date/time input
// should be interpreted in — normally the guild's configured `timezone`
// (see src/utils/config.ts). Defaults to UTC so callers that don't have a
// guild config on hand (tests, one-off scripts) get deterministic, explicit
// behavior instead of the host process's local zone.
export function parseDateTime(dateStr: string, timeStr: string, timeZone = 'UTC'): Date {
  // Parse time without regex — strip am/pm, split on colon
  const t = timeStr.trim().toLowerCase().replace(/\s/g, '');
  const isPM = t.endsWith('pm');
  const isAM = t.endsWith('am');
  const numeric = t.replace(/(am|pm)$/, '');
  const colonIdx = numeric.indexOf(':');
  let hours = parseInt(colonIdx === -1 ? numeric : numeric.slice(0, colonIdx), 10);
  const minutes = colonIdx === -1 ? 0 : parseInt(numeric.slice(colonIdx + 1, colonIdx + 3), 10);
  if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time: "${timeStr}"`);
  if (isPM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  // Parse date using explicit month-name lookup
  const parts = dateStr.trim().toLowerCase().replace(/,/g, '').split(/\s+/);
  let month = -1;
  let day = -1;
  let year = new Date().getFullYear();
  for (const part of parts) {
    if (MONTH_NAMES[part] !== undefined) month = MONTH_NAMES[part];
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(part)) day = parseInt(part, 10);
    else if (/^\d{4}$/.test(part)) year = parseInt(part, 10);
  }
  if (month === -1 || day === -1) throw new Error(`Invalid date: "${dateStr}"`);

  return zonedTimeToUtc(year, month, day, hours, minutes, timeZone);
}

function formatDate(date: Date, timeZone = 'UTC'): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  });
}

function formatTime(date: Date, timeZone = 'UTC'): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
}

// Surfaces the event ID in the event channel's own topic, not just the
// announcement post footer, so a host can find it without leaving the channel.
function buildEventChannelTopic(title: string, date: string, time: string, location: string, id: string): string {
  return `${title} — ${date} | ${time} | ${location} | Event ID: ${id}`;
}

export async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    await interaction.reply({ content: 'Only hosts can schedule events.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.options.getString('title', true).trim();
  const rawDate = interaction.options.getString('date', true);
  const guild = interaction.guild!;
  const defaults = await getGuildConfig(guild.id);

  const me = await guild.members.fetchMe();
  const rawTime = interaction.options.getString('time', true);
  const rawEndTime = interaction.options.getString('end_time') ?? defaults.defaultEndTime;
  const location = interaction.options.getString('location') ?? (defaults.defaultLocation || 'TBD');
  const link = interaction.options.getString('link') ?? '';
  const description = interaction.options.getString('description') ?? defaults.defaultDescription;

  const timeZone = defaults.timezone;

  let startTime: Date;
  try {
    startTime = parseDateTime(rawDate, rawTime, timeZone);
  } catch {
    await interaction.editReply(
      `Could not parse "${rawDate} ${rawTime}". Try something like "August 22" and "7:00 PM".`,
    );
    return;
  }

  let endTime: Date;
  if (rawEndTime) {
    try {
      endTime = parseDateTime(rawDate, rawEndTime, timeZone);
    } catch {
      await interaction.editReply(
        `Could not parse end time "${rawEndTime}". Try something like "10:00 PM".`,
      );
      return;
    }
  } else {
    endTime = new Date(startTime.getTime() + 4 * 60 * 60 * 1000);
  }

  const date = formatDate(startTime, timeZone);
  const time = `${formatTime(startTime, timeZone)} – ${formatTime(endTime, timeZone)}`;

  // Create Discord scheduled event
  let discordEventId: string | null = null;
  try {
    const scheduledEndTime = endTime;
    const scheduledEvent = await guild.scheduledEvents.create({
      name: `${title} — ${date}`,
      scheduledStartTime: startTime,
      scheduledEndTime: scheduledEndTime,
      entityType: GuildScheduledEventEntityType.External,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityMetadata: { location },
      description: description || undefined,
    });
    discordEventId = scheduledEvent.id;
  } catch (err) {
    console.warn('Could not create Discord scheduled event:', err);
  }

  // Find or create the configured event category
  const eventCategoryName = (await getGuildConfig(guild.id)).eventCategoryName;
  let categoryId: string | undefined;
  try {
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === eventCategoryName,
    );
    if (!category) {
      category = await guild.channels.create({
        name: eventCategoryName,
        type: ChannelType.GuildCategory,
      });
    }
    categoryId = category.id;
  } catch (err) {
    console.warn('Could not find/create event category:', err);
  }

  const id = randomUUID().slice(0, 8);

  // Create event channel, then lock it down in a separate step
  let eventChannelId: string | null = null;
  try {
    const shortDate = startTime.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone });
    const eventChannel = (await guild.channels.create({
      name: `${slugify(shortDate)}-${slugify(title)}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: buildEventChannelTopic(title, date, time, location, id),
    })) as TextChannel;
    eventChannelId = eventChannel.id;

    // Bot always needs explicit access so it can manage the channel. PinMessages is
    // its own permission split off from ManageMessages (see discord link.md) — both
    // are required to actually pin the Quick Actions/Game Lineup/Games to Bring pins.
    await eventChannel.permissionOverwrites.create(me, {
      ViewChannel: true,
      SendMessages: true,
      ManageMessages: true,
      PinMessages: true,
    });

    if (!defaults.openEventChannels) {
      // Private mode: hide from everyone, then grant access per RSVP
      await eventChannel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
      await eventChannel.permissionOverwrites.create(interaction.user, { ViewChannel: true });
    }

    const announcementsRef = defaults.announcementsChannelId
      ? `<#${defaults.announcementsChannelId}>`
      : 'the announcements channel';
    const welcomeMsg = defaults.openEventChannels
      ? `Welcome to **${title}** (${date})! Everyone is welcome — RSVP in ${announcementsRef} so we know you're coming.`
      : `Welcome to **${title}** (${date})! RSVP in ${announcementsRef} to join this channel.`;
    await eventChannel.send(welcomeMsg);
  } catch (err) {
    console.error('Could not create or lock event channel:', err);
  }

  const gn: GameNight = {
    id,
    title,
    date,
    time,
    location,
    link,
    description,
    messageId: '',
    channelId: defaults.announcementsChannelId || interaction.channelId,
    guildId: guild.id,
    discordEventId,
    eventChannelId,
    startTimeISO: startTime.toISOString(),
    endTimeISO: endTime.toISOString(),
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: interaction.user.id,
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    openChannel: defaults.openEventChannels ?? false,
  };

  // Post RSVP embed — in announcements channel if configured, else command channel
  let announcementMsg: Message | null = null;
  let announcementMention = '';
  const targetChannelId = defaults.announcementsChannelId || interaction.channelId;

  try {
    const targetChannel = await guild.channels.fetch(targetChannelId);

    if (targetChannel?.type === ChannelType.GuildForum) {
      // Forum channel: each event becomes a thread post members can comment on
      const forumChannel = targetChannel as ForumChannel;
      const threadName = `${title} · ${date} · ${time}`.slice(0, 100);
      const tagIds = await ensureGameNightTags(forumChannel, guild.id);
      const thread = await forumChannel.threads.create({
        name: threadName,
        appliedTags: resolvedGameNightTag(tagIds, 'upcoming'),
        message: {
          content: '@everyone',
          embeds: [buildGameNightEmbed(gn, {})],
          components: [buildGameNightButtons(id)],
        },
      });
      gn.messageId = thread.id; // thread ID === starter message ID in Discord
      gn.channelId = targetChannelId;
      announcementMention = `<#${thread.id}>`;
    } else {
      // Text channel: existing behaviour
      const textChannel = targetChannel as TextChannel;
      announcementMsg = await textChannel.send({
        content: '@everyone',
        embeds: [buildGameNightEmbed(gn, {})],
        components: [buildGameNightButtons(id)],
      });
      gn.messageId = announcementMsg.id;
      gn.channelId = targetChannelId;
      announcementMention = `<#${targetChannelId}>`;
    }
  } catch (err) {
    console.warn('Could not post RSVP embed:', err);
  }

  await upsertGameNight(gn);

  // Initialize pinned embeds in the event channel right away (even while empty)
  if (gn.eventChannelId) {
    await updateGameListPin(interaction.client, gn.id).catch(() => null);
    await updateRequestPin(interaction.client, gn.id).catch(() => null);
    await updateHubPin(interaction.client, gn.id).catch(() => null);
  }

  // Pin the new event (text channels only — forum threads don't use channel pins)
  if (announcementMsg) {
    await updateAnnouncementPin(guild.client, guild.id).catch((err) =>
      console.warn('Could not pin announcement:', err),
    );
  }

  await interaction.editReply(
    `Event created for **${date}** at **${time}**! RSVP embed posted in ${announcementMention || `<#${gn.channelId}>`}.`,
  );
}

export async function handleEdit(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    await interaction.reply({ content: 'Only hosts can edit events.', flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getString('id', true);
  const gn = await findGameNight(id);

  if (!gn) {
    await interaction.reply({ content: `No event found with ID \`${id}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (gn.cancelled) {
    await interaction.reply({
      content: 'That event is already cancelled and cannot be edited.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (gn.archived) {
    await interaction.reply({
      content: 'That event has already concluded and cannot be edited.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newTitle = interaction.options.getString('title');
  const newRawDate = interaction.options.getString('date');
  const newRawTime = interaction.options.getString('time');
  const newRawEndTime = interaction.options.getString('end_time');
  const newLocation = interaction.options.getString('location');
  const newLink = interaction.options.getString('link');
  const newDescription = interaction.options.getString('description');

  if (
    newTitle === null &&
    newRawDate === null &&
    newRawTime === null &&
    newRawEndTime === null &&
    newLocation === null &&
    newLink === null &&
    newDescription === null
  ) {
    await interaction.reply({
      content: 'Provide at least one field to update.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const timeZone = (await getGuildConfig(gn.guildId)).timezone;

  const currentStart = new Date(gn.startTimeISO);
  const currentEnd = gn.endTimeISO ? new Date(gn.endTimeISO) : new Date(currentStart.getTime() + 4 * 60 * 60 * 1000);
  const currentDateStr = currentStart.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  });
  const currentTimeStr = currentStart.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });

  let startTime = currentStart;
  if (newRawDate || newRawTime) {
    try {
      startTime = parseDateTime(newRawDate ?? currentDateStr, newRawTime ?? currentTimeStr, timeZone);
    } catch {
      await interaction.reply({
        content: `Could not parse "${newRawDate ?? currentDateStr} ${newRawTime ?? currentTimeStr}". Try something like "August 22" and "7:00 PM".`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  let endTime = currentEnd;
  if (newRawEndTime) {
    try {
      endTime = parseDateTime(newRawDate ?? currentDateStr, newRawEndTime, timeZone);
    } catch {
      await interaction.reply({
        content: `Could not parse end time "${newRawEndTime}". Try something like "10:00 PM".`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (newRawDate || newRawTime) {
    // Date/start time shifted but no new end time given — preserve the original duration.
    endTime = new Date(currentEnd.getTime() + (startTime.getTime() - currentStart.getTime()));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = newTitle?.trim() ?? gn.title ?? 'Game Night';
  const date = formatDate(startTime, timeZone);
  const time = `${formatTime(startTime, timeZone)} – ${formatTime(endTime, timeZone)}`;
  const location = newLocation ?? gn.location;
  const link = newLink ?? gn.link;
  const description = newDescription ?? gn.description;

  const timingChanged = startTime.getTime() !== currentStart.getTime() || endTime.getTime() !== currentEnd.getTime();
  const displayChanged =
    timingChanged || title !== (gn.title ?? 'Game Night') || location !== gn.location || newLink !== null || newDescription !== null;

  gn.title = title;
  gn.date = date;
  gn.time = time;
  gn.location = location;
  gn.link = link;
  gn.description = description;
  gn.startTimeISO = startTime.toISOString();
  gn.endTimeISO = endTime.toISOString();

  // Sync the Discord scheduled event so native RSVP ("Interested") stays consistent.
  if (gn.discordEventId) {
    try {
      const guild = interaction.guild!;
      const event = await guild.scheduledEvents.fetch(gn.discordEventId);
      await event.edit({
        name: `${title} — ${date}`,
        scheduledStartTime: startTime,
        scheduledEndTime: endTime,
        entityMetadata: { location },
        description: description || undefined,
      });
    } catch (err) {
      console.warn(`Could not sync Discord scheduled event for game night ${id}:`, err);
    }
  }

  // Rename/retopic the event channel if anything shown there changed.
  if (gn.eventChannelId && displayChanged) {
    try {
      const eventChannel = (await interaction.client.channels.fetch(gn.eventChannelId)) as TextChannel;
      if (eventChannel) {
        const shortDate = startTime.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone });
        await eventChannel.setName(`${slugify(shortDate)}-${slugify(title)}`.slice(0, 100));
        await eventChannel.setTopic(buildEventChannelTopic(title, date, time, location, gn.id));
      }
    } catch (err) {
      console.warn(`Could not rename/retopic event channel for game night ${id}:`, err);
    }
  }

  // Re-render the RSVP post so it reflects the new details.
  if (gn.messageId && gn.channelId && displayChanged) {
    try {
      const postChannel = await interaction.client.channels.fetch(gn.channelId);
      if (postChannel?.type === ChannelType.GuildForum) {
        const thread = await interaction.client.channels.fetch(gn.messageId);
        if (thread?.isThread()) {
          const starter = await thread.fetchStarterMessage();
          await starter?.edit({ embeds: [buildGameNightEmbed(gn, {})] });
          await thread.setName(`${title} · ${date} · ${time}`.slice(0, 100));
        }
      } else {
        const msg = await (postChannel as TextChannel).messages.fetch(gn.messageId);
        await msg.edit({ embeds: [buildGameNightEmbed(gn, {})] });
      }
    } catch (err) {
      console.warn(`Could not update RSVP post for game night ${id}:`, err);
    }
  }

  await upsertGameNight(gn);
  await updateAnnouncementPin(interaction.client, gn.guildId).catch(() => null);

  await interaction.editReply(`Event \`${id}\` updated.`);
}

// Guild-wide `openEventChannels` (see handleConfig below) only sets the default for *new*
// events — it can't flip an event that already exists between open/RSVP-only. This lets a
// host override that per event, e.g. to open up a channel that started RSVP-only once it's
// no longer at capacity, without touching the server-wide default.
export async function handlePrivacy(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    await interaction.reply({
      content: "Only hosts can change an event's channel visibility.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = interaction.options.getString('id', true);
  const open = interaction.options.getBoolean('open', true);
  const gn = await findGameNight(id);

  if (!gn) {
    await interaction.reply({ content: `No event found with ID \`${id}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (gn.cancelled) {
    await interaction.reply({
      content: 'That event is already cancelled.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (gn.archived) {
    await interaction.reply({
      content: 'That event has already concluded.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!gn.eventChannelId) {
    await interaction.reply({
      content: 'This event has no channel to update.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const current = gn.openChannel ?? false;
  if (open === current) {
    await interaction.reply({
      content: `This event's channel is already ${open ? 'open to everyone' : 'RSVP-only'}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild!;
  try {
    const eventChannel = (await interaction.client.channels.fetch(gn.eventChannelId)) as TextChannel;
    if (open) {
      // Remove the deny-view overwrite so the channel inherits normal visibility. The
      // per-user grants made while it was RSVP-only are left in place — harmless once
      // @everyone can see the channel anyway.
      await eventChannel.permissionOverwrites.delete(guild.roles.everyone);
    } else {
      await eventChannel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
      // Re-grant access to whoever should already be able to see it — the creator, plus
      // everyone currently RSVP'd Going/Maybe — since none of them got an individual
      // overwrite while the channel was open.
      const attendees = new Set([gn.createdBy, ...gn.rsvps.yes, ...gn.rsvps.maybe]);
      for (const userId of attendees) {
        await eventChannel.permissionOverwrites.create(userId, { ViewChannel: true }).catch(() => null);
      }
    }
  } catch (err) {
    console.warn(`Could not update channel visibility for game night ${id}:`, err);
    await interaction.editReply(
      'Could not update the channel permissions — check the bot has Manage Roles access there.',
    );
    return;
  }

  gn.openChannel = open;
  await upsertGameNight(gn);

  await interaction.editReply(
    `Event \`${id}\`'s channel is now ${open ? '**open to everyone**' : '**RSVP-only**'}.`,
  );
}

// Re-renders a single game's posted card (embed + buttons) after its seats/waitlist
// were mutated outside the normal button-click flow (e.g. by the greeter reconciliation
// below), so the live message doesn't go stale.
async function refreshGameCard(client: Client, game: GameSuggestion): Promise<void> {
  try {
    const channel = (await client.channels.fetch(game.channelId)) as TextChannel;
    const msg = await channel.messages.fetch(game.messageId);
    const nameMap: Record<string, string> = {};
    if (channel.guild) {
      await Promise.all(
        [...game.seats, ...game.waitlist].map(async (userId) => {
          try {
            nameMap[userId] = (await channel.guild.members.fetch(userId)).displayName;
          } catch {
            /* fall back to mention */
          }
        }),
      );
    }
    await msg.edit({
      embeds: [await buildGameEmbed(game, nameMap)],
      files: [buildBggAttachment()],
      components: [buildGameButtons(game.id, game.seats.length >= game.maxPlayers)],
    });
  } catch {
    /* card may have been deleted */
  }
}

// Assigning a new greeter can retroactively conflict with seats/waitlist spots they (or
// the other greeter) already hold — see handleSetGreeters below. Rather than leaving the
// event in an inconsistent state (a "greeter" seated on a Heavy game), this removes the
// offending seats/waitlist spots and reports what it removed so the host can tell affected
// players directly if needed.
async function reconcileGreeterSeats(
  client: Client,
  eventId: string,
  newGreeters: string[],
): Promise<string[]> {
  const notes: string[] = [];
  if (newGreeters.length === 0) return notes;

  const games = await findGamesByEvent(eventId);
  const [keep, drop] = newGreeters; // if both greeters land on the same game, keep the first, drop the second

  for (const game of games) {
    let changed = false;
    const nonLight = game.complexity !== 'Light';

    for (const greeterId of newGreeters) {
      if (nonLight && game.seats.includes(greeterId)) {
        game.seats = game.seats.filter((id) => id !== greeterId);
        notes.push(`Removed <@${greeterId}> from **${game.title}** (not a Light game)`);
        changed = true;
      }
      if (nonLight && game.waitlist.includes(greeterId)) {
        game.waitlist = game.waitlist.filter((id) => id !== greeterId);
        notes.push(`Removed <@${greeterId}> from **${game.title}**'s waitlist (not a Light game)`);
        changed = true;
      }
    }

    if (drop) {
      if (game.seats.includes(keep) && game.seats.includes(drop)) {
        game.seats = game.seats.filter((id) => id !== drop);
        notes.push(`Removed <@${drop}> from **${game.title}** (both greeters can't be on the same game)`);
        changed = true;
      }
      if (game.waitlist.includes(keep) && game.waitlist.includes(drop)) {
        game.waitlist = game.waitlist.filter((id) => id !== drop);
        notes.push(`Removed <@${drop}> from **${game.title}**'s waitlist (both greeters can't be on the same game)`);
        changed = true;
      }
    }

    if (changed) {
      await upsertGame(game);
      await refreshGameCard(client, game);
    }
  }

  return notes;
}

export async function handleSetGreeters(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    await interaction.reply({ content: 'Only hosts can set greeters.', flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getString('id', true);
  const gn = await findGameNight(id);

  if (!gn) {
    await interaction.reply({ content: `No event found with ID \`${id}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (gn.cancelled) {
    await interaction.reply({ content: 'That event is already cancelled.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (gn.archived) {
    await interaction.reply({ content: 'That event has already concluded.', flags: MessageFlags.Ephemeral });
    return;
  }

  const clear = interaction.options.getBoolean('clear') ?? false;
  const greeter1 = interaction.options.getUser('greeter1');
  const greeter2 = interaction.options.getUser('greeter2');
  const removeUser = interaction.options.getUser('remove');

  if (clear) {
    gn.greeters = [];
    await upsertGameNight(gn);
    await interaction.reply({ content: `Greeters cleared for event \`${id}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (removeUser) {
    const current = gn.greeters ?? [];
    if (!current.includes(removeUser.id)) {
      await interaction.reply({
        content: `<@${removeUser.id}> isn't currently a greeter for event \`${id}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const remaining = current.filter((userId) => userId !== removeUser.id);
    gn.greeters = remaining;
    await upsertGameNight(gn);
    try {
      await updateGameListPin(interaction.client, gn.id);
    } catch {
      /* no event channel */
    }
    const remainingNote = remaining.length > 0
      ? ` Remaining greeter: <@${remaining[0]}>.`
      : ' No greeters remain for this event.';
    await interaction.reply({
      content: `Removed <@${removeUser.id}> as a greeter for event \`${id}\`.${remainingNote}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!greeter1) {
    const current = gn.greeters ?? [];
    const content = current.length > 0
      ? `Current greeter(s) for event \`${id}\`: ${current.map((userId) => `<@${userId}>`).join(' and ')}.`
      : `No greeters currently set for event \`${id}\`.`;
    await interaction.reply({
      content: `${content}\n\nProvide \`greeter1\` (and optionally \`greeter2\`) to set greeters, \`remove\` to remove just one, or \`clear:true\` to remove all.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (greeter2 && greeter2.id === greeter1.id) {
    await interaction.reply({
      content: '`greeter1` and `greeter2` must be different users.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const newGreeters = greeter2 ? [greeter1.id, greeter2.id] : [greeter1.id];
  gn.greeters = newGreeters;
  await upsertGameNight(gn);

  const notes = await reconcileGreeterSeats(interaction.client, gn.id, newGreeters);
  try {
    await updateGameListPin(interaction.client, gn.id);
  } catch {
    /* no event channel */
  }

  const names = newGreeters.map((userId) => `<@${userId}>`).join(' and ');
  const pairNote = newGreeters.length === MAX_GREETERS ? ", and they can't both be seated on the same game" : '';
  const summary = `Greeters for event \`${id}\` set to ${names}. They can now only sign up for Light-complexity games${pairNote}.`;
  const noteBlock = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
  await interaction.editReply(`${summary}${noteBlock}`);
}

export async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const patch: Partial<GuildConfig> = {};
  const location = interaction.options.getString('location');
  const time = interaction.options.getString('time');
  const endTime = interaction.options.getString('end_time');
  const description = interaction.options.getString('description');
  const announcements = interaction.options.getChannel('announcements');
  const openChannels = interaction.options.getBoolean('open_channels');
  const eventCategory = interaction.options.getString('event_category');
  const archiveCategory = interaction.options.getString('archive_category');
  const archiveRetentionDays = interaction.options.getInteger('archive_retention_days');
  const lockHoursBeforeEvent = interaction.options.getInteger('lock_hours_before_event');
  const tableCount = interaction.options.getInteger('table_count');
  const lightBufferMinutes = interaction.options.getInteger('light_buffer_minutes');
  const mediumBufferMinutes = interaction.options.getInteger('medium_buffer_minutes');
  const heavyBufferMinutes = interaction.options.getInteger('heavy_buffer_minutes');
  const postBgStatsLinks = interaction.options.getBoolean('post_bgstats_links');
  const heavyGameBreakMinutes = interaction.options.getInteger('heavy_game_break_minutes');
  const maxGameRepeats = interaction.options.getInteger('max_game_repeats');
  const maxTableCount = interaction.options.getInteger('max_tables');
  const breakMinutesBetweenGames = interaction.options.getInteger('break_minutes');
  const flexTableCount = interaction.options.getInteger('flex_tables');
  const timezone = interaction.options.getString('timezone');

  if (timezone !== null && !isValidTimeZone(timezone)) {
    await interaction.reply({
      content: `"${timezone}" isn't a recognized timezone. Use an IANA name like \`America/New_York\`, \`Europe/London\`, \`Australia/Sydney\`, or \`UTC\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (location !== null) patch.defaultLocation = location;
  if (time !== null) patch.defaultTime = time;
  if (endTime !== null) patch.defaultEndTime = endTime;
  if (description !== null) patch.defaultDescription = description;
  if (announcements !== null) patch.announcementsChannelId = announcements.id;
  if (openChannels !== null) patch.openEventChannels = openChannels;
  if (eventCategory !== null) patch.eventCategoryName = eventCategory;
  if (archiveCategory !== null) patch.archiveCategoryName = archiveCategory;
  if (archiveRetentionDays !== null) {
    // Enforce minimum of 7 days (the lock delay) when non-zero
    patch.archivedChannelRetentionDays = archiveRetentionDays > 0 && archiveRetentionDays < 7 ? 7 : archiveRetentionDays;
  }
  if (lockHoursBeforeEvent !== null) patch.lockHoursBeforeEvent = lockHoursBeforeEvent;
  if (tableCount !== null) patch.scheduleTableCount = tableCount;
  if (lightBufferMinutes !== null) patch.lightBufferMinutes = lightBufferMinutes;
  if (mediumBufferMinutes !== null) patch.mediumBufferMinutes = mediumBufferMinutes;
  if (heavyBufferMinutes !== null) patch.heavyBufferMinutes = heavyBufferMinutes;
  if (postBgStatsLinks !== null) patch.postBgStatsLinks = postBgStatsLinks;
  if (heavyGameBreakMinutes !== null) patch.heavyGameBreakMinutes = heavyGameBreakMinutes;
  if (maxGameRepeats !== null) patch.maxGameRepeats = maxGameRepeats;
  if (maxTableCount !== null) patch.maxTableCount = maxTableCount;
  if (breakMinutesBetweenGames !== null) patch.breakMinutesBetweenGames = breakMinutesBetweenGames;
  if (flexTableCount !== null) patch.flexTableCount = flexTableCount;
  if (timezone !== null) patch.timezone = timezone;

  function formatConfig(c: GuildConfig): string {
    const retentionDays = c.archivedChannelRetentionDays ?? 0;
    return [
      '**Event defaults:**',
      `> Timezone: ${c.timezone}${c.timezone === 'UTC' ? ' ⚠️ *not configured — event times will display in UTC, which is likely wrong for your community. Set it with `timezone:America/New_York` (or your own IANA zone).*' : ''}`,
      `> Start time: ${c.defaultTime || '*not set*'}`,
      `> End time: ${c.defaultEndTime || '*not set*'}`,
      `> Location: ${c.defaultLocation || '*not set*'}`,
      `> Description: ${c.defaultDescription || '*not set*'}`,
      `> Announcements channel: ${c.announcementsChannelId ? `<#${c.announcementsChannelId}>` : '*not set*'}`,
      `> Event channel access: ${c.openEventChannels ? 'Open to everyone' : 'RSVP only'}`,
      `> Event category: ${c.eventCategoryName}`,
      `> Archive category: ${c.archiveCategoryName}`,
      `> Archived channel retention: ${retentionDays === 0 ? 'Never auto-delete' : `${retentionDays} days`}`,
      `> Lineup lock: ${c.lockHoursBeforeEvent === 0 ? 'Disabled' : `${c.lockHoursBeforeEvent}h before event`}`,
      `> Scheduler tables: ${c.scheduleTableCount}${c.maxTableCount > 0 ? ` (capped at ${c.maxTableCount})` : ''}${c.flexTableCount > 0 ? ` (${c.flexTableCount} reserved for Light games)` : ''}`,
      `> Scheduling buffers: Light +${c.lightBufferMinutes}m, Medium +${c.mediumBufferMinutes}m, Heavy +${c.heavyBufferMinutes}m`,
      `> Heavy-game break: ${c.heavyGameBreakMinutes === 0 ? 'Disabled' : `${c.heavyGameBreakMinutes}m before back-to-back Heavy games at a table`}`,
      `> Break between games: ${c.breakMinutesBetweenGames === 0 ? 'Disabled' : `${c.breakMinutesBetweenGames}m before a person's next game can start`}`,
      `> Short-game repeat cap: ${c.maxGameRepeats}x`,
      `> BG Stats buttons on lock: ${c.postBgStatsLinks ? 'Enabled' : 'Disabled'}`,
    ].join('\n');
  }

  if (Object.keys(patch).length === 0) {
    await interaction.reply({
      content: formatConfig(await getGuildConfig(interaction.guildId!)),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updated = await updateGuildConfig(interaction.guildId!, patch);
  await interaction.reply({
    content: formatConfig(updated).replace('**Event defaults:**', '**Event defaults updated:**'),
    flags: MessageFlags.Ephemeral,
  });

  // Eagerly create forum status tags so they're ready before the first event post
  // (only applies when the announcements channel is a forum channel; best-effort).
  if (patch.announcementsChannelId) {
    try {
      const forumChannel = await interaction.client.channels.fetch(patch.announcementsChannelId);
      if (forumChannel?.type === ChannelType.GuildForum) {
        await ensureGameNightTags(forumChannel as ForumChannel, interaction.guildId!);
      }
    } catch {
      // non-fatal — tags will be created lazily on the first event post
    }
  }
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const upcoming = (await loadGameNights()).filter((g) => !g.cancelled && !g.archived);

  if (upcoming.length === 0) {
    await interaction.reply({ content: 'No upcoming game nights scheduled.', flags: MessageFlags.Ephemeral });
    return;
  }

  const isHost = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const guildId = interaction.guildId!;

  const lines = upcoming.map((g) => {
    const rsvpLink = g.messageId && g.channelId
      ? `[RSVP](https://discord.com/channels/${guildId}/${g.channelId}/${g.messageId})`
      : null;
    const channelRef = g.eventChannelId ? `<#${g.eventChannelId}>` : null;
    const startUnix = Math.floor(new Date(g.startTimeISO).getTime() / 1000);
    const parts = [
      `**<t:${startUnix}:F>** @ ${g.location}`,
      `${g.rsvps.yes.length} going`,
      channelRef,
      rsvpLink,
      isHost ? `\`id:${g.id}\`` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  });

  await interaction.reply({
    content: `**Upcoming Game Nights:**\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString('id', true);
  const gn = await findGameNight(id);

  if (!gn) {
    await interaction.reply({ content: `No event found with ID \`${id}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (gn.cancelled) {
    await interaction.reply({ content: 'That event is already cancelled.', flags: MessageFlags.Ephemeral });
    return;
  }

  const isCreator = gn.createdBy === interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (!isCreator && !isAdmin) {
    await interaction.reply({
      content: 'Only the event creator or an admin can cancel this.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (gn.discordEventId) {
    try {
      const event = await interaction.guild!.scheduledEvents.fetch(gn.discordEventId);
      await event.delete();
    } catch {
      /* already deleted */
    }
  }

  gn.cancelled = true;
  await upsertGameNight(gn);
  await cleanupCancelledNight(interaction.client, gn);

  await updateAnnouncementPin(interaction.client, interaction.guildId!).catch(() => null);

  await interaction.editReply(`Event \`${id}\` has been cancelled.`);
}

export async function handleArchiveOld(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const now = Date.now();
  const toArchive = (await loadGameNights()).filter(
    (g) =>
      !g.cancelled && !g.archived && g.eventChannelId && new Date(g.startTimeISO).getTime() < now,
  );

  if (toArchive.length === 0) {
    await interaction.editReply('No past event channels to archive.');
    return;
  }

  let archived = 0;
  for (const gn of toArchive) {
    try {
      await archiveEventChannel(interaction.client, gn);
      archived++;
    } catch (err) {
      console.warn(`Could not archive channel for event ${gn.id}:`, err);
    }
  }

  await updateAnnouncementPin(interaction.client, interaction.guildId!).catch(() => null);
  await interaction.editReply(`Archived ${archived} of ${toArchive.length} past event channel(s).`);
}
