import { readJson, writeJson } from './db';

const FILE = 'bgg_accounts.json';

export interface BggAccount {
  userId: string;
  bggUsername: string;
  linkedAt: string;
  // Last time this account's collection was successfully pulled into the library —
  // by /library import bgg or the automatic re-sync (see bggAutoSync.ts). Drives
  // when the next automatic sync is due.
  lastSyncedAt?: string;
  // Last time a sync was attempted, successful or not. Lets a failing account be
  // retried after a short back-off instead of every hour, or never.
  lastSyncAttemptAt?: string;
}

type Store = Record<string, BggAccount[]>;

export async function getBggAccount(
  guildId: string,
  userId: string,
): Promise<BggAccount | undefined> {
  return (await readJson<Store>(FILE, {}))[guildId]?.find((a) => a.userId === userId);
}

export async function listAllBggAccounts(): Promise<Array<BggAccount & { guildId: string }>> {
  const store = await readJson<Store>(FILE, {});
  return Object.entries(store).flatMap(([guildId, accounts]) => accounts.map((a) => ({ ...a, guildId })));
}

// Stamps the outcome of a sync attempt. A failed attempt only moves
// lastSyncAttemptAt, so the account stays "due" and is retried after the back-off.
export async function recordBggSyncAttempt(
  guildId: string,
  userId: string,
  outcome: { at: string; success: boolean },
): Promise<void> {
  const store = await readJson<Store>(FILE, {});
  const account = store[guildId]?.find((a) => a.userId === userId);
  if (!account) return;
  account.lastSyncAttemptAt = outcome.at;
  if (outcome.success) account.lastSyncedAt = outcome.at;
  await writeJson(FILE, store);
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
