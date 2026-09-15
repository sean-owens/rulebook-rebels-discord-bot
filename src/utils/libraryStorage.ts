import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';
import { GENRE_TAG_DEFINITIONS } from './tagDefinitions';
import { matchesFuzzy } from './bggCatalog';
import { getEffectiveOwnerIds, getLibraryLinksForGuild } from './libraryLinkStorage';
import { BGGGame, weightTag } from './bgg';

const LIBRARY_FILE = 'library.json';
const REQUESTS_FILE = 'library_requests.json';
const GAME_INFO_FILE = 'game_info.json';

export interface LibraryEntry {
  guildId: string;
  userId: string;
  gameName: string;
  objectid?: string;
  isExpansion?: boolean;
  addedAt: string;
}

export interface RequestConfirmation {
  ownerId: string;
  confirmedAt: string;
}

export interface RequestAsk {
  ownerId: string;
  dmChannelId?: string;
  dmMessageId?: string;
  askedAt: string;
}

export interface GameRequest {
  id: string;
  eventId: string;
  gameName: string;
  requestedBy: string;
  createdAt: string;
  copiesNeeded?: number;
  // Explicit copy-select target (still only ever set once, at creation) —
  // restricts which owner's /library bring view shows this request. Distinct
  // from confirmations/pendingAsks below, which track the multi-copy
  // ask/confirm/decline cascade and can span several owners at once.
  preferredOwnerId?: string;
  confirmations: RequestConfirmation[];
  declinedOwnerIds: string[];
  pendingAsks: RequestAsk[];
}

export async function loadLibrary(): Promise<LibraryEntry[]> {
  return readJson<LibraryEntry[]>(LIBRARY_FILE, []);
}

async function saveLibrary(entries: LibraryEntry[]): Promise<void> {
  await writeJson(LIBRARY_FILE, entries);
}

export async function loadLibraryForGuild(guildId: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter((e) => e.guildId === guildId);
}

export async function addGame(
  guildId: string,
  userId: string,
  gameName: string,
  objectid?: string,
  isExpansion?: boolean,
): Promise<'added' | 'duplicate'> {
  const entries = await loadLibrary();
  const exists = entries.some((e) => {
    if (e.guildId !== guildId || e.userId !== userId) return false;
    if (objectid && e.objectid === objectid) return true;
    return e.gameName.toLowerCase() === gameName.toLowerCase();
  });
  if (exists) return 'duplicate';
  const entry: LibraryEntry = { guildId, userId, gameName, addedAt: new Date().toISOString() };
  if (objectid) entry.objectid = objectid;
  if (isExpansion) entry.isExpansion = true;
  entries.push(entry);
  await saveLibrary(entries);
  return 'added';
}

// Bulk variant of addGame — does a single read + single write regardless of
// how many games are added, instead of one round trip per game. Use this
// whenever adding more than one game at a time (BGG/CSV imports).
export async function addGamesBulk(
  guildId: string,
  userId: string,
  games: Array<{ gameName: string; objectid?: string; isExpansion?: boolean }>,
): Promise<('added' | 'duplicate')[]> {
  const entries = await loadLibrary();
  const results: ('added' | 'duplicate')[] = [];
  for (const g of games) {
    const exists = entries.some((e) => {
      if (e.guildId !== guildId || e.userId !== userId) return false;
      if (g.objectid && e.objectid === g.objectid) return true;
      return e.gameName.toLowerCase() === g.gameName.toLowerCase();
    });
    if (exists) {
      results.push('duplicate');
      continue;
    }
    const entry: LibraryEntry = { guildId, userId, gameName: g.gameName, addedAt: new Date().toISOString() };
    if (g.objectid) entry.objectid = g.objectid;
    if (g.isExpansion) entry.isExpansion = true;
    entries.push(entry);
    results.push('added');
  }
  await saveLibrary(entries);
  return results;
}

