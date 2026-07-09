import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRooms, findRoomByChannel, upsertRoom, removeRoom, PrivateRoom } from '../src/utils/roomStorage';

function makeRoom(overrides: Partial<PrivateRoom> = {}): PrivateRoom {
  return {
    id: overrides.id ?? 'room1',
    guildId: overrides.guildId ?? 'g1',
    channelId: overrides.channelId ?? 'c1',
    name: overrides.name ?? 'test-room',
    createdBy: overrides.createdBy ?? 'u1',
    invitedUserIds: overrides.invitedUserIds ?? ['u2', 'u3'],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe('roomStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-roomstorage-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when no rooms exist', async () => {
    expect(await loadRooms()).toEqual([]);
  });

  it('creates a new room via upsertRoom', async () => {
    await upsertRoom(makeRoom());
    const rooms = await loadRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].id).toBe('room1');
  });

  it('updates an existing room in place rather than duplicating it', async () => {
    await upsertRoom(makeRoom({ name: 'original' }));
    await upsertRoom(makeRoom({ name: 'renamed' }));
    const rooms = await loadRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe('renamed');
  });

  it('finds a room by its channel id', async () => {
    await upsertRoom(makeRoom({ id: 'room1', channelId: 'c1' }));
    await upsertRoom(makeRoom({ id: 'room2', channelId: 'c2' }));
    const found = await findRoomByChannel('c2');
    expect(found?.id).toBe('room2');
  });

  it('returns undefined when no room matches the channel id', async () => {
    expect(await findRoomByChannel('nope')).toBeUndefined();
  });

  it('removes a room by id', async () => {
    await upsertRoom(makeRoom({ id: 'room1' }));
    await upsertRoom(makeRoom({ id: 'room2', channelId: 'c2' }));
    await removeRoom('room1');
    const rooms = await loadRooms();
    expect(rooms.map((r) => r.id)).toEqual(['room2']);
  });
});
