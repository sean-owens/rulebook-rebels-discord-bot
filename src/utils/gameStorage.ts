import { readJson, writeJson } from './db';

const FILE = 'games.json';

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
  complexity?: string;
  howToPlayUrl?: string | null;
  thumbnail?: string | null;
  expansions: GameExpansion[];
  seats: string[];
  waitlist: string[];
  createdAt: string;
  createdBy: string;
}

export function loadGames(): GameSuggestion[] {
  return readJson<GameSuggestion[]>(FILE, []);
}

export function saveGames(games: GameSuggestion[]): void {
  writeJson(FILE, games);
}

export function findGame(id: string): GameSuggestion | undefined {
  return loadGames().find(g => g.id === id);
}

export function findGamesByChannel(channelId: string): GameSuggestion[] {
  return loadGames().filter(g => g.channelId === channelId);
}

export function findGamesByEvent(eventId: string): GameSuggestion[] {
  return loadGames().filter(g => g.eventId === eventId);
}

export function removeGamesByEvent(eventId: string): void {
  saveGames(loadGames().filter(g => g.eventId !== eventId));
}

export function upsertGame(game: GameSuggestion): void {
  const all = loadGames();
  const idx = all.findIndex(g => g.id === game.id);
  if (idx >= 0) all[idx] = game;
  else all.push(game);
  saveGames(all);
}
