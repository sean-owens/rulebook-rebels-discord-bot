import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PermissionFlagsBits } from 'discord.js';
import { execute, handleRoomConfig, checkExpiredRooms } from '../src/commands/room';
import { loadRooms, upsertRoom, PrivateRoom } from '../src/utils/roomStorage';

function makeRolesCollection(roles: Array<{ id: string; permissions: { has: (p: bigint) => boolean } }>): any {
  return {
    filter: (fn: (r: any) => boolean) => makeRolesCollection(roles.filter(fn)),
    map: (fn: (r: any) => unknown) => roles.map(fn),
  };
}

function makeGuild(opts: { existingCategory?: boolean; unresolvableIds?: string[] } = {}) {
  const eventChannel: any = {
    id: 'room-channel-1',
    name: 'room-channel-1',
    permissionOverwrites: { create: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    send: vi.fn(async () => {}),
    setTopic: vi.fn(async () => {}),
  };
  eventChannel.setName = vi.fn(async (n: string) => {
    eventChannel.name = n;
  });
  const category = { id: 'category-1', type: 4, name: 'Private Rooms' };
  const channelsCreate = vi.fn(async (createOpts: { type: number }) => {
    return createOpts.type === 4 ? category : eventChannel;
  });

  const hostRole = { id: 'host-role', permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageEvents } };
  const adminRole = { id: 'admin-role', permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild } };
  const memberRole = { id: 'member-role', permissions: { has: () => false } };

  const unresolvable = new Set(opts.unresolvableIds ?? []);

  return {
    id: 'guild-1',
    roles: {
      everyone: { id: 'everyone-role' },
      fetch: vi.fn(async () => {}),
      cache: makeRolesCollection([hostRole, adminRole, memberRole]),
    },
    members: {
      fetchMe: vi.fn(async () => ({ id: 'bot-member' })),
      fetch: vi.fn(async (id: string) => {
        if (unresolvable.has(id)) throw new Error('Unknown Member');
        return { id };
      }),
    },
    channels: {
      cache: { find: vi.fn(() => (opts.existingCategory ? category : undefined)) },
      create: channelsCreate,
    },
    _eventChannel: eventChannel,
    _channelsCreate: channelsCreate,
  };
}

// Always a real future date relative to whenever the suite actually runs.
const FUTURE_DATE_STR = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

