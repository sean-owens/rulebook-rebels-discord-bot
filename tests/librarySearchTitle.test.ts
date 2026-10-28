import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execute } from '../src/commands/library';
import { addGame, upsertGameInfo } from '../src/utils/libraryStorage';
import { addGameRole } from '../src/utils/gameRoles';

const GUILD_ID = 'g1';
const USER_ID = 'u1';

function makeMember(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } } as any;
}

describe('/library search — title filter (#113)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-search-title-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    await addGameRole(GUILD_ID, { roleId: 'role-party', name: 'Party', type: 'genre' });

    await addGame(GUILD_ID, USER_ID, 'Catan');
    await upsertGameInfo({ gameName: 'Catan', tags: ['Strategy'], complexity: 'Medium', updatedAt: '' });

    await addGame(GUILD_ID, USER_ID, 'Catan Junior');
    await upsertGameInfo({ gameName: 'Catan Junior', tags: ['Family'], complexity: 'Light', updatedAt: '' });

    await addGame(GUILD_ID, USER_ID, 'Catan: Seafarers', undefined, true); // expansion
    await addGame(GUILD_ID, USER_ID, 'Ticket to Ride');
    await upsertGameInfo({ gameName: 'Ticket to Ride', tags: ['Family'], complexity: 'Light', updatedAt: '' });
    await addGame(GUILD_ID, USER_ID, 'Wingspan');
    await upsertGameInfo({ gameName: 'Wingspan', tags: ['Strategy'], complexity: 'Medium', updatedAt: '' });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeInteraction(
    options: Record<string, string>,
    opts: { roleIds?: string[] } = {},
  ) {
    return {
      guildId: GUILD_ID,
      user: { id: USER_ID },
      guild: { members: { fetch: vi.fn(async () => makeMember(opts.roleIds ?? [])) } },
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => 'search',
        getString: (name: string) => options[name] ?? null,
        getInteger: () => null,
      },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  it('lists every library game whose name matches the title, ignoring case', async () => {
    const interaction = makeInteraction({ title: 'CATAN' });
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).toContain('2 games matching title **CATAN**');
    const body = embed.fields.map((f: any) => f.value).join('\n');
    expect(body).toContain('Catan');
    expect(body).toContain('Catan Junior');
    expect(body).not.toContain('Ticket to Ride');
    expect(body).not.toContain('Wingspan');
  });

  it('matches on any word of a multi-word title, not just an exact name', async () => {
    const interaction = makeInteraction({ title: 'ticket ride' });
    await execute(interaction);

    // One match -> shown as a /library view card (see below), so assert via editReply.
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe('Ticket to Ride');
  });

  it('tolerates a small typo', async () => {
    const interaction = makeInteraction({ title: 'wingspn' });
    await execute(interaction);

    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe('Wingspan');
  });

  it('leaves expansions out of title matches, so a base game resolves on its own', async () => {
    const interaction = makeInteraction({ title: 'catan seafarers' });
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No games found matching title **catan seafarers**') }),
    );
  });

  it('combines with other filters (title AND tag)', async () => {
    const interaction = makeInteraction({ title: 'catan', tag: 'Family' });
    await execute(interaction);

    // Only Catan Junior is both a "catan" title and Family -> single result -> view card.
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe('Catan Junior');
  });

  it('is not narrowed by the caller\'s /myroles preferences', async () => {
    // The caller prefers Party games; neither Catan is Party. Personalization
    // must not kick in for a title search or both results would vanish.
    const interaction = makeInteraction({ title: 'catan' }, { roleIds: ['role-party'] });
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).not.toContain('/myroles');
    expect(embed.description).toContain('2 games');
  });

  it('shows the full /library view card when exactly one game matches, instead of a results list', async () => {
    const interaction = makeInteraction({ title: 'wingspan' });
    await execute(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalled();
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe('Wingspan');
    expect(embed.fields.map((f: any) => f.name)).toContain('Owner');
  });

  it('also shows the view card for a single match from non-title filters', async () => {
    const interaction = makeInteraction({ tag: 'Strategy', complexity: 'Medium', title: 'wing' });
    await execute(interaction);

    expect(interaction.editReply.mock.calls[0][0].embeds[0].toJSON().title).toBe('Wingspan');
  });

  it('replies with a no-results message when nothing matches the title', async () => {
    const interaction = makeInteraction({ title: 'zzzzz' });
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No games found matching title **zzzzz**.' }),
    );
  });

  it('ignores a blank title and still requires some other filter', async () => {
    const interaction = makeInteraction({ title: '   ' });
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('`title`') }),
    );
  });
});
