import { readJson, writeJson } from './db';

const FILE = 'library_links.json';

// Directional: delegateId can view/request/bring ownerId's library as if they
// owned it too. There's no consent step needed since a link only ever grants
// access to the *grantor's own* collection — for two people to fully share
// with each other, each runs /library link naming the other once.
export interface LibraryLink {
  guildId: string;
  ownerId: string;
  delegateId: string;
  linkedAt: string;
}

type Store = Record<string, LibraryLink[]>;

export async function getLibraryLinksForGuild(guildId: string): Promise<LibraryLink[]> {
  return (await readJson<Store>(FILE, {}))[guildId] ?? [];
}

export async function addLibraryLink(
  guildId: string,
  ownerId: string,
  delegateId: string,
): Promise<void> {
  const store = await readJson<Store>(FILE, {});
  const links = store[guildId] ?? [];
  const alreadyLinked = links.some((l) => l.ownerId === ownerId && l.delegateId === delegateId);
  if (!alreadyLinked) {
    links.push({ guildId, ownerId, delegateId, linkedAt: new Date().toISOString() });
  }
  store[guildId] = links;
  await writeJson(FILE, store);
}

/** Removes every link between the two users, regardless of which direction(s) exist. */
export async function removeLibraryLink(
  guildId: string,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const store = await readJson<Store>(FILE, {});
  const links = store[guildId] ?? [];
  const before = links.length;
  store[guildId] = links.filter((l) => {
    const matches =
      (l.ownerId === userId && l.delegateId === otherUserId) ||
      (l.ownerId === otherUserId && l.delegateId === userId);
    return !matches;
  });
  await writeJson(FILE, store);
  return store[guildId].length < before;
}

/**
 * Every userId whose library `userId` should be treated as an owner of —
 * their own, plus anyone who's linked `userId` as a delegate. Always
 * includes `userId` itself, deduped.
 */
export async function getEffectiveOwnerIds(guildId: string, userId: string): Promise<string[]> {
  const links = await getLibraryLinksForGuild(guildId);
  const delegatedTo = links.filter((l) => l.delegateId === userId).map((l) => l.ownerId);
  return [...new Set([userId, ...delegatedTo])];
}
