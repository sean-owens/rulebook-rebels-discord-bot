import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execute } from '../src/commands/library';
import { addGame, upsertGameInfo } from '../src/utils/libraryStorage';
import { addGameRole, getMemberPreferences } from '../src/utils/gameRoles';

const GUILD_ID = 'g1';
const USER_ID = 'u1';

function makeMember(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } } as any;
}

describe('/library random and /library search — personalized to /myroles preferences', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-personalization-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    await addGameRole(GUILD_ID, { roleId: 'role-party', name: 'Party', type: 'genre' });
    await addGameRole(GUILD_ID, { roleId: 'role-coop', name: 'Co-op', type: 'genre' });
    await addGameRole(GUILD_ID, { roleId: 'role-light', name: 'Light', type: 'difficulty' });
    await addGameRole(GUILD_ID, { roleId: 'role-heavy', name: 'Heavy', type: 'difficulty' });

    await addGame(GUILD_ID, USER_ID, 'Codenames');
    await upsertGameInfo({ gameName: 'Codenames', tags: ['Party'], complexity: 'Light', updatedAt: '' });

    await addGame(GUILD_ID, USER_ID, 'Gloomhaven');
    await upsertGameInfo({ gameName: 'Gloomhaven', tags: ['Co-op'], complexity: 'Heavy', updatedAt: '' });

    await addGame(GUILD_ID, USER_ID, 'Chess');
    await upsertGameInfo({ gameName: 'Chess', tags: ['Abstract'], complexity: 'Medium', updatedAt: '' });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeInteractionWithRoles(sub: string, roleIds: string[], options: Record<string, string> = {}) {
    const interaction = {
      guildId: GUILD_ID,
      user: { id: USER_ID },
      guild: { members: { fetch: vi.fn(async () => makeMember(roleIds)) } },
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => sub,
        getString: (name: string) => options[name] ?? null,
        getInteger: () => null,
      },
      reply: vi.fn(async () => {}),
    };
    return interaction as any;
  }

  it('getMemberPreferences reads genre + difficulty selections back out of Discord roles', async () => {
    const member = makeMember(['role-party', 'role-light']);
    const prefs = await getMemberPreferences(GUILD_ID, member);
    expect(prefs.tags).toEqual(['Party']);
    expect(prefs.complexity).toBe('Light');
  });

  it('getMemberPreferences returns empty when no /myroles selections match', async () => {
    const member = makeMember([]);
    const prefs = await getMemberPreferences(GUILD_ID, member);
    expect(prefs.tags).toEqual([]);
    expect(prefs.complexity).toBeNull();
  });

  it('/library random defaults to the caller\'s /myroles tag when no explicit filter is given', async () => {
    const interaction = makeInteractionWithRoles('random', ['role-party']);
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toContain('Party');
    expect(embed.title).toContain('/myroles');
    expect(embed.fields.map((f: any) => f.name)).toEqual(['Codenames']);
  });

  it('/library random ignores /myroles preferences when an explicit tag is passed', async () => {
    const interaction = makeInteractionWithRoles('random', ['role-party'], { tag: 'Co-op' });
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).not.toContain('/myroles');
    expect(embed.fields.map((f: any) => f.name)).toEqual(['Gloomhaven']);
  });

  it('/library random stays fully random with no /myroles hint when the caller has no preferences set', async () => {
    const interaction = makeInteractionWithRoles('random', []);
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).not.toContain('/myroles');
    expect(embed.footer.text).toContain('/myroles');
  });

  it('/library search defaults to the caller\'s /myroles complexity when no explicit filter is given', async () => {
    const interaction = makeInteractionWithRoles('search', ['role-heavy']);
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).toContain('/myroles');
    expect(embed.fields[0].value).toContain('Gloomhaven');
  });

  it('/library search still errors when the caller has no explicit filters and no /myroles preferences', async () => {
    const interaction = makeInteractionWithRoles('search', []);
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('/myroles'),
      }),
    );
  });

  it('/library search uses explicit filters over /myroles preferences when both are present', async () => {
    const interaction = makeInteractionWithRoles('search', ['role-heavy'], { tag: 'Party' });
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).not.toContain('/myroles');
    expect(embed.fields[0].value).toContain('Codenames');
  });
});
