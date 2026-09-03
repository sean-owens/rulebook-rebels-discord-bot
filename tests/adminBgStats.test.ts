import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageFlags } from 'discord.js';
import { handleAdminBgStats } from '../src/commands/admin';
import { upsertGameNight } from '../src/utils/storage';
import { upsertGame } from '../src/utils/gameStorage';
import { createShortLink, recordShortLinkOpen } from '../src/utils/shortLinkStorage';

function makeInteraction(guildId = 'guild-1') {
  return {
    guildId,
    reply: vi.fn(async () => {}),
  } as any;
}

function makeGameNight(overrides: Partial<Record<string, unknown>> = {}) {
  const start = new Date(Date.now() - 60 * 60 * 1000);
  return {
    id: 'gn1',
    title: 'Game Night',
    date: 'Someday',
    time: 'Sometime',
    location: 'TBD',
    link: '',
    description: '',
    messageId: '',
    channelId: 'announcements',
    guildId: 'guild-1',
    discordEventId: null,
    eventChannelId: 'event-channel-1',
    startTimeISO: start.toISOString(),
    endTimeISO: null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: 'u1',
    cancelled: false,
    archived: false,
    locked: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGame(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'game1',
    eventId: 'gn1',
    channelId: 'event-channel-1',
    messageId: 'm1',
    guildId: 'guild-1',
    bggId: '266192',
    title: 'Wingspan',
    bggLink: '',
    minPlayers: 1,
    maxPlayers: 4,
    suggestedPlayers: null,
    minPlaytime: 40,
    maxPlaytime: 60,
    suggestedStartTime: null,
    expansions: [],
    seats: ['p1'],
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: 'p1',
    scheduledTable: 1,
    ...overrides,
  };
}

describe('/admin bgstats', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-admin-bgstats-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no locked events when the guild has none', async () => {
    const interaction = makeInteraction();
    await handleAdminBgStats(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('No locked events yet'),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('reports no scheduled games when the most recent locked event has none', async () => {
    await upsertGameNight(makeGameNight() as any);
    const interaction = makeInteraction();
    await handleAdminBgStats(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('locked with no scheduled games');
  });

  it('shows open/unopened status per scheduled game plus a summary line', async () => {
    await upsertGameNight(makeGameNight() as any);
    await upsertGame(makeGame({ id: 'game1', title: 'Wingspan' }) as any);
    await upsertGame(makeGame({ id: 'game2', title: 'Catan' }) as any);
    // A suggestion that never made the lineup should be excluded entirely.
    await upsertGame(makeGame({ id: 'game3', title: 'Unscheduled Game', scheduledTable: undefined }) as any);

    const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=abc', {
      guildId: 'guild-1',
      eventId: 'gn1',
      gameId: 'game1',
    });
    await recordShortLinkOpen(link.code);

    const interaction = makeInteraction();
    await handleAdminBgStats(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(reply.content).toContain('**Wingspan** — 1 open');
    expect(reply.content).toContain('**Catan** — not opened yet');
    expect(reply.content).not.toContain('Unscheduled Game');
    expect(reply.content).toContain('1 of 2 scheduled sessions opened at least once.');
  });

  it('includes a walk-up (1-signup) game, which has no scheduledTable, alongside table-scheduled games', async () => {
    await upsertGameNight(makeGameNight() as any);
    await upsertGame(makeGame({ id: 'game1', title: 'Wingspan' }) as any);
    await upsertGame(
      makeGame({ id: 'game2', title: 'Firefly', scheduledTable: undefined, scheduledWalkUp: true }) as any,
    );

    const interaction = makeInteraction();
    await handleAdminBgStats(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('**Firefly** — not opened yet');
    expect(reply.content).toContain('2 scheduled sessions');
  });

  it('picks the most recently locked event when multiple exist', async () => {
    await upsertGameNight(
      makeGameNight({
        id: 'gn-old',
        startTimeISO: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }) as any,
    );
    await upsertGame(makeGame({ id: 'old-game', eventId: 'gn-old', title: 'Old Game' }) as any);

    await upsertGameNight(
      makeGameNight({
        id: 'gn-new',
        startTimeISO: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }) as any,
    );
    await upsertGame(makeGame({ id: 'new-game', eventId: 'gn-new', title: 'New Game' }) as any);

    const interaction = makeInteraction();
    await handleAdminBgStats(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain('New Game');
    expect(reply.content).not.toContain('Old Game');
  });

  it('scopes to the requesting guild only', async () => {
    await upsertGameNight(makeGameNight({ guildId: 'other-guild' }) as any);
    const interaction = makeInteraction('guild-1');
    await handleAdminBgStats(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('No locked events yet'),
      flags: MessageFlags.Ephemeral,
    });
  });
});
