import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'library_requests.json');
const GAME_INFO_FILE = path.join(DATA_DIR, 'game_info.json');

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
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadLibrary(): LibraryEntry[] {
  ensureDataDir();
  if (!fs.existsSync(LIBRARY_FILE)) return [];
  return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8')) as LibraryEntry[];
}

function saveLibrary(entries: LibraryEntry[]): void {
  ensureDataDir();
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(entries, null, 2));
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
  ensureDataDir();
  if (!fs.existsSync(REQUESTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf-8')) as GameRequest[];
}

function saveRequests(requests: GameRequest[]): void {
  ensureDataDir();
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

export function addRequest(eventId: string, gameName: string, requestedBy: string): 'added' | 'duplicate' {
  const requests = loadRequests();
  const exists = requests.some(
    r => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase()
  );
  if (exists) return 'duplicate';
  const { randomUUID } = require('crypto');
  requests.push({ id: randomUUID(), eventId, gameName, requestedBy, createdAt: new Date().toISOString() });
  saveRequests(requests);
  return 'added';
}

export function getRequestsForEvent(eventId: string): GameRequest[] {
  return loadRequests().filter(r => r.eventId === eventId);
}

export interface GameInfo {
  gameName: string;
  objectid?: string;
  minPlayers?: number;
  maxPlayers?: number;
  playTime?: number;
  gameType?: string;
  expansions?: string[];
  updatedAt: string;
}

export function loadGameInfos(): GameInfo[] {
  ensureDataDir();
  if (!fs.existsSync(GAME_INFO_FILE)) return [];
  return JSON.parse(fs.readFileSync(GAME_INFO_FILE, 'utf-8')) as GameInfo[];
}

function saveGameInfos(infos: GameInfo[]): void {
  ensureDataDir();
  fs.writeFileSync(GAME_INFO_FILE, JSON.stringify(infos, null, 2));
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
