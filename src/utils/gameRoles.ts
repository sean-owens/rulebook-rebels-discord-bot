import { readJson, writeJson } from './db';

const FILE = 'gameroles.json';

export interface GameRole {
  roleId: string;
  name: string;
  type?: 'genre' | 'difficulty';
  // False when this entry was linked to a pre-existing Discord role rather than
  // created by the bot (e.g. via /admin tags sync finding a same-named role).
  // Undefined/true means the bot created the role and owns its lifecycle —
  // only those roles should ever be deleted from Discord by /admin tags
  // remove or clear.
  botCreated?: boolean;
}

type Store = Record<string, GameRole[]>;

export async function getGameRoles(guildId: string): Promise<GameRole[]> {
  return (await readJson<Store>(FILE, {}))[guildId] ?? [];
}

export async function addGameRole(guildId: string, role: GameRole): Promise<void> {
  const store = await readJson<Store>(FILE, {});
  store[guildId] = [...(store[guildId] ?? []), role];
  await writeJson(FILE, store);
}

export async function removeGameRole(guildId: string, roleId: string): Promise<void> {
  const store = await readJson<Store>(FILE, {});
  store[guildId] = (store[guildId] ?? []).filter((r) => r.roleId !== roleId);
  await writeJson(FILE, store);
}

export async function clearGameRoles(guildId: string): Promise<GameRole[]> {
  const store = await readJson<Store>(FILE, {});
  const removed = store[guildId] ?? [];
  store[guildId] = [];
  await writeJson(FILE, store);
  return removed;
}
