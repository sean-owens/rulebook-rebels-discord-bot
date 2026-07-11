import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  scheduleGames,
  complexityBufferMinutes,
  toSchedulableGame,
  buildScheduleEmbed,
  lockAndScheduleEvent,
  checkPendingSchedules,
  isLineupLocked,
  SchedulableGame,
} from '../src/utils/scheduler';
import { GameSuggestion } from '../src/utils/gameStorage';

const BUFFER_CONFIG = { lightBufferMinutes: 20, mediumBufferMinutes: 30, heavyBufferMinutes: 40 };

function makeGame(overrides: Partial<SchedulableGame> = {}): SchedulableGame {
  return {
    id: overrides.id ?? 'g1',
    title: overrides.title ?? 'Game',
    minPlayers: overrides.minPlayers ?? 2,
    seatedPlayers: overrides.seatedPlayers ?? ['p1', 'p2'],
    effectiveDurationMinutes: overrides.effectiveDurationMinutes ?? 60,
  };
}

describe('complexityBufferMinutes', () => {
  it('returns the matching tier', () => {
    expect(complexityBufferMinutes('Light', BUFFER_CONFIG)).toBe(20);
    expect(complexityBufferMinutes('Medium', BUFFER_CONFIG)).toBe(30);
    expect(complexityBufferMinutes('Heavy', BUFFER_CONFIG)).toBe(40);
  });

  it('falls back to the medium tier when complexity is unset', () => {
    expect(complexityBufferMinutes(undefined, BUFFER_CONFIG)).toBe(30);
    expect(complexityBufferMinutes('', BUFFER_CONFIG)).toBe(30);
  });
});

describe('toSchedulableGame', () => {
  it('adds the complexity buffer to maxPlaytime', () => {
    const game = { id: 'g1', title: 'Wingspan', minPlayers: 2, maxPlaytime: 70, complexity: 'Medium', seats: ['p1'] } as GameSuggestion;
    const result = toSchedulableGame(game, BUFFER_CONFIG);
    expect(result.effectiveDurationMinutes).toBe(100); // 70 + 30
    expect(result.seatedPlayers).toEqual(['p1']);
  });
});

describe('scheduleGames', () => {
  it('schedules a single game onto round 1, table 1', () => {
    const result = scheduleGames([makeGame({ id: 'g1' })], 2, 120);
    expect(result.assignments).toEqual([{ gameId: 'g1', round: 1, table: 1 }]);
    expect(result.unscheduled).toEqual([]);
    expect(result.totalDurationMinutes).toBe(60);
    expect(result.fitsInWindow).toBe(true);
  });

  it('excludes a game below its minimum player count, with a clear reason', () => {
    const result = scheduleGames(
      [makeGame({ id: 'g1', minPlayers: 4, seatedPlayers: ['p1', 'p2'] })],
      2,
      120,
    );
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([
      { gameId: 'g1', reason: 'only 2/4 minimum players seated' },
    ]);
  });

  it('places two non-conflicting games in the same round when tables allow it', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p3', 'p4'] }),
      ],
      2,
      120,
    );
    const rounds = new Set(result.assignments.map((a) => a.round));
    expect(rounds.size).toBe(1);
    const tables = result.assignments.map((a) => a.table).sort();
    expect(tables).toEqual([1, 2]);
  });

  it('pushes a player-conflicting game to a later round even with a free table', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', seatedPlayers: ['p1', 'p2'] }),
        makeGame({ id: 'g2', seatedPlayers: ['p1', 'p3'] }), // shares p1 with g1
      ],
      2, // two tables available — conflict is about the player, not table capacity
      240,
    );
    const g1Round = result.assignments.find((a) => a.gameId === 'g1')!.round;
    const g2Round = result.assignments.find((a) => a.gameId === 'g2')!.round;
    expect(g1Round).not.toBe(g2Round);
  });

  it('queues a third game to round 2 when only one table is available', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1'] }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p2'] }),
      ],
      1, // single table
      240,
    );
    const rounds = result.assignments.map((a) => a.round).sort();
    expect(rounds).toEqual([1, 2]);
  });

  it('computes each round duration as the max effective duration among its games', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1'], effectiveDurationMinutes: 90 }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p2'], effectiveDurationMinutes: 45 }),
      ],
      2,
      120,
    );
    expect(result.roundDurationsMinutes).toEqual([90]);
    expect(result.totalDurationMinutes).toBe(90);
  });

  it('flags fitsInWindow as false when the schedule exceeds the event window', () => {
    const result = scheduleGames(
      [
        makeGame({ id: 'g1', minPlayers: 1, seatedPlayers: ['p1'], effectiveDurationMinutes: 90 }),
        makeGame({ id: 'g2', minPlayers: 1, seatedPlayers: ['p1'], effectiveDurationMinutes: 90 }), // conflicts with g1 -> forced to round 2
      ],
      1,
      120, // only enough time for one 90-minute round
    );
    expect(result.totalDurationMinutes).toBe(180);
    expect(result.fitsInWindow).toBe(false);
  });

  it('handles an empty game list', () => {
    const result = scheduleGames([], 2, 120);
    expect(result.assignments).toEqual([]);
    expect(result.unscheduled).toEqual([]);
    expect(result.totalDurationMinutes).toBe(0);
    expect(result.fitsInWindow).toBe(true);
  });

  it('never double-books a player across tables in the same round, even under load', () => {
    // 6 games, alternating between two overlapping player pools, 3 tables available.
    const games = Array.from({ length: 6 }, (_, i) =>
      makeGame({
        id: `g${i}`,
        seatedPlayers: i % 2 === 0 ? ['p1', 'p2'] : ['p2', 'p3'],
        effectiveDurationMinutes: 60,
      }),
    );
    const result = scheduleGames(games, 3, 600);

    const byRound = new Map<number, string[]>();
    for (const a of result.assignments) {
      const game = games.find((g) => g.id === a.gameId)!;
      const existing = byRound.get(a.round) ?? [];
      for (const p of game.seatedPlayers) {
        expect(existing.includes(p)).toBe(false);
      }
      byRound.set(a.round, [...existing, ...game.seatedPlayers]);
    }
  });
});

