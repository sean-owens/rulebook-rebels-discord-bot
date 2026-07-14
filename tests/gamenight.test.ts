import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDateTime } from '../src/commands/gamenight';

const YEAR = new Date().getFullYear();

vi.mock('../src/utils/requestPin', () => ({
  updateGameListPin: vi.fn(async () => {}),
  updateRequestPin: vi.fn(async () => {}),
}));

vi.mock('../src/utils/pins', () => ({
  updateAnnouncementPin: vi.fn(async () => {}),
}));

describe('parseDateTime', () => {
  // Default timezone is UTC (see src/utils/timezone.ts), so assertions use the
  // UTC getters — this makes the tests deterministic regardless of the host
  // machine's own local timezone, and reflects the fixed contract: the
  // returned Date's absolute instant corresponds to the given wall-clock time
  // in the requested (or default UTC) zone, not whatever zone the process happens to run in.

  // ── Time parsing ───────────────────────────────────────────────────────────

  it('parses "7pm" as 19:00', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('parses "7:30 PM" as 19:30', () => {
    const d = parseDateTime('August 22', '7:30 PM');
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(30);
  });

  it('parses "12pm" as noon (12:00)', () => {
    const d = parseDateTime('August 22', '12pm');
    expect(d.getUTCHours()).toBe(12);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('parses "12am" as midnight (0:00)', () => {
    const d = parseDateTime('August 22', '12am');
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('parses "10:00 PM" as 22:00', () => {
    const d = parseDateTime('August 22', '10:00 PM');
    expect(d.getUTCHours()).toBe(22);
    expect(d.getUTCMinutes()).toBe(0);
  });

  // ── Date parsing ───────────────────────────────────────────────────────────

  it('parses full month name', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getUTCMonth()).toBe(7); // 0-indexed
    expect(d.getUTCDate()).toBe(22);
    expect(d.getUTCFullYear()).toBe(YEAR);
  });

  it('parses abbreviated month name', () => {
    const d = parseDateTime('aug 22', '7pm');
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(22);
  });

  it('parses an explicit 4-digit year', () => {
    const d = parseDateTime('September 5 2027', '7pm');
    expect(d.getUTCFullYear()).toBe(2027);
    expect(d.getUTCMonth()).toBe(8);
    expect(d.getUTCDate()).toBe(5);
  });

  it('handles December correctly', () => {
    const d = parseDateTime('December 31', '11:59 PM');
    expect(d.getUTCMonth()).toBe(11);
    expect(d.getUTCDate()).toBe(31);
    expect(d.getUTCHours()).toBe(23);
    expect(d.getUTCMinutes()).toBe(59);
  });

  it('handles January correctly', () => {
    const d = parseDateTime('January 1', '12am');
    expect(d.getUTCMonth()).toBe(0);
    expect(d.getUTCDate()).toBe(1);
  });

  it('ignores extra commas in the date string', () => {
    const d = parseDateTime('August, 22', '7pm');
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(22);
  });

  it('parses ordinal day suffixes (1st, 2nd, 3rd, 30th)', () => {
    expect(parseDateTime('June 30th', '8am').getUTCDate()).toBe(30);
    expect(parseDateTime('July 1st', '7pm').getUTCDate()).toBe(1);
    expect(parseDateTime('August 2nd', '7pm').getUTCDate()).toBe(2);
    expect(parseDateTime('September 3rd', '7pm').getUTCDate()).toBe(3);
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  it('throws when the date string has no recognisable month', () => {
    expect(() => parseDateTime('22nd of the 8th', '7pm')).toThrow();
  });

  it('throws when the date string has no recognisable day', () => {
    expect(() => parseDateTime('August', '7pm')).toThrow();
  });

  it('throws when the time string is not parseable', () => {
    expect(() => parseDateTime('August 22', 'noon')).toThrow();
  });

  // ── Timezone handling (regression: native scheduled event time not matching
  // the announcement embed, caused by parsing input in the host process's
  // local zone instead of an explicit, configured one) ───────────────────────

  it('defaults to UTC when no timezone is given', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.toISOString()).toBe(`${YEAR}-08-22T19:00:00.000Z`);
  });

  it('interprets the wall-clock time in the given IANA timezone', () => {
    // 7:00 PM EDT (UTC-4) in July.
    const d = parseDateTime('July 14 2026', '7pm', 'America/New_York');
    expect(d.toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });

  it('produces a different UTC instant for the same wall-clock time in different timezones', () => {
    const ny = parseDateTime('July 14 2026', '7pm', 'America/New_York');
    const utc = parseDateTime('July 14 2026', '7pm', 'UTC');
    expect(ny.getTime()).not.toBe(utc.getTime());
  });
});

// ── handleCreate — title threaded through naming ────────────────────────────

describe('handleCreate', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGuild() {
    const eventChannel = {
      id: 'event-channel-1',
      permissionOverwrites: { create: vi.fn(async () => {}) },
      send: vi.fn(async () => {}),
    };
    const announcementChannel = {
      type: 0, // ChannelType.GuildText
      send: vi.fn(async () => ({ id: 'announcement-msg-1' })),
    };
    const channelsCreate = vi.fn(async (opts: { type: number; name: string }) => {
      // First call is the category (type GuildCategory=4), second is the event text channel.
      return opts.type === 4 ? { id: 'category-1' } : eventChannel;
    });

    return {
      id: 'guild-1',
      client: {},
      roles: { everyone: { id: 'everyone-role' } },
      members: { fetchMe: vi.fn(async () => ({ id: 'bot-member' })) },
      scheduledEvents: { create: vi.fn(async (opts: { name: string }) => ({ id: 'sched-1', ...opts })) },
      channels: {
        cache: { find: vi.fn(() => undefined) },
        create: channelsCreate,
        fetch: vi.fn(async () => announcementChannel),
      },
      _eventChannel: eventChannel,
      _announcementChannel: announcementChannel,
    };
  }

  function makeCreateInteraction(title: string, guild: ReturnType<typeof makeGuild>) {
    const options: Record<string, string | null> = {
      title,
      date: 'August 22',
      time: '7pm',
      end_time: null,
      location: null,
      link: null,
      description: null,
    };
    return {
      guild,
      guildId: guild.id,
      client: {},
      channelId: 'command-channel-1',
      user: { id: 'host-1' },
      memberPermissions: { has: () => true },
      options: {
        getString: (name: string) => options[name] ?? null,
      },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('uses the title across the scheduled event, channel name/topic, and welcome message', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Board Game Bash', guild);

    await handleCreate(interaction);

    expect(guild.scheduledEvents.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^Board Game Bash — .*August 22/) }),
    );
    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'august-22-board-game-bash',
        topic: expect.stringMatching(/^Board Game Bash — .*August 22/),
      }),
    );
    expect(guild._eventChannel.send).toHaveBeenCalledWith(
      expect.stringContaining('Board Game Bash'),
    );
  });

  it('stores the title on the GameNight record and uses it in the RSVP embed', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const { loadGameNights } = await import('../src/utils/storage');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Trivia Night', guild);

    await handleCreate(interaction);

    const nights = await loadGameNights();
    expect(nights).toHaveLength(1);
    expect(nights[0].title).toBe('Trivia Night');

    const sendCall = guild._announcementChannel.send.mock.calls[0][0];
    const embedTitle = sendCall.embeds[0].data.title;
    expect(embedTitle).toMatch(/^Trivia Night — .*August 22/);
  });
});

