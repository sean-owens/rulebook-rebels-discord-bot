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
  // How many times this game was scheduled to be played within its round's
  // time slot (opportunistic repeat-fill for short games). 1 = played once.
  scheduledPlayCount?: number;
  // True if this game's round is projected to run past the event's end time.
  scheduledMayNotFinish?: boolean;
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

// For each game title actually scheduled onto a lineup in this guild (not
// just suggested — a suggestion that never got a table is no evidence a game
// was played), returns the most recent suggestion's createdAt, keyed by
// lowercased title. Used to weight /library random away from games that keep
// coming up (see resolveRandomGames in src/commands/library.ts) — there's no
// reliable "was this actually played" signal (BG Stats gives no callback), so
// "last scheduled" is the closest available proxy.
export async function getLastScheduledAt(guildId: string): Promise<Map<string, string>> {
  const games = (await loadGames()).filter(
    (g) => g.guildId === guildId && g.scheduledRound !== undefined,
  );
  const result = new Map<string, string>();
  for (const game of games) {
    const key = game.title.toLowerCase();
    const existing = result.get(key);
    if (!existing || game.createdAt > existing) {
      result.set(key, game.createdAt);
    }
  }
  return result;
}
