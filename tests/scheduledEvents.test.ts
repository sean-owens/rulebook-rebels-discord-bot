import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/embeds', () => ({
  buildGameNightEmbed: vi.fn(() => ({})),
  buildGameNightButtons: vi.fn(() => ({})),
}));

import {
  handleScheduledEventUserAdd,
  handleScheduledEventUserRemove,
} from '../src/events/scheduledEvents';
import { upsertGameNight, findGameNight, GameNight } from '../src/utils/storage';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'gn1',
    date: 'August 22',
    time: '7pm',
    location: 'TBD',
    link: '',
    description: '',
    messageId: 'msg1',
    channelId: 'announcements',
    guildId: 'g1',
    discordEventId: 'evt1',
    eventChannelId: 'event-channel-1',
    startTimeISO: future,
    endTimeISO: null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: 'host1',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeClient() {
  const eventChannel = {
    permissionOverwrites: {
      create: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  };
  const announcementChannel = {
    messages: {
      fetch: vi.fn(async () => ({ edit: vi.fn(async () => {}) })),
    },
  };
  return {
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === 'event-channel-1') return eventChannel;
        if (id === 'announcements') return announcementChannel;
        throw new Error('unknown channel');
      }),
    },
    _eventChannel: eventChannel,
  };
}

describe('scheduled event Interested add/remove — RSVP mapping', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduled-events-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks the user Going when they click Interested', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await handleScheduledEventUserAdd({ id: 'evt1', client } as any, { id: 'u1' } as any);

    const gn = await findGameNight('gn1');
    expect(gn?.rsvps.yes).toContain('u1');
    expect(gn?.rsvps.maybe).not.toContain('u1');
    expect(gn?.rsvps.no).not.toContain('u1');
    expect(client._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('u1', {
      ViewChannel: true,
    });
  });

  it('marks the user Can\'t Go when they remove Interested', async () => {
    await upsertGameNight(makeGameNight({ rsvps: { yes: ['u1'], maybe: [], no: [] } }));
    const client = makeClient();

    await handleScheduledEventUserRemove({ id: 'evt1', client } as any, { id: 'u1' } as any);

    const gn = await findGameNight('gn1');
    expect(gn?.rsvps.no).toContain('u1');
    expect(gn?.rsvps.yes).not.toContain('u1');
    expect(client._eventChannel.permissionOverwrites.delete).toHaveBeenCalledWith('u1');
  });

  it('moves a user from Maybe to Going when they click Interested', async () => {
    await upsertGameNight(makeGameNight({ rsvps: { yes: [], maybe: ['u1'], no: [] } }));
    const client = makeClient();

    await handleScheduledEventUserAdd({ id: 'evt1', client } as any, { id: 'u1' } as any);

    const gn = await findGameNight('gn1');
    expect(gn?.rsvps.yes).toContain('u1');
    expect(gn?.rsvps.maybe).not.toContain('u1');
  });

  it('does nothing when no game night matches the scheduled event id', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await handleScheduledEventUserAdd({ id: 'some-other-event' } as any, { id: 'u1' } as any);

    const gn = await findGameNight('gn1');
    expect(gn?.rsvps.yes).not.toContain('u1');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('does nothing when the game night is already cancelled', async () => {
    await upsertGameNight(makeGameNight({ cancelled: true }));
    const client = makeClient();

    await handleScheduledEventUserAdd({ id: 'evt1', client } as any, { id: 'u1' } as any);

    const gn = await findGameNight('gn1');
    expect(gn?.rsvps.yes).not.toContain('u1');
  });

  it('is a no-op when the user removing Interested is already marked Can\'t Go', async () => {
    await upsertGameNight(makeGameNight({ rsvps: { yes: [], maybe: [], no: ['u1'] } }));
    const client = makeClient();

    await handleScheduledEventUserRemove({ id: 'evt1', client } as any, { id: 'u1' } as any);

    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
