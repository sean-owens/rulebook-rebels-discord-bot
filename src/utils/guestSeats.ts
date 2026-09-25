import { randomUUID } from 'crypto';

// A guest seat is represented as a synthetic pseudo-ID pushed into the same
// GameSuggestion.seats/.waitlist string arrays real Discord IDs live in (see
// GameSuggestion.guests in gameStorage.ts for the metadata each one carries).
// This lets every existing capacity/waitlist-promotion/scheduler-grouping
// check keep working unmodified, since they already treat those arrays as
// opaque string lists — only code that fetches a Discord member/BGG account
// or renders a raw mention needs to special-case a guest id (see
// isGuestSeatId below).
export const GUEST_ID_PREFIX = 'guest:';

export interface GuestSeat {
  id: string; // `guest:${randomUUID()}`, pushed into seats/waitlist
  ownerId: string; // the real Discord user who reserved this guest
  name: string | null; // optional free-text name, e.g. "Mom"
}

export function makeGuestId(): string {
  return `${GUEST_ID_PREFIX}${randomUUID()}`;
}

export function isGuestSeatId(id: string): boolean {
  return id.startsWith(GUEST_ID_PREFIX);
}

// "Will's Guest (Mom)" for a lone guest, "Will's Guest 2 (Mom)" when the
// owner has more than one — numbered by current position in their own guest
// list rather than a stored number, so it stays correct after any of their
// other guests leave (matches how seat lines already renumber by position).
export function guestDisplayName(
  guestId: string,
  guests: GuestSeat[],
  ownerNameMap: Record<string, string>,
): string {
  const g = guests.find((x) => x.id === guestId);
  if (!g) return 'Guest';
  const ownerGuests = guests.filter((x) => x.ownerId === g.ownerId);
  const n = ownerGuests.findIndex((x) => x.id === guestId) + 1;
  const ownerName = ownerNameMap[g.ownerId] ?? `<@${g.ownerId}>`;
  const label = ownerGuests.length > 1 ? `${ownerName}'s Guest ${n}` : `${ownerName}'s Guest`;
  return g.name ? `${label} (${g.name})` : label;
}
