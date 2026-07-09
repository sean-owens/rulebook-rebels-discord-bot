import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PermissionFlagsBits } from 'discord.js';
import { execute, handleRoomConfig } from '../src/commands/getaroom';
import { loadRooms } from '../src/utils/roomStorage';

function makeRolesCollection(roles: Array<{ id: string; permissions: { has: (p: bigint) => boolean } }>): any {
  return {
    filter: (fn: (r: any) => boolean) => makeRolesCollection(roles.filter(fn)),
    map: (fn: (r: any) => unknown) => roles.map(fn),
  };
}

function makeGuild(opts: { existingCategory?: boolean; unresolvableIds?: string[] } = {}) {
  const eventChannel = {
    id: 'room-channel-1',
    permissionOverwrites: { create: vi.fn(async () => {}) },
    send: vi.fn(async () => {}),
  };
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

function makeInteraction(
  options: { people?: string | null; name?: string | null; sub: string },
  guild: ReturnType<typeof makeGuild>,
  userId = 'creator-1',
  channelId = 'general',
) {
  return {
    guild,
    guildId: guild.id,
    client: { channels: { fetch: vi.fn(async () => guild._eventChannel) } },
    user: { id: userId },
    channelId,
    memberPermissions: { has: () => false },
    options: {
      getSubcommand: () => options.sub,
      getString: (name: string) => (name === 'people' ? options.people ?? null : name === 'name' ? options.name ?? null : null),
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}

describe('/getaroom create', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-getaroom-test-'));
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
});

describe('/getaroom close', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-getaroom-close-test-'));
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

describe('handleRoomConfig', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-getaroom-config-test-'));
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