function makeInteraction(
  options: {
    people?: string | null;
    name?: string | null;
    date?: string | null;
    persist?: boolean | null;
    enabled?: boolean | null;
    targetUserId?: string | null;
    sub: string;
  },
  guild: ReturnType<typeof makeGuild>,
  userId = 'creator-1',
  channelId = 'general',
) {
  // Only auto-fill a future date for /room create when the test didn't explicitly
  // pass a `date` (even null) and isn't testing the persist:true no-date path.
  const shouldDefaultDate = options.sub === 'create' && options.persist !== true && options.date === undefined;
  const values: Record<string, string | null | undefined> = {
    people: options.people,
    name: options.name,
    date: shouldDefaultDate ? FUTURE_DATE_STR : options.date,
  };
  const booleans: Record<string, boolean | null | undefined> = {
    persist: options.persist,
    enabled: options.enabled,
  };
  return {
    guild,
    guildId: guild.id,
    client: { channels: { fetch: vi.fn(async () => guild._eventChannel) } },
    user: { id: userId },
    channelId,
    memberPermissions: { has: () => false },
    options: {
      getSubcommand: () => options.sub,
      getString: (name: string) => values[name] ?? null,
      getBoolean: (name: string) => booleans[name] ?? null,
      getUser: (name: string) =>
        name === 'user' && options.targetUserId
          ? { id: options.targetUserId, username: `user-${options.targetUserId}` }
          : null,
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}

describe('/room create', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a hidden channel and invites the mentioned people', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111> <@222>' }, guild);

    await execute(interaction);

    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith(
      guild.roles.everyone,
      { ViewChannel: false },
    );
    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('111', {
      ViewChannel: true,
      SendMessages: true,
    });
    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('222', {
      ViewChannel: true,
      SendMessages: true,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Private room created'));
  });

  it('grants view access to roles carrying Manage Events or Manage Guild, not the plain member role', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>' }, guild);

    await execute(interaction);

    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('host-role', {
      ViewChannel: true,
      SendMessages: true,
    });
    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('admin-role', {
      ViewChannel: true,
      SendMessages: true,
    });
    expect(guild._eventChannel.permissionOverwrites.create).not.toHaveBeenCalledWith('member-role', expect.anything());
  });

  it('grants the creator view access too', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>' }, guild, 'creator-1');

    await execute(interaction);

    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith(
      { id: 'creator-1' },
      { ViewChannel: true, SendMessages: true },
    );
  });

  it('pings each invited person in the new channel', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111> <@222>' }, guild);

    await execute(interaction);

    const sentMessage = guild._eventChannel.send.mock.calls[0][0];
    expect(sentMessage).toContain('<@111>');
    expect(sentMessage).toContain('<@222>');
  });

  it('persists the room, including who was invited', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111> <@222>', name: 'Strategy Corner' }, guild);

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe('Strategy Corner');
    expect(rooms[0].createdBy).toBe('creator-1');
    expect(rooms[0].invitedUserIds.sort()).toEqual(['111', '222']);
    expect(rooms[0].channelId).toBe('room-channel-1');
  });

  it('reuses an existing category instead of creating a duplicate', async () => {
    const guild = makeGuild({ existingCategory: true });
    const interaction = makeInteraction({ sub: 'create', people: '<@111>' }, guild);

    await execute(interaction);

    expect(guild._channelsCreate).toHaveBeenCalledTimes(1); // only the text channel, not a category
  });

  it('replies with an error when no one is mentioned', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: 'just some text, no mentions' }, guild);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Mention at least one') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("does not invite the command author twice even if they mention themselves", async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@creator-1> <@111>' }, guild, 'creator-1');

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).toEqual(['111']);
  });

  it('skips mentions that cannot be resolved to a guild member and notes the count', async () => {
    const guild = makeGuild({ unresolvableIds: ['999'] });
    const interaction = makeInteraction({ sub: 'create', people: '<@111> <@999>' }, guild);

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).toEqual(['111']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("couldn't be found"));
  });

  it('replies with a clear error when nobody mentioned can be resolved', async () => {
    const guild = makeGuild({ unresolvableIds: ['999'] });
    const interaction = makeInteraction({ sub: 'create', people: '<@999>' }, guild);

    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Couldn't find any"));
  });

  it('stores expiresAt as the end of the given date, and no channel is created for an unparseable date', async () => {
    const guild = makeGuild();
    const badInteraction = makeInteraction({ sub: 'create', people: '<@111>', date: 'not a date' }, guild);

    await execute(badInteraction);

    expect(badInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Could not parse') }),
    );
    expect(badInteraction.deferReply).not.toHaveBeenCalled();
    expect(await loadRooms()).toHaveLength(0);
  });

  it('rejects a date that has already passed', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', date: 'January 1, 2000' }, guild);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already passed') }),
    );
    expect(await loadRooms()).toHaveLength(0);
  });

  it('stores an expiresAt matching the requested expiration date', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', date: FUTURE_DATE_STR }, guild);

    await execute(interaction);

    const rooms = await loadRooms();
    const expires = new Date(rooms[0].expiresAt);
    const expected = new Date(FUTURE_DATE_STR);
    expect(expires.getFullYear()).toBe(expected.getFullYear());
    expect(expires.getMonth()).toBe(expected.getMonth());
    expect(expires.getDate()).toBe(expected.getDate());
  });

  it('creates a persistent room with no expiration when persist:true, without requiring a date', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild);

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].persistent).toBe(true);
    expect(rooms[0].expiresAt).toBeUndefined();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('persists until closed'));
  });

  it('prefixes the channel name and topic with the pin icon for a persistent room', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild);

    await execute(interaction);

    expect(guild._channelsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringContaining('📌'), topic: expect.stringContaining('📌') }),
    );
  });

  it('does not prefix the channel name with the pin icon for a normal expiring room', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', date: FUTURE_DATE_STR }, guild);

    await execute(interaction);

    expect(guild._channelsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.not.stringContaining('📌') }),
    );
  });

  it('requires a date when persist is not set to true', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'create', people: '<@111>', date: null }, guild);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Provide a `date`') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(await loadRooms()).toHaveLength(0);
  });
});

