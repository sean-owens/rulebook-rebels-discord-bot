import { readJson, writeJson } from './db';
import { GuestSeat } from './guestSeats';

const FILE = 'games.json';

export interface GameExpansion {
  id: string;
  name: string;
}

// One real scheduled table session for a game. A game with more interested
// players than fit at one table gets split into groups (see
// expandGamesIntoGroups in src/utils/scheduler.ts) — each group is its own
// session here, groupIndex 1 being the primary. A game that wasn't split
// always has exactly one session in this array.
export interface ScheduledSession {
  groupIndex: number;
  table: number;
  startMinutes: number;
  endMinutes: number;
  playCount: number;
  mayNotFinish: boolean;
  attendingPlayerIds: string[];
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
  // Metadata for synthetic guest pseudo-IDs present in seats/waitlist — see
  // src/utils/guestSeats.ts. Real Discord IDs never appear in this array.
  guests?: GuestSeat[];
  createdAt: string;
  createdBy: string;
  // Set once the scheduler (see src/utils/scheduler.ts) assigns this game a
  // slot on its own independent per-table timeline. scheduledTable is the
  // "was this game scheduled at all" presence marker used elsewhere (e.g.
  // getLastScheduledAt below) — deliberately NOT set for a walk-up game (see
  // scheduledWalkUp), since a walk-up was never confidently placed on a real
  // table and should still be eligible to come up again via /library random.
  scheduledTable?: number;
  scheduledStartMinutes?: number;
  scheduledEndMinutes?: number;
  // How many times this game was scheduled to be played back-to-back at its
  // table (opportunistic repeat-fill for short games). 1 = played once.
  scheduledPlayCount?: number;
  // True if this game's start or end is projected to run past the event's end time.
  scheduledMayNotFinish?: boolean;
  // Every real table session this game was scheduled into — more than one
  // when the scheduler split it into groups (see ScheduledSession). Session
  // 1 is always mirrored into the singular scheduledTable/scheduledStartMinutes/
  // scheduledEndMinutes/scheduledPlayCount/scheduledMayNotFinish fields above,
  // so existing single-session consumers of those fields need no changes.
  scheduledSessions?: ScheduledSession[];
  // Only 1 signed-up player at lock time — never gets a scheduledTable (see
  // WalkUpGame in scheduler.ts), but a BG Stats link IS still posted for it
  // (open recruiting opportunity), so handleAdminBgStats in
  // src/commands/admin.ts tracks it via this flag instead.
  scheduledWalkUp?: boolean;
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
    (g) => g.guildId === guildId && g.scheduledTable !== undefined,
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
