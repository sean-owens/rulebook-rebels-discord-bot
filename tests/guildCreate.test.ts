import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGuildCreate } from '../src/events/guildCreate';
import type { Guild, Role, Collection, Snowflake } from 'discord.js';

function makeRole(name: string): Role {
  return { name } as Role;
}

function makeGuild(existingRoleNames: string[]): Guild {
  const roleMap = new Map<Snowflake, Role>(
    existingRoleNames.map((name, i) => [String(i), makeRole(name)])
  );
  const collection = {
    map: (fn: (r: Role) => unknown) => [...roleMap.values()].map(fn),
  } as unknown as Collection<Snowflake, Role>;

  return {
    name: 'Test Server',
    roles: {
      fetch: vi.fn().mockResolvedValue(collection),
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Guild;
}

describe('handleGuildCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates Admin and Host roles when neither exists', async () => {
    const guild = makeGuild([]);
    await handleGuildCreate(guild);

    expect(guild.roles.create).toHaveBeenCalledTimes(2);
    const names = (guild.roles.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name
    );
    expect(names).toContain('Admin');
    expect(names).toContain('Host');
  });

  it('skips Admin role if it already exists', async () => {
    const guild = makeGuild(['Admin']);
    await handleGuildCreate(guild);

    const names = (guild.roles.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name
    );
    expect(names).not.toContain('Admin');
    expect(names).toContain('Host');
    expect(guild.roles.create).toHaveBeenCalledTimes(1);
  });

  it('skips Host role if it already exists', async () => {
    const guild = makeGuild(['Host']);
    await handleGuildCreate(guild);

    const names = (guild.roles.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name
    );
    expect(names).toContain('Admin');
    expect(names).not.toContain('Host');
    expect(guild.roles.create).toHaveBeenCalledTimes(1);
  });

  it('skips both roles if both already exist', async () => {
    const guild = makeGuild(['Admin', 'Host']);
    await handleGuildCreate(guild);

    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('is case-insensitive when checking existing roles', async () => {
    const guild = makeGuild(['admin', 'host']);
    await handleGuildCreate(guild);

    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles role creation failure gracefully without throwing', async () => {
    const guild = makeGuild([]);
    (guild.roles.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Missing permissions'));

    await expect(handleGuildCreate(guild)).resolves.not.toThrow();
  });
});
