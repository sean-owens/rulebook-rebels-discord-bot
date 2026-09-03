import { GameNight } from './storage';
import { GameSuggestion } from './gameStorage';

export const MAX_GREETERS = 2;

export function isGreeter(gn: Pick<GameNight, 'greeters'>, userId: string): boolean {
  return (gn.greeters ?? []).includes(userId);
}

export const GREETER_COMPLEXITY_MESSAGE =
  "As a greeter for this event, you can only sign up for Light-complexity games — that keeps you free to help arriving guests. This game isn't confirmed Light.";

export const GREETER_CONFLICT_MESSAGE =
  "Both greeters can't be on the same game — you and the other greeter need to stay split across different games so someone's always free to greet.";

/**
 * Returns the reason `userId` can't be seated/waitlisted on `game`, or null
 * if it's allowed. Checked everywhere a user is added to a game's seats or
 * waitlist — Join, Waitlist Join, and suggestion creation (which auto-seats
 * the suggester) — so the greeter restriction can't be bypassed via any one
 * of those paths.
 */
export function greeterSeatViolation(
  gn: Pick<GameNight, 'greeters'>,
  game: Pick<GameSuggestion, 'complexity' | 'seats' | 'waitlist'>,
  userId: string,
): string | null {
  if (!isGreeter(gn, userId)) return null;
  if (game.complexity !== 'Light') return GREETER_COMPLEXITY_MESSAGE;

  const otherGreeters = (gn.greeters ?? []).filter((id) => id !== userId);
  const occupied = [...game.seats, ...game.waitlist];
  if (otherGreeters.some((id) => occupied.includes(id))) return GREETER_CONFLICT_MESSAGE;

  return null;
}
