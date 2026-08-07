import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  getBGGGamesBatch: vi.fn(),
  weightTag: vi.fn(() => 'Medium'),
  validateBggUser: vi.fn(async (username: string) => ({ id: '1', username })),
  getBggUserProfile: vi.fn(),
  fetchBggOwnedCollection: vi.fn(async () => [
    {
      gameName: 'Wingspan',
      bggGameId: '266192',
      isExpansion: false,
      minPlayers: 1,
      maxPlayers: 5,
      playingTime: 70,
      own: true,
      forTrade: false,
      wantToPlay: false,
      wishlisted: false,
      userRating: null,
      numPlays: 0,
    },
  ]),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return { ...actual, searchCatalog: vi.fn(() => []), isCatalogLoaded: vi.fn(() => true) };
});

vi.mock('../src/utils/gameRoles', () => ({ getGameRoles: vi.fn(() => []) }));
vi.mock('../src/utils/requestPin', () => ({ updateRequestPin: vi.fn() }));
vi.mock('../src/utils/pins', () => ({ upsertLibraryPin: vi.fn() }));
vi.mock('../src/utils/storage', () => ({
  loadGameNights: vi.fn(() => []),
  findGameNight: vi.fn(() => null),
  upsertGameNight: vi.fn(),
}));

import { execute as executeBgg, handleBggLinkImportButton } from '../src/commands/bgg';
import { loadLibraryForGuild } from '../src/utils/libraryStorage';
import { getUserCollection } from '../src/utils/userCollectionStorage';

function makeLinkInteraction(username: string, guildId = 'g1', userId = 'u1') {
  return {
    options: {
      getSubcommand: () => 'link',
      getString: (name: string) => (name === 'username' ? username : null),
    },
    guildId,
    user: { id: userId },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
  } as any;
}

function makeButtonInteraction(guildId = 'g1', userId = 'u1') {
  return {
    guildId,
    user: { id: userId },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    replied: false,
    deferred: false,
    isButton: () => true,
  } as any;
}

describe('/bgg link → import my library now button', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bgg-link-import-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('offers an import button in the reply after a successful link', async () => {
    const interaction = makeLinkInteraction('boardgamefan');
    await executeBgg(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          expect.objectContaining({
            components: [
              expect.objectContaining({
                data: expect.objectContaining({ custom_id: 'bgg_link_import', label: 'Import my library now' }),
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('imports the BGG collection when the button is clicked', async () => {
    // Distinct guild/user from the other cases in this file — /bgg link has a
    // per-guild+user cooldown (module-level state) that would otherwise reject
    // a second real link within the same test run.
    const linkInteraction = makeLinkInteraction('boardgamefan', 'g3', 'u3');
    await executeBgg(linkInteraction);

    const buttonInteraction = makeButtonInteraction('g3', 'u3');
    await handleBggLinkImportButton(buttonInteraction);

    expect(buttonInteraction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('1** game added'),
    );

    const library = await loadLibraryForGuild('g3');
    expect(library.some((e) => e.gameName === 'Wingspan')).toBe(true);

    const collection = await getUserCollection('g3', 'u3');
    expect(collection.some((c) => c.gameName === 'Wingspan')).toBe(true);
  });

  it('tells the user to link first if the button is somehow clicked without a linked account', async () => {
    const buttonInteraction = makeButtonInteraction('g2', 'u2');
    await handleBggLinkImportButton(buttonInteraction);

    expect(buttonInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("don't have a BoardGameGeek account linked") }),
    );
  });
});
