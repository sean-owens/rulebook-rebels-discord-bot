import { readJson, writeJson } from './db';

const FILE = 'privateRooms.json';

export interface PrivateRoom {
  id: string;
  guildId: string;
  channelId: string;
  name: string;
  createdBy: string;
  invitedUserIds: string[];
  createdAt: string;
  expiresAt: string;
}

export async function loadRooms(): Promise<PrivateRoom[]> {
  return readJson<PrivateRoom[]>(FILE, []);
}

export async function findRoomByChannel(channelId: string): Promise<PrivateRoom | undefined> {
  return (await loadRooms()).find((r) => r.channelId === channelId);
}

export async function upsertRoom(room: PrivateRoom): Promise<void> {
  const rooms = await loadRooms();
  const idx = rooms.findIndex((r) => r.id === room.id);
  if (idx === -1) rooms.push(room);
  else rooms[idx] = room;
  await writeJson(FILE, rooms);
}

export async function removeRoom(id: string): Promise<void> {
  const rooms = await loadRooms();
  await writeJson(
    FILE,
    rooms.filter((r) => r.id !== id),
  );
}