describe('isLineupLocked', () => {
  it('is false when unset', () => {
    expect(isLineupLocked({})).toBe(false);
  });
  it('is true only when explicitly set', () => {
    expect(isLineupLocked({ suggestionsLocked: true })).toBe(true);
    expect(isLineupLocked({ suggestionsLocked: false })).toBe(false);
  });
});

describe('buildScheduleEmbed', () => {
  const games = [
    { id: 'g1', title: 'Wingspan' },
    { id: 'g2', title: 'Catan' },
  ];

  it('lists each round with its table assignments', () => {
    const result = {
      assignments: [
        { gameId: 'g1', round: 1, table: 1 },
        { gameId: 'g2', round: 1, table: 2 },
      ],
      unscheduled: [],
      roundDurationsMinutes: [90],
      totalDurationMinutes: 90,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed({ title: 'Game Night' }, games, result);
    const data = embed.toJSON();
    expect(data.fields).toHaveLength(1);
    expect(data.fields![0].name).toContain('Round 1');
    expect(data.fields![0].value).toContain('Wingspan');
    expect(data.fields![0].value).toContain('Catan');
  });

  it('lists unscheduled games with their reason', () => {
    const result = {
      assignments: [],
      unscheduled: [{ gameId: 'g1', reason: 'only 1/3 minimum players seated' }],
      roundDurationsMinutes: [],
      totalDurationMinutes: 0,
      fitsInWindow: true,
    };
    const embed = buildScheduleEmbed({ title: 'Game Night' }, games, result);
    const data = embed.toJSON();
    const unscheduledField = data.fields!.find((f) => f.name === 'Not scheduled');
    expect(unscheduledField?.value).toContain('Wingspan');
    expect(unscheduledField?.value).toContain('only 1/3 minimum players seated');
  });

  it('flags in the footer when the schedule does not fit the window', () => {
    const result = {
      assignments: [],
      unscheduled: [],
      roundDurationsMinutes: [],
      totalDurationMinutes: 300,
      fitsInWindow: false,
    };
    const embed = buildScheduleEmbed({ title: 'Game Night' }, [], result);
    expect(embed.toJSON().footer?.text).toContain('may run past');
  });
});

describe('lockAndScheduleEvent', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-lock-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGameNight(overrides: Partial<Record<string, unknown>> = {}) {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
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
      endTimeISO: end.toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeClient(sendMock = vi.fn(async () => {})) {
    const channel = { send: sendMock };
    const guild = {
      members: { fetch: vi.fn(async (id: string) => ({ displayName: `Display-${id}` })) },
    };
    return {
      channels: { fetch: vi.fn(async () => channel) },
      guilds: { fetch: vi.fn(async () => guild) },
      _channel: channel,
    };
  }

  const BUFFER_CONFIG = {
    scheduleTableCount: 2,
    lightBufferMinutes: 20,
    mediumBufferMinutes: 30,
    heavyBufferMinutes: 40,
    postBgStatsLinks: false,
  };

  it('marks the event locked and posts a schedule embed', async () => {
    const { upsertGameNight, findGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    const updated = await findGameNight('gn1');
    expect(updated?.suggestionsLocked).toBe(true);
    expect(updated?.scheduledAt).toBeDefined();
    expect(client._channel.send).toHaveBeenCalled();
  });

  it('persists scheduledRound/scheduledTable on each scheduled game', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame, findGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    const game = await findGame('game1');
    expect(game?.scheduledRound).toBe(1);
    expect(game?.scheduledTable).toBe(1);
  });

  it('posts a BG Stats button per scheduled game when postBgStatsLinks is enabled', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    // One call for the schedule-summary embed, one more per scheduled game.
    expect(client._channel.send).toHaveBeenCalledTimes(2);
    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    expect(button.label).toBe('Log in BG Stats');

    const data = JSON.parse(decodeURIComponent(button.url.split('?data=')[1]));
    expect(data.sourceName).toBe('Rulebook Rebels Discord Bot');
    expect(data.sourcePlayId).toBe('game1');
    expect(typeof data.playDate).toBe('string');
    expect(data.game.name).toBe('Wingspan');
    expect(data.location).toBe('The Rec Room');
    expect(data.players).toEqual([{ name: 'Display-p1', sourcePlayerId: 'p1' }]);

    // A QR code encoding the same URL is attached alongside the button.
    expect(bgStatsCall.files).toHaveLength(1);
    expect(bgStatsCall.files[0].toJSON().name).toBe('bgstats-game1.png');
  });

  // Regression: BG Stats' link grows with player count and Discord caps button
  // URLs at 512 chars. A real multi-player game crashed the whole post in
  // production (DiscordAPIError 50035) because the button was always included
  // regardless of URL length. The QR code has no such limit, so it must always
  // be attached even when the button is omitted.
  it('omits the button (but still attaches the QR code) for a game with enough players to exceed the Discord button URL limit', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight({ location: 'The Rec Room' });
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '266192', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 6, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1', 'p2', 'p3', 'p4', 'p5'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    expect(bgStatsCall.components).toEqual([]);
    expect(bgStatsCall.files).toHaveLength(1);
    expect(bgStatsCall.files[0].toJSON().name).toBe('bgstats-game1.png');
  });

  it('does not post BG Stats buttons when postBgStatsLinks is disabled (default)', async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, BUFFER_CONFIG);

    expect(client._channel.send).toHaveBeenCalledTimes(1);
  });

  it("uses a player's linked BGG username instead of their Discord display name when available", async () => {
    const { upsertGameNight } = await import('../src/utils/storage');
    const { upsertGame } = await import('../src/utils/gameStorage');
    const { setBggAccount } = await import('../src/utils/bggAccountStorage');
    const gn = makeGameNight();
    await upsertGameNight(gn as any);
    await upsertGame({
      id: 'game1', eventId: 'gn1', channelId: 'event-channel-1', messageId: 'm1', guildId: 'guild-1',
      bggId: '1', title: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 4, suggestedPlayers: null,
      minPlaytime: 40, maxPlaytime: 60, suggestedStartTime: null, expansions: [], seats: ['p1'], waitlist: [],
      createdAt: new Date().toISOString(), createdBy: 'p1', complexity: 'Light',
    } as any);
    await setBggAccount('guild-1', 'p1', 'sean_o');
    const client = makeClient();

    await lockAndScheduleEvent(client as any, gn as any, { ...BUFFER_CONFIG, postBgStatsLinks: true });

    const bgStatsCall = (client._channel.send as any).mock.calls[1][0];
    const button = bgStatsCall.components[0].toJSON().components[0];
    const data = JSON.parse(decodeURIComponent(button.url.split('?data=')[1]));
    expect(data.players).toEqual([{ name: 'sean_o', sourcePlayerId: 'p1' }]);
  });
});

