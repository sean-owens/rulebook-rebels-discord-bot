import type { BGGCollectionGame } from './bgg';
import { addGamesBulk, loadGameInfos, loadLibraryForGuild, upsertGameInfosBulk, GameInfo } from './libraryStorage';
import type { ProposedRemoval } from './bggRemovalStorage';
import { getUserCollection, mergeUserCollection, UserCollectionEntry } from './userCollectionStorage';

// 'all'      — every game in the collection is offered to the library (duplicates are
//              skipped). This is what /library import bgg has always done: the member
//              asked for it, so a game they'd removed comes back.
// 'new-only' — only games that weren't in the member's previous BGG snapshot are offered.
//              The automatic re-sync uses this so it picks up newly acquired games
//              without re-adding ones the member deliberately removed with
//              /library remove, which are still owned on BGG and would otherwise
//              reappear every cycle.
export type BggSyncMode = 'all' | 'new-only';

export interface BggSyncSummary {
  addedGames: number;
  addedExpansions: number;
  // Already in the library (or, for 'new-only', skipped as not new).
  skipped: number;
  addedGameNames: string[];
  addedExpansionNames: string[];
  // Games that were in the member's last BGG snapshot, are gone from this fetch, and are
  // still in their library — only ever filled in 'new-only' mode. These are PROPOSALS,
  // never acted on here: the caller asks the member before anything is removed.
  noLongerOnBgg: ProposedRemoval[];
  // True when the fetch came back empty although the member's last snapshot wasn't. BGG
  // can return a 200 with nothing in it (still preparing the collection, a privacy
  // flip), and believing it would wipe the stored snapshot — after which every game
  // looks "new" and ones the member had removed would be re-added. In that case
  // NOTHING is written; the sync just waits for the next cycle.
  heldBack: boolean;
}

// Games the member used to own on BGG that have now left their collection AND are still
// in the group library. Matching is by BGG id on the library entry, so an entry the
// member added by hand (no id) — or one they already removed — is never proposed; only
// a game that demonstrably came from BGG can be asked about.
async function findNoLongerOnBgg(
  guildId: string,
  userId: string,
  previous: UserCollectionEntry[],
  fetched: BGGCollectionGame[],
): Promise<ProposedRemoval[]> {
  if (previous.length === 0) return [];
  const fetchedIds = new Set(fetched.map((g) => g.bggGameId));
  const gone = previous.filter((e) => !fetchedIds.has(e.bggGameId));
  if (gone.length === 0) return [];

  const library = (await loadLibraryForGuild(guildId)).filter((e) => e.userId === userId && e.objectid);
  const proposals: ProposedRemoval[] = [];
  for (const entry of gone) {
    const inLibrary = library.find((l) => l.objectid === entry.bggGameId);
    if (inLibrary) {
      proposals.push({ bggGameId: entry.bggGameId, gameName: inLibrary.gameName, isExpansion: !!inLibrary.isExpansion });
    }
  }
  return proposals;
}

// Applies a fetched BGG collection to one member's library, game info cache, and
// stored BGG snapshot. Purely additive to the library — nothing is ever removed.
// Batched into one read + one write per store rather than one round trip per game:
// with a large collection (100s of games) the per-game pattern took minutes.
export async function applyBggCollectionToLibrary(
  guildId: string,
  userId: string,
  games: BGGCollectionGame[],
  mode: BggSyncMode,
): Promise<BggSyncSummary> {
  const validGames = games.filter((g) => !!g.gameName);

  // Read the previous snapshot BEFORE it's overwritten below — it's what defines "new"
  // (and, from the other side, what a game "no longer on BGG" is measured against).
  const previousEntries = mode === 'new-only' ? await getUserCollection(guildId, userId) : [];
  const previousIds = mode === 'new-only' ? new Set(previousEntries.map((e) => e.bggGameId)) : null;

  if (mode === 'new-only' && validGames.length === 0 && previousEntries.length > 0) {
    return {
      addedGames: 0,
      addedExpansions: 0,
      skipped: 0,
      addedGameNames: [],
      addedExpansionNames: [],
      noLongerOnBgg: [],
      heldBack: true,
    };
  }

  const candidates = previousIds ? validGames.filter((g) => !previousIds.has(g.bggGameId)) : validGames;

  const addResults = await addGamesBulk(
    guildId,
    userId,
    candidates.map((g) => ({ gameName: g.gameName, objectid: g.bggGameId, isExpansion: g.isExpansion })),
  );

  const existingInfos = await loadGameInfos();
  const existingByName = new Map(existingInfos.map((i) => [i.gameName.toLowerCase(), i]));

  const summary: BggSyncSummary = {
    addedGames: 0,
    addedExpansions: 0,
    skipped: validGames.length - candidates.length,
    addedGameNames: [],
    addedExpansionNames: [],
    noLongerOnBgg: await findNoLongerOnBgg(guildId, userId, previousEntries, validGames),
    heldBack: false,
  };
  const infosToUpsert: GameInfo[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const game = candidates[i];
    if (addResults[i] === 'added') {
      if (game.isExpansion) {
        summary.addedExpansions++;
        summary.addedExpansionNames.push(game.gameName);
      } else {
        summary.addedGames++;
        summary.addedGameNames.push(game.gameName);
      }
    } else {
      summary.skipped++;
    }

    const existing = existingByName.get(game.gameName.toLowerCase());
    infosToUpsert.push({
      gameName: game.gameName,
      objectid: game.bggGameId,
      minPlayers: existing?.minPlayers ?? game.minPlayers ?? undefined,
      maxPlayers: existing?.maxPlayers ?? game.maxPlayers ?? undefined,
      playTime: existing?.playTime ?? game.playingTime ?? undefined,
      weight: existing?.weight,
      complexity: existing?.complexity,
      tags: existing?.tags,
      expansions: existing?.expansions,
      updatedAt: new Date().toISOString(),
    });
  }

  // The stored snapshot always reflects the WHOLE fetched collection, in either mode,
  // so the next 'new-only' pass diffs against what BGG showed this time.
  const syncedAt = new Date().toISOString();
  const collectionEntries: UserCollectionEntry[] = validGames.map((game) => ({
    bggGameId: game.bggGameId,
    gameName: game.gameName,
    bggOwn: game.own,
    bggForTrade: game.forTrade,
    bggWantToPlay: game.wantToPlay,
    bggWishlisted: game.wishlisted,
    bggUserRating: game.userRating,
    bggNumPlays: game.numPlays,
    bggSyncedAt: syncedAt,
  }));

  await upsertGameInfosBulk(infosToUpsert);
  await mergeUserCollection(guildId, userId, collectionEntries);

  return summary;
}
