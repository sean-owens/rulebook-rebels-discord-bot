import { readJson, writeJson } from './db';

const FILE = 'gameroles.json';

export interface GameRole {
  roleId: string;
  name: string;
  type?: 'genre' | 'difficulty';
}

type Store = Record<string, GameRole[]>;

export function getGameRoles(guildId: string): GameRole[] {
  return readJson<Store>(FILE, {})[guildId] ?? [];
}

export function addGameRole(guildId: string, role: GameRole): void {
  const store = readJson<Store>(FILE, {});
  store[guildId] = [...(store[guildId] ?? []), role];
  writeJson(FILE, store);
}

export function removeGameRole(guildId: string, roleId: string): void {
  const store = readJson<Store>(FILE, {});
  store[guildId] = (store[guildId] ?? []).filter(r => r.roleId !== roleId);
  writeJson(FILE, store);
}

export function clearGameRoles(guildId: string): GameRole[] {
  const store = readJson<Store>(FILE, {});
  const removed = store[guildId] ?? [];
  store[guildId] = [];
  writeJson(FILE, store);
  return removed;
}
