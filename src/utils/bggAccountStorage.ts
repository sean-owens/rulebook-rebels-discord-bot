import { readJson, writeJson } from './db';

const FILE = 'bgg_accounts.json';

export interface BggAccount {
  userId: string;
  bggUsername: string;
  linkedAt: string;
}

type Store = Record<string, BggAccount[]>;

export function getBggAccount(guildId: string, userId: string): BggAccount | undefined {
  return readJson<Store>(FILE, {})[guildId]?.find((a) => a.userId === userId);
}

export function setBggAccount(guildId: string, userId: string, bggUsername: string): void {
  const store = readJson<Store>(FILE, {});
  const accounts = (store[guildId] ?? []).filter((a) => a.userId !== userId);
  accounts.push({ userId, bggUsername, linkedAt: new Date().toISOString() });
  store[guildId] = accounts;
  writeJson(FILE, store);
}

export function removeBggAccount(guildId: string, userId: string): boolean {
  const store = readJson<Store>(FILE, {});
  const before = (store[guildId] ?? []).length;
  store[guildId] = (store[guildId] ?? []).filter((a) => a.userId !== userId);
  writeJson(FILE, store);
  return store[guildId].length < before;
}