describe('checkExpiredRooms', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-expiry-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRoom(overrides: Partial<PrivateRoom> = {}): PrivateRoom {
    return {
      id: overrides.id ?? 'room1',
      guildId: 'guild-1',
      channelId: overrides.channelId ?? 'chan1',
      name: 'Test Room',
      createdBy: 'u1',
      invitedUserIds: ['u2'],
      createdAt: new Date().toISOString(),
      expiresAt: overrides.expiresAt ?? new Date().toISOString(),
      persistent: overrides.persistent,
    };
  }

  function makeClient(deleteMock = vi.fn(async () => {})) {
    const channel = { delete: deleteMock };
    return { channels: { fetch: vi.fn(async () => channel) } };
  }

  it('closes a room whose expiration date has passed', async () => {
    await upsertRoom(makeRoom({ id: 'expired', expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const client = makeClient();

    await checkExpiredRooms(client as any);

    expect(await loadRooms()).toHaveLength(0);
  });

  it('leaves a room that has not expired yet untouched', async () => {
    await upsertRoom(makeRoom({ id: 'active', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));
    const client = makeClient();

    await checkExpiredRooms(client as any);

    expect(await loadRooms()).toHaveLength(1);
  });

  it('deletes the underlying Discord channel for an expired room', async () => {
    await upsertRoom(makeRoom({ id: 'expired', channelId: 'chan-expired', expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const deleteMock = vi.fn(async () => {});
    const client = makeClient(deleteMock);

    await checkExpiredRooms(client as any);

    expect(deleteMock).toHaveBeenCalled();
  });

  it('handles multiple rooms, only closing the expired ones', async () => {
    await upsertRoom(makeRoom({ id: 'expired1', channelId: 'c1', expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await upsertRoom(makeRoom({ id: 'active1', channelId: 'c2', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));
    await upsertRoom(makeRoom({ id: 'expired2', channelId: 'c3', expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const client = makeClient();

    await checkExpiredRooms(client as any);

    const remaining = await loadRooms();
    expect(remaining.map((r) => r.id)).toEqual(['active1']);
  });

  it('never closes a persistent room, even if its stored expiresAt is in the past', async () => {
    await upsertRoom(
      makeRoom({ id: 'persisted', persistent: true, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const client = makeClient();

    await checkExpiredRooms(client as any);

    expect(await loadRooms()).toHaveLength(1);
  });
});

describe('/room close', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-close-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRoom(guild: ReturnType<typeof makeGuild>, creatorId = 'creator-1') {
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>' }, guild, creatorId);
    await execute(createInteraction);
  }

  it('lets the creator close the room', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const deleteMock = vi.fn(async () => {});
    guild._eventChannel.delete = deleteMock;
    const closeInteraction = makeInteraction({ sub: 'close' }, guild, 'creator-1', 'room-channel-1');

    await execute(closeInteraction);

    expect(deleteMock).toHaveBeenCalled();
    expect(await loadRooms()).toHaveLength(0);
  });

  it('lets a host close a room they did not create', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    guild._eventChannel.delete = vi.fn(async () => {});
    const closeInteraction = makeInteraction({ sub: 'close' }, guild, 'some-host', 'room-channel-1');
    closeInteraction.memberPermissions = { has: (p: bigint) => p === PermissionFlagsBits.ManageEvents };

    await execute(closeInteraction);

    expect(guild._eventChannel.delete).toHaveBeenCalled();
  });

  it('blocks an unprivileged non-creator from closing the room', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    guild._eventChannel.delete = vi.fn(async () => {});
    const closeInteraction = makeInteraction({ sub: 'close' }, guild, 'random-user', 'room-channel-1');

    await execute(closeInteraction);

    expect(guild._eventChannel.delete).not.toHaveBeenCalled();
    expect(closeInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("creator or a host/admin") }),
    );
    expect(await loadRooms()).toHaveLength(1);
  });

  it('replies with a clear error when run outside a private room channel', async () => {
    const guild = makeGuild();
    const closeInteraction = makeInteraction({ sub: 'close' }, guild, 'creator-1', 'general-channel');

    await execute(closeInteraction);

    expect(closeInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('must be run inside a private room channel') }),
    );
  });
});

describe('/room persist', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-persist-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRoom(guild: ReturnType<typeof makeGuild>, creatorId = 'creator-1') {
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>' }, guild, creatorId);
    await execute(createInteraction);
  }

  it('lets the creator turn on persistence, clearing the expiration', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'persist', enabled: true },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].persistent).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer auto-expire') }),
    );
  });

  it('adds the pin icon to the channel name and topic when turning persistence on', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'persist', enabled: true },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.setName).toHaveBeenCalledWith(expect.stringContaining('📌'));
    expect(guild._eventChannel.setTopic).toHaveBeenCalledWith(expect.stringContaining('📌'));
  });

  it('removes the pin icon from the channel name and topic when turning persistence off', async () => {
    const guild = makeGuild();
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild, 'creator-1');
    await execute(createInteraction);
    const interaction = makeInteraction(
      { sub: 'persist', enabled: false, date: FUTURE_DATE_STR },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.setName).toHaveBeenCalledWith(expect.not.stringContaining('📌'));
    expect(guild._eventChannel.setTopic).toHaveBeenCalledWith(expect.not.stringContaining('📌'));
  });

  it('still updates the topic even if renaming the channel fails (e.g. a Discord rate limit)', async () => {
    const guild = makeGuild();
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild, 'creator-1');
    await execute(createInteraction);
    guild._eventChannel.setName = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const interaction = makeInteraction(
      { sub: 'persist', enabled: false, date: FUTURE_DATE_STR },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.setTopic).toHaveBeenCalledWith(expect.not.stringContaining('📌'));
  });

  it('requires a date when turning persistence back off', async () => {
    const guild = makeGuild();
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild, 'creator-1');
    await execute(createInteraction);
    const interaction = makeInteraction(
      { sub: 'persist', enabled: false },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Provide a `date`') }),
    );
    const rooms = await loadRooms();
    expect(rooms[0].persistent).toBe(true);
  });

  it('turns persistence off and sets a new expiration when given a valid date', async () => {
    const guild = makeGuild();
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>', persist: true }, guild, 'creator-1');
    await execute(createInteraction);
    const interaction = makeInteraction(
      { sub: 'persist', enabled: false, date: FUTURE_DATE_STR },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].persistent).toBe(false);
    expect(rooms[0].expiresAt).toBeDefined();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('will now expire') }),
    );
  });

  it('lets a host toggle persistence on a room they did not create', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'persist', enabled: true },
      guild,
      'some-host',
      'room-channel-1',
    );
    interaction.memberPermissions = { has: (p: bigint) => p === PermissionFlagsBits.ManageEvents };

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].persistent).toBe(true);
  });

  it('blocks an unprivileged non-creator from toggling persistence', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'persist', enabled: true },
      guild,
      'random-user',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("creator or a host/admin") }),
    );
    const rooms = await loadRooms();
    expect(rooms[0].persistent).toBeFalsy();
  });

  it('replies with a clear error when run outside a private room channel', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'persist', enabled: true }, guild, 'creator-1', 'general-channel');

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('must be run inside a private room channel') }),
    );
  });
});