// ── handleCreate — forum channel status tags ────────────────────────────────

describe('handleCreate — forum announcements channel', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-forum-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeForumChannel() {
    const channel: any = {
      type: 15, // ChannelType.GuildForum
      availableTags: [] as { id: string; name: string; moderated: boolean }[],
      threads: { create: vi.fn(async (opts: any) => ({ id: 'thread-1', ...opts })) },
    };
    channel.setAvailableTags = vi.fn(async (tags: { id?: string; name: string; moderated: boolean }[]) => {
      channel.availableTags = tags.map((t, i) => ({ id: t.id ?? `tag-${i}`, name: t.name, moderated: t.moderated }));
      return { availableTags: channel.availableTags };
    });
    return channel;
  }

  function makeGuildWithForum(forumChannel: ReturnType<typeof makeForumChannel>) {
    const eventChannel = {
      id: 'event-channel-1',
      permissionOverwrites: { create: vi.fn(async () => {}) },
      send: vi.fn(async () => {}),
    };
    const channelsCreate = vi.fn(async (opts: { type: number; name: string }) =>
      opts.type === 4 ? { id: 'category-1' } : eventChannel,
    );
    return {
      id: 'guild-1',
      client: {},
      roles: { everyone: { id: 'everyone-role' } },
      members: { fetchMe: vi.fn(async () => ({ id: 'bot-member' })) },
      scheduledEvents: { create: vi.fn(async (opts: { name: string }) => ({ id: 'sched-1', ...opts })) },
      channels: {
        cache: { find: vi.fn(() => undefined) },
        create: channelsCreate,
        fetch: vi.fn(async () => forumChannel),
      },
      _eventChannel: eventChannel,
    };
  }

  function makeCreateInteraction(title: string, guild: ReturnType<typeof makeGuildWithForum>) {
    const options: Record<string, string | null> = {
      title,
      date: 'August 22',
      time: '7pm',
      end_time: null,
      location: null,
      link: null,
      description: null,
    };
    return {
      guild,
      guildId: guild.id,
      client: {},
      channelId: 'command-channel-1',
      user: { id: 'host-1' },
      memberPermissions: { has: () => true },
      options: {
        getString: (name: string) => options[name] ?? null,
      },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('creates status tags on the forum channel and applies "Upcoming" to the new thread', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const forumChannel = makeForumChannel();
    const guild = makeGuildWithForum(forumChannel);
    const interaction = makeCreateInteraction('Board Game Bash', guild);

    await handleCreate(interaction);

    expect(forumChannel.setAvailableTags).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Upcoming' }),
        expect.objectContaining({ name: 'Cancelled' }),
        expect.objectContaining({ name: 'Concluded' }),
      ]),
    );
    const upcomingTagId = forumChannel.availableTags.find((t: any) => t.name === 'Upcoming')!.id;
    expect(forumChannel.threads.create).toHaveBeenCalledWith(
      expect.objectContaining({ appliedTags: [upcomingTagId] }),
    );
  });

  it('reuses previously-created tag IDs from guild config instead of recreating them', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const { updateGuildConfig } = await import('../src/utils/config');
    await updateGuildConfig('guild-1', {
      gameNightTagIds: { upcoming: 'existing-upcoming-id', cancelled: 'existing-cancelled-id', concluded: 'existing-concluded-id' },
    } as any);

    const forumChannel = makeForumChannel();
    const guild = makeGuildWithForum(forumChannel);
    const interaction = makeCreateInteraction('Board Game Bash', guild);

    await handleCreate(interaction);

    expect(forumChannel.setAvailableTags).not.toHaveBeenCalled();
    expect(forumChannel.threads.create).toHaveBeenCalledWith(
      expect.objectContaining({ appliedTags: ['existing-upcoming-id'] }),
    );
  });
});

