import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';

const mockUpsertGameNight = vi.fn();
vi.mock('../src/utils/storage', () => ({
  loadGameNights: vi.fn(async () => []),
  upsertGameNight: (...args: unknown[]) => mockUpsertGameNight(...args),
}));
vi.mock('../src/utils/config', () => ({ getGuildConfig: vi.fn(async () => ({})) }));
vi.mock('../src/utils/gameNightTags', () => ({
  ensureGameNightTags: vi.fn(),
  resolvedGameNightTag: vi.fn(),
}));

import { buildLockOverwrite, lockEventChannel } from '../src/utils/archive';

const EVERYONE = { id: 'everyone-role' };

function makeFixture(opts: { botHasAddReactions: boolean; createRejects?: unknown }) {
  const create = vi.fn(async () => {
    if (opts.createRejects) throw opts.createRejects;
  });
  const send = vi.fn(async () => {});
  const channel = {
    permissionOverwrites: { create },
    send,
    permissionsFor: vi.fn(() => ({
      has: (flag: bigint) => (flag === PermissionFlagsBits.AddReactions ? opts.botHasAddReactions : true),
    })),
  };
  const guild = {
    roles: { everyone: EVERYONE },
    members: { fetchMe: vi.fn(async () => ({ id: 'bot' })) },
  };
  const client = {
    guilds: { fetch: vi.fn(async () => guild) },
    channels: { fetch: vi.fn(async () => channel) },
  } as any;
  return { client, create, send, channel };
}

function makeGameNight(overrides: Record<string, unknown> = {}) {
  return { id: 'gn1', guildId: 'g1', eventChannelId: 'c1', archived: true, locked: false, ...overrides } as any;
}

describe('buildLockOverwrite', () => {
  it('denies sending and reactions when the bot can deny reactions', () => {
    expect(buildLockOverwrite(true)).toEqual({ SendMessages: false, AddReactions: false });
  });

  it('only denies sending when the bot lacks Add Reactions (Discord would reject the edit)', () => {
    expect(buildLockOverwrite(false)).toEqual({ SendMessages: false });
  });

  it('never touches ViewChannel, so a private channel does not become visible', () => {
    expect(buildLockOverwrite(true)).not.toHaveProperty('ViewChannel');
    expect(buildLockOverwrite(false)).not.toHaveProperty('ViewChannel');
  });
});

describe('lockEventChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('locks the channel, posts the notice, and marks the game night locked', async () => {
    const { client, create, send } = makeFixture({ botHasAddReactions: true });
    const gn = makeGameNight();

    await lockEventChannel(client, gn);

    expect(create).toHaveBeenCalledWith(EVERYONE, { SendMessages: false, AddReactions: false });
    expect(send).toHaveBeenCalledWith('*This channel is now read-only.*');
    expect(gn.locked).toBe(true);
    expect(mockUpsertGameNight).toHaveBeenCalledWith(gn);
  });

  it('still locks (without the reaction block) when the bot lacks Add Reactions, and logs why — issue #118', async () => {
    const { client, create } = makeFixture({ botHasAddReactions: false });
    const gn = makeGameNight();

    await lockEventChannel(client, gn);

    expect(create).toHaveBeenCalledWith(EVERYONE, { SendMessages: false });
    expect(gn.locked).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Add Reactions'));
  });

  it('does not mark the channel locked when Discord rejects the overwrite', async () => {
    const { client, send } = makeFixture({ botHasAddReactions: true, createRejects: new Error('Missing Permissions') });
    const gn = makeGameNight();

    await lockEventChannel(client, gn);

    expect(gn.locked).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(mockUpsertGameNight).not.toHaveBeenCalled();
  });

  it('does nothing for an already-locked game night or one with no event channel', async () => {
    const { client, create } = makeFixture({ botHasAddReactions: true });

    await lockEventChannel(client, makeGameNight({ locked: true }));
    await lockEventChannel(client, makeGameNight({ eventChannelId: undefined }));

    expect(create).not.toHaveBeenCalled();
  });
});
