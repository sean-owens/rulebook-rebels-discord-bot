import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  Message,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { loadGameNights, findGameNight, upsertGameNight, GameNight } from '../utils/storage';
import { buildGameNightEmbed, buildGameNightButtons } from '../utils/embeds';
import { cleanupCancelledNight } from './cancelHelper';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { archiveEventChannel } from '../utils/archive';
import { updateAnnouncementPin } from '../utils/pins';

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Manage game night events')
  .addSubcommand(sub =>
    sub
      .setName('create')
      .setDescription('Schedule a new game night')
      .addStringOption(opt =>
        opt.setName('date').setDescription('Date (e.g. "August 22" or "aug 22")').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('time').setDescription('Start time (e.g. "7pm" or "7:00 PM")').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('end_time').setDescription('End time (e.g. "10pm" or "10:00 PM") — uses server default if omitted').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('location').setDescription('Where it is — uses server default if omitted').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('link').setDescription('Optional URL (e.g. map link, event page)').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('description').setDescription('Optional extra notes').setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName('list').setDescription('List upcoming game nights')
  )
  .addSubcommand(sub =>
    sub
      .setName('config')
      .setDescription('Set server-wide defaults for new events (admin only)')
      .addStringOption(opt =>
        opt.setName('location').setDescription('Default location').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('time').setDescription('Default start time (e.g. "7:00 PM")').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('end_time').setDescription('Default end time (e.g. "10:00 PM")').setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('description').setDescription('Default notes').setRequired(false)
      )
      .addChannelOption(opt =>
        opt.setName('announcements').setDescription('Channel where RSVP embeds are posted').setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('archive')
      .setDescription('Archive channels for all past events (admin only)')
  )
  .addSubcommand(sub =>
    sub
      .setName('cancel')
      .setDescription('Cancel a game night (creator or admin only)')
      .addStringOption(opt =>
        opt.setName('id').setDescription('Game night ID (shown in the event embed footer)').setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') await handleCreate(interaction);
  else if (sub === 'list') await handleList(interaction);
  else if (sub === 'cancel') await handleCancel(interaction);
  else if (sub === 'config') await handleConfig(interaction);
  else if (sub === 'archive') await handleArchiveOld(interaction);
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

function parseDateTime(dateStr: string, timeStr: string): Date {
  console.log(`parseDateTime date="${dateStr}" time="${timeStr}"`);

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
    else if (/^\d{1,2}$/.test(part)) day = parseInt(part, 10);
    else if (/^\d{4}$/.test(part)) year = parseInt(part, 10);
  }
  console.log(`Parsed month=${month} day=${day} year=${year} hours=${hours} minutes=${minutes}`);
  if (month === -1 || day === -1) throw new Error(`Invalid date: "${dateStr}"`);

  return new Date(year, month, day, hours, minutes, 0, 0);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}


async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const rawDate = interaction.options.getString('date', true);
  const guild = interaction.guild!;
  const defaults = getGuildConfig(guild.id);

  const me = await guild.members.fetchMe();
  console.log('Bot permissions:', me.permissions.toArray());

  const rawTime = interaction.options.getString('time', true);
  const rawEndTime = interaction.options.getString('end_time') ?? defaults.defaultEndTime;
  const location = interaction.options.getString('location') ?? (defaults.defaultLocation || 'TBD');
  const link = interaction.options.getString('link') ?? '';
  const description = interaction.options.getString('description') ?? defaults.defaultDescription;

  let startTime: Date;
  try {
    startTime = parseDateTime(rawDate, rawTime);
  } catch {
    await interaction.editReply(`Could not parse "${rawDate} ${rawTime}". Try something like "August 22" and "7:00 PM".`);
    return;
  }

  let endTime: Date;
  if (rawEndTime) {
    try {
      endTime = parseDateTime(rawDate, rawEndTime);
    } catch {
      await interaction.editReply(`Could not parse end time "${rawEndTime}". Try something like "10:00 PM".`);
      return;
    }
  } else {
    endTime = new Date(startTime.getTime() + 4 * 60 * 60 * 1000);
  }

  const date = formatDate(startTime);
  const time = `${formatTime(startTime)} – ${formatTime(endTime)}`;

  // Create Discord scheduled event
  let discordEventId: string | null = null;
  try {
    const scheduledEndTime = endTime;
    const scheduledEvent = await guild.scheduledEvents.create({
      name: `Monthly Game Event — ${date}`,
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

  // Find or create "Monthly Events" category
  let categoryId: string | undefined;
  try {
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === 'Monthly Events'
    );
    if (!category) {
      category = await guild.channels.create({ name: 'Monthly Events', type: ChannelType.GuildCategory });
    }
    categoryId = category.id;
  } catch (err) {
    console.warn('Could not find/create Monthly Events category:', err);
  }

  // Create event channel, then lock it down in a separate step
  let eventChannelId: string | null = null;
  try {
    const shortDate = startTime.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const eventChannel = await guild.channels.create({
      name: `monthly-${slugify(shortDate)}`,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Monthly Gaming Event — ${date} | ${time} | ${location}`,
    }) as TextChannel;
    eventChannelId = eventChannel.id;

    // Set bot access first so it retains access after @everyone is denied
    await eventChannel.permissionOverwrites.create(me, { ViewChannel: true, SendMessages: true, ManageMessages: true });
    await eventChannel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
    await eventChannel.permissionOverwrites.create(interaction.user, { ViewChannel: true });

    const announcementsRef = defaults.announcementsChannelId ? `<#${defaults.announcementsChannelId}>` : 'the announcements channel';
    await eventChannel.send(`Welcome to the **${date}** Monthly Gaming Event! RSVP in ${announcementsRef} to join this channel.`);
  } catch (err) {
    console.error('Could not create or lock event channel:', err);
  }

  const id = randomUUID().slice(0, 8);

  const gn: GameNight = {
    id,
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
  };

  // Post RSVP embed — in announcements channel if configured, else command channel
  let announcementMsg: Message | null = null;
  const targetChannelId = defaults.announcementsChannelId || interaction.channelId;

  try {
    const targetChannel = await guild.channels.fetch(targetChannelId) as TextChannel;
    announcementMsg = await targetChannel.send({
      content: '@everyone',
      embeds: [buildGameNightEmbed(gn, {})],
      components: [buildGameNightButtons(id)],
    });
    gn.messageId = announcementMsg.id;
    gn.channelId = targetChannelId;
  } catch (err) {
    console.warn('Could not post RSVP embed:', err);
  }

  upsertGameNight(gn);

  // Pin the new event, unpin the previous bot pin
  if (announcementMsg) {
    await updateAnnouncementPin(guild.client, guild.id).catch(err =>
      console.warn('Could not pin announcement:', err)
    );
  }

  const channelMention = `<#${gn.channelId}>`;
  await interaction.editReply(`Event created for **${date}** at **${time}**! RSVP embed posted in ${channelMention}.`);
}

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (!isAdmin) {
    await interaction.reply({ content: 'Only admins can change event defaults.', ephemeral: true });
    return;
  }

  const patch: Record<string, string> = {};
  const location = interaction.options.getString('location');
  const time = interaction.options.getString('time');
  const endTime = interaction.options.getString('end_time');
  const description = interaction.options.getString('description');
  const announcements = interaction.options.getChannel('announcements');

  if (location !== null) patch.defaultLocation = location;
  if (time !== null) patch.defaultTime = time;
  if (endTime !== null) patch.defaultEndTime = endTime;
  if (description !== null) patch.defaultDescription = description;
  if (announcements !== null) patch.announcementsChannelId = announcements.id;

  if (Object.keys(patch).length === 0) {
    const current = getGuildConfig(interaction.guildId!);
    await interaction.reply({
      content: [
        '**Current event defaults:**',
        `> Start time: ${current.defaultTime || '*not set*'}`,
        `> End time: ${current.defaultEndTime || '*not set*'}`,
        `> Location: ${current.defaultLocation || '*not set*'}`,
        `> Description: ${current.defaultDescription || '*not set*'}`,
        `> Announcements channel: ${current.announcementsChannelId ? `<#${current.announcementsChannelId}>` : '*not set*'}`,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  const updated = updateGuildConfig(interaction.guildId!, patch);
  await interaction.reply({
    content: [
      '**Event defaults updated:**',
      `> Start time: ${updated.defaultTime || '*not set*'}`,
      `> End time: ${updated.defaultEndTime || '*not set*'}`,
      `> Location: ${updated.defaultLocation || '*not set*'}`,
      `> Description: ${updated.defaultDescription || '*not set*'}`,
      `> Announcements channel: ${updated.announcementsChannelId ? `<#${updated.announcementsChannelId}>` : '*not set*'}`,
    ].join('\n'),
    ephemeral: true,
  });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const upcoming = loadGameNights().filter(g => !g.cancelled && !g.archived);

  if (upcoming.length === 0) {
    await interaction.reply({ content: 'No upcoming game nights scheduled.', ephemeral: true });
    return;
  }

  const lines = upcoming.map(
    g => `\`${g.id}\` — **${g.date}** at **${g.time}** @ ${g.location}${g.eventChannelId ? ` | <#${g.eventChannelId}>` : ''} (${g.rsvps.yes.length} going)`
  );

  await interaction.reply({
    content: `**Upcoming Game Nights:**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString('id', true);
  const gn = findGameNight(id);

  if (!gn) {
    await interaction.reply({ content: `No event found with ID \`${id}\`.`, ephemeral: true });
    return;
  }
  if (gn.cancelled) {
    await interaction.reply({ content: 'That event is already cancelled.', ephemeral: true });
    return;
  }

  const isCreator = gn.createdBy === interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (!isCreator && !isAdmin) {
    await interaction.reply({ content: 'Only the event creator or an admin can cancel this.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  if (gn.discordEventId) {
    try {
      const event = await interaction.guild!.scheduledEvents.fetch(gn.discordEventId);
      await event.delete();
    } catch { /* already deleted */ }
  }

  gn.cancelled = true;
  upsertGameNight(gn);
  await cleanupCancelledNight(interaction.client, gn);

  await updateAnnouncementPin(interaction.client, interaction.guildId!).catch(() => null);

  await interaction.editReply(`Event \`${id}\` has been cancelled.`);
}

async function handleArchiveOld(interaction: ChatInputCommandInteraction): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (!isAdmin) {
    await interaction.reply({ content: 'Only admins can archive events.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const now = Date.now();
  const toArchive = loadGameNights().filter(
    g => !g.cancelled && !g.archived && g.eventChannelId && new Date(g.startTimeISO).getTime() < now
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