// ── handleCancel — forum thread status tag ──────────────────────────────────

describe('handleCancel — forum announcements channel', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-cancel-forum-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies the "Cancelled" tag to the thread before locking/archiving it', async () => {
    const { handleCancel } = await import('../src/commands/gamenight');
    const { upsertGameNight } = await import('../src/utils/storage');
    const { updateGuildConfig } = await import('../src/utils/config');

    await updateGuildConfig('guild-1', {
      gameNightTagIds: { upcoming: 'up-id', cancelled: 'cancel-id', concluded: 'concl-id' },
    } as any);

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await upsertGameNight({
      id: 'gn-cancel-1',
      title: 'Board Game Bash',
      date: 'August 22',
      time: '7pm',
      location: 'TBD',
      link: '',
      description: '',
      messageId: 'thread-1',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: null,
      eventChannelId: null,
      startTimeISO: future,
      endTimeISO: null,
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
    } as any);

    const forumChannel: any = { type: 15, availableTags: [{ id: 'up-id', name: 'Upcoming', moderated: false }] };
    const thread = {
      isThread: () => true,
      setAppliedTags: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      setLocked: vi.fn(async () => {}),
      setArchived: vi.fn(async () => {}),
    };
    const client = {
      channels: {
        fetch: vi.fn(async (id: string) => (id === 'announcements' ? forumChannel : thread)),
      },
    };

    const interaction = {
      options: { getString: (name: string) => (name === 'id' ? 'gn-cancel-1' : null) },
      user: { id: 'host-1' },
      memberPermissions: { has: () => true },
      guild: { scheduledEvents: { fetch: vi.fn() } },
      guildId: 'guild-1',
      client,
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;

    await handleCancel(interaction);

    expect(thread.setAppliedTags).toHaveBeenCalledWith(['cancel-id']);
    // Tag update happens before the thread is locked/archived.
    const tagCallOrder = thread.setAppliedTags.mock.invocationCallOrder[0];
    const lockCallOrder = thread.setLocked.mock.invocationCallOrder[0];
    expect(tagCallOrder).toBeLessThan(lockCallOrder);
  });
});

