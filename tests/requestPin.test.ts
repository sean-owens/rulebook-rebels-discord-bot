import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateGameListPin, updateRequestPin } from '../src/utils/requestPin';
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

function makeClient(pinImpl: () => Promise<void> = async () => {}) {
  let nextId = 1;
  const sentMessages = new Map<string, { edit: ReturnType<typeof vi.fn>; pinned: boolean }>();
  const channel = {
    send: vi.fn(async () => {
      const id = `msg-${nextId++}`;
      const msg = {
        id,
        pinned: false,
        pin: vi.fn(async () => {
          await pinImpl();
          msg.pinned = true;
        }),
        edit: vi.fn(async () => {}),
      };
      sentMessages.set(id, msg as any);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async (id: string) => {
        const msg = sentMessages.get(id);
        if (!msg) throw new Error('message not found');
        return msg;
      }),
    },
  };
  return {
    channels: { fetch: vi.fn(async () => channel) },
    guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn() } })) },
    _channel: channel,
  };
}

describe('updateGameListPin', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-requestpin-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends and pins the lineup message on first call, storing the message id', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateGameListPin(client as any, 'gn1');

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    const gn = await findGameNight('gn1');
    expect(gn?.gameListPinMessageId).toBe('msg-1');
  });

  it('edits the existing message on a later call instead of posting a new one', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateGameListPin(client as any, 'gn1');
    await updateGameListPin(client as any, 'gn1');

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    expect(client._channel.messages.fetch).toHaveBeenCalledWith('msg-1');
  });

  it('still sends and records the message even when pinning fails, and logs a warning', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient(async () => {
      throw new Error('Missing Permissions');
    });

    await updateGameListPin(client as any, 'gn1');

    const gn = await findGameNight('gn1');
    expect(gn?.gameListPinMessageId).toBe('msg-1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not pin game list message'),
      expect.any(Error),
    );
  });

  it('does not re-pin an already-pinned message on a later update', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateGameListPin(client as any, 'gn1');
    const msg = await client._channel.messages.fetch('msg-1');
    expect(msg.pin).toHaveBeenCalledTimes(1);

    await updateGameListPin(client as any, 'gn1');
    expect(msg.pin).toHaveBeenCalledTimes(1);
  });

  it('re-pins a message that was unpinned since the last update', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateGameListPin(client as any, 'gn1');
    const msg = await client._channel.messages.fetch('msg-1');
    msg.pinned = false; // simulates a mod/host manually unpinning it

    await updateGameListPin(client as any, 'gn1');
    expect(msg.pin).toHaveBeenCalledTimes(2);
    expect(msg.pinned).toBe(true);
  });
});

describe('updateRequestPin', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-requestpin-test2-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends and pins the request message on first call, storing the message id', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateRequestPin(client as any, 'gn1');

    expect(client._channel.send).toHaveBeenCalledTimes(1);
    const gn = await findGameNight('gn1');
    expect(gn?.requestPinMessageId).toBe('msg-1');
  });

  it('still sends and records the message even when pinning fails, and logs a warning', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient(async () => {
      throw new Error('Missing Permissions');
    });

    await updateRequestPin(client as any, 'gn1');

    const gn = await findGameNight('gn1');
    expect(gn?.requestPinMessageId).toBe('msg-1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not pin request message'),
      expect.any(Error),
    );
  });

  it('re-pins a message that was unpinned since the last update', async () => {
    await upsertGameNight(makeGameNight());
    const client = makeClient();

    await updateRequestPin(client as any, 'gn1');
    const msg = await client._channel.messages.fetch('msg-1');
    msg.pinned = false; // simulates a mod/host manually unpinning it

    await updateRequestPin(client as any, 'gn1');
    expect(msg.pin).toHaveBeenCalledTimes(2);
    expect(msg.pinned).toBe(true);
  });
});