describe('checkPendingSchedules', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-scheduler-check-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClient() {
    const channel = { send: vi.fn(async () => {}) };
    return { channels: { fetch: vi.fn(async () => channel) }, _channel: channel };
  }

  async function seedNight(hoursUntilStart: number, overrides: Partial<Record<string, unknown>> = {}) {
    const { upsertGameNight } = await import('../src/utils/storage');
    const start = new Date(Date.now() + hoursUntilStart * 60 * 60 * 1000);
    const gn = {
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
      endTimeISO: new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      rsvps: { yes: [], maybe: [], no: [] },
      createdBy: 'host-1',
      cancelled: false,
      archived: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    await upsertGameNight(gn as any);
    return gn;
  }

  it('locks an event once it crosses the configured lock threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    const { findGameNight } = await import('../src/utils/storage');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(20); // starts in 20h, threshold is 24h before -> already past lock time

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBe(true);
  });

  it('does not lock an event that has not yet reached the threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    const { findGameNight } = await import('../src/utils/storage');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(48); // starts in 48h, well before the 24h threshold

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBeFalsy();
  });

  it('does nothing when the lock feature is disabled (default)', async () => {
    const { findGameNight } = await import('../src/utils/storage');
    await seedNight(1); // starts very soon, would lock if enabled

    await checkPendingSchedules(makeClient() as any);

    const gn = await findGameNight('gn1');
    expect(gn?.suggestionsLocked).toBeFalsy();
  });

  it('skips a cancelled event even past the threshold', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(1, { cancelled: true });
    const client = makeClient();

    await checkPendingSchedules(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });

  it('does not re-lock/re-schedule an already-locked event', async () => {
    const { updateGuildConfig } = await import('../src/utils/config');
    await updateGuildConfig('guild-1', { lockHoursBeforeEvent: 24 });
    await seedNight(1, { suggestionsLocked: true });
    const client = makeClient();

    await checkPendingSchedules(client as any);

    expect(client._channel.send).not.toHaveBeenCalled();
  });
});