// ── handleEdit ────────────────────────────────────────────────────────────

describe('handleEdit', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-edit-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedGameNight(overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGameNight } = await import('../src/utils/storage');
    const start = new Date('2026-08-22T19:00:00.000Z');
    const end = new Date('2026-08-22T23:00:00.000Z');
    const gn = {
      id: 'gn-edit-1',
      title: 'Board Game Bash',
      date: 'Saturday, August 22, 2026',
      time: '7:00 PM – 11:00 PM',
      location: 'Library Room 1',
      link: '',
      description: '',
      messageId: 'announcement-msg-1',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: 'sched-1',
      eventChannelId: 'event-channel-1',
      startTimeISO: start.toISOString(),
      endTimeISO: end.toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    await upsertGameNight(gn as any);
    return gn;
  }

  function makeClientForEdit() {
    const eventChannel = {
      setName: vi.fn(async () => {}),
      setTopic: vi.fn(async () => {}),
    };
    const announcementMsg = { edit: vi.fn(async () => {}) };
    const announcementChannel = {
      type: 0, // ChannelType.GuildText
      messages: { fetch: vi.fn(async () => announcementMsg) },
    };
    const scheduledEvent = { edit: vi.fn(async () => {}) };
    return {
      channels: {
        fetch: vi.fn(async (id: string) => {
          if (id === 'event-channel-1') return eventChannel;
          if (id === 'announcements') return announcementChannel;
          return null;
        }),
      },
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn() } })) },
      _eventChannel: eventChannel,
      _announcementMsg: announcementMsg,
      _scheduledEvent: scheduledEvent,
    };
  }

  function makeEditInteraction(
    options: Record<string, string | null>,
    client: ReturnType<typeof makeClientForEdit>,
  ) {
    return {
      guild: {
        scheduledEvents: { fetch: vi.fn(async () => client._scheduledEvent) },
      },
      guildId: 'guild-1',
      client,
      user: { id: 'host-2' },
      memberPermissions: { has: () => true },
      options: { getString: (name: string) => options[name] ?? null },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('updates the stored fields and confirms via editReply', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', location: 'New Venue', title: null, date: null, time: null, end_time: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    const gn = await findGameNight('gn-edit-1');
    expect(gn?.location).toBe('New Venue');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('updated'));
  });

  it('renames and retopics the channel when the title changes', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', title: 'Trivia Night', date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(client._eventChannel.setName).toHaveBeenCalledWith('august-22-trivia-night');
    expect(client._eventChannel.setTopic).toHaveBeenCalledWith(expect.stringContaining('Trivia Night'));
  });

  it('syncs the Discord scheduled event', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', title: 'Trivia Night', date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(client._scheduledEvent.edit).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringContaining('Trivia Night') }),
    );
  });

  it('re-renders the RSVP embed', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', location: 'New Venue', title: null, date: null, time: null, end_time: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(client._announcementMsg.edit).toHaveBeenCalled();
  });

  it('preserves the original duration when the date shifts without a new end_time', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', date: 'August 29', title: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    const gn = await findGameNight('gn-edit-1');
    const durationMs = new Date(gn!.endTimeISO!).getTime() - new Date(gn!.startTimeISO!).getTime();
    expect(durationMs).toBe(4 * 60 * 60 * 1000); // original 7pm-11pm = 4 hours
  });

  it('replies with an error and does not defer when no fields are provided', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', title: null, date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('at least one field') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('replies with an error for an unknown event id', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'no-such-id', title: 'New Title', date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No event found') }),
    );
  });

  it('refuses to edit a cancelled event', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight({ cancelled: true });
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', title: 'New Title', date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already cancelled') }),
    );
  });

  it('refuses to edit an archived event', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight({ archived: true });
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', title: 'New Title', date: null, time: null, end_time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already concluded') }),
    );
  });
});