describe('/room invite', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-invite-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRoom(guild: ReturnType<typeof makeGuild>, creatorId = 'creator-1') {
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>' }, guild, creatorId);
    await execute(createInteraction);
  }

  it('lets the creator invite a new person, granting channel access and updating the room record', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@333>' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.permissionOverwrites.create).toHaveBeenCalledWith('333', {
      ViewChannel: true,
      SendMessages: true,
    });
    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds.sort()).toEqual(['111', '333']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Added'));
  });

  it('pings the newly added person in the room channel', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@333>' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.send).toHaveBeenCalledWith(expect.stringContaining('<@333>'));
  });

  it('lets a host invite someone to a room they did not create', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@333>' },
      guild,
      'some-host',
      'room-channel-1',
    );
    interaction.memberPermissions = { has: (p: bigint) => p === PermissionFlagsBits.ManageEvents };

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).toContain('333');
  });

  it('blocks an unprivileged non-creator from inviting people', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@333>' },
      guild,
      'random-user',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("creator or a host/admin can invite") }),
    );
    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).not.toContain('333');
  });

  it('rejects mentions of people already in the room', async () => {
    const guild = makeGuild();
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@111>' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("isn't already in this room") }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('skips mentions that cannot be resolved to a guild member and notes the count', async () => {
    const guild = makeGuild({ unresolvableIds: ['999'] });
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@333> <@999>' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).toContain('333');
    expect(rooms[0].invitedUserIds).not.toContain('999');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("couldn't be found"));
  });

  it('replies with a clear error when nobody mentioned can be resolved', async () => {
    const guild = makeGuild({ unresolvableIds: ['999'] });
    await createRoom(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'invite', people: '<@999>' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Couldn't find any"));
  });

  it('replies with a clear error when run outside a private room channel', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'invite', people: '<@333>' }, guild, 'creator-1', 'general-channel');

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('must be run inside a private room channel') }),
    );
  });
});

