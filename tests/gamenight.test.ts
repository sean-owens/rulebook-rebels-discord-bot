import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDateTime, handleConfig } from '../src/commands/gamenight';

// A date guaranteed to still be upcoming (not yet passed) relative to
// whenever these tests actually run, so parseDateTime's no-year-given
// rollover logic (see gamenight.ts) never kicks in — deriving from `now`
// instead of a hardcoded "August 22" avoids the assertion going stale every
// year once the calendar reaches that date (parseDateTime correctly rolls a
// now-past, year-less date to next year, which a fixed date/year pair can't
// account for). +14 days keeps comfortable margin and, if it happens to cross
// a Dec→Jan boundary, FUTURE_YEAR already reflects the rolled-forward year
// the same way parseDateTime's own rollover would compute it.
const FULL_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const _futureDate = new Date();
_futureDate.setUTCDate(_futureDate.getUTCDate() + 14);
const FUTURE_MONTH_NAME = FULL_MONTH_NAMES[_futureDate.getUTCMonth()];
const FUTURE_DAY = _futureDate.getUTCDate();
const FUTURE_YEAR = _futureDate.getUTCFullYear();
const FUTURE_MONTH_INDEX = _futureDate.getUTCMonth();

vi.mock('../src/utils/requestPin', () => ({
  updateGameListPin: vi.fn(async () => {}),
  updateRequestPin: vi.fn(async () => {}),
  updateHubPin: vi.fn(async () => {}),
}));

vi.mock('../src/utils/pins', () => ({
  updateAnnouncementPin: vi.fn(async () => {}),
}));

