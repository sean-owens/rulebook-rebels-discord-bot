import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { groupSnacksByUser, buildSnackReminderMessage, sendSnackReminders } from '../src/utils/snackReminders';
import { addSnackItem, SnackList } from '../src/utils/snackStorage';

const list = (items: [string, string][]): SnackList => ({
  channelId: 'c1',
  guildId: 'g1',
  eventId: 'gn1',
  items: items.map(([userId, item], i) => ({ id: String(i), userId, item, createdAt: '' })),
});

describe('groupSnacksByUser', () => {
  it('groups each member\'s items in the order they were added', () => {
    const grouped = groupSnacksByUser(list([['a', 'Chips'], ['b', 'Soda'], ['a', 'Dip']]), []);
    expect([...grouped.entries()]).toEqual([
      ['a', ['Chips', 'Dip']],
      ['b', ['Soda']],
    ]);
  });

  it('leaves out members who RSVP\'d no', () => {
    const grouped = groupSnacksByUser(list([['a', 'Chips'], ['b', 'Soda']]), ['b']);
    expect([...grouped.keys()]).toEqual(['a']);
  });

  it('is empty for an empty list', () => {
    expect(groupSnacksByUser(list([]), []).size).toBe(0);
  });
});

describe('buildSnackReminderMessage', () => {
  it('names the event, links its channel, and bullets each snack', () => {
    const msg = buildSnackReminderMessage({ title: 'Game Night', date: 'Aug 22', eventChannelId: 'c1' }, ['Chips', 'Soda']);
    expect(msg).toContain('Game Night');
    expect(msg).toContain('Aug 22');
    expect(msg).toContain('<#c1>');
    expect(msg).toContain('• Chips\n• Soda');
    expect(msg).toContain('/snacks remove');
  });

  it('falls back gracefully without a title or channel', () => {
    const msg = buildSnackReminderMessage({ title: undefined, date: 'Aug 22', eventChannelId: undefined }, ['Chips']);
    expect(msg).toContain('the event');
    expect(msg).not.toContain('<#');
  });
});

describe('sendSnackReminders', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-snack-reminder-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const gn = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'gn1', title: 'Game Night', date: 'Aug 22', eventChannelId: 'c1',
      rsvps: { yes: [], maybe: [], no: [] }, ...overrides,
    }) as any;

  function makeClient(failFor: string[] = []) {
    const sent: { userId: string; content: string }[] = [];
    const client = {
      users: {
        fetch: vi.fn(async (userId: string) => ({
          send: vi.fn(async (content: string) => {
            if (failFor.includes(userId)) throw new Error('Cannot send messages to this user');
            sent.push({ userId, content });
          }),
        })),
      },
    } as any;
    return { client, sent };
  }

  it('sends one DM per member with only their own snacks', async () => {
    await addSnackItem('c1', 'g1', 'gn1', 'alice', 'Chips');
    await addSnackItem('c1', 'g1', 'gn1', 'bob', 'Soda');
    await addSnackItem('c1', 'g1', 'gn1', 'alice', 'Dip');
    const { client, sent } = makeClient();

    expect(await sendSnackReminders(client, gn())).toBe(2);

    const alice = sent.find((s) => s.userId === 'alice')!;
    expect(alice.content).toContain('Chips');
    expect(alice.content).toContain('Dip');
    expect(alice.content).not.toContain('Soda');
    expect(sent.find((s) => s.userId === 'bob')!.content).not.toContain('Chips');
  });

  it('skips members who RSVP\'d no', async () => {
    await addSnackItem('c1', 'g1', 'gn1', 'alice', 'Chips');
    await addSnackItem('c1', 'g1', 'gn1', 'bob', 'Soda');
    const { client, sent } = makeClient();

    await sendSnackReminders(client, gn({ rsvps: { yes: ['alice'], maybe: [], no: ['bob'] } }));

    expect(sent.map((s) => s.userId)).toEqual(['alice']);
  });

  it('keeps going when one member has DMs disabled', async () => {
    await addSnackItem('c1', 'g1', 'gn1', 'alice', 'Chips');
    await addSnackItem('c1', 'g1', 'gn1', 'bob', 'Soda');
    const { client, sent } = makeClient(['alice']);

    expect(await sendSnackReminders(client, gn())).toBe(1);
    expect(sent.map((s) => s.userId)).toEqual(['bob']);
  });

  it('does nothing when there is no snack list, or the event has no channel', async () => {
    const { client } = makeClient();
    expect(await sendSnackReminders(client, gn())).toBe(0);
    expect(await sendSnackReminders(client, gn({ eventChannelId: undefined }))).toBe(0);
    expect(client.users.fetch).not.toHaveBeenCalled();
  });
});