describe('handlePrivacy', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-privacy-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedGameNight(overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGameNight } = await import('../src/utils/storage');
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const gn = {
      id: 'gn-privacy-1',
      title: 'Board Game Bash',
      date: 'Saturday',
      time: '7:00 PM',
      location: 'Library Room 1',
      link: '',
      description: '',
      messageId: 'announcement-msg-1',
      channelId: 'announcements',
      guildId: 'guild-1',
      discordEventId: null,
      eventChannelId: 'event-channel-1',
      startTimeISO: future,
      endTimeISO: null,
      rsvps: { yes: ['attendee-1'], maybe: ['attendee-2'], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      openChannel: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    await upsertGameNight(gn as any);
    return gn;
  }

  function makeClientForPrivacy() {
    const eventChannel = {
      permissionOverwrites: {
        create: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
    };
    return {
      channels: { fetch: vi.fn(async () => eventChannel) },
      _eventChannel: eventChannel,
    };
  }

  function makePrivacyInteraction(
    id: string,
    open: boolean,
    client: ReturnType<typeof makeClientForPrivacy>,
  ) {
    return {
      guild: { roles: { everyone: 'everyone-role' } },
      guildId: 'guild-1',
      client,
      user: { id: 'host-2' },
      memberPermissions: { has: () => true },
      options: {
        getString: () => id,
        getBoolean: () => open,
      },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('refuses when the invoker lacks ManageEvents', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    const interaction = {
      memberPermissions: { has: () => false },
      reply: vi.fn(async () => {}),
    } as any;

    await handlePrivacy(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Only hosts') }),
    );
  });

  it('opens an RSVP-only channel: removes the @everyone deny-view overwrite and persists openChannel', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ openChannel: false });
    const client = makeClientForPrivacy();

    await handlePrivacy(makePrivacyInteraction('gn-privacy-1', true, client));

    expect(client._eventChannel.permissionOverwrites.delete).toHaveBeenCalledWith('everyone-role');
    const gn = await findGameNight('gn-privacy-1');
    expect(gn?.openChannel).toBe(true);
  });

  it('closes an open channel: hides it from @everyone and re-grants access to the creator and current attendees', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ openChannel: true });
    const client = makeClientForPrivacy();

    await handlePrivacy(makePrivacyInteraction('gn-privacy-1', false, client));

    expect(client._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('everyone-role', {
      ViewChannel: false,
    });
    expect(client._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('host-1', { ViewChannel: true });
    expect(client._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('attendee-1', { ViewChannel: true });
    expect(client._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('attendee-2', { ViewChannel: true });

    const gn = await findGameNight('gn-privacy-1');
    expect(gn?.openChannel).toBe(false);
  });

  it('is a no-op reply when the channel already matches the requested state', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    await seedGameNight({ openChannel: true });
    const client = makeClientForPrivacy();

    await handlePrivacy(makePrivacyInteraction('gn-privacy-1', true, client));

    expect(client._eventChannel.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(client._eventChannel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it('refuses for a cancelled event', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    await seedGameNight({ cancelled: true });
    const client = makeClientForPrivacy();

    await handlePrivacy(makePrivacyInteraction('gn-privacy-1', true, client));

    expect(client._eventChannel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it('reports an error and does not flip openChannel when Discord permission update fails', async () => {
    const { handlePrivacy } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ openChannel: false });
    const client = makeClientForPrivacy();
    client._eventChannel.permissionOverwrites.delete.mockRejectedValueOnce(new Error('Missing Access'));

    const interaction = makePrivacyInteraction('gn-privacy-1', true, client);
    await handlePrivacy(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Could not update'));
    const gn = await findGameNight('gn-privacy-1');
    expect(gn?.openChannel).toBe(false);
  });
});
