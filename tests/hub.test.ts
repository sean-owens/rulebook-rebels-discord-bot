import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execute } from '../src/commands/hub';
import { upsertGameNight, GameNight } from '../src/utils/storage';
import { upsertRoom, PrivateRoom } from '../src/utils/roomStorage';
import { updateGuildConfig } from '../src/utils/config';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  return {
    id: overrides.id ?? 'gn1',
    title: 'Game Night',
    date: 'Someday',
    time: 'Sometime',
    location: 'TBD',
    link: '',
    description: '',
    messageId: 'm1',
    channelId: 'announcements',
    guildId: 'guild-1',
    discordEventId: null,
    eventChannelId: 'event-channel-1',
    startTimeISO: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endTimeISO: null,
    rsvps: { yes: [], maybe: [], no: [] },
    createdBy: 'host1',
    cancelled: false,
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRoom(overrides: Partial<PrivateRoom> = {}): PrivateRoom {
  return {
    id: overrides.id ?? 'room1',
    guildId: 'guild-1',
    channelId: overrides.channelId ?? 'room-channel-1',
    name: 'Test Room',
    createdBy: 'u1',
    invitedUserIds: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInteraction(channelId: string, guildId = 'guild-1') {
  return {
    channelId,
    guildId,
    reply: vi.fn(async () => {}),
  } as any;
}

describe('/hub', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-hub-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replies with the room hub when run inside a private room', async () => {
    await upsertRoom(makeRoom({ channelId: 'room-channel-1' }));
    const interaction = makeInteraction('room-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.flags).toBeDefined();
    expect(reply.embeds[0].toJSON().title).toContain('Quick Actions');
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_room_invite');
  });

  it('replies with the event hub when run inside an active event channel', async () => {
    await upsertGameNight(makeGameNight({ eventChannelId: 'event-channel-1' }));
    const interaction = makeInteraction('event-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_request');
    expect(customIds).toContain('hub_bring');
  });

  it('ignores a cancelled event when matching the event hub', async () => {
    await upsertGameNight(makeGameNight({ eventChannelId: 'event-channel-1', cancelled: true }));
    const interaction = makeInteraction('event-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toContain("no Quick Actions hub for this channel");
  });

  it('ignores an archived event when matching the event hub', async () => {
    await upsertGameNight(makeGameNight({ eventChannelId: 'event-channel-1', archived: true }));
    const interaction = makeInteraction('event-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain("no Quick Actions hub for this channel");
  });

  it('replies with the marketplace hub when run inside the configured hub thread', async () => {
    await updateGuildConfig('guild-1', { marketplaceHubThreadId: 'mp-thread-1' });
    const interaction = makeInteraction('mp-thread-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_mp_sell');
    expect(customIds).toContain('hub_mp_trade');
  });

  it('replies with the general hub when run inside the configured general-chat channel', async () => {
    await updateGuildConfig('guild-1', { generalHubChannelId: 'general-channel-1' });
    const interaction = makeInteraction('general-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_general_browse');
    expect(customIds).toContain('hub_general_view');
  });

  it('replies with a graceful ephemeral message when the channel matches no hub', async () => {
    const interaction = makeInteraction('some-random-channel');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.flags).toBeDefined();
    expect(reply.content).toBe(
      "There's no Quick Actions hub for this channel — try this in an event channel, a private room, the marketplace, general chat, or the board game challenge channel.",
    );
  });

  it('replies with the challenge hub when run inside the configured, enabled challenge channel', async () => {
    await updateGuildConfig('guild-1', {
      boardGameChallengeEnabled: true,
      boardGameChallengeChannelId: 'challenge-channel-1',
    });
    const interaction = makeInteraction('challenge-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_challenge_status');
    expect(customIds).toContain('hub_challenge_leaderboard');
  });

  it('does not match the challenge channel when the feature is configured but disabled', async () => {
    await updateGuildConfig('guild-1', {
      boardGameChallengeEnabled: false,
      boardGameChallengeChannelId: 'challenge-channel-1',
    });
    const interaction = makeInteraction('challenge-channel-1');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toContain("no Quick Actions hub for this channel");
  });

  it('prefers the room hub over the event hub when a channel somehow matches both', async () => {
    await upsertRoom(makeRoom({ channelId: 'shared-channel' }));
    await upsertGameNight(makeGameNight({ eventChannelId: 'shared-channel' }));
    const interaction = makeInteraction('shared-channel');

    await execute(interaction);

    const reply = interaction.reply.mock.calls[0][0];
    const customIds = reply.components[0].components.map((c: any) => c.toJSON().custom_id);
    expect(customIds).toContain('hub_room_kick');
  });
});
