import type { BGGCollectionGame } from './bgg';
import { addGamesBulk, loadGameInfos, upsertGameInfosBulk, GameInfo } from './libraryStorage';
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

  // Read the previous snapshot BEFORE it's overwritten below — it's what defines "new".
  const previousIds =
    mode === 'new-only' ? new Set((await getUserCollection(guildId, userId)).map((e) => e.bggGameId)) : null;
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
