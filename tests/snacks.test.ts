import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  execute,
  handleSnacksRemoveSelect,
  handleHubSnacksButton,
  handleHubSnacksAddButton,
  handleHubSnacksAddModal,
  handleHubSnacksRemoveButton,
  handleHubSnacksRemoveSelect,
  updateSnacksPin,
} from '../src/commands/snacks';
import { upsertGameNight, GameNight } from '../src/utils/storage';
import { upsertRoom, PrivateRoom } from '../src/utils/roomStorage';
import { findSnackListByChannel, addSnackItem, removeSnackItem } from '../src/utils/snackStorage';

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  return {
    id: overrides.id ?? 'event-1',
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

function makeChannelClient() {
  let nextId = 1;
  const sentMessages = new Map<string, { edit: ReturnType<typeof vi.fn>; pinned: boolean; pin: ReturnType<typeof vi.fn> }>();
  const send = vi.fn(async () => {
    const id = `msg-${nextId++}`;
    const msg = {
      id,
      pinned: false,
      pin: vi.fn(async () => {
        msg.pinned = true;
      }),
      edit: vi.fn(async () => {}),
    };
    sentMessages.set(id, msg as any);
    return msg;
  });
  const channel = {
    send,
    messages: { fetch: vi.fn(async (id: string) => sentMessages.get(id)) },
  };
  return {
    channels: { fetch: vi.fn(async () => channel) },
    guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async (id: string) => ({ displayName: `Display-${id}` })) } })) },
    users: { cache: { get: () => undefined } },
    _channel: channel,
    _sentMessages: sentMessages,
  };
}

function makeSlashInteraction(
  sub: string,
  channelId: string,
  userId: string,
  client: any,
  item?: string,
) {
  return {
    channelId,
    user: { id: userId },
    client,
    options: {
      getSubcommand: () => sub,
      getString: (name: string, _required?: boolean) => (name === 'item' ? (item ?? '') : null),
    },
    reply: vi.fn(async () => {}),
  } as any;
}

