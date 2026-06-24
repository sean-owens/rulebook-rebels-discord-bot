import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';

const LIBRARY_FILE = 'library.json';
const REQUESTS_FILE = 'library_requests.json';
const GAME_INFO_FILE = 'game_info.json';

export interface LibraryEntry {
  userId: string;
  gameName: string;
  objectid?: string;
  addedAt: string;
}

export interface GameRequest {
  id: string;
  eventId: string;
  gameName: string;
  requestedBy: string;
  createdAt: string;
  copiesNeeded?: number;
}

export function loadLibrary(): LibraryEntry[] {
  return readJson<LibraryEntry[]>(LIBRARY_FILE, []);
}

function saveLibrary(entries: LibraryEntry[]): void {
  writeJson(LIBRARY_FILE, entries);
}

export function addGame(userId: string, gameName: string, objectid?: string): 'added' | 'duplicate' {
  const entries = loadLibrary();
  const exists = entries.some(e => {
    if (e.userId !== userId) return false;
    if (objectid && e.objectid === objectid) return true;
    return e.gameName.toLowerCase() === gameName.toLowerCase();
  });
  if (exists) return 'duplicate';
  const entry: LibraryEntry = { userId, gameName, addedAt: new Date().toISOString() };
  if (objectid) entry.objectid = objectid;
  entries.push(entry);
  saveLibrary(entries);
  return 'added';
}

export function findGamesByName(gameName: string): LibraryEntry[] {
  return loadLibrary().filter(e => e.gameName.toLowerCase() === gameName.toLowerCase());
}

export function findGameNamesByPartial(term: string): string[] {
  const lower = term.toLowerCase();
  const seen = new Set<string>();
  const names: string[] = [];
  for (const e of loadLibrary()) {
    const key = e.gameName.toLowerCase();
    if (key.includes(lower) && !seen.has(key)) {
      seen.add(key);
      names.push(e.gameName);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export function clearUserLibrary(userId: string): number {
  const entries = loadLibrary();
  const remaining = entries.filter(e => e.userId !== userId);
  saveLibrary(remaining);
  return entries.length - remaining.length;
}

export function removeGame(userId: string, gameName: string): 'removed' | 'not_found' {
  const entries = loadLibrary();
  const idx = entries.findIndex(
    e => e.userId === userId && e.gameName.toLowerCase() === gameName.toLowerCase()
  );
  if (idx === -1) return 'not_found';
  entries.splice(idx, 1);
  saveLibrary(entries);
  return 'removed';
}

export function getGamesByUser(userId: string): LibraryEntry[] {
  return loadLibrary().filter(e => e.userId === userId);
}

export function loadRequests(): GameRequest[] {
  return readJson<GameRequest[]>(REQUESTS_FILE, []);
}

function saveRequests(requests: GameRequest[]): void {
  writeJson(REQUESTS_FILE, requests);
}

export function addRequest(eventId: string, gameName: string, requestedBy: string): 'added' | 'duplicate' {
  const requests = loadRequests();
  const exists = requests.some(
    r => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase()
  );
  if (exists) return 'duplicate';
  requests.push({ id: randomUUID(), eventId, gameName, requestedBy, createdAt: new Date().toISOString() });
  saveRequests(requests);
  return 'added';
}

export function getRequestsForEvent(eventId: string): GameRequest[] {
  return loadRequests().filter(r => r.eventId === eventId);
}

export function removeRequests(requestIds: string[]): number {
  const requests = loadRequests();
  const remaining = requests.filter(r => !requestIds.includes(r.id));
  saveRequests(remaining);
  return requests.length - remaining.length;
}

export function removeAllRequestsForEvent(eventId: string, userId?: string): number {
  const requests = loadRequests();
  const remaining = requests.filter(r => {
    if (r.eventId !== eventId) return true;
    if (userId) return r.requestedBy !== userId;
    return false;
  });
  saveRequests(remaining);
  return requests.length - remaining.length;
}

export function updateRequestCopies(eventId: string, gameName: string, copies: number): void {
  const requests = loadRequests();
  const idx = requests.findIndex(
    r => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase()
  );
  if (idx >= 0) {
    requests[idx].copiesNeeded = copies;
    saveRequests(requests);
  }
}

export const GAME_TAGS = [
  'Co-op',
  'Competitive',
  'Semi-Co-op',
  'Team vs Team',
  'Solo Friendly',
  'Deck Building',
  'Engine Building',
  'Worker Placement',
  'Area Control',
  'Tile Placement',
  'Drafting',
  'Auction',
  'Trick Taking',
  'Roll & Write',
  'Push Your Luck',
  'Hand Management',
  'Social Deduction',
  'Hidden Roles',
  'Bluffing',
  'Party',
  'Abstract',
  'Economic',
  'Dungeon Crawler',
  'Legacy',
  'Gateway / Family',
] as const;

export type GameTag = typeof GAME_TAGS[number];

export interface GameInfo {
  gameName: string;
  objectid?: string;
  minPlayers?: number;
  maxPlayers?: number;
  playTime?: number;
  tags?: string[];
  expansions?: string[];      // owner-noted expansions they personally own
  bggExpansions?: string[];   // full expansion list from BGG
  updatedAt: string;
}

export function loadGameInfos(): GameInfo[] {
  return readJson<GameInfo[]>(GAME_INFO_FILE, []);
}

function saveGameInfos(infos: GameInfo[]): void {
  writeJson(GAME_INFO_FILE, infos);
}

export function getGameInfo(gameName: string): GameInfo | undefined {
  return loadGameInfos().find(i => i.gameName.toLowerCase() === gameName.toLowerCase());
}

export function upsertGameInfo(info: GameInfo): void {
  const infos = loadGameInfos();
  const idx = infos.findIndex(i => i.gameName.toLowerCase() === info.gameName.toLowerCase());
  if (idx >= 0) infos[idx] = info;
  else infos.push(info);
  saveGameInfos(infos);
}
