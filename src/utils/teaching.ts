import { GameSuggestion } from './gameStorage';
import { isGuestSeatId } from './guestSeats';

// What a suggester (or later volunteer) says about their familiarity with a
// game: 'teach' = can explain the rules to a table, 'answer' = can answer
// rules questions but not run a full teach, 'learning' = new to it too.
export type TeachingLevel = 'teach' | 'answer' | 'learning';

export const TEACHING_LEVELS: TeachingLevel[] = ['teach', 'answer', 'learning'];

export function isTeachingLevel(value: string): value is TeachingLevel {
  return (TEACHING_LEVELS as string[]).includes(value);
}

// Fresh teaching lists for a newly-suggested game, from the suggester's own answer.
export function initialTeaching(userId: string, level: TeachingLevel): { teachers: string[]; helpers: string[] } {
  return {
    teachers: level === 'teach' ? [userId] : [],
    helpers: level === 'answer' ? [userId] : [],
  };
}

// Drops a user from both lists — used when they leave the game's seats.
export function removeFromTeaching(game: GameSuggestion, userId: string): void {
  if (game.teachers) game.teachers = game.teachers.filter((id) => id !== userId);
  if (game.helpers) game.helpers = game.helpers.filter((id) => id !== userId);
}

// Toggles a seated player's "I can teach" status; returns true if they're a
// teacher afterwards. A player who volunteers to teach is dropped from the
// (weaker) question-answerer list so they aren't listed twice.
export function toggleTeacher(game: GameSuggestion, userId: string): boolean {
  const teachers = game.teachers ?? [];
  if (teachers.includes(userId)) {
    game.teachers = teachers.filter((id) => id !== userId);
    return false;
  }
  game.teachers = [...teachers, userId];
  game.helpers = (game.helpers ?? []).filter((id) => id !== userId);
  return true;
}

// Games with real seated players but nobody who can teach them. Games from
// before teaching was tracked (teachers undefined) are never flagged.
export function findGamesNeedingTeacher(games: GameSuggestion[]): GameSuggestion[] {
  return games.filter(
    (g) => g.teachers !== undefined && g.teachers.length === 0 && g.seats.some((id) => !isGuestSeatId(id)),
  );
}

export function buildTeacherHostMessage(eventTitle: string, games: GameSuggestion[]): string {
  const lines = games.map((g) => `• **${g.title}**${g.helpers?.length ? ' (someone can answer questions)' : ''}`);
  return (
    `🎓 The lineup for **${eventTitle}** just locked, and these games have players signed up but nobody who ` +
    `has said they can teach them:\n${lines.join('\n')}\n` +
    'You may want to find a teacher — players can tap "🎓 I Can Teach" on the game card.'
  );
}
