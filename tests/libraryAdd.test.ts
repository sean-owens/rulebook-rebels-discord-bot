import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  weightTag: vi.fn((w: number) => (w <= 2 ? 'Light' : w <= 3.5 ? 'Medium' : 'Heavy')),
  fetchBggOwnedCollection: vi.fn(() => null),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', () => ({
  searchCatalog: vi.fn(() => []),
  isCatalogLoaded: vi.fn(() => true),
  // mirrors the real implementation in bggCatalog.ts
  normalizeName: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
}));

vi.mock('../src/utils/bggAccountStorage', () => ({
  getBggAccount: vi.fn(() => null),
}));

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

vi.mock('../src/utils/gameRoles', () => ({
  getGameRoles: vi.fn(() => []),
}));

vi.mock('../src/utils/requestPin', () => ({
  updateRequestPin: vi.fn(),
}));

vi.mock('../src/utils/pins', () => ({
  upsertLibraryPin: vi.fn(),
}));

import { execute } from '../src/commands/library';
import { addGame, getGamesByUser } from '../src/utils/libraryStorage';
import { searchCatalog, isCatalogLoaded } from '../src/utils/bggCatalog';

const mockSearchCatalog = vi.mocked(searchCatalog);
const mockIsCatalogLoaded = vi.mocked(isCatalogLoaded);

function makeAddInteraction(gameName: string, guildId = 'g1', userId = 'u1') {
  return {
    options: {
      getString: (name: string, _required?: boolean) => (name === 'game' ? gameName : null),
      getInteger: vi.fn(() => null),
      getSubcommand: () => 'add',
      getSubcommandGroup: (_allowNull?: boolean) => null,
    },
    reply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    guildId,
    user: { id: userId },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
  } as any;
}

describe('/library add — step ordering', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-add-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockSearchCatalog.mockReturnValue([]);
    mockIsCatalogLoaded.mockReturnValue(true);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Step 1a: exact match in user's own library ---

  it('step 1a: blocks when user already owns the exact game', async () => {
    addGame('g1', 'u1', 'Wingspan');
    const interaction = makeAddInteraction('Wingspan');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('already in your library'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('step 1a: match is case-insensitive', async () => {
    addGame('g1', 'u1', 'Wingspan');
    const interaction = makeAddInteraction('wingspan');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('already in your library'),
      }),
    );
  });

  // --- Step 1b: exact match in guild library owned by others ---

  it('step 1b: offers "adding your copy?" when others own the exact game', async () => {
    addGame('g1', 'u2', 'Wingspan');
    const interaction = makeAddInteraction('Wingspan', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('already in the group library'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('step 1b: match against others is also case-insensitive', async () => {
    addGame('g1', 'u2', 'Wingspan');
    const interaction = makeAddInteraction('wingspan', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('already in the group library'),
      }),
    );
  });

  // --- Step 2: partial match in guild library ---

  it('step 2: shows library partial select when similar game exists', async () => {
    addGame('g1', 'u2', 'Wingspan');
    const interaction = makeAddInteraction('wing', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('similar games in the group library'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('step 2: partial select is shown before BGG catalog', async () => {
    addGame('g1', 'u2', 'Wingspan');
    // BGG would also find Wingspan — library partial should win
    mockSearchCatalog.mockReturnValue([
      { id: '266192', name: 'Wingspan', year: 2019, isExpansion: false, rank: 10 },
    ]);
    const interaction = makeAddInteraction('wing', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('similar games in the group library'),
      }),
    );
  });

  // --- Step 3a: BGG exact canonical match ---

  it('step 3a: BGG exact match shows confirm prompt before adding', async () => {
    mockSearchCatalog.mockReturnValue([
      { id: '266192', name: 'Wingspan', year: 2019, isExpansion: false, rank: 10 },
    ]);
    const interaction = makeAddInteraction('Wingspan', 'g1', 'u1');
    await execute(interaction);
    // Shows confirm buttons — game is NOT added until user clicks Yes
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Wingspan'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(getGamesByUser('g1', 'u1').some((e) => e.gameName === 'Wingspan')).toBe(false);
  });

  it('step 3a: BGG exact match re-checks library via normalized name (caught by step 2 normalized path)', async () => {
    addGame('g1', 'u2', 'Brass: Birmingham');
    mockSearchCatalog.mockReturnValue([
      { id: '224517', name: 'Brass: Birmingham', year: 2018, isExpansion: false, rank: 5 },
    ]);
    // "brass birmingham" normalizes to "brassbirmingham" which is a substring of "brassbirmingham"
    // → step 2 (partial library match) catches it before step 3
    const interaction = makeAddInteraction('brass birmingham', 'g1', 'u1');
    await execute(interaction);
    const content: string = interaction.reply.mock.calls[0][0].content;
    expect(content).toContain('similar games in the group library');
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  // --- Step 3b: BGG partial matches ---

  it('step 3b: shows BGG select for multiple partial matches', async () => {
    mockSearchCatalog.mockReturnValue([
      { id: '266192', name: 'Wingspan', year: 2019, isExpansion: false, rank: 10 },
      { id: '300877', name: 'Wingspan: Asia', year: 2022, isExpansion: true, rank: null },
    ]);
    const interaction = makeAddInteraction('wing', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('possible matches'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('step 3b: shows single BGG confirm for one partial match', async () => {
    mockSearchCatalog.mockReturnValue([
      { id: '266192', name: 'Wingspan', year: 2019, isExpansion: false, rank: 10 },
    ]);
    const interaction = makeAddInteraction('wingsspan', 'g1', 'u1'); // typo, not exact match
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Found **Wingspan**'),
      }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  // --- Step 4: no matches anywhere → custom game ---

  it('step 4: adds custom game and shows detail modal when nothing matches', async () => {
    mockSearchCatalog.mockReturnValue([]);
    const interaction = makeAddInteraction('My Custom Game', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.showModal).toHaveBeenCalled();
    expect(getGamesByUser('g1', 'u1').some((e) => e.gameName === 'My Custom Game')).toBe(true);
  });

  it('step 4: adds as custom when BGG catalog is not loaded', async () => {
    mockIsCatalogLoaded.mockReturnValue(false);
    const interaction = makeAddInteraction('Some Game', 'g1', 'u1');
    await execute(interaction);
    expect(interaction.showModal).toHaveBeenCalled();
    expect(getGamesByUser('g1', 'u1').some((e) => e.gameName === 'Some Game')).toBe(true);
  });

  // --- Guild isolation ---

  it('library checks are guild-scoped', async () => {
    addGame('g1', 'u2', 'Wingspan'); // only in guild g1
    const interaction = makeAddInteraction('Wingspan', 'g2', 'u1'); // different guild
    await execute(interaction);
    // Should not find Wingspan in g2 → falls through to BGG/custom
    const content: string = interaction.reply.mock.calls[0]?.[0]?.content ?? '';
    expect(content).not.toContain('already in the group library');
  });
});
