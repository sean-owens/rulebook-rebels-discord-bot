import { readJson, writeJson } from './db';

const FILE = 'bgg_accounts.json';

export interface BggAccount {
  userId: string;
  bggUsername: string;
  linkedAt: string;
}

type Store = Record<string, BggAccount[]>;

export async function getBggAccount(
  guildId: string,
  userId: string,
): Promise<BggAccount | undefined> {
  return (await readJson<Store>(FILE, {}))[guildId]?.find((a) => a.userId === userId);
}

export async function setBggAccount(
  guildId: string,
  userId: string,
  bggUsername: string,
): Promise<void> {
  const store = await readJson<Store>(FILE, {});
  const accounts = (store[guildId] ?? []).filter((a) => a.userId !== userId);
  accounts.push({ userId, bggUsername, linkedAt: new Date().toISOString() });
  store[guildId] = accounts;
  await writeJson(FILE, store);
}

export async function removeBggAccount(guildId: string, userId: string): Promise<boolean> {
  const store = await readJson<Store>(FILE, {});
  const before = (store[guildId] ?? []).length;
  store[guildId] = (store[guildId] ?? []).filter((a) => a.userId !== userId);
  await writeJson(FILE, store);
  return store[guildId].length < before;
}
