import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  weightTag: vi.fn(() => 'Medium'),
  fetchBggOwnedCollection: vi.fn(() => null),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return { ...actual, searchCatalog: vi.fn(() => []), isCatalogLoaded: vi.fn(() => true) };
});

vi.mock('../src/utils/bggAccountStorage', () => ({ getBggAccount: vi.fn(() => null) }));

vi.mock('../src/utils/userCollectionStorage', () => ({
  mergeUserCollection: vi.fn(),
  getUserCollection: vi.fn(() => []),
  setUserCollection: vi.fn(),
  updateCollectionEntry: vi.fn(),
}));

vi.mock('../src/utils/storage', () => ({
  loadGameNights: vi.fn(() => []),
  findGameNight: vi.fn(() => null),
  upsertGameNight: vi.fn(),
}));

vi.mock('../src/utils/gameRoles', () => ({ getGameRoles: vi.fn(() => []) }));
vi.mock('../src/utils/requestPin', () => ({ updateRequestPin: vi.fn() }));
vi.mock('../src/utils/pins', () => ({ upsertLibraryPin: vi.fn() }));

import { execute } from '../src/commands/library';
import { addGame } from '../src/utils/libraryStorage';
import { addLibraryLink, getEffectiveOwnerIds } from '../src/utils/libraryLinkStorage';

function makeLinkInteraction(sub: 'link' | 'unlink', targetUserId: string, guildId = 'g1', userId = 'u1') {
  return {
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: (_allowNull?: boolean) => null,
      getUser: (name: string) => (name === 'user' ? { id: targetUserId, bot: false } : null),
    },
    reply: vi.fn(async () => {}),
    guildId,
    user: { id: userId },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
  } as any;
}

describe('/library link and /library unlink', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-link-cmd-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('grants the target user delegate access to the caller\'s library', async () => {
    const interaction = makeLinkInteraction('link', 'bob', 'g1', 'alice');
    await execute(interaction);

    expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob', 'alice']);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('can now see your games') }),
    );
  });

  it('does not grant the reverse direction', async () => {
    await execute(makeLinkInteraction('link', 'bob', 'g1', 'alice'));
    expect(await getEffectiveOwnerIds('g1', 'alice')).toEqual(['alice']);
  });

  it('refuses to link your own account to itself', async () => {
    const interaction = makeLinkInteraction('link', 'alice', 'g1', 'alice');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can't link your own account") }),
    );
    expect(await getEffectiveOwnerIds('g1', 'alice')).toEqual(['alice']);
  });

  it('reports when already linked instead of creating a duplicate', async () => {
    await execute(makeLinkInteraction('link', 'bob', 'g1', 'alice'));
    const interaction = makeLinkInteraction('link', 'bob', 'g1', 'alice');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('can already view') }),
    );
  });

  it('removes the link on /library unlink', async () => {
    await addLibraryLink('g1', 'alice', 'bob');
    const interaction = makeLinkInteraction('unlink', 'bob', 'g1', 'alice');
    await execute(interaction);

    expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob']);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('removed') }),
    );
  });

  it('unlink works from either party, not just the original grantor', async () => {
    await addLibraryLink('g1', 'alice', 'bob');
    const interaction = makeLinkInteraction('unlink', 'alice', 'g1', 'bob');
    await execute(interaction);
    expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob']);
  });

  it('reports cleanly when there was nothing to unlink', async () => {
    const interaction = makeLinkInteraction('unlink', 'bob', 'g1', 'alice');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("don't have a library link") }),
    );
  });
});

describe('/library mine shows linked delegate\'s games', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-mine-linked-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMineInteraction(guildId = 'g1', userId = 'bob') {
    return {
      options: {
        getSubcommand: () => 'mine',
        getSubcommandGroup: (_allowNull?: boolean) => null,
      },
      reply: vi.fn(async () => {}),
      guildId,
      user: { id: userId },
      isChatInputCommand: () => true,
      replied: false,
      deferred: false,
    } as any;
  }

  it("includes the linked owner's games, attributed to them", async () => {
    await addGame('g1', 'bob', 'Catan');
    await addGame('g1', 'alice', 'Wingspan');
    await addLibraryLink('g1', 'alice', 'bob');

    const interaction = makeMineInteraction('g1', 'bob');
    await execute(interaction);

    const call = interaction.reply.mock.calls[0][0];
    const description = call.embeds[0].data.description as string;
    expect(description).toContain('Catan');
    expect(description).toContain('Wingspan');
    expect(description).toContain('shared from <@alice>');
  });
});