describe('/snacks', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-snacks-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('/snacks add', () => {
    it('adds a snack for an event channel and updates the pinned list', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('add', 'event-channel-1', 'user-1', client, 'Chips');

      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Added **Chips**') }),
      );
      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.items).toHaveLength(1);
      expect(list?.items[0]).toMatchObject({ userId: 'user-1', item: 'Chips' });
      expect(list?.eventId).toBe('event-1');
      expect(client._channel.send).toHaveBeenCalledTimes(1);
    });

    it('adds a snack for a private room, keyed with the room: prefix', async () => {
      await upsertRoom(makeRoom());
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('add', 'room-channel-1', 'user-1', client, 'Soda');

      await execute(interaction);

      const list = await findSnackListByChannel('room-channel-1');
      expect(list?.eventId).toBe('room:room1');
    });

    it('rejects a channel that matches neither an active event nor a room', async () => {
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('add', 'random-channel', 'user-1', client, 'Chips');

      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('event channel or a private room') }),
      );
      expect(await findSnackListByChannel('random-channel')).toBeUndefined();
    });

    it('ignores a cancelled event when resolving context', async () => {
      await upsertGameNight(makeGameNight({ cancelled: true }));
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('add', 'event-channel-1', 'user-1', client, 'Chips');

      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('event channel or a private room') }),
      );
    });

    it('appends multiple items from the same person rather than replacing', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await execute(makeSlashInteraction('add', 'event-channel-1', 'user-1', client, 'Chips'));
      await execute(makeSlashInteraction('add', 'event-channel-1', 'user-1', client, 'Soda'));

      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.items.map((i) => i.item)).toEqual(['Chips', 'Soda']);
    });
  });

  describe('/snacks list', () => {
    it('shows an ephemeral embed of the current list', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const interaction = makeSlashInteraction('list', 'event-channel-1', 'user-2', client);

      await execute(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.flags).toBeDefined();
      expect(reply.embeds[0].data.description).toContain('Chips');
    });

    it('shows a friendly empty state when nothing has been added', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('list', 'event-channel-1', 'user-1', client);

      await execute(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.embeds[0].data.description).toContain('No snacks have been added yet');
    });
  });

  describe('/snacks remove', () => {
    it('tells the user they have nothing to remove', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      const interaction = makeSlashInteraction('remove', 'event-channel-1', 'user-1', client);

      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("haven't added any snacks") }),
      );
    });

    it('removes a single item directly, with no select menu', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const interaction = makeSlashInteraction('remove', 'event-channel-1', 'user-1', client);

      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Removed **Chips**') }),
      );
      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.items).toHaveLength(0);
    });

    it('shows a select menu when the user has more than one item', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Soda');
      const interaction = makeSlashInteraction('remove', 'event-channel-1', 'user-1', client);

      await execute(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.components[0].components[0].data.custom_id).toBe('snacks_remove_select');
      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.items).toHaveLength(2); // nothing removed yet — still pending selection
    });

    it("only offers the caller's own items in the select menu, not someone else's", async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Soda');
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-2', 'Cookies');
      const interaction = makeSlashInteraction('remove', 'event-channel-1', 'user-1', client);

      await execute(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      const labels = reply.components[0].components[0].options.map((o: any) => o.data.label);
      expect(labels).toEqual(['Chips', 'Soda']);
    });
  });

  describe('handleSnacksRemoveSelect', () => {
    it('removes the chosen item and updates the pin', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const list = await findSnackListByChannel('event-channel-1');
      const itemId = list!.items[0].id;
      const interaction = {
        channelId: 'event-channel-1',
        user: { id: 'user-1' },
        client,
        values: [itemId],
        update: vi.fn(async () => {}),
      } as any;

      await handleSnacksRemoveSelect(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Removed **Chips**') }),
      );
      expect((await findSnackListByChannel('event-channel-1'))!.items).toHaveLength(0);
    });

    it("refuses to remove someone else's item", async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const list = await findSnackListByChannel('event-channel-1');
      const itemId = list!.items[0].id;
      const interaction = {
        channelId: 'event-channel-1',
        user: { id: 'user-2' },
        client,
        values: [itemId],
        update: vi.fn(async () => {}),
      } as any;

      await handleSnacksRemoveSelect(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("couldn't be found") }),
      );
      expect((await findSnackListByChannel('event-channel-1'))!.items).toHaveLength(1);
    });
  });

  describe('hub_snacks button flow', () => {
    function makeButtonInteraction(userId: string, channelId: string, client: any) {
      return {
        channelId,
        user: { id: userId },
        client,
        reply: vi.fn(async () => {}),
        showModal: vi.fn(async () => {}),
      } as any;
    }

    it('shows the current list with Remove Mine disabled when the caller has nothing added', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'event-channel-1', client);

      await handleHubSnacksButton(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      const removeButton = reply.components[0].components[1];
      expect(removeButton.data.custom_id).toBe('hub_snacks_remove');
      expect(removeButton.data.disabled).toBe(true);
    });

    it('enables Remove Mine once the caller has an item on the list', async () => {
      await upsertGameNight(makeGameNight());
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'event-channel-1', client);

      await handleHubSnacksButton(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.components[0].components[1].data.disabled).toBe(false);
    });

    it('rejects use outside an event/room channel', async () => {
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'random-channel', client);

      await handleHubSnacksButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('event channel or a private room') }),
      );
    });

    it('hub_snacks_add shows a modal', async () => {
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'event-channel-1', client);

      await handleHubSnacksAddButton(interaction);

      expect(interaction.showModal).toHaveBeenCalledTimes(1);
      expect(interaction.showModal.mock.calls[0][0].toJSON().custom_id).toBe('hub_snacks_add_modal');
    });

    it('hub_snacks_add_modal submission adds the item and updates the pin', async () => {
      await upsertGameNight(makeGameNight());
      const client = makeChannelClient();
      const interaction = {
        channelId: 'event-channel-1',
        user: { id: 'user-1' },
        client,
        fields: { getTextInputValue: () => 'Pretzels' },
        reply: vi.fn(async () => {}),
      } as any;

      await handleHubSnacksAddModal(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Added **Pretzels**') }),
      );
      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.items[0].item).toBe('Pretzels');
      expect(client._channel.send).toHaveBeenCalledTimes(1);
    });

    it('hub_snacks_remove removes directly when the caller has exactly one item', async () => {
      await upsertGameNight(makeGameNight());
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'event-channel-1', client);

      await handleHubSnacksRemoveButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Removed **Chips**') }),
      );
    });

    it('hub_snacks_remove shows a select menu when the caller has more than one item', async () => {
      await upsertGameNight(makeGameNight());
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Soda');
      const client = makeChannelClient();
      const interaction = makeButtonInteraction('user-1', 'event-channel-1', client);

      await handleHubSnacksRemoveButton(interaction);

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.components[0].components[0].data.custom_id).toBe('hub_snacks_remove_select');
    });

    it('handleHubSnacksRemoveSelect removes the chosen item', async () => {
      await upsertGameNight(makeGameNight());
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Soda');
      const list = await findSnackListByChannel('event-channel-1');
      const sodaId = list!.items.find((i) => i.item === 'Soda')!.id;
      const client = makeChannelClient();
      const interaction = {
        channelId: 'event-channel-1',
        user: { id: 'user-1' },
        client,
        values: [sodaId],
        update: vi.fn(async () => {}),
      } as any;

      await handleHubSnacksRemoveSelect(interaction);

      const updated = await findSnackListByChannel('event-channel-1');
      expect(updated?.items.map((i) => i.item)).toEqual(['Chips']);
    });
  });

  describe('updateSnacksPin', () => {
    it('does nothing when no list exists yet for the channel', async () => {
      const client = makeChannelClient();
      await updateSnacksPin(client as any, 'no-such-channel');
      expect(client._channel.send).not.toHaveBeenCalled();
    });

    it('creates and pins the list message on first update, then edits it on the next', async () => {
      await upsertGameNight(makeGameNight());
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Chips');
      const client = makeChannelClient();

      await updateSnacksPin(client as any, 'event-channel-1');
      await removeSnackItem('event-channel-1', (await findSnackListByChannel('event-channel-1'))!.items[0].id);
      await addSnackItem('event-channel-1', 'guild-1', 'event-1', 'user-1', 'Soda');
      await updateSnacksPin(client as any, 'event-channel-1');

      expect(client._channel.send).toHaveBeenCalledTimes(1);
      const msg = await client._channel.messages.fetch('msg-1');
      expect(msg.edit).toHaveBeenCalledTimes(1);
      const list = await findSnackListByChannel('event-channel-1');
      expect(list?.pinMessageId).toBe('msg-1');
    });
  });
});
