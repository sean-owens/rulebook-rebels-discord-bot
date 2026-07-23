import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';

const FILE = 'snacks.json';

export interface SnackItem {
  id: string;
  userId: string;
  item: string;
  createdAt: string;
}

export interface SnackList {
  channelId: string;
  guildId: string;
  // GameNight.id, or `room:<PrivateRoom.id>` — same convention games.json uses
  // (see ROOM_GAME_NIGHT_PREFIX in src/commands/game.ts) so a room's snack
  // list has a stable key distinct from an event's, without needing to touch
  // the GameNight/PrivateRoom interfaces themselves.
  eventId: string;
  items: SnackItem[];
  // Persistent "🍿 Snacks List" pin — mirrors updateGameListPin/updateRequestPin
  // in src/utils/requestPin.ts, created lazily on the first add rather than at
  // event/room creation time.
  pinMessageId?: string;
}

export async function loadSnackLists(): Promise<SnackList[]> {
  return readJson<SnackList[]>(FILE, []);
}

export async function saveSnackLists(lists: SnackList[]): Promise<void> {
  await writeJson(FILE, lists);
}

export async function findSnackListByChannel(channelId: string): Promise<SnackList | undefined> {
  return (await loadSnackLists()).find((l) => l.channelId === channelId);
}

export async function upsertSnackList(list: SnackList): Promise<void> {
  const lists = await loadSnackLists();
  const idx = lists.findIndex((l) => l.channelId === list.channelId);
  if (idx === -1) lists.push(list);
  else lists[idx] = list;
  await saveSnackLists(lists);
}

export async function addSnackItem(
  channelId: string,
  guildId: string,
  eventId: string,
  userId: string,
  item: string,
): Promise<SnackList> {
  const lists = await loadSnackLists();
  let list = lists.find((l) => l.channelId === channelId);
  const entry: SnackItem = { id: randomUUID().slice(0, 8), userId, item, createdAt: new Date().toISOString() };
  if (!list) {
    list = { channelId, guildId, eventId, items: [entry] };
    lists.push(list);
  } else {
    list.items.push(entry);
  }
  await saveSnackLists(lists);
  return list;
}

export async function removeSnackItem(channelId: string, itemId: string): Promise<SnackList | undefined> {
  const lists = await loadSnackLists();
  const list = lists.find((l) => l.channelId === channelId);
  if (!list) return undefined;
  list.items = list.items.filter((i) => i.id !== itemId);
  await saveSnackLists(lists);
  return list;
}