describe('/room kick', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-kick-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRoomWithInvitee(guild: ReturnType<typeof makeGuild>, creatorId = 'creator-1') {
    const createInteraction = makeInteraction({ sub: 'create', people: '<@111>' }, guild, creatorId);
    await execute(createInteraction);
  }

  it('lets the creator remove an invited person, revoking channel access and updating the room record', async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: '111' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.permissionOverwrites.delete).toHaveBeenCalledWith('111');
    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).not.toContain('111');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('announces the removal in the room channel', async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: '111' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(guild._eventChannel.send).toHaveBeenCalledWith(expect.stringContaining('<@111>'));
  });

  it('lets a host kick someone from a room they did not create', async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: '111' },
      guild,
      'some-host',
      'room-channel-1',
    );
    interaction.memberPermissions = { has: (p: bigint) => p === PermissionFlagsBits.ManageEvents };

    await execute(interaction);

    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).not.toContain('111');
  });

  it('blocks an unprivileged non-creator from kicking people', async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: '111' },
      guild,
      'random-user',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("creator or a host/admin can remove people") }),
    );
    const rooms = await loadRooms();
    expect(rooms[0].invitedUserIds).toContain('111');
  });

  it("refuses to kick the room's creator", async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: 'creator-1' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can't remove the room's creator") }),
    );
    expect(guild._eventChannel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it('rejects kicking someone who was never invited to this room', async () => {
    const guild = makeGuild();
    await createRoomWithInvitee(guild, 'creator-1');
    const interaction = makeInteraction(
      { sub: 'kick', targetUserId: '999' },
      guild,
      'creator-1',
      'room-channel-1',
    );

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("hasn't been individually invited") }),
    );
    expect(guild._eventChannel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it('replies with a clear error when run outside a private room channel', async () => {
    const guild = makeGuild();
    const interaction = makeInteraction({ sub: 'kick', targetUserId: '111' }, guild, 'creator-1', 'general-channel');

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('must be run inside a private room channel') }),
    );
  });
});

describe('handleRoomConfig', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-config-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows the current category when no option is given', async () => {
    const interaction = {
      guildId: 'guild-1',
      options: { getString: () => null },
      reply: vi.fn(async () => {}),
    } as any;

    await handleRoomConfig(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Private Rooms') }),
    );
  });

  it('updates the category when given', async () => {
    const interaction = {
      guildId: 'guild-1',
      options: { getString: (name: string) => (name === 'category' ? 'Secret Rooms' : null) },
      reply: vi.fn(async () => {}),
    } as any;

    await handleRoomConfig(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Secret Rooms') }),
    );
  });
});
