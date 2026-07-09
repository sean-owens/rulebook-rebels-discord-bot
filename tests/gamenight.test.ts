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
  // ── Time parsing ───────────────────────────────────────────────────────────

  it('parses "7pm" as 19:00', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "7:30 PM" as 19:30', () => {
    const d = parseDateTime('August 22', '7:30 PM');
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(30);
  });

  it('parses "12pm" as noon (12:00)', () => {
    const d = parseDateTime('August 22', '12pm');
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "12am" as midnight (0:00)', () => {
    const d = parseDateTime('August 22', '12am');
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "10:00 PM" as 22:00', () => {
    const d = parseDateTime('August 22', '10:00 PM');
    expect(d.getHours()).toBe(22);
    expect(d.getMinutes()).toBe(0);
  });

  // ── Date parsing ───────────────────────────────────────────────────────────

  it('parses full month name', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getMonth()).toBe(7); // 0-indexed
    expect(d.getDate()).toBe(22);
    expect(d.getFullYear()).toBe(YEAR);
  });

  it('parses abbreviated month name', () => {
    const d = parseDateTime('aug 22', '7pm');
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(22);
  });

  it('parses an explicit 4-digit year', () => {
    const d = parseDateTime('September 5 2027', '7pm');
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(5);
  });

  it('handles December correctly', () => {
    const d = parseDateTime('December 31', '11:59 PM');
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });

  it('handles January correctly', () => {
    const d = parseDateTime('January 1', '12am');
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it('ignores extra commas in the date string', () => {
    const d = parseDateTime('August, 22', '7pm');
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(22);
  });

  it('parses ordinal day suffixes (1st, 2nd, 3rd, 30th)', () => {
    expect(parseDateTime('June 30th', '8am').getDate()).toBe(30);
    expect(parseDateTime('July 1st', '7pm').getDate()).toBe(1);
    expect(parseDateTime('August 2nd', '7pm').getDate()).toBe(2);
    expect(parseDateTime('September 3rd', '7pm').getDate()).toBe(3);
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