export async function findGamesByName(guildId: string, gameName: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter(
    (e) => e.guildId === guildId && e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
}

export async function findGameNamesByPartial(guildId: string, term: string): Promise<string[]> {
  if (!term.trim()) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  // Expansions can't be suggested/requested on their own — they're always
  // played alongside their base game — so exclude them here rather than
  // cluttering the picker with entries the player couldn't actually pick.
  for (const e of (await loadLibrary()).filter((e) => e.guildId === guildId && !e.isExpansion)) {
    const key = e.gameName.toLowerCase();
    if (matchesFuzzy(term, e.gameName) && !seen.has(key)) {
      seen.add(key);
      names.push(e.gameName);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function clearUserLibrary(guildId: string, userId: string): Promise<number> {
  const entries = await loadLibrary();
  const remaining = entries.filter((e) => !(e.guildId === guildId && e.userId === userId));
  await saveLibrary(remaining);
  return entries.length - remaining.length;
}

export async function removeGame(
  guildId: string,
  userId: string,
  gameName: string,
): Promise<'removed' | 'not_found'> {
  const entries = await loadLibrary();
  const idx = entries.findIndex(
    (e) =>
      e.guildId === guildId &&
      e.userId === userId &&
      e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx === -1) return 'not_found';
  entries.splice(idx, 1);
  await saveLibrary(entries);
  return 'removed';
}

export async function getGamesByUser(guildId: string, userId: string): Promise<LibraryEntry[]> {
  return (await loadLibrary()).filter((e) => e.guildId === guildId && e.userId === userId);
}

/**
 * Like getGamesByUser, but also includes games owned by anyone who has
 * linked `userId` as a delegate via /library link — i.e. the caller's own
 * entries plus their effective "shared household" collection.
 */
export async function getGamesByUserAndLinked(guildId: string, userId: string): Promise<LibraryEntry[]> {
  const effectiveOwnerIds = await getEffectiveOwnerIds(guildId, userId);
  return (await loadLibrary()).filter(
    (e) => e.guildId === guildId && effectiveOwnerIds.includes(e.userId),
  );
}

export async function loadRequests(): Promise<GameRequest[]> {
  return readJson<GameRequest[]>(REQUESTS_FILE, []);
}

async function saveRequests(requests: GameRequest[]): Promise<void> {
  await writeJson(REQUESTS_FILE, requests);
}

export async function addRequest(
  eventId: string,
  gameName: string,
  requestedBy: string,
  preferredOwnerId?: string,
): Promise<GameRequest | 'duplicate'> {
  const requests = await loadRequests();
  const exists = requests.some(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (exists) return 'duplicate';
  const req: GameRequest = {
    id: randomUUID(),
    eventId,
    gameName,
    requestedBy,
    createdAt: new Date().toISOString(),
    confirmations: [],
    declinedOwnerIds: [],
    pendingAsks: [],
  };
  if (preferredOwnerId) req.preferredOwnerId = preferredOwnerId;
  requests.push(req);
  await saveRequests(requests);
  return req;
}

export async function getRequestsForEvent(eventId: string): Promise<GameRequest[]> {
  return (await loadRequests()).filter((r) => r.eventId === eventId);
}

export async function getRequestById(id: string): Promise<GameRequest | undefined> {
  return (await loadRequests()).find((r) => r.id === id);
}

// Records that a "please bring this" DM was sent to ownerId, and where —
// lets a later action (drop, reminder, decline cascade) find and edit that
// DM. Upsert semantics: re-asking the same owner (e.g. a lock-time reminder)
// updates their existing pending ask's DM location rather than duplicating it.
export async function addPendingAsk(
  requestId: string,
  ownerId: string,
  dmChannelId: string,
  dmMessageId: string,
): Promise<void> {
  const requests = await loadRequests();
  const idx = requests.findIndex((r) => r.id === requestId);
  if (idx === -1) return;
  const req = requests[idx];
  const askIdx = req.pendingAsks.findIndex((a) => a.ownerId === ownerId);
  const ask: RequestAsk = { ownerId, dmChannelId, dmMessageId, askedAt: new Date().toISOString() };
  if (askIdx >= 0) req.pendingAsks[askIdx] = ask;
  else req.pendingAsks.push(ask);
  await saveRequests(requests);
}

// Removes ownerId's pending ask (e.g. once retracted as no longer needed, or
// superseded by a decline/confirmation) and returns it so the caller can
// invalidate its DM. Does not add ownerId to declinedOwnerIds — that's a
// distinct, explicit action (see declineBring).
export async function removePendingAsk(
  requestId: string,
  ownerId: string,
): Promise<RequestAsk | undefined> {
  const requests = await loadRequests();
  const idx = requests.findIndex((r) => r.id === requestId);
  if (idx === -1) return undefined;
  const req = requests[idx];
  const askIdx = req.pendingAsks.findIndex((a) => a.ownerId === ownerId);
  if (askIdx === -1) return undefined;
  const [removed] = req.pendingAsks.splice(askIdx, 1);
  await saveRequests(requests);
  return removed;
}

// An owner explicitly declines a pending ask — moves them from pendingAsks to
// declinedOwnerIds so they're never re-asked for this same request.
export async function declineBring(
  requestId: string,
  ownerId: string,
): Promise<'declined' | 'not_requested' | 'not_asked'> {
  const requests = await loadRequests();
  const idx = requests.findIndex((r) => r.id === requestId);
  if (idx === -1) return 'not_requested';
  const req = requests[idx];
  const askIdx = req.pendingAsks.findIndex((a) => a.ownerId === ownerId);
  if (askIdx === -1) return 'not_asked';
  req.pendingAsks.splice(askIdx, 1);
  if (!req.declinedOwnerIds.includes(ownerId)) req.declinedOwnerIds.push(ownerId);
  await saveRequests(requests);
  return 'declined';
}

export async function removeRequests(requestIds: string[]): Promise<number> {
  const requests = await loadRequests();
  const remaining = requests.filter((r) => !requestIds.includes(r.id));
  await saveRequests(remaining);
  return requests.length - remaining.length;
}

// Called at lineup lock (see lockAndScheduleEvent in scheduler.ts) to drop
// "games to bring" requests for suggestions nobody signed up to play.
// Requests with no matching suggestion at all are left untouched — /library
// request is valid independent of the suggested-games/signup system (e.g.
// bringing a game just to teach or show off, never suggested for a round).
// Returns the removed records (not just a count) so the caller can also
// invalidate any pending "please bring this" DM tied to them.
export async function removeZeroSignupRequests(
  eventId: string,
  zeroSignupTitles: string[],
): Promise<GameRequest[]> {
  if (zeroSignupTitles.length === 0) return [];
  const lowerTitles = new Set(zeroSignupTitles.map((t) => t.toLowerCase()));
  const requests = await getRequestsForEvent(eventId);
  const toRemove = requests.filter((r) => lowerTitles.has(r.gameName.toLowerCase()));
  if (toRemove.length === 0) return [];
  await removeRequests(toRemove.map((r) => r.id));
  return toRemove;
}

export async function removeAllRequestsForEvent(
  eventId: string,
  userId?: string,
): Promise<number> {
  const requests = await loadRequests();
  const remaining = requests.filter((r) => {
    if (r.eventId !== eventId) return true;
    if (userId) return r.requestedBy !== userId;
    return false;
  });
  await saveRequests(remaining);
  return requests.length - remaining.length;
}

// Returns the updated request (or undefined if no matching request exists)
// so the caller can reconcile pending asks against the new copy count —
// see reconcileRequestCopies in libraryBringDm.ts.
export async function updateRequestCopies(
  eventId: string,
  gameName: string,
  copies: number,
): Promise<GameRequest | undefined> {
  const requests = await loadRequests();
  const idx = requests.findIndex(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx === -1) return undefined;
  requests[idx].copiesNeeded = copies;
  await saveRequests(requests);
  return requests[idx];
}

export type ConfirmBringResult =
  | { status: 'confirmed'; invalidatedAsk?: RequestAsk }
  | { status: 'not_requested' }
  | { status: 'not_owner' };

export async function confirmBring(
  guildId: string,
  eventId: string,
  gameName: string,
  userId: string,
): Promise<ConfirmBringResult> {
  const requests = await loadRequests();
  const idx = requests.findIndex(
    (r) => r.eventId === eventId && r.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (idx === -1) return { status: 'not_requested' };

  const effectiveOwnerIds = await getEffectiveOwnerIds(guildId, userId);
  const owns = (await loadLibrary()).some(
    (e) =>
      e.guildId === guildId &&
      effectiveOwnerIds.includes(e.userId) &&
      e.gameName.toLowerCase() === gameName.toLowerCase(),
  );
  if (!owns) return { status: 'not_owner' };

  const req = requests[idx];
  const askIdx = req.pendingAsks.findIndex((a) => a.ownerId === userId);
  const invalidatedAsk = askIdx >= 0 ? req.pendingAsks.splice(askIdx, 1)[0] : undefined;
  if (!req.confirmations.some((c) => c.ownerId === userId)) {
    req.confirmations.push({ ownerId: userId, confirmedAt: new Date().toISOString() });
  }
  await saveRequests(requests);
  return { status: 'confirmed', invalidatedAsk };
}

// Attending owners of gameName who haven't already been asked, confirmed, or
// declined for this request — the pool reconcileRequestCopies/pickPreferredOwner
// draw from when a new copy needs to be requested.
export async function resolveAttendingOwnerIds(
  guildId: string,
  ownerIds: string[],
  rsvps: { yes: string[]; maybe: string[] },
): Promise<string[]> {
  const links = await getLibraryLinksForGuild(guildId);
  const isAttending = (id: string) => rsvps.yes.includes(id) || rsvps.maybe.includes(id);
  return ownerIds.filter((ownerId) => {
    const delegateIds = links.filter((l) => l.ownerId === ownerId).map((l) => l.delegateId);
    return isAttending(ownerId) || delegateIds.some(isAttending);
  });
}

// Picks whichever eligible owner currently has the fewest confirmed brings
// for this event — load-balances repeat asks across a group rather than
// always landing on the same generous owner. excludeIds filters out anyone
// already asked, confirmed, or declined for the request being resolved.
// Returns undefined if every eligible owner has already been tried.
export async function pickPreferredOwner(
  eventId: string,
  attendingOwnerIds: string[],
  excludeIds: string[] = [],
): Promise<string | undefined> {
  const eligible = attendingOwnerIds.filter((id) => !excludeIds.includes(id));
  if (eligible.length === 0) return undefined;
  const requests = await getRequestsForEvent(eventId);
  const bringCounts = new Map<string, number>(eligible.map((id) => [id, 0]));
  for (const req of requests) {
    for (const c of req.confirmations) {
      if (bringCounts.has(c.ownerId)) {
        bringCounts.set(c.ownerId, (bringCounts.get(c.ownerId) ?? 0) + 1);
      }
    }
  }
  let minCount = Infinity,
    chosen = eligible[0];
  for (const [id, count] of bringCounts) {
    if (count < minCount) {
      minCount = count;
      chosen = id;
    }
  }
  return chosen;
}

export type GameTag = (typeof GENRE_TAG_DEFINITIONS)[number]['name'];
export const GAME_TAGS: readonly GameTag[] = GENRE_TAG_DEFINITIONS.map((t) => t.name);

export type Complexity = 'Light' | 'Medium' | 'Heavy';

export interface GameInfo {
  gameName: string;
  objectid?: string;
  minPlayers?: number;
  maxPlayers?: number;
  bestPlayers?: number; // BGG community "best at" player count
  playTime?: number;
  weight?: number; // BGG average weight (1–5 complexity scale)
  complexity?: Complexity | null; // null = checked BGG, no weight data found
  tags?: string[];
  // Raw BGG category/mechanic/designer/publisher names, kept separate from
  // the curated `tags` vocabulary above — populated straight from BGGGame
  // wherever a live lookup already succeeded (library sync, /game, or the
  // weekly challenge's own picks) so a later BGG-outage fallback has enough
  // to generate real hints instead of always falling back to a placeholder.
  categories?: string[];
  mechanics?: string[];
  yearPublished?: number | null;
  designers?: string[];
  publishers?: string[];
  expansions?: string[]; // owner-noted expansions they personally own
  bggExpansions?: string[]; // full expansion list from BGG
  howToPlayUrl?: string | null; // null = checked BGG, no instructional video found
  thumbnail?: string | null;
  updatedAt: string;
}

export async function loadGameInfos(): Promise<GameInfo[]> {
  return readJson<GameInfo[]>(GAME_INFO_FILE, []);
}

async function saveGameInfos(infos: GameInfo[]): Promise<void> {
  await writeJson(GAME_INFO_FILE, infos);
}

export async function getGameInfo(gameName: string): Promise<GameInfo | undefined> {
  return (await loadGameInfos()).find((i) => i.gameName.toLowerCase() === gameName.toLowerCase());
}

// Which of userId's (or their linked delegates') owned expansions apply to
// gameName — used to nudge "bring the expansions too" alongside a base-game
// request/confirmation. Returns a display-ready parenthetical, or '' if none.
export async function buildExpansionNote(
  guildId: string,
  userId: string,
  gameName: string,
): Promise<string> {
  const info = await getGameInfo(gameName);
  if (!info?.bggExpansions?.length) return '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const effectiveOwnerIds = await getEffectiveOwnerIds(guildId, userId);
  const userExpNames = new Set(
    (await loadLibraryForGuild(guildId))
      .filter((e) => effectiveOwnerIds.includes(e.userId) && e.isExpansion)
      .map((e) => norm(e.gameName)),
  );
  const ownedExps = info.bggExpansions.filter((name) => userExpNames.has(norm(name)));
  if (ownedExps.length === 0) return '';
  return ` (with ${ownedExps.join(', ')})`;
}

export async function upsertGameInfo(info: GameInfo): Promise<void> {
  const infos = await loadGameInfos();
  const idx = infos.findIndex((i) => i.gameName.toLowerCase() === info.gameName.toLowerCase());
  if (idx >= 0) infos[idx] = info;
  else infos.push(info);
  await saveGameInfos(infos);
}

// Merges a live BGGGame lookup into a GameInfo record and persists it —
// shared by /admin library sync(all), /admin library backfilltop, and the
// weekly challenge's own successful picks (selectWeeklyGame in
// boardGameChallenge.ts), so every successful live lookup from any of those
// paths grows the same fallback cache for when BGG itself is unreachable.
// `force:true` overwrites existing fields with BGG's current data; `force:
// false` only fills in fields this record doesn't already have.
export async function applyBGGDataToGameInfo(
  info: GameInfo,
  bggGame: BGGGame,
  force: boolean,
): Promise<void> {
  await upsertGameInfo({
    ...info,
    minPlayers: info.minPlayers ?? bggGame.minPlayers,
    maxPlayers: info.maxPlayers ?? bggGame.maxPlayers,
    playTime: info.playTime ?? bggGame.maxPlaytime,
    complexity: info.complexity ?? (bggGame.weight ? weightTag(bggGame.weight) : null),
    tags: bggGame.tags.length > 0 ? bggGame.tags : (info.tags ?? []),
    bestPlayers: force
      ? bggGame.suggestedPlayers || undefined
      : (info.bestPlayers ?? (bggGame.suggestedPlayers || undefined)),
    weight: force ? (bggGame.weight ?? undefined) : (info.weight ?? bggGame.weight ?? undefined),
    // Raw category/mechanic/designer/publisher names — kept for the
    // BGG-outage fallback to generate real hints from, separate from the
    // curated `tags` vocabulary above.
    categories: force ? bggGame.categories : (info.categories ?? bggGame.categories),
    mechanics: force ? bggGame.mechanics : (info.mechanics ?? bggGame.mechanics),
    yearPublished: force ? bggGame.yearPublished : (info.yearPublished ?? bggGame.yearPublished),
    designers: force ? bggGame.designers : (info.designers ?? bggGame.designers),
    publishers: force ? bggGame.publishers : (info.publishers ?? bggGame.publishers),
    bggExpansions: force
      ? bggGame.expansions.map((e) => e.name)
      : (info.bggExpansions ?? bggGame.expansions.map((e) => e.name)),
    howToPlayUrl: force
      ? bggGame.howToPlayUrl
      : info.howToPlayUrl !== undefined
        ? info.howToPlayUrl
        : bggGame.howToPlayUrl,
    thumbnail: force
      ? bggGame.thumbnail
      : info.thumbnail !== undefined
        ? info.thumbnail
        : bggGame.thumbnail,
    updatedAt: new Date().toISOString(),
  });
}

// Bulk variant of upsertGameInfo — does a single read + single write for the
// whole batch instead of one round trip per game. Use this when upserting
// more than one GameInfo at a time (BGG/CSV imports).
export async function upsertGameInfosBulk(updates: GameInfo[]): Promise<void> {
  if (updates.length === 0) return;
  const infos = await loadGameInfos();
  for (const info of updates) {
    const idx = infos.findIndex((i) => i.gameName.toLowerCase() === info.gameName.toLowerCase());
    if (idx >= 0) infos[idx] = info;
    else infos.push(info);
  }
  await saveGameInfos(infos);
}
