import { readJson, writeJson } from './db';

const FILE = 'user_collections.json';

export interface UserCollectionEntry {
  bggGameId: string;
  gameName: string;

  // BGG-sourced — refreshed on re-sync, never manually edited
  bggOwn: boolean;
  bggForTrade: boolean;
  bggWantToPlay: boolean;
  bggWishlisted: boolean;
  bggUserRating: number | null;
  bggNumPlays: number;
  bggSyncedAt: string;

  // Bot-tracked — set by bot commands, never overwritten by BGG re-sync
  traded?: boolean;
  sold?: boolean;
}

type Store = Record<string, Record<string, UserCollectionEntry[]>>;

function load(): Promise<Store> {
  return readJson<Store>(FILE, {});
}

function save(store: Store): Promise<void> {
  return writeJson(FILE, store);
}

export async function getUserCollection(
  guildId: string,
  userId: string,
): Promise<UserCollectionEntry[]> {
  return (await load())[guildId]?.[userId] ?? [];
}

export async function setUserCollection(
  guildId: string,
  userId: string,
  entries: UserCollectionEntry[],
): Promise<void> {
  const store = await load();
  (store[guildId] ??= {})[userId] = entries;
  await save(store);
}

export async function mergeUserCollection(
  guildId: string,
  userId: string,
  incoming: UserCollectionEntry[],
): Promise<void> {
  const existing = await getUserCollection(guildId, userId);
  const existingById = new Map(existing.map((e) => [e.bggGameId, e]));

  const merged = incoming.map((entry) => {
    const prev = existingById.get(entry.bggGameId);
    if (!prev) return entry;
    // Preserve bot-tracked fields; refresh all BGG-sourced fields
    return {
      ...entry,
      traded: prev.traded,
      sold: prev.sold,
    };
  });

  await setUserCollection(guildId, userId, merged);
}

export async function updateCollectionEntry(
  guildId: string,
  userId: string,
  bggGameId: string,
  updates: Partial<Pick<UserCollectionEntry, 'traded' | 'sold'>>,
): Promise<boolean> {
  const store = await load();
  const entries = store[guildId]?.[userId];
  if (!entries) return false;
  const idx = entries.findIndex((e) => e.bggGameId === bggGameId);
  if (idx === -1) return false;
  entries[idx] = { ...entries[idx], ...updates };
  await save(store);
  return true;
}
