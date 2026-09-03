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

const mockLoadGameNights = vi.fn();
vi.mock('../src/utils/storage', () => ({
  loadGameNights: () => mockLoadGameNights(),
  findGameNight: vi.fn(() => null),
  upsertGameNight: vi.fn(),
}));

vi.mock('../src/utils/gameRoles', () => ({ getGameRoles: vi.fn(() => []) }));
vi.mock('../src/utils/requestPin', () => ({ updateRequestPin: vi.fn(async () => {}) }));
vi.mock('../src/utils/pins', () => ({ upsertLibraryPin: vi.fn() }));

import { execute } from '../src/commands/library';
import { addGame, getRequestsForEvent } from '../src/utils/libraryStorage';
import { addLibraryLink } from '../src/utils/libraryLinkStorage';

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'event-1',
    eventChannelId: 'event-channel-1',
    startTimeISO: future,
    endTimeISO: null,
    date: 'Saturday',
    cancelled: false,
    archived: false,
    rsvps: { yes: [], maybe: [], no: [] },
    ...overrides,
  };
}

function makeRequestInteraction(gameName: string, guildId = 'g1', userId = 'requester', channelId = 'event-channel-1') {
  return {
    options: {
      getSubcommand: () => 'request',
      getSubcommandGroup: (_allowNull?: boolean) => null,
      getString: (name: string) => (name === 'game' ? gameName : null),
    },
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    guildId,
    channelId,
    user: { id: userId },
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
  } as any;
}

describe('/library request — eligibility through a library link', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-request-link-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    mockLoadGameNights.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects the request when the owner isn't attending and has no linked delegate attending either", async () => {
    await addGame('g1', 'alice', 'Wingspan');
    mockLoadGameNights.mockReturnValue([makeEvent({ rsvps: { yes: [], maybe: [], no: [] } })]);

    const interaction = makeRequestInteraction('Wingspan');
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can't be requested") }),
    );
  });

  it("allows the request when only the owner's linked delegate is attending", async () => {
    await addGame('g1', 'alice', 'Wingspan');
    await addLibraryLink('g1', 'alice', 'bob'); // alice shares her library with bob
    mockLoadGameNights.mockReturnValue([makeEvent({ rsvps: { yes: ['bob'], maybe: [], no: [] } })]);

    const interaction = makeRequestInteraction('Wingspan');
    await execute(interaction);

    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can't be requested") }),
    );
    const requests = await getRequestsForEvent('event-1');
    expect(requests).toHaveLength(1);
    expect(requests[0].gameName).toBe('Wingspan');
  });
});
