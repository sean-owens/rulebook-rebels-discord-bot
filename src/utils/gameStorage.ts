import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'games.json');

export interface GameExpansion {
  id: string;
  name: string;
}

export interface GameSuggestion {
  id: string;
  eventId: string;
  channelId: string;
  messageId: string;
  guildId: string;
  bggId: string;
  title: string;
  bggLink: string;
  minPlayers: number;
  maxPlayers: number;
  suggestedPlayers: number;
  minPlaytime: number;
  maxPlaytime: number;
  suggestedStartTime: string | null;
  tags?: string[];
  expansions: GameExpansion[];
  seats: string[];
  waitlist: string[];
  createdAt: string;
  createdBy: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadGames(): GameSuggestion[] {
  ensureDataDir();
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as GameSuggestion[];
}

export function saveGames(games: GameSuggestion[]): void {
  ensureDataDir();
  fs.writeFileSync(FILE, JSON.stringify(games, null, 2));
}

export function findGame(id: string): GameSuggestion | undefined {
  return loadGames().find(g => g.id === id);
}

export function findGamesByChannel(channelId: string): GameSuggestion[] {
  return loadGames().filter(g => g.channelId === channelId);
}

export function upsertGame(game: GameSuggestion): void {
  const all = loadGames();
  const idx = all.findIndex(g => g.id === game.id);
  if (idx >= 0) all[idx] = game;
  else all.push(game);
  saveGames(all);
}
