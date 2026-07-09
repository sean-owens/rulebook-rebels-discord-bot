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
  suggestedPlayers: number | null;
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
  // Set once the scheduler (see src/utils/scheduler.ts) assigns this game a slot.
  scheduledRound?: number;
  scheduledTable?: number;
}

export async function loadGames(): Promise<GameSuggestion[]> {
  return readJson<GameSuggestion[]>(FILE, []);
}

export async function saveGames(games: GameSuggestion[]): Promise<void> {
  await writeJson(FILE, games);
}

export async function findGame(id: string): Promise<GameSuggestion | undefined> {
  return (await loadGames()).find((g) => g.id === id);
}

export async function findGamesByChannel(channelId: string): Promise<GameSuggestion[]> {
  return (await loadGames()).filter((g) => g.channelId === channelId);
}

export async function findGamesByEvent(eventId: string): Promise<GameSuggestion[]> {
  return (await loadGames()).filter((g) => g.eventId === eventId);
}

export async function removeGamesByEvent(eventId: string): Promise<void> {
  await saveGames((await loadGames()).filter((g) => g.eventId !== eventId));
}

export async function upsertGame(game: GameSuggestion): Promise<void> {
  const all = await loadGames();
  const idx = all.findIndex((g) => g.id === game.id);
  if (idx >= 0) all[idx] = game;
  else all.push(game);
  await saveGames(all);
}
