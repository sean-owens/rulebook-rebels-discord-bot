import { readJson, writeJson } from './db';

const CHALLENGES_FILE = 'board_game_challenges.json';
const LEADERBOARD_FILE = 'board_game_challenge_leaderboard.json';

// Points awarded for guessing correctly while hint N is the most recent one
// posted — earlier/vaguer hints are worth more since guessing off them is harder.
export const POINTS_BY_HINT_STAGE: Record<1 | 2 | 3, number> = { 1: 100, 2: 80, 3: 50 };

export interface CorrectGuess {
  userId: string;
  points: number;
  hintStage: 1 | 2 | 3;
  guessedAt: string;
}

export interface WeeklyChallenge {
  id: string;
  guildId: string;
  weekStart: string; // ISO date (YYYY-MM-DD) of that week's Monday, in the guild's timezone
  bggId: string;
  title: string;
  clues: [string, string, string];
  thumbnail: string | null;
  bggLink: string;
  hintsPostedCount: 0 | 1 | 2 | 3;
  hintMessageIds: string[];
  channelId: string;
  revealed: boolean;
  correctGuesses: CorrectGuess[];
}

type ChallengeStore = Record<string, WeeklyChallenge[]>;
type LeaderboardStore = Record<string, Record<string, number>>;

function load(): Promise<ChallengeStore> {
  return readJson<ChallengeStore>(CHALLENGES_FILE, {});
}

function save(store: ChallengeStore): Promise<void> {
  return writeJson(CHALLENGES_FILE, store);
}

function loadLeaderboard(): Promise<LeaderboardStore> {
  return readJson<LeaderboardStore>(LEADERBOARD_FILE, {});
}

function saveLeaderboard(store: LeaderboardStore): Promise<void> {
  return writeJson(LEADERBOARD_FILE, store);
}

export async function getChallengesForGuild(guildId: string): Promise<WeeklyChallenge[]> {
  return (await load())[guildId] ?? [];
}

// A guild has at most one non-revealed challenge at a time — the schedule
// check (see checkAndAdvanceChallengeSchedule in boardGameChallenge.ts) only
// ever creates a new one once the prior week's has been revealed.
export async function getActiveChallenge(guildId: string): Promise<WeeklyChallenge | undefined> {
  const challenges = await getChallengesForGuild(guildId);
  return challenges.find((c) => !c.revealed);
}

export async function getChallenge(
  guildId: string,
  challengeId: string,
): Promise<WeeklyChallenge | undefined> {
  return (await getChallengesForGuild(guildId)).find((c) => c.id === challengeId);
}

export async function createWeeklyChallenge(
  guildId: string,
  data: Pick<WeeklyChallenge, 'weekStart' | 'bggId' | 'title' | 'clues' | 'thumbnail' | 'bggLink' | 'channelId'>,
): Promise<WeeklyChallenge> {
  const store = await load();
  const challenges = store[guildId] ?? [];
  const challenge: WeeklyChallenge = {
    ...data,
    id: `${guildId}-${data.weekStart}`,
    guildId,
    hintsPostedCount: 0,
    hintMessageIds: [],
    revealed: false,
    correctGuesses: [],
  };
  challenges.push(challenge);
  store[guildId] = challenges;
  await save(store);
  return challenge;
}

export async function recordHintPosted(
  guildId: string,
  challengeId: string,
  hintIndex: 1 | 2 | 3,
  messageId: string,
): Promise<WeeklyChallenge | undefined> {
  const store = await load();
  const challenges = store[guildId] ?? [];
  const idx = challenges.findIndex((c) => c.id === challengeId);
  if (idx === -1) return undefined;

  challenges[idx].hintsPostedCount = hintIndex;
  challenges[idx].hintMessageIds.push(messageId);
  store[guildId] = challenges;
  await save(store);
  return challenges[idx];
}

// Idempotent — a user who already scored this challenge gets undefined back
// rather than a second point award, so a re-processed/duplicate message event
// can never double-score them.
export async function recordCorrectGuess(
  guildId: string,
  challengeId: string,
  userId: string,
  hintStage: 1 | 2 | 3,
): Promise<{ points: number; totalPoints: number } | undefined> {
  const store = await load();
  const challenges = store[guildId] ?? [];
  const idx = challenges.findIndex((c) => c.id === challengeId);
  if (idx === -1) return undefined;
  if (challenges[idx].correctGuesses.some((g) => g.userId === userId)) return undefined;

  const points = POINTS_BY_HINT_STAGE[hintStage];
  challenges[idx].correctGuesses.push({
    userId,
    points,
    hintStage,
    guessedAt: new Date().toISOString(),
  });
  store[guildId] = challenges;
  await save(store);

  const leaderboardStore = await loadLeaderboard();
  const guildLeaderboard = leaderboardStore[guildId] ?? {};
  const totalPoints = (guildLeaderboard[userId] ?? 0) + points;
  guildLeaderboard[userId] = totalPoints;
  leaderboardStore[guildId] = guildLeaderboard;
  await saveLeaderboard(leaderboardStore);

  return { points, totalPoints };
}

export async function revealChallenge(
  guildId: string,
  challengeId: string,
): Promise<WeeklyChallenge | undefined> {
  const store = await load();
  const challenges = store[guildId] ?? [];
  const idx = challenges.findIndex((c) => c.id === challengeId);
  if (idx === -1) return undefined;

  challenges[idx].revealed = true;
  store[guildId] = challenges;
  await save(store);
  return challenges[idx];
}

// bggIds played in the last `weeks` weeks — used to keep selectWeeklyGame
// (boardGameChallenge.ts) from repeating a recent game.
export async function getRecentGameIds(guildId: string, weeks = 52): Promise<Set<string>> {
  const challenges = await getChallengesForGuild(guildId);
  const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
  return new Set(
    challenges.filter((c) => new Date(c.weekStart).getTime() >= cutoff).map((c) => c.bggId),
  );
}

export interface LeaderboardEntry {
  userId: string;
  points: number;
}

export async function getLeaderboard(guildId: string): Promise<LeaderboardEntry[]> {
  const guildLeaderboard = (await loadLeaderboard())[guildId] ?? {};
  return Object.entries(guildLeaderboard)
    .map(([userId, points]) => ({ userId, points }))
    .sort((a, b) => b.points - a.points);
}
