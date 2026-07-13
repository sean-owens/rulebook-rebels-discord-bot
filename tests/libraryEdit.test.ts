import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/utils/bgg', () => ({
  getBGGGame: vi.fn(),
  getBGGGamesBatch: vi.fn(),
  weightTag: vi.fn((w: number) => (w <= 2 ? 'Light' : w <= 3.5 ? 'Medium' : 'Heavy')),
  fetchBggOwnedCollection: vi.fn(() => null),
  BGG_TO_TAG: {},
}));

vi.mock('../src/utils/bggCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bggCatalog')>();
  return {
    ...actual,
    searchCatalog: vi.fn(() => []),
    isCatalogLoaded: vi.fn(() => true),
  };
});

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

import { execute, handleEditModal } from '../src/commands/library';
import { addGame, getGameInfo, upsertGameInfo } from '../src/utils/libraryStorage';

function makeEditInteraction(gameName: string, guildId = 'g1', userId = 'u1') {
  return {
    options: {
      getString: (name: string) => (name === 'game' ? gameName : null),
      getSubcommand: () => 'edit',
      getSubcommandGroup: (_allowNull?: boolean) => null,
    },
    reply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    guildId,
    user: { id: userId },
    isChatInputCommand: () => true,
  } as any;
}

function makeModalInteraction(
  values: Record<string, string>,
  userId = 'u1',
) {
  return {
    fields: {
      getTextInputValue: (id: string) => values[id] ?? '',
    },
    reply: vi.fn(async () => {}),
    user: { id: userId },
  } as any;
}

describe('/library edit — clearing fields', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-edit-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedGame() {
    await addGame('g1', 'u1', 'Terraforming Mars');
    await upsertGameInfo({
      gameName: 'Terraforming Mars',
      minPlayers: 1,
      maxPlayers: 5,
      playTime: 120,
      complexity: 'Heavy',
      tags: ['Worker Placement'],
      expansions: ['Prelude', 'Venus Next'],
      updatedAt: new Date().toISOString(),
    });
  }

  it('clearing only the expansions field deletes existing expansions, leaving other fields untouched', async () => {
    await seedGame();

    const editInteraction = makeEditInteraction('Terraforming Mars');
    await execute(editInteraction);
    expect(editInteraction.showModal).toHaveBeenCalled();

    // Modal re-submits with every field pre-filled with its current value except
    // expansions, which the user cleared.
    const modalInteraction = makeModalInteraction({
      players: '1-5',
      playtime: '120',
      tags: 'Worker Placement',
      expansions: '',
      complexity: 'Heavy',
    });
    await handleEditModal(modalInteraction);

    const info = await getGameInfo('Terraforming Mars');
    expect(info?.expansions).toBeUndefined();
    expect(info?.minPlayers).toBe(1);
    expect(info?.maxPlayers).toBe(5);
    expect(info?.playTime).toBe(120);
    expect(info?.complexity).toBe('Heavy');
    expect(info?.tags).toEqual(['Worker Placement']);
  });

  it('clearing all fields clears all of them', async () => {
    await seedGame();

    const editInteraction = makeEditInteraction('Terraforming Mars');
    await execute(editInteraction);

    const modalInteraction = makeModalInteraction({
      players: '',
      playtime: '',
      tags: '',
      expansions: '',
      complexity: '',
    });
    await handleEditModal(modalInteraction);

    const info = await getGameInfo('Terraforming Mars');
    expect(info?.minPlayers).toBeUndefined();
    expect(info?.maxPlayers).toBeUndefined();
    expect(info?.playTime).toBeUndefined();
    expect(info?.complexity).toBeUndefined();
    expect(info?.tags).toEqual([]);
    expect(info?.expansions).toBeUndefined();
  });

  it('providing new values still updates fields normally', async () => {
    await seedGame();

    const editInteraction = makeEditInteraction('Terraforming Mars');
    await execute(editInteraction);

    const modalInteraction = makeModalInteraction({
      players: '2-4',
      playtime: '90',
      tags: 'Worker Placement',
      expansions: 'Prelude',
      complexity: 'Heavy',
    });
    await handleEditModal(modalInteraction);

    const info = await getGameInfo('Terraforming Mars');
    expect(info?.minPlayers).toBe(2);
    expect(info?.maxPlayers).toBe(4);
    expect(info?.playTime).toBe(90);
    expect(info?.expansions).toEqual(['Prelude']);
  });
});
