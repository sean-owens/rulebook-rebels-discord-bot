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

function load(): Store {
  return readJson<Store>(FILE, {});
}

function save(store: Store): void {
  writeJson(FILE, store);
}

export function getUserCollection(guildId: string, userId: string): UserCollectionEntry[] {
  return load()[guildId]?.[userId] ?? [];
}

export function setUserCollection(
  guildId: string,
  userId: string,
  entries: UserCollectionEntry[],
): void {
  const store = load();
  (store[guildId] ??= {})[userId] = entries;
  save(store);
}

export function mergeUserCollection(
  guildId: string,
  userId: string,
  incoming: UserCollectionEntry[],
): void {
  const existing = getUserCollection(guildId, userId);
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

  setUserCollection(guildId, userId, merged);
}

export function updateCollectionEntry(
  guildId: string,
  userId: string,
  bggGameId: string,
  updates: Partial<Pick<UserCollectionEntry, 'traded' | 'sold'>>,
): boolean {
  const store = load();
  const entries = store[guildId]?.[userId];
  if (!entries) return false;
  const idx = entries.findIndex((e) => e.bggGameId === bggGameId);
  if (idx === -1) return false;
  entries[idx] = { ...entries[idx], ...updates };
  save(store);
  return true;
}
