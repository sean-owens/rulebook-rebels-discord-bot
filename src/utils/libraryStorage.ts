import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';
import { GENRE_TAG_DEFINITIONS } from './tagDefinitions';
import { matchesFuzzy } from './bggCatalog';

const LIBRARY_FILE = 'library.json';
const REQUESTS_FILE = 'library_requests.json';
const GAME_INFO_FILE = 'game_info.json';

export interface LibraryEntry {
  guildId: string;
  userId: string;
  gameName: string;
  objectid?: string;
  isExpansion?: boolean;
  addedAt: string;
}

export interface GameRequest {
  id: string;
  eventId: string;
  gameName: string;
  requestedBy: string;
  createdAt: string;
  copiesNeeded?: number;
  confirmedBy?: string;
  preferredOwnerId?: string;
}

export async function loadLibrary(): Promise<LibraryEntry[]> {
  return readJson<LibraryEntry[]>(LIBRARY_FILE, []);
}

async function saveLibrary(entries: LibraryEntry[]): Promise<void> {
  await writeJson(LIBRARY_FILE, entries);
}

export async function loadLibraryForGuild(guildId: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter((e) => e.guildId === guildId);
}

export async function addGame(
  guildId: string,
  userId: string,
  gameName: string,
  objectid?: string,
  isExpansion?: boolean,
): Promise<'added' | 'duplicate'> {
  const entries = await loadLibrary();
  const exists = entries.some((e) => {
    if (e.guildId !== guildId || e.userId !== userId) return false;
    if (objectid && e.objectid === objectid) return true;
    return e.gameName.toLowerCase() === gameName.toLowerCase();
  });
  if (exists) return 'duplicate';
  const entry: LibraryEntry = { guildId, userId, gameName, addedAt: new Date().toISOString() };
  if (objectid) entry.objectid = objectid;
  if (isExpansion) entry.isExpansion = true;
  entries.push(entry);
  await saveLibrary(entries);
  return 'added';
}

// Bulk variant of addGame — does a single read + single write regardless of
// how many games are added, instead of one round trip per game. Use this
// whenever adding more than one game at a time (BGG/CSV imports).
export async function addGamesBulk(
  guildId: string,
  userId: string,
  games: Array<{ gameName: string; objectid?: string; isExpansion?: boolean }>,
): Promise<('added' | 'duplicate')[]> {
  const entries = await loadLibrary();
  const results: ('added' | 'duplicate')[] = [];
  for (const g of games) {
    const exists = entries.some((e) => {
      if (e.guildId !== guildId || e.userId !== userId) return false;
      if (g.objectid && e.objectid === g.objectid) return true;
      return e.gameName.toLowerCase() === g.gameName.toLowerCase();
    });
    if (exists) {
      results.push('duplicate');
      continue;
    }
    const entry: LibraryEntry = { guildId, userId, gameName: g.gameName, addedAt: new Date().toISOString() };
    if (g.objectid) entry.objectid = g.objectid;
    if (g.isExpansion) entry.isExpansion = true;
    entries.push(entry);
    results.push('added');
  }
  await saveLibrary(entries);
  return results;
}