describe('handleConfig — view current settings', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-config-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfigInteraction(options: Record<string, string | number | boolean | null> = {}) {
    return {
      guildId: 'guild-config-1',
      options: {
        getString: (name: string) => (options[name] as string | undefined) ?? null,
        getChannel: () => null,
        getBoolean: (name: string) => (options[name] as boolean | undefined) ?? null,
        getInteger: (name: string) => (options[name] as number | undefined) ?? null,
      },
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('warns that timezone is unconfigured (still the UTC default)', async () => {
    const interaction = makeConfigInteraction();
    await handleConfig(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Timezone: UTC ⚠️ *not configured'),
      }),
    );
  });

  it('does not warn once a real timezone has been set', async () => {
    await handleConfig(makeConfigInteraction({ timezone: 'America/New_York' }));

    const viewInteraction = makeConfigInteraction();
    await handleConfig(viewInteraction);

    expect(viewInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Timezone: America/New_York') }),
    );
    expect(viewInteraction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not configured') }),
    );
  });
});

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
    const d = parseDateTime(`${FUTURE_MONTH_NAME} ${FUTURE_DAY}`, '7pm');
    expect(d.getUTCMonth()).toBe(FUTURE_MONTH_INDEX);
    expect(d.getUTCDate()).toBe(FUTURE_DAY);
    expect(d.getUTCFullYear()).toBe(FUTURE_YEAR);
  });

  it('parses abbreviated month name', () => {
    const d = parseDateTime('aug 22', '7pm');
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(22);
  });

  it('parses the common 4-letter "Sept" abbreviation for September (not just "Sep")', () => {
    const d = parseDateTime('Sept 2nd', '5pm');
    expect(d.getUTCMonth()).toBe(8);
    expect(d.getUTCDate()).toBe(2);
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
    const d = parseDateTime(`${FUTURE_MONTH_NAME} ${FUTURE_DAY}`, '7pm');
    const expectedMonth = String(FUTURE_MONTH_INDEX + 1).padStart(2, '0');
    const expectedDay = String(FUTURE_DAY).padStart(2, '0');
    expect(d.toISOString()).toBe(`${FUTURE_YEAR}-${expectedMonth}-${expectedDay}T19:00:00.000Z`);
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

  // ── 12-hour / 24-hour clock support ─────────────────────────────────────────

  it('accepts 24-hour clock input ("19:00") equivalently to "7pm"', () => {
    const d = parseDateTime('August 22', '19:00');
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('accepts 24-hour midnight ("00:00")', () => {
    const d = parseDateTime('August 22', '00:00');
    expect(d.getUTCHours()).toBe(0);
  });

  it('rejects an out-of-range 24-hour value ("25:00")', () => {
    expect(() => parseDateTime('August 22', '25:00')).toThrow();
  });

  it('rejects an out-of-range 12-hour value ("13pm")', () => {
    expect(() => parseDateTime('August 22', '13pm')).toThrow();
  });

  it('rejects an out-of-range minute value ("7:75pm")', () => {
    expect(() => parseDateTime('August 22', '7:75pm')).toThrow();
  });

  // ── Year rollover for year-less dates ────────────────────────────────────────

  describe('with no year given', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rolls a past month/day forward to next year (December → January)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-10T12:00:00.000Z'));

      const d = parseDateTime('January 5', '7pm');

      expect(d.getUTCFullYear()).toBe(2027);
      expect(d.getUTCMonth()).toBe(0);
      expect(d.getUTCDate()).toBe(5);
    });

    it('does not roll forward a month/day still ahead later this year', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

      const d = parseDateTime('August 22', '7pm');

      expect(d.getUTCFullYear()).toBe(2026);
    });

    it('does not roll forward for a same-day time earlier than right now', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-22T20:00:00.000Z')); // 8pm UTC

      // 7pm on the same calendar day as "now" — earlier today, not a past year.
      const d = parseDateTime('August 22', '7pm');

      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(7);
      expect(d.getUTCDate()).toBe(22);
    });
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

  it('posts the button hub pin in the new event channel', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const { updateHubPin } = await import('../src/utils/requestPin');
    const { loadGameNights } = await import('../src/utils/storage');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Board Game Bash', guild);

    await handleCreate(interaction);

    const nights = await loadGameNights();
    expect(updateHubPin).toHaveBeenCalledWith(interaction.client, nights[0].id);
  });

  it('includes the event ID in the event channel topic, matching the stored GameNight record', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const { loadGameNights } = await import('../src/utils/storage');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Board Game Bash', guild);

    await handleCreate(interaction);

    const nights = await loadGameNights();
    const topicArg = guild.channels.create.mock.calls.find(
      (call: any[]) => call[0].type === 0,
    )![0].topic as string;
    expect(topicArg).toContain(`Event ID: ${nights[0].id}`);
  });

  it('rejects a start date/time in the past', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Board Game Bash', guild);
    const options: Record<string, string | null> = {
      title: 'Board Game Bash',
      date: 'August 22 2020',
      time: '7pm',
      end_time: null,
      location: null,
      link: null,
      description: null,
    };
    interaction.options.getString = (name: string) => options[name] ?? null;

    await handleCreate(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('is in the past'));
    expect(guild.scheduledEvents.create).not.toHaveBeenCalled();
  });

  it('rejects an end_time that is not after the start time', async () => {
    const { handleCreate } = await import('../src/commands/gamenight');
    const guild = makeGuild();
    const interaction = makeCreateInteraction('Board Game Bash', guild);
    const options: Record<string, string | null> = {
      title: 'Board Game Bash',
      date: 'August 22',
      time: '9pm',
      end_time: '8pm',
      location: null,
      link: null,
      description: null,
    };
    interaction.options.getString = (name: string) => options[name] ?? null;

    await handleCreate(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('is not after the start time'),
    );
    expect(guild.scheduledEvents.create).not.toHaveBeenCalled();
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

  it('rejects moving the start date/time into the past', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', date: 'August 22 2020', time: '7pm', title: null, location: null, end_time: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is in the past') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('rejects an end_time that is not after the start time', async () => {
    const { handleEdit } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForEdit();

    const interaction = makeEditInteraction(
      { id: 'gn-edit-1', end_time: '6pm', title: null, date: null, time: null, location: null, link: null, description: null },
      client,
    );
    await handleEdit(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('is not after the start time') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
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
    expect(client._eventChannel.setTopic).toHaveBeenCalledWith(expect.stringContaining('Event ID: gn-edit-1'));
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

describe('handleSetGreeters', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gamenight-greeters-test-'));
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
      id: 'gn-greeters-1',
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

  async function seedGame(overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGame } = await import('../src/utils/gameStorage');
    const id = (overrides.id as string) ?? 'game-1';
    const game = {
      id,
      eventId: 'gn-greeters-1',
      channelId: 'event-channel-1',
      messageId: `msg-${id}`,
      guildId: 'guild-1',
      bggId: '1',
      title: `Game ${id}`,
      bggLink: '',
      minPlayers: 1,
      maxPlayers: 4,
      suggestedPlayers: null,
      minPlaytime: 30,
      maxPlaytime: 60,
      suggestedStartTime: null,
      complexity: 'Medium',
      expansions: [],
      seats: [],
      waitlist: [],
      createdAt: new Date().toISOString(),
      createdBy: 'u1',
      ...overrides,
    };
    await upsertGame(game as any);
    return game;
  }

  function makeClientForGreeters() {
    const messages: Record<string, { edit: ReturnType<typeof vi.fn> }> = {};
    const guild = { members: { fetch: vi.fn(async (id: string) => ({ displayName: id })) } };
    const channel = {
      guild,
      messages: {
        fetch: vi.fn(async (msgId: string) => {
          if (!messages[msgId]) messages[msgId] = { edit: vi.fn(async () => {}) };
          return messages[msgId];
        }),
      },
    };
    return {
      channels: { fetch: vi.fn(async () => channel) },
      _channel: channel,
      _messages: messages,
    };
  }

  function makeGreetersInteraction(
    options: { id: string; greeter1?: string | null; greeter2?: string | null; clear?: boolean | null; remove?: string | null },
    client: ReturnType<typeof makeClientForGreeters>,
  ) {
    return {
      guildId: 'guild-1',
      client,
      user: { id: 'host-2' },
      memberPermissions: { has: () => true },
      options: {
        getString: (name: string) => (name === 'id' ? options.id : null),
        getUser: (name: string) => {
          const val = name === 'greeter1' ? options.greeter1
            : name === 'greeter2' ? options.greeter2
            : name === 'remove' ? options.remove
            : null;
          return val ? { id: val } : null;
        },
        getBoolean: (name: string) => (name === 'clear' ? (options.clear ?? null) : null),
      },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('refuses when the invoker lacks ManageEvents', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const interaction = { memberPermissions: { has: () => false }, reply: vi.fn(async () => {}) } as any;

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Only hosts') }),
    );
  });

  it('replies with an error for an unknown event id', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'no-such-id', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No event found') }),
    );
  });

  it('refuses for a cancelled event', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight({ cancelled: true });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already cancelled') }),
    );
  });

  it('refuses for an archived event', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight({ archived: true });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already concluded') }),
    );
  });

  it('shows a "no greeters set" view plus usage hint when no options are given and none are set', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('No greeters currently set'),
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Provide `greeter1`') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('shows the current greeters when no options are given and some are already set', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight({ greeters: ['greeter-a', 'greeter-b'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Current greeter(s) for event `gn-greeters-1`: <@greeter-a> and <@greeter-b>'),
      }),
    );
  });

  it('removes just one greeter, leaving the other in place', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ greeters: ['greeter-a', 'greeter-b'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', remove: 'greeter-a' }, client);

    await handleSetGreeters(interaction);

    const gn = await findGameNight('gn-greeters-1');
    expect(gn?.greeters).toEqual(['greeter-b']);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Removed <@greeter-a>'),
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Remaining greeter: <@greeter-b>') }),
    );
  });

  it('removing the last greeter leaves none remaining', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ greeters: ['greeter-a'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', remove: 'greeter-a' }, client);

    await handleSetGreeters(interaction);

    const gn = await findGameNight('gn-greeters-1');
    expect(gn?.greeters).toEqual([]);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No greeters remain for this event') }),
    );
  });

  it('errors when trying to remove someone who is not currently a greeter', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight({ greeters: ['greeter-a'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', remove: 'not-a-greeter' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("isn't currently a greeter") }),
    );
  });

  it('errors when greeter1 and greeter2 are the same user', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight();
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1', greeter2: 'u1' }, client);

    await handleSetGreeters(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('must be different users') }),
    );
  });

  it('sets a single greeter and confirms via editReply', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight();
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    const gn = await findGameNight('gn-greeters-1');
    expect(gn?.greeters).toEqual(['u1']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('<@u1>'));
  });

  it('sets two greeters', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight();
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1', greeter2: 'u2' }, client);

    await handleSetGreeters(interaction);

    const gn = await findGameNight('gn-greeters-1');
    expect(gn?.greeters).toEqual(['u1', 'u2']);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("can't both be seated on the same game"),
    );
  });

  it('clears greeters and replies without deferring', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    const { findGameNight } = await import('../src/utils/storage');
    await seedGameNight({ greeters: ['u1', 'u2'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', clear: true }, client);

    await handleSetGreeters(interaction);

    const gn = await findGameNight('gn-greeters-1');
    expect(gn?.greeters).toEqual([]);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('cleared') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('auto-removes a newly-designated greeter from a non-Light game they already occupy, and refreshes its card', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight();
    await seedGame({ id: 'g-heavy', complexity: 'Heavy', seats: ['u1', 'other-player'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    const { findGame } = await import('../src/utils/gameStorage');
    const game = await findGame('g-heavy');
    expect(game?.seats).toEqual(['other-player']);
    expect(client._messages['msg-g-heavy'].edit).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('not a Light game'));
  });

  it('auto-removes the second greeter (keeping the first) when both already share a Light game', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight();
    await seedGame({ id: 'g-light', complexity: 'Light', seats: ['u1', 'u2'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1', greeter2: 'u2' }, client);

    await handleSetGreeters(interaction);

    const { findGame } = await import('../src/utils/gameStorage');
    const game = await findGame('g-light');
    expect(game?.seats).toEqual(['u1']);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("both greeters can't be on the same game"),
    );
  });

  it('leaves unaffected games untouched (no card refresh, no note)', async () => {
    const { handleSetGreeters } = await import('../src/commands/gamenight');
    await seedGameNight();
    await seedGame({ id: 'g-fine', complexity: 'Light', seats: ['other-player'] });
    const client = makeClientForGreeters();
    const interaction = makeGreetersInteraction({ id: 'gn-greeters-1', greeter1: 'u1' }, client);

    await handleSetGreeters(interaction);

    expect(client._channel.messages.fetch).not.toHaveBeenCalledWith('msg-g-fine');
  });
});
