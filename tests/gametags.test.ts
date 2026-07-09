import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleSync } from '../src/commands/gametags';
import { getGameRoles } from '../src/utils/gameRoles';
import { GENRE_TAG_DEFINITIONS, DIFFICULTY_TAG_DEFINITIONS } from '../src/utils/tagDefinitions';

function makeDiscordRole(id: string, name: string) {
  return { id, name };
}

function makeGuildRolesCollection(roles: { id: string; name: string }[]) {
  const map = new Map(roles.map((r) => [r.id, r]));
  return {
    map: (fn: (r: { id: string; name: string }) => unknown) => [...map.values()].map(fn),
    // vitest's Map spread/iteration is enough for `guildRoles.map(...)` used in gametags.ts
    [Symbol.iterator]: () => map.values(),
  };
}

function makeSyncInteraction(existingDiscordRoles: { id: string; name: string }[], guildId = 'g1') {
  let nextId = 1000;
  return {
    guildId,
    user: { tag: 'tester#0001' },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    guild: {
      roles: {
        fetch: vi.fn(async () => makeGuildRolesCollection(existingDiscordRoles)),
        create: vi.fn(async ({ name }: { name: string }) => {
          return makeDiscordRole(String(nextId++), name);
        }),
      },
    },
  } as any;
}

describe('/admin tags sync — reusing existing Discord roles', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gametags-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links to an existing same-named Discord role instead of creating a duplicate', async () => {
    const existing = [makeDiscordRole('r1', GENRE_TAG_DEFINITIONS[0].name)];
    const interaction = makeSyncInteraction(existing);

    await handleSync(interaction);

    expect(interaction.guild.roles.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: GENRE_TAG_DEFINITIONS[0].name }),
    );

    const stored = await getGameRoles('g1');
    const linked = stored.find((r) => r.name === GENRE_TAG_DEFINITIONS[0].name);
    expect(linked).toBeDefined();
    expect(linked?.roleId).toBe('r1');
    expect(linked?.botCreated).toBe(false);
  });

  it('is case-insensitive when matching existing role names', async () => {
    const existing = [makeDiscordRole('r1', GENRE_TAG_DEFINITIONS[0].name.toUpperCase())];
    const interaction = makeSyncInteraction(existing);

    await handleSync(interaction);

    expect(interaction.guild.roles.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: GENRE_TAG_DEFINITIONS[0].name }),
    );
    const stored = await getGameRoles('g1');
    expect(stored.find((r) => r.roleId === 'r1')?.botCreated).toBe(false);
  });

  it('creates a new role only for tags with no matching existing Discord role', async () => {
    const interaction = makeSyncInteraction([]);

    await handleSync(interaction);

    const total = GENRE_TAG_DEFINITIONS.length + DIFFICULTY_TAG_DEFINITIONS.length;
    expect(interaction.guild.roles.create).toHaveBeenCalledTimes(total);
    const stored = await getGameRoles('g1');
    expect(stored).toHaveLength(total);
    expect(stored.every((r) => r.botCreated === true)).toBe(true);
  });

  it('does not create duplicate roles when run a second time after already syncing', async () => {
    const interaction1 = makeSyncInteraction([]);
    await handleSync(interaction1);
    const total = GENRE_TAG_DEFINITIONS.length + DIFFICULTY_TAG_DEFINITIONS.length;
    expect(interaction1.guild.roles.create).toHaveBeenCalledTimes(total);

    // Second sync run — bot-side gameRoles storage now already has everything tracked,
    // so it should report "already synced" and create nothing further, regardless of
    // what Discord-side roles look like.
    const interaction2 = makeSyncInteraction([]);
    await handleSync(interaction2);
    expect(interaction2.guild.roles.create).not.toHaveBeenCalled();

    const stored = await getGameRoles('g1');
    expect(stored).toHaveLength(total);
  });
});