export async function findGamesByName(guildId: string, gameName: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter(
    (e) => e.guildId === guildId && e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
}

export async function findGameNamesByPartial(guildId: string, term: string): Promise<string[]> {
  if (!term.trim()) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const e of (await loadLibrary()).filter((e) => e.guildId === guildId)) {
    const key = e.gameName.toLowerCase();
    if (matchesFuzzy(term, e.gameName) && !seen.has(key)) {
      seen.add(key);
      names.push(e.gameName);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function clearUserLibrary(guildId: string, userId: string): Promise<number> {
  const entries = await loadLibrary();
  const remaining = entries.filter((e) => !(e.guildId === guildId && e.userId === userId));
  await saveLibrary(remaining);
  return entries.length - remaining.length;
}

export async function removeGame(
  guildId: string,
  userId: string,
  gameName: string,
): Promise<'removed' | 'not_found'> {
  const entries = await loadLibrary();
  const idx = entries.findIndex(
    (e) =>
      e.guildId === guildId &&
      e.userId === userId &&
      e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx === -1) return 'not_found';
  entries.splice(idx, 1);
  await saveLibrary(entries);
  return 'removed';
}

export async function getGamesByUser(guildId: string, userId: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter((e) => e.guildId === guildId && e.userId === userId);
}

export async function loadRequests(): Promise<GameRequest[]> {
  return readJson<GameRequest[]>(REQUESTS_FILE, []);
}

async function saveRequests(requests: GameRequest[]): Promise<void> {
  await writeJson(REQUESTS_FILE, requests);
}

export async function addRequest(
  eventId: string,
  gameName: string,
  requestedBy: string,
  preferredOwnerId?: string,
): Promise<'added' | 'duplicate'> {
  const requests = await loadRequests();
  const exists = requests.some(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (exists) return 'duplicate';
  const req: GameRequest = {
    id: randomUUID(),
    eventId,
    gameName,
    requestedBy,
    createdAt: new Date().toISOString(),
  };
  if (preferredOwnerId) req.preferredOwnerId = preferredOwnerId;
  requests.push(req);
  await saveRequests(requests);
  return 'added';
}

export async function getRequestsForEvent(eventId: string): Promise<GameRequest[]> {
  return (await loadRequests()).filter((r) => r.eventId === eventId);
}

export async function removeRequests(requestIds: string[]): Promise<number> {
  const requests = await loadRequests();
  const remaining = requests.filter((r) => !requestIds.includes(r.id));
  await saveRequests(remaining);
  return requests.length - remaining.length;
}

export async function removeAllRequestsForEvent(
  eventId: string,
  userId?: string,
): Promise<number> {
  const requests = await loadRequests();
  const remaining = requests.filter((r) => {
    if (r.eventId !== eventId) return true;
    if (userId) return r.requestedBy !== userId;
    return false;
  });
  await saveRequests(remaining);
  return requests.length - remaining.length;
}

export async function updateRequestCopies(
  eventId: string,
  gameName: string,
  copies: number,
): Promise<void> {
  const requests = await loadRequests();
  const idx = requests.findIndex(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx >= 0) {
    requests[idx].copiesNeeded = copies;
    await saveRequests(requests);
  }
}

export async function confirmBring(
  guildId: string,
  eventId: string,
  gameName: string,
  userId: string,
): Promise<'confirmed' | 'not_requested' | 'not_owner'> {
  const requests = await loadRequests();
  const idx = requests.findIndex(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx === -1) return 'not_requested';

  const owns = (await loadLibrary()).some(
    (e) =>
      e.guildId === guildId &&
      e.userId === userId &&
      e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (!owns) return 'not_owner';

  requests[idx].confirmedBy = userId;
  await saveRequests(requests);
  return 'confirmed';
}

export type GameTag = (typeof GENRE_TAG_DEFINITIONS)[number]['name'];
export const GAME_TAGS: readonly GameTag[] = GENRE_TAG_DEFINITIONS.map((t) => t.name);

export type Complexity = 'Light' | 'Medium' | 'Heavy';

export interface GameInfo {
  gameName: string;
  objectid?: string;
  minPlayers?: number;
  maxPlayers?: number;
  bestPlayers?: number; // BGG community "best at" player count
  playTime?: number;
  weight?: number; // BGG average weight (1–5 complexity scale)
  complexity?: Complexity | null; // null = checked BGG, no weight data found
  tags?: string[];
  expansions?: string[]; // owner-noted expansions they personally own
  bggExpansions?: string[]; // full expansion list from BGG
  howToPlayUrl?: string | null; // null = checked BGG, no instructional video found
  thumbnail?: string | null;
  updatedAt: string;
}

export async function loadGameInfos(): Promise<GameInfo[]> {
  return readJson<GameInfo[]>(GAME_INFO_FILE, []);
}

async function saveGameInfos(infos: GameInfo[]): Promise<void> {
  await writeJson(GAME_INFO_FILE, infos);
}

export async function getGameInfo(gameName: string): Promise<GameInfo | undefined> {
  return (await loadGameInfos()).find((i) => i.gameName.toLowerCase() === gameName.toLowerCase());
}

export async function upsertGameInfo(info: GameInfo): Promise<void> {
  const infos = await loadGameInfos();
  const idx = infos.findIndex((i) => i.gameName.toLowerCase() === info.gameName.toLowerCase());
  if (idx >= 0) infos[idx] = info;
  else infos.push(info);
  await saveGameInfos(infos);
}

// Bulk variant of upsertGameInfo — does a single read + single write for the
// whole batch instead of one round trip per game. Use this when upserting
// more than one GameInfo at a time (BGG/CSV imports).
export async function upsertGameInfosBulk(updates: GameInfo[]): Promise<void> {
  if (updates.length === 0) return;
  const infos = await loadGameInfos();
  for (const info of updates) {
    const idx = infos.findIndex((i) => i.gameName.toLowerCase() === info.gameName.toLowerCase());
    if (idx >= 0) infos[idx] = info;
    else infos.push(info);
  }
  await saveGameInfos(infos);
}
