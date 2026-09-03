import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  TextChannel,
} from 'discord.js';
import { GameSuggestion, findGamesByChannel, upsertGame } from './gameStorage';
import { GuildConfig, getGuildConfig } from './config';
import { GameNight, loadGameNights, upsertGameNight } from './storage';
import { resolvePlayerNames } from './playerNames';
import { getMemberPreferences } from './gameRoles';
import { removeZeroSignupRequests, getRequestsForEvent } from './libraryStorage';
import { updateRequestPin } from './requestPin';
import { invalidateBringDm, reconcileRequestCopies } from './libraryBringDm';
import {
  buildBgStatsPlayUrl,
  buildBgStatsButton,
  buildBgStatsButtonUrl,
  buildBgStatsQrAttachment,
} from './bgStats';

export const LOCK_MESSAGE =
  "This event's lineup is locked ahead of the scheduled start — suggestions and seats can no longer change.";

export function isLineupLocked(gn: Pick<GameNight, 'suggestionsLocked'>): boolean {
  return gn.suggestionsLocked === true;
}

// A short game (raw playtime, before any complexity buffer) may opportunistically
// repeat back-to-back at its table once nothing else is ready to be scheduled
// there — see applyRepeatFill().
const SHORT_GAME_MAX_RAW_MINUTES = 30;

export interface SchedulableGame {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  // BGG's community "best with N players" figure, when known — used as the
  // quorum target for partial-group starts (see quorumThreshold()).
  suggestedPlayers?: number | null;
  seatedPlayers: string[];
  // Signed up but couldn't fit in seats at the time — only meaningful before
  // expandGamesIntoGroups() runs; once a game is split into groups, every
  // group's own seatedPlayers already reflects who's actually assigned to it.
  waitlistedPlayers?: string[];
  effectiveDurationMinutes: number;
  rawMaxPlaytime: number;
  complexity?: string;
  // Set only on entries produced by expandGamesIntoGroups() — identifies a
  // synthetic per-group entry and which real suggestion it split from.
  groupInfo?: { sourceGameId: string; groupIndex: number; groupCount: number };
}

export interface ScheduleAssignment {
  gameId: string;
  table: number; // 1-indexed — each table runs its own independent timeline
  startMinutes: number; // minutes from event start
  endMinutes: number;
  // How many times this game was played back-to-back at its table (opportunistic
  // repeat-fill for short games, see applyRepeatFill()). 1 = played once.
  playCount: number;
  // True if this game's start or end is projected to run past the event's end time.
  mayNotFinish: boolean;
  // Set when this game's start was gated by a seated player still finishing
  // an earlier game, rather than by table availability — the whole game
  // waits on them, not just that one player, so this is surfaced on the
  // game's own schedule line (see buildScheduleEmbed) rather than framed as
  // a private "this one player is running late" note.
  delayedByPlayerId?: string;
  // The subset of the game's seated players this instance is actually built
  // around — may be fewer than every signed-up player when the game reached
  // its quorum threshold (see quorumThreshold()) before everyone was ready.
  // Anyone signed up but left out is still free the whole time (never marked
  // busy by this game) and shown as able to join once free (see
  // buildScheduleEmbed).
  attendingPlayerIds: string[];
}

export interface UnscheduledGame {
  gameId: string;
  reason: string;
}

// Only 1 signed-up player at lock time — too speculative to reserve real
// table-time for (a handful of these could otherwise crowd out real signups'
// access to tables all day), but not dropped either: someone may still set up
// and recruit walk-ups through the day (this is exactly how a real event's
// Firefly table went from 1 signup to a full game). Shown as its own
// no-time/no-table "open to walk-ups" entry instead of competing in the
// per-table placement loop.
export interface WalkUpGame {
  gameId: string;
}

export interface PlayerWarning {
  userId: string;
  reason: string;
}

export interface ScheduleResult {
  assignments: ScheduleAssignment[];
  unscheduled: UnscheduledGame[];
  // 1-signup games — never occupy a table/timeline slot, see WalkUpGame.
  walkUps: WalkUpGame[];
  totalDurationMinutes: number;
  fitsInWindow: boolean;
  // Players seated in 2+ games where at least one is at risk of not
  // happening (unscheduled) or not finishing in time (mayNotFinish) — a
  // best-effort heads-up, not a hard guarantee (see scheduleGames()).
  playerWarnings: PlayerWarning[];
  // Every group (1..N) of every input game, split or not (see
  // expandGamesIntoGroups) — the source of truth for resolving an
  // assignment's/warning's title and roster, since a split game's groups
  // don't correspond 1:1 with the original GameSuggestion list passed in.
  resolvedGames: SchedulableGame[];
}

export function complexityBufferMinutes(
  complexity: string | undefined,
  config: Pick<GuildConfig, 'lightBufferMinutes' | 'mediumBufferMinutes' | 'heavyBufferMinutes'>,
): number {
  switch (complexity) {
    case 'Light':
      return config.lightBufferMinutes;
    case 'Medium':
      return config.mediumBufferMinutes;
    case 'Heavy':
      return config.heavyBufferMinutes;
    default:
      // No complexity set — fall back to the middle tier rather than assuming
      // no teach/overflow time is needed at all.
      return config.mediumBufferMinutes;
  }
}

export function toSchedulableGame(
  game: GameSuggestion,
  config: Pick<GuildConfig, 'lightBufferMinutes' | 'mediumBufferMinutes' | 'heavyBufferMinutes'>,
): SchedulableGame {
  return {
    id: game.id,
    title: game.title,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    suggestedPlayers: game.suggestedPlayers,
    seatedPlayers: game.seats,
    waitlistedPlayers: game.waitlist ?? [],
    // Complexity buffer alone accounts for a bigger table taking longer —
    // no separate player-count scaling on top of it (removed: double-counted
    // the same effect the buffer already covers).
    effectiveDurationMinutes: game.maxPlaytime + complexityBufferMinutes(game.complexity, config),
    rawMaxPlaytime: game.maxPlaytime,
    complexity: game.complexity,
  };
}

/**
 * Opportunistically repeats the LAST game placed at each table, back-to-back,
 * once nothing else is ready to be scheduled there — the only slot with
 * genuinely trailing dead time that doesn't disturb anything already placed.
 * Only applies within a fixed event window (an open-ended event has no edge
 * to fill up against) and only for short games (raw playtime under
 * SHORT_GAME_MAX_RAW_MINUTES) — repeats skip the complexity buffer, since the
 * group already knows the game.
 */
function applyRepeatFill(
  assignments: ScheduleAssignment[],
  gameById: Map<string, SchedulableGame>,
  windowMinutes: number,
  maxGameRepeats: number,
): void {
  if (!Number.isFinite(windowMinutes)) return;

  const lastAssignmentByTable = new Map<number, ScheduleAssignment>();
  for (const a of assignments) {
    const existing = lastAssignmentByTable.get(a.table);
    if (!existing || a.endMinutes > existing.endMinutes) lastAssignmentByTable.set(a.table, a);
  }

  for (const last of lastAssignmentByTable.values()) {
    const game = gameById.get(last.gameId);
    if (!game) continue;
    if (game.rawMaxPlaytime <= 0 || game.rawMaxPlaytime >= SHORT_GAME_MAX_RAW_MINUTES) continue;

    // Repeating this game keeps its attending players occupied longer than
    // originally planned when they were placed here — don't extend past the
    // start of another assignment one of them is also attending, or the
    // repeat would double-book that player.
    let repeatCap = windowMinutes;
    for (const other of assignments) {
      if (other === last) continue;
      if (other.startMinutes < last.endMinutes) continue;
      if (other.attendingPlayerIds.some((p) => last.attendingPlayerIds.includes(p))) {
        repeatCap = Math.min(repeatCap, other.startMinutes);
      }
    }

    let plays = 1;
    let cursor = last.endMinutes;
    while (plays < maxGameRepeats) {
      const nextEnd = cursor + game.rawMaxPlaytime;
      if (nextEnd > repeatCap) break;
      cursor = nextEnd;
      plays++;
    }
    if (plays > 1) {
      last.playCount = plays;
      last.endMinutes = cursor;
      last.mayNotFinish = cursor > windowMinutes;
    }
  }
}

function computePlayerWarnings(
  games: SchedulableGame[],
  assignments: ScheduleAssignment[],
  unscheduled: UnscheduledGame[],
): PlayerWarning[] {
  const assignmentByGame = new Map(assignments.map((a) => [a.gameId, a]));
  const unscheduledIds = new Set(unscheduled.map((u) => u.gameId));
  const gameById = new Map(games.map((g) => [g.id, g]));

  const gamesByPlayer = new Map<string, string[]>();
  for (const g of games) {
    for (const p of g.seatedPlayers) {
      const list = gamesByPlayer.get(p) ?? [];
      list.push(g.id);
      gamesByPlayer.set(p, list);
    }
  }

  const warnings: PlayerWarning[] = [];
  for (const [userId, gameIds] of gamesByPlayer) {
    if (gameIds.length < 2) continue;
    // Name the specific game(s) actually at risk, not just a generic count —
    // "1 of 5" and "1 of 2" read identically even though a single late/short
    // game out of five is a very different situation from one of only two.
    const atRiskTitles = gameIds
      .filter((id) => unscheduledIds.has(id) || assignmentByGame.get(id)?.mayNotFinish)
      .map((id) => gameById.get(id)?.title ?? 'Unknown game');
    if (atRiskTitles.length > 0) {
      const list = atRiskTitles.map((t) => `**${t}**`).join(', ');
      const verb = atRiskTitles.length === 1 ? 'may' : 'may each';
      warnings.push({
        userId,
        reason: `seated in ${gameIds.length} games — ${list} ${verb} not happen as scheduled`,
      });
    }
  }
  return warnings;
}

/**
 * How many of a game's seated players need to be ready before it can start —
 * the "quorum." Only ever based on the recommended player count (BGG's
 * community "best with N players" figure) — deliberately NOT minPlayers,
 * since plenty of games technically support 1-2 players but don't actually
 * play well that low (a minPlayers-based fallback would start most games
 * with just their single readiest signup and treat everyone else as
 * optional, which is worse than the problem this is meant to solve). When
 * there's no recommended count to go by, fall back to waiting for every
 * signed-up player, same as before this feature existed. Never below the
 * hard minPlayers floor, and never above how many people actually signed up
 * (there's no one else to wait for).
 *
 * Trimming down to the quorum leaves the rest of the seated players
 * "excluded" (see ScheduleAssignment.attendingPlayerIds) — free the whole
 * time, but with no path back into this specific game, since it only runs
 * once. That's fine when the excluded remainder is big enough to plausibly
 * be its own group; it's not fine when it's a single stray signup (or any
 * remainder under minPlayers) with nowhere else to go — that person signed
 * up for this game and would simply never get seated in it. So quorum only
 * trims when doing so wouldn't strand an unredeemable remainder; otherwise
 * it falls back to waiting for everyone, same as the no-suggestedPlayers case.
 */
function quorumThreshold(game: SchedulableGame): number {
  if (game.suggestedPlayers == null) return game.seatedPlayers.length;
  const target = Math.min(Math.max(game.suggestedPlayers, game.minPlayers), game.seatedPlayers.length);
  const excluded = game.seatedPlayers.length - target;
  if (excluded > 0 && excluded < game.minPlayers) return game.seatedPlayers.length;
  return target;
}

// Only Light-complexity games may use a reserved flex table (see
// flexTableCount) — Medium/Heavy and unrated games are deliberately NOT
// eligible, since an unrated game's real weight isn't known.
function isFlexEligible(game: Pick<SchedulableGame, 'complexity'>): boolean {
  return game.complexity === 'Light';
}

/**
 * For each game, how many OTHER games in the list share at least one seated
 * player with it — a game entangled with many others is more schedule-
 * critical than a merely long one, regardless of its own duration. This is
 * RCPSP's "Most Total Successors" priority rule, adapted to a setting with
 * no precedence constraints but shared (player) resources — see the
 * `most-shared-players` placement pass in scheduleGames(). Dedup by game,
 * not by shared-player count: sharing 2 players with the same other game
 * still only counts as one conflict.
 */
export function computeSharedPlayerConflictDegree(
  games: Pick<SchedulableGame, 'id' | 'seatedPlayers'>[],
): Map<string, number> {
  const gameIdsByPlayer = new Map<string, Set<string>>();
  for (const g of games) {
    for (const p of g.seatedPlayers) {
      const ids = gameIdsByPlayer.get(p) ?? new Set<string>();
      ids.add(g.id);
      gameIdsByPlayer.set(p, ids);
    }
  }

  const degree = new Map<string, number>();
  for (const g of games) {
    const conflicting = new Set<string>();
    for (const p of g.seatedPlayers) {
      for (const otherId of gameIdsByPlayer.get(p) ?? []) {
        if (otherId !== g.id) conflicting.add(otherId);
      }
    }
    degree.set(g.id, conflicting.size);
  }
  return degree;
}

// Synthetic id for a split game's group 2+ (see expandGamesIntoGroups) —
// group 1 keeps the real id so any lookup that isn't split-aware still
// resolves to something correct.
export function makeGroupGameId(baseId: string, groupIndex: number): string {
  return groupIndex === 1 ? baseId : `${baseId}::g${groupIndex}`;
}

export function baseGameId(id: string): string {
  const i = id.indexOf('::g');
  return i === -1 ? id : id.slice(0, i);
}

/**
 * How many groups a pool of `total` interested players should split into so
 * every group fits within `maxPlayers` and none falls below `minPlayers` —
 * sized as evenly as possible (e.g. 9 people at maxPlayers 4 → 3/3/3, never
 * 4/4/1, which would strand the last group below most games' minimum).
 * `maxPlayers` alone fixes the fewest groups that can possibly work
 * (`ceil(total / maxPlayers)`) — there's no "try fewer, bigger groups"
 * fallback, since fewer groups only means each one grows past maxPlayers.
 * Returns `[total]` (a single group — meaning "don't split") when even that
 * fewest-groups split can't clear minPlayers (e.g. maxPlayers 6, minPlayers
 * 4, total 7) — a real but narrow gap: the excess simply stays waitlisted,
 * same as before this feature existed.
 */
export function computeSplitGroupSizes(total: number, minPlayers: number, maxPlayers: number): number[] {
  if (maxPlayers <= 0 || total <= maxPlayers) return [total];

  const groupCount = Math.ceil(total / maxPlayers);
  const base = Math.floor(total / groupCount);
  const remainder = total % groupCount;
  if (base < minPlayers) return [total];

  return [...Array(remainder).fill(base + 1), ...Array(groupCount - remainder).fill(base)];
}

interface ChainedGroup {
  gameId: string;
  players: string[];
}

interface ExpandedGames {
  // Fed into the up-front viable/walkUps/unscheduled filter and the 3
  // placement passes — one entry per real game, or (for a split game) one
  // entry for its group 1, reserving the whole chain's duration.
  placementGames: SchedulableGame[];
  // Groups 2+ for every split game, keyed by the source game's real id —
  // never enter the placement passes directly; chainRemainingGroups() places
  // them after the fact, onto group 1's table.
  chainedGroupsByGameId: Map<string, ChainedGroup[]>;
  // Every group (1..N) of every game, split or not — the full picture for
  // anything that needs to resolve a title/roster by id (buildScheduleEmbed,
  // computePlayerWarnings) or walk every real seat/signup regardless of
  // whether it made it into a scheduled session.
  gameById: Map<string, SchedulableGame>;
}

/**
 * A game with more real interest (seats + waitlist) than fits at one table
 * gets split into evenly-sized groups (see computeSplitGroupSizes) so
 * everyone who wants to play actually gets a real table session instead of a
 * permanent spot on the waitlist. Only group 1 competes for a table in the
 * normal placement passes — it reserves the FULL chain's duration up front
 * (perGroupDuration * groupCount) so nothing else gets scheduled into the
 * table gap meant for the remaining groups; chainRemainingGroups() then
 * fills that reserved block in for real once placement finishes (see
 * scheduleGames()). A game that doesn't need splitting passes through
 * completely unchanged.
 */
function expandGamesIntoGroups(games: SchedulableGame[]): ExpandedGames {
  const placementGames: SchedulableGame[] = [];
  const chainedGroupsByGameId = new Map<string, ChainedGroup[]>();
  const gameById = new Map<string, SchedulableGame>();

  for (const game of games) {
    const pool = [...game.seatedPlayers, ...(game.waitlistedPlayers ?? [])];

    if (game.maxPlayers <= 0 || pool.length <= game.maxPlayers) {
      // Everyone (seats + waitlist) already fits at one table — no need to
      // split, but merge them into a single group so a waitlisted player
      // still actually gets scheduled, not silently left inert.
      const merged =
        pool.length === game.seatedPlayers.length ? game : { ...game, seatedPlayers: pool, waitlistedPlayers: [] };
      placementGames.push(merged);
      gameById.set(merged.id, merged);
      continue;
    }

    const sizes = computeSplitGroupSizes(pool.length, game.minPlayers, game.maxPlayers);
    if (sizes.length <= 1) {
      // No valid multi-group split exists — leave unchanged; the excess
      // stays waitlisted, same as before this feature existed.
      placementGames.push(game);
      gameById.set(game.id, game);
      continue;
    }

    let cursor = 0;
    const groupRosters = sizes.map((size) => {
      const chunk = pool.slice(cursor, cursor + size);
      cursor += size;
      return chunk;
    });

    const perGroupDuration = game.effectiveDurationMinutes;
    const groupCount = groupRosters.length;

    const primary: SchedulableGame = {
      ...game,
      seatedPlayers: groupRosters[0],
      // A group's own roster was already deliberately sized (see
      // computeSplitGroupSizes) — quorumThreshold trimming it further could
      // exclude someone from the specific group they were assigned to, with
      // nowhere else to go. Clearing suggestedPlayers here makes
      // quorumThreshold fall back to requiring the group's full roster,
      // same as chainRemainingGroups already does for groups 2+.
      suggestedPlayers: null,
      waitlistedPlayers: [],
      effectiveDurationMinutes: perGroupDuration * groupCount,
      groupInfo: { sourceGameId: game.id, groupIndex: 1, groupCount },
    };
    placementGames.push(primary);
    gameById.set(primary.id, primary);

    const chained: ChainedGroup[] = [];
    for (let i = 1; i < groupRosters.length; i++) {
      const groupIndex = i + 1;
      const groupId = makeGroupGameId(game.id, groupIndex);
      const groupGame: SchedulableGame = {
        ...game,
        id: groupId,
        title: `${game.title} (Group ${groupIndex})`,
        seatedPlayers: groupRosters[i],
        suggestedPlayers: null,
        waitlistedPlayers: [],
        effectiveDurationMinutes: perGroupDuration,
        groupInfo: { sourceGameId: game.id, groupIndex, groupCount },
      };
      gameById.set(groupId, groupGame);
      chained.push({ gameId: groupId, players: groupRosters[i] });
    }
    chainedGroupsByGameId.set(game.id, chained);
  }

  return { placementGames, chainedGroupsByGameId, gameById };
}

/**
 * Places groups 2+ of a split game (see expandGamesIntoGroups) onto the SAME
 * table as group 1, back-to-back, in order — reusing one table sequentially
 * rather than spreading across several, since there's normally only one
 * physical copy of a given game. Runs once per pass-candidate, after that
 * pass's core placement loop finishes and before applyRepeatFill (so
 * repeat-fill correctly sees whichever chained group ends up truly last on a
 * table). Each group requires its own FULL roster to be ready before it
 * starts — no partial-quorum trimming within an already-rebalanced group, so
 * nobody deliberately assigned to a group is ever silently dropped from it.
 */
function chainRemainingGroups(
  assignments: ScheduleAssignment[],
  gameById: Map<string, SchedulableGame>,
  chainedGroupsByGameId: Map<string, ChainedGroup[]>,
  personBreakMinutes: number,
  windowMinutes: number,
  horizonMinutes: number,
  unscheduled: UnscheduledGame[],
): void {
  for (const [sourceGameId, groups] of chainedGroupsByGameId) {
    const primary = assignments.find((a) => a.gameId === sourceGameId);
    if (!primary) {
      for (const group of groups) {
        unscheduled.push({
          gameId: group.gameId,
          reason: "the first group for this game couldn't be scheduled",
        });
      }
      continue;
    }

    // Group 1 reserved the FULL chain's duration up front (see
    // expandGamesIntoGroups) so nothing else could claim this table in the
    // meantime — shrink it back to its own real single-group length now that
    // the rest of the chain is about to be placed for real.
    const perGroupDuration = gameById.get(groups[0].gameId)!.effectiveDurationMinutes;
    primary.endMinutes = primary.startMinutes + perGroupDuration;
    primary.mayNotFinish = primary.endMinutes > windowMinutes;

    const readyAt = (p: string): number => {
      let latest = 0;
      for (const a of assignments) {
        if (a.attendingPlayerIds.includes(p)) latest = Math.max(latest, a.endMinutes);
      }
      return latest > 0 ? latest + personBreakMinutes : 0;
    };

    let cursor = primary.endMinutes;
    for (const group of groups) {
      let groupReadyAt = 0;
      for (const p of group.players) groupReadyAt = Math.max(groupReadyAt, readyAt(p));
      const start = Math.max(cursor, groupReadyAt);

      // Only name a specific player as "the reason" this group waited when
      // the table itself was already free and they were the sole latest
      // among this group's own players — same convention as everywhere else
      // in this file.
      let delayedByPlayerId: string | undefined;
      if (groupReadyAt > 0 && groupReadyAt >= cursor) {
        const atMax = group.players.filter((p) => readyAt(p) === groupReadyAt);
        if (atMax.length === 1) delayedByPlayerId = atMax[0];
      }

      if (start > horizonMinutes) {
        unscheduled.push({ gameId: group.gameId, reason: 'not enough time left in the event window' });
        cursor = start;
        continue;
      }

      const end = start + perGroupDuration;
      assignments.push({
        gameId: group.gameId,
        table: primary.table,
        startMinutes: start,
        endMinutes: end,
        playCount: 1,
        mayNotFinish: end > windowMinutes,
        delayedByPlayerId,
        attendingPlayerIds: group.players,
      });
      cursor = end;
    }
  }
}

interface PlacementPassResult {
  assignments: ScheduleAssignment[];
  unscheduled: UnscheduledGame[];
}

interface TableSearchResult {
  table: number;
  start: number;
  gatedByPlayer?: string;
  attending: string[];
}

/**
 * Finds the earliest table a single already-chosen game can start on, given
 * the current (mutable, per-pass) table/player state. Shared by both
 * fixed-order passes (`runFixedOrderPass`) — the dynamic earliest-ready pass
 * keeps its own inlined copy of this logic (see runEarliestReadyPass) since
 * its duration tie-break is interleaved across games, not just within one.
 */
function findBestTableForGame(
  game: SchedulableGame,
  gameById: Map<string, SchedulableGame>,
  tableCap: number,
  regularTableCap: number,
  heavyBreakMinutes: number,
  personAvailable: (p: string) => number,
  tableFree: number[],
  tableLastGameId: (string | undefined)[],
  tableBookedMinutes: number[],
): TableSearchResult {
  const threshold = quorumThreshold(game);
  const sortedByReadiness = [...game.seatedPlayers].sort(
    (a, b) => personAvailable(a) - personAvailable(b),
  );
  const attending = sortedByReadiness.slice(0, threshold);
  let playersReadyAt = 0;
  for (const p of attending) playersReadyAt = Math.max(playersReadyAt, personAvailable(p));

  let gatedByPlayer: string | undefined;
  if (playersReadyAt > 0) {
    const atMax = attending.filter((p) => personAvailable(p) === playersReadyAt);
    if (atMax.length === 1) gatedByPlayer = atMax[0];
  }

  // Light games may use any table; everything else is restricted to the
  // regular (non-reserved) pool, even if a flex table is sitting idle —
  // that idle time is the deliberate cost of guaranteeing a lane for
  // players who only want quick/light games.
  const tableLimit = isFlexEligible(game) ? tableCap : regularTableCap;

  let bestTable = -1;
  let bestStart = Number.POSITIVE_INFINITY;
  for (let t = 0; t < tableLimit; t++) {
    const lastGameId = tableLastGameId[t];
    const lastGame = lastGameId ? gameById.get(lastGameId) : undefined;
    const heavyBreak =
      lastGame?.complexity === 'Heavy' && game.complexity === 'Heavy' ? heavyBreakMinutes : 0;
    const candidateStart = Math.max(tableFree[t], playersReadyAt) + heavyBreak;

    let better = candidateStart < bestStart;
    if (!better && candidateStart === bestStart) {
      // Same start time — most often several equally-idle tables. Prefer
      // whichever has hosted the least game-time so far, so load spreads
      // across tables instead of always defaulting to whichever one this
      // loop happens to reach first.
      better = tableBookedMinutes[t] < tableBookedMinutes[bestTable];
    }
    if (better) {
      bestStart = candidateStart;
      bestTable = t;
    }
  }

  return { table: bestTable, start: bestStart, gatedByPlayer, attending };
}

/**
 * Places games one at a time in a FIXED order (the caller decides that order —
 * longest-duration-first or most-shared-players-first, see scheduleGames()),
 * each claiming its own earliest available table given whatever's already
 * been placed. Unlike the dynamic earliest-ready pass, games never compete
 * for "who goes next" — the order is fixed up front — so a game whose start
 * falls outside the horizon only removes *that* game, since a later
 * (possibly shorter) game in the order may still fit comfortably.
 */
function runFixedOrderPass(
  orderedGames: SchedulableGame[],
  gameById: Map<string, SchedulableGame>,
  tableCap: number,
  regularTableCap: number,
  heavyBreakMinutes: number,
  personBreakMinutes: number,
  horizonMinutes: number,
  windowMinutes: number,
): PlacementPassResult {
  const tableFree: number[] = new Array(tableCap).fill(0);
  const tableLastGameId: (string | undefined)[] = new Array(tableCap).fill(undefined);
  const tableBookedMinutes: number[] = new Array(tableCap).fill(0);
  const personNextAvailable = new Map<string, number>();
  const personAvailable = (p: string): number => personNextAvailable.get(p) ?? 0;

  const assignments: ScheduleAssignment[] = [];
  const unscheduled: UnscheduledGame[] = [];

  for (const game of orderedGames) {
    const { table: bestTable, start: bestStart, gatedByPlayer, attending } = findBestTableForGame(
      game,
      gameById,
      tableCap,
      regularTableCap,
      heavyBreakMinutes,
      personAvailable,
      tableFree,
      tableLastGameId,
      tableBookedMinutes,
    );

    if (bestTable === -1) continue; // no tables at all — shouldn't happen

    if (bestStart > horizonMinutes) {
      unscheduled.push({ gameId: game.id, reason: 'not enough time left in the event window' });
      continue; // a later, possibly shorter, game in the order may still fit
    }

    const end = bestStart + game.effectiveDurationMinutes;
    assignments.push({
      gameId: game.id,
      table: bestTable + 1,
      startMinutes: bestStart,
      endMinutes: end,
      playCount: 1,
      mayNotFinish: end > windowMinutes,
      delayedByPlayerId: gatedByPlayer,
      attendingPlayerIds: attending,
    });
    tableFree[bestTable] = end;
    tableLastGameId[bestTable] = game.id;
    tableBookedMinutes[bestTable] += game.effectiveDurationMinutes;
    for (const p of attending) {
      personNextAvailable.set(p, end + personBreakMinutes);
    }
  }

  return { assignments, unscheduled };
}

/**
 * Today's default: dynamically recomputes readiness for every remaining game
 * each iteration and greedily commits to whichever (game, table) pair can
 * start soonest overall — ties broken by longer duration, then by whichever
 * table has hosted the least game-time so far. Kept as an exact, untouched
 * copy of the original single-pass algorithm (rather than rebuilt on top of
 * findBestTableForGame) since its duration tie-break is interleaved across
 * games, not contained within one — decomposing it isn't worth the risk.
 */
function runEarliestReadyPass(
  viable: SchedulableGame[],
  gameById: Map<string, SchedulableGame>,
  tableCap: number,
  regularTableCap: number,
  heavyBreakMinutes: number,
  personBreakMinutes: number,
  horizonMinutes: number,
  windowMinutes: number,
): PlacementPassResult {
  const tableFree: number[] = new Array(tableCap).fill(0);
  const tableLastGameId: (string | undefined)[] = new Array(tableCap).fill(undefined);
  const tableBookedMinutes: number[] = new Array(tableCap).fill(0);
  const personNextAvailable = new Map<string, number>();
  const personAvailable = (p: string): number => personNextAvailable.get(p) ?? 0;

  const assignments: ScheduleAssignment[] = [];
  const unscheduled: UnscheduledGame[] = [];
  const remaining = new Set(viable.map((g) => g.id));

  while (remaining.size > 0) {
    let bestGameId: string | undefined;
    let bestTable = -1;
    let bestStart = Number.POSITIVE_INFINITY;
    let bestDuration = -1;
    let bestGatingPlayerId: string | undefined;
    let bestAttending: string[] = [];

    for (const gameId of remaining) {
      const game = gameById.get(gameId)!;

      // Only wait for enough players to meet quorum (the recommended count,
      // falling back to the bare minimum) — not every signed-up player. The
      // "attending" subset is whichever seated players are ready soonest;
      // anyone left over is still signed up, but isn't part of this
      // instance's estimate at all (see buildScheduleEmbed's "can join once
      // free" note) and is never marked busy by it.
      const threshold = quorumThreshold(game);
      const sortedByReadiness = [...game.seatedPlayers].sort(
        (a, b) => personAvailable(a) - personAvailable(b),
      );
      const attending = sortedByReadiness.slice(0, threshold);
      let playersReadyAt = 0;
      for (const p of attending) playersReadyAt = Math.max(playersReadyAt, personAvailable(p));

      // A specific player only counts as "the reason" this game waited when
      // they're the *sole* latest among the players actually attending —
      // comparing against just this instance's own group, not against the
      // earliest table anywhere in the venue (which fired for almost any
      // returning player, even when teammates were on the exact same normal
      // break-driven schedule and nobody was actually held up), and not
      // against a signed-up player who isn't even part of this instance.
      let gatedByPlayer: string | undefined;
      if (playersReadyAt > 0) {
        const atMax = attending.filter((p) => personAvailable(p) === playersReadyAt);
        if (atMax.length === 1) gatedByPlayer = atMax[0];
      }

      // Light games may use any table; everything else is restricted to the
      // regular (non-reserved) pool, even if a flex table is sitting idle —
      // that idle time is the deliberate cost of guaranteeing a lane for
      // players who only want quick/light games.
      const tableLimit = isFlexEligible(game) ? tableCap : regularTableCap;

      for (let t = 0; t < tableLimit; t++) {
        const lastGameId = tableLastGameId[t];
        const lastGame = lastGameId ? gameById.get(lastGameId) : undefined;
        const heavyBreak =
          lastGame?.complexity === 'Heavy' && game.complexity === 'Heavy' ? heavyBreakMinutes : 0;
        const candidateStart = Math.max(tableFree[t], playersReadyAt) + heavyBreak;

        let better = candidateStart < bestStart;
        if (!better && candidateStart === bestStart) {
          if (game.effectiveDurationMinutes !== bestDuration) {
            better = game.effectiveDurationMinutes > bestDuration;
          } else {
            // Same start time AND same duration — most often the exact same
            // game being checked against several equally-idle tables.
            // Prefer whichever has hosted the least game-time so far, so load
            // spreads across tables instead of always defaulting to whichever
            // one this loop happens to reach first.
            better = tableBookedMinutes[t] < tableBookedMinutes[bestTable];
          }
        }

        if (better) {
          bestStart = candidateStart;
          bestTable = t;
          bestGameId = gameId;
          bestDuration = game.effectiveDurationMinutes;
          bestGatingPlayerId = gatedByPlayer;
          bestAttending = attending;
        }
      }
    }

    if (bestGameId === undefined || bestTable === -1) break; // no tables at all — shouldn't happen

    if (bestStart > horizonMinutes) {
      for (const gameId of remaining) {
        unscheduled.push({ gameId, reason: 'not enough time left in the event window' });
      }
      break;
    }

    const game = gameById.get(bestGameId)!;
    const end = bestStart + game.effectiveDurationMinutes;
    assignments.push({
      gameId: bestGameId,
      table: bestTable + 1,
      startMinutes: bestStart,
      endMinutes: end,
      playCount: 1,
      mayNotFinish: end > windowMinutes,
      delayedByPlayerId: bestGatingPlayerId,
      attendingPlayerIds: bestAttending,
    });
    tableFree[bestTable] = end;
    tableLastGameId[bestTable] = bestGameId;
    tableBookedMinutes[bestTable] += game.effectiveDurationMinutes;
    // Only the attending subset is occupied by this game — anyone signed up
    // but left out (see quorumThreshold) stays free for another suggestion,
    // or simply remains available if this was their only signup.
    for (const p of bestAttending) {
      personNextAvailable.set(p, end + personBreakMinutes);
    }
    remaining.delete(bestGameId);
  }

  return { assignments, unscheduled };
}

interface FinishedCandidate {
  name: string;
  assignments: ScheduleAssignment[];
  unscheduled: UnscheduledGame[];
  totalDurationMinutes: number;
  playerWarnings: PlayerWarning[];
}

function isBetterCandidate(a: FinishedCandidate, b: FinishedCandidate): boolean {
  if (a.unscheduled.length !== b.unscheduled.length) return a.unscheduled.length < b.unscheduled.length;
  if (a.totalDurationMinutes !== b.totalDurationMinutes) return a.totalDurationMinutes < b.totalDurationMinutes;
  return a.playerWarnings.length < b.playerWarnings.length;
}

/**
 * Continuous per-table/per-person scheduler: each table runs its own
 * independent timeline (freed the instant its current game ends, not
 * synchronized to any shared "round" boundary), and each player has their
 * own next-available clock (their last game's end time plus a configured
 * break) gating when their next game can start.
 *
 * This is a heuristic, not an optimal solver — same NP-hard-in-general
 * caveat as before (pack games onto tables without double-booking a shared
 * player, now also respecting per-person breaks). It's a variant of the
 * Resource-Constrained Project Scheduling Problem (no precedence
 * constraints, but hard renewable-resource constraints: tables have
 * capacity N, each player has capacity 1). RCPSP research is explicit that
 * no single greedy priority rule dominates across problem instances — we
 * confirmed this ourselves this session (a longest-game-first rule was
 * tried and reverted, see TESTING.md §4.7: it protected long games in
 * isolated cases but cascaded badly on a real, densely-connected event) —
 * so rather than commit to one rule, this runs a small **multi-pass**
 * construction: three deterministic placement strategies (earliest-ready,
 * longest-duration-first, most-shared-players-first), each producing a full
 * candidate schedule from independent state, scored by (1) fewest
 * unscheduled games, (2) lowest total span, (3) fewest at-risk players —
 * whichever candidate wins is returned. Ties keep the earliest-tried pass,
 * so any event with no real contention (the common case) still produces
 * exactly today's familiar output.
 */
export function scheduleGames(
  games: SchedulableGame[],
  tableCount: number,
  windowMinutes: number,
  config: Pick<
    GuildConfig,
    'heavyGameBreakMinutes' | 'maxGameRepeats' | 'breakMinutesBetweenGames' | 'flexTableCount'
  >,
): ScheduleResult {
  const unscheduled: UnscheduledGame[] = [];
  const walkUps: WalkUpGame[] = [];

  // A game with more real interest (seats + waitlist) than fits at one table
  // gets split into evenly-sized groups here, before anything else runs — see
  // expandGamesIntoGroups(). A game that doesn't need splitting passes
  // through unchanged.
  const { placementGames, chainedGroupsByGameId, gameById } = expandGamesIntoGroups(games);

  const viable = placementGames.filter((g) => {
    if (g.seatedPlayers.length === 0) {
      unscheduled.push({ gameId: g.id, reason: `only 0/${g.minPlayers} minimum players seated` });
      return false;
    }
    if (g.seatedPlayers.length === 1) {
      // Too speculative to reserve a real table/time slot — see WalkUpGame.
      // Never enters the table-placement loop at all, so it can't crowd out
      // a real signup's access to a table.
      walkUps.push({ gameId: g.id });
      return false;
    }
    if (g.seatedPlayers.length < g.minPlayers) {
      unscheduled.push({
        gameId: g.id,
        reason: `only ${g.seatedPlayers.length}/${g.minPlayers} minimum players seated`,
      });
      return false;
    }
    return true;
  });

  const heavyBreakMinutes = Math.max(0, config.heavyGameBreakMinutes);
  const personBreakMinutes = Math.max(0, config.breakMinutesBetweenGames);

  const tableCap = Math.max(1, tableCount);
  // Reserve the LAST N table indices exclusively for Light-complexity games
  // (see isFlexEligible/flexTableCount) — always leaves at least 1 regular
  // table, however flexTableCount is configured relative to the actual
  // table count.
  const regularTableCap = Math.max(1, tableCap - Math.max(0, config.flexTableCount));

  // Safety horizon so a large backlog with no realistic room left doesn't
  // place things arbitrarily far into overtime — anything that can't start
  // within this window is bucketed as unscheduled instead.
  const horizonMinutes = Number.isFinite(windowMinutes) ? windowMinutes * 2 : Number.POSITIVE_INFINITY;

  const byDurationDesc = [...viable].sort(
    (a, b) => b.effectiveDurationMinutes - a.effectiveDurationMinutes,
  );
  const conflictDegree = computeSharedPlayerConflictDegree(viable);
  const byConflictDesc = [...viable].sort(
    (a, b) => (conflictDegree.get(b.id) ?? 0) - (conflictDegree.get(a.id) ?? 0),
  );

  const passes: Array<{ name: string; run: () => PlacementPassResult }> = [
    {
      name: 'earliest-ready',
      run: () =>
        runEarliestReadyPass(
          viable, gameById, tableCap, regularTableCap, heavyBreakMinutes,
          personBreakMinutes, horizonMinutes, windowMinutes,
        ),
    },
    {
      name: 'longest-duration',
      run: () =>
        runFixedOrderPass(
          byDurationDesc, gameById, tableCap, regularTableCap, heavyBreakMinutes,
          personBreakMinutes, horizonMinutes, windowMinutes,
        ),
    },
    {
      name: 'most-shared-players',
      run: () =>
        runFixedOrderPass(
          byConflictDesc, gameById, tableCap, regularTableCap, heavyBreakMinutes,
          personBreakMinutes, horizonMinutes, windowMinutes,
        ),
    },
  ];

  const expandedGames = [...gameById.values()];

  let best: FinishedCandidate | undefined;
  for (const pass of passes) {
    const { assignments, unscheduled: passUnscheduled } = pass.run();
    const combinedUnscheduled = [...unscheduled, ...passUnscheduled];
    // Chain any split game's groups 2+ onto group 1's table before
    // repeat-fill runs, so repeat-fill correctly sees whichever chained
    // group ends up truly last on a table (see chainRemainingGroups).
    chainRemainingGroups(
      assignments,
      gameById,
      chainedGroupsByGameId,
      personBreakMinutes,
      windowMinutes,
      horizonMinutes,
      combinedUnscheduled,
    );
    // Repeat-fill mutates assignments in place and isn't idempotent (it
    // always resets play count to 1 and extends from the current
    // endMinutes), so it must run exactly once per candidate, before this
    // candidate is scored or considered final.
    applyRepeatFill(assignments, gameById, windowMinutes, Math.max(1, config.maxGameRepeats));
    const totalDurationMinutes = assignments.reduce((max, a) => Math.max(max, a.endMinutes), 0);
    const playerWarnings = computePlayerWarnings(expandedGames, assignments, combinedUnscheduled);

    const candidate: FinishedCandidate = {
      name: pass.name,
      assignments,
      unscheduled: combinedUnscheduled,
      totalDurationMinutes,
      playerWarnings,
    };
    if (!best || isBetterCandidate(candidate, best)) best = candidate;
  }

  console.log(`[scheduleGames] chose "${best!.name}" placement pass (of ${passes.length} tried)`);

  return {
    assignments: best!.assignments,
    unscheduled: best!.unscheduled,
    walkUps,
    totalDurationMinutes: best!.totalDurationMinutes,
    fitsInWindow: best!.totalDurationMinutes <= windowMinutes,
    playerWarnings: best!.playerWarnings,
    resolvedGames: expandedGames,
  };
}

export function minutesToUnix(eventStartISO: string, minutes: number): number {
  return Math.floor(new Date(eventStartISO).getTime() / 1000) + Math.round(minutes * 60);
}

// Rounds a *displayed* minute value up to the next quarter-hour (:00/:15/:30/
// :45) — always up, never down or nearest, so a game is never shown as
// available before it actually is. Purely cosmetic: the scheduler's own
// placement/quorum/chaining math (see scheduleGames()) always runs on the
// exact minute internally — this only affects what gets posted to Discord,
// so a host or player can plan around a clean "starts at 2:15" instead of
// an arbitrary "2:19".
function roundUpToQuarterHour(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

// Discord caps a single embed field's value at 1024 characters and a whole
// embed at 25 fields — a busy event (many tables, many multi-game players
// flagged in "May not get to play everything") can genuinely blow past
// either, which would otherwise throw when building the embed rather than
// degrading gracefully. Leave headroom and truncate defensively, same
// pattern as USAGE_CONTENT_BUDGET in src/commands/admin.ts.
const FIELD_VALUE_BUDGET = 1000;
const MAX_TABLE_FIELDS = 20;

function joinWithBudget(lines: string[], budget = FIELD_VALUE_BUDGET): string {
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > budget) break;
    body += (body ? '\n' : '') + line;
    shown++;
  }
  const omitted = lines.length - shown;
  return body + (omitted > 0 ? `${body ? '\n' : ''}…and ${omitted} more` : '');
}

export function buildScheduleEmbed(
  gn: Pick<GameNight, 'title' | 'startTimeISO' | 'greeters'>,
  games: Pick<SchedulableGame, 'id' | 'title' | 'seatedPlayers'>[],
  result: ScheduleResult,
): EmbedBuilder {
  const gameById = new Map(games.map((g) => [g.id, g]));

  const embed = new EmbedBuilder()
    .setTitle(`🔒 Lineup Locked — ${gn.title ?? 'Game Night'}`)
    .setColor(result.fitsInWindow ? 0x57f287 : 0xf0b232)
    .setDescription(
      "Suggestions and seats are now locked. Here's a suggested schedule based on who's seated — times aren't enforced in person, just a guide to help fit everything in.",
    );

  if (gn.greeters && gn.greeters.length > 0) {
    embed.addFields({
      name: '👋 Greeters',
      value: gn.greeters.map((userId) => `<@${userId}>`).join(' and '),
    });
  }

  const byTable = new Map<number, ScheduleAssignment[]>();
  for (const a of result.assignments) {
    const slots = byTable.get(a.table) ?? [];
    slots.push(a);
    byTable.set(a.table, slots);
  }

  const sortedTables = [...byTable.entries()].sort(([a], [b]) => a - b);
  const shownTables = sortedTables.slice(0, MAX_TABLE_FIELDS);
  for (const [table, slots] of shownTables) {
    slots.sort((a, b) => a.startMinutes - b.startMinutes);
    const lines = slots.map((a) => {
      const game = gameById.get(a.gameId);
      const title = game?.title ?? 'Unknown game';
      const repeatNote = a.playCount > 1 ? ` (${a.playCount}x)` : '';
      const playersNote =
        a.attendingPlayerIds.length > 0
          ? ` — ${a.attendingPlayerIds.map((id) => `<@${id}>`).join(', ')}`
          : '';
      // Anyone signed up but not part of this quorum-based estimate (see
      // quorumThreshold) is still shown here, rather than silently vanishing
      // — they just weren't ready in time to be part of this instance.
      const lateSigners = game ? game.seatedPlayers.filter((id) => !a.attendingPlayerIds.includes(id)) : [];
      const lateJoinersNote =
        lateSigners.length > 0
          ? ` (+ ${lateSigners.map((id) => `<@${id}>`).join(', ')} can join once free)`
          : '';

      const lateNote = a.mayNotFinish ? ' ⚠️' : '';
      // The whole table waits here, not just the named player — this is
      // shown on the game's own line (visible to everyone seated in it)
      // rather than as a private note about one person running late.
      const waitingNote = a.delayedByPlayerId
        ? ` — ⏳ waiting on <@${a.delayedByPlayerId}> to finish an earlier game`
        : '';
      const startUnix = minutesToUnix(gn.startTimeISO, roundUpToQuarterHour(a.startMinutes));
      const endUnix = minutesToUnix(gn.startTimeISO, roundUpToQuarterHour(a.endMinutes));
      return `**${title}**${repeatNote} (<t:${startUnix}:t>–<t:${endUnix}:t>)${playersNote}${lateJoinersNote}${waitingNote}${lateNote}`;
    });

    embed.addFields({ name: `Table ${table}`, value: joinWithBudget(lines) || '*(empty)*' });
  }

  if (sortedTables.length === 0 && result.walkUps.length === 0) {
    embed.addFields({ name: 'Schedule', value: '*(no games scheduled)*' });
  } else if (sortedTables.length > shownTables.length) {
    embed.addFields({
      name: 'More tables',
      value: `…and ${sortedTables.length - shownTables.length} more table(s) not shown here.`,
    });
  }

  if (result.walkUps.length > 0) {
    const lines = result.walkUps.map((w) => {
      const game = gameById.get(w.gameId);
      const title = game?.title ?? 'Unknown game';
      const playersNote = game && game.seatedPlayers.length > 0 ? ` — ${game.seatedPlayers.map((id) => `<@${id}>`).join(', ')}` : '';
      return `**${title}**${playersNote}`;
    });
    embed.addFields({
      name: '🌱 Open to walk-ups',
      value: `${joinWithBudget(lines, FIELD_VALUE_BUDGET - 100)}\nOnly 1 signup so far — no reserved table, but set up and open to anyone through the day.`,
    });
  }

  if (result.playerWarnings.length > 0) {
    embed.addFields({
      name: '⚠️ May not get to play everything',
      value: joinWithBudget(result.playerWarnings.map((w) => `<@${w.userId}> — ${w.reason}`)),
    });
  }

  if (result.unscheduled.length > 0) {
    embed.addFields({
      name: 'Not scheduled',
      value: joinWithBudget(
        result.unscheduled.map(
          (u) => `**${gameById.get(u.gameId)?.title ?? 'Unknown game'}** — ${u.reason}`,
        ),
      ),
    });
  }

  embed.setFooter({
    text: result.fitsInWindow
      ? `Estimated total: ${result.totalDurationMinutes} min — fits within the event window`
      : `Estimated total: ${result.totalDurationMinutes} min — may run past the event window`,
  });

  return embed;
}

async function postBgStatsButtons(
  client: Client,
  gn: GameNight,
  games: GameSuggestion[],
  result: ScheduleResult,
): Promise<void> {
  if (!gn.eventChannelId) return;

  if (result.assignments.length === 0 && result.walkUps.length === 0) {
    console.log(
      `[BG Stats] Skipping post for game night ${gn.id} — no games were scheduled at lock time (${games.length} suggested, 0 met the minimum-player threshold).`,
    );
    return;
  }

  const gameById = new Map(games.map((g) => [g.id, g]));
  const resolvedById = new Map(result.resolvedGames.map((g) => [g.id, g]));

  // One post per real session — a split game's groups 2+ (see
  // expandGamesIntoGroups) are each their own separate real-world play, not
  // a duplicate of group 1's, so each gets its own play id/QR/short link.
  interface Session {
    sessionId: string;
    realGame: GameSuggestion;
    title: string;
    attendingPlayerIds: string[];
    assignment?: ScheduleAssignment;
  }
  const sessions: Session[] = [];
  for (const a of result.assignments) {
    const realGame = gameById.get(baseGameId(a.gameId));
    if (!realGame) continue;
    sessions.push({
      sessionId: a.gameId,
      realGame,
      title: resolvedById.get(a.gameId)?.title ?? realGame.title,
      attendingPlayerIds: a.attendingPlayerIds,
      assignment: a,
    });
  }
  for (const w of result.walkUps) {
    const realGame = gameById.get(w.gameId);
    if (!realGame) continue;
    // A walk-up game (see WalkUpGame) never gets a real assignment — fall
    // back to its lone seated signup rather than "no players."
    sessions.push({ sessionId: w.gameId, realGame, title: realGame.title, attendingPlayerIds: realGame.seats });
  }

  const allPlayerIds = [...new Set(sessions.flatMap((s) => s.attendingPlayerIds))];
  const nameMap = await resolvePlayerNames(client, gn.guildId, allPlayerIds);

  try {
    const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;
    if (!channel) return;

    for (const { sessionId, realGame, title, attendingPlayerIds, assignment } of sessions) {
      const url = buildBgStatsPlayUrl({
        gameName: realGame.title,
        bggId: realGame.bggId,
        location: gn.location,
        players: attendingPlayerIds.map((id) => ({ name: nameMap[id] ?? id, sourcePlayerId: id })),
        sourcePlayId: sessionId,
        playDate: new Date(gn.startTimeISO),
      });
      // With SHORT_LINK_BASE_URL configured this always fits (see bgStats.ts);
      // otherwise it falls back to the same length-check as before. The QR
      // code has no length limit either way, so it's the reliable fallback —
      // but it still scans more easily off the short link when one exists.
      const buttonUrl = await buildBgStatsButtonUrl(url, {
        guildId: gn.guildId,
        eventId: gn.id,
        gameId: sessionId,
      });
      const qrFilename = `bgstats-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
      const qrAttachment = await buildBgStatsQrAttachment(buttonUrl ?? url, qrFilename);

      const timingNote = assignment
        ? `Table ${assignment.table} — <t:${minutesToUnix(gn.startTimeISO, roundUpToQuarterHour(assignment.startMinutes))}:t>–<t:${minutesToUnix(gn.startTimeISO, roundUpToQuarterHour(assignment.endMinutes))}:t>`
        : '🌱 Open to walk-ups — set up and open to anyone any time.';

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${title}`)
        .setDescription(
          `${timingNote}\n` +
            (buttonUrl
              ? 'Tap the button or scan the QR code to log this play in BG Stats.'
              : 'Scan the QR code to log this play in BG Stats (too many players for a tappable link).'),
        )
        .addFields({
          name: 'Players',
          value: attendingPlayerIds.map((id) => nameMap[id] ?? id).join('\n') || '*(no seats defined)*',
        })
        .setColor(0xe8a838)
        .setImage(`attachment://${qrFilename}`);

      await channel.send({
        embeds: [embed],
        components: buttonUrl ? [buildBgStatsButton(buttonUrl)] : [],
        files: [qrAttachment],
      });
    }
  } catch (err) {
    console.warn(`Could not post BG Stats buttons for game night ${gn.id}:`, err);
  }
}

// ── Smart table-count sizing ─────────────────────────────────────────────────
//
// scheduleTableCount used to be a single flat number a host had to guess at.
// These functions instead derive an effective table count at lock time from
// (a) how many people RSVP'd, assuming real games seat 3-6 players, and
// (b) whether the RSVP pool's /myroles complexity preferences split into
// distinct groups that can't share a table (a Light-only preference can't
// play a Medium/Heavy game; Medium can't play Heavy). The configured default
// still acts as a floor, and maxTableCount (if set) acts as a hard ceiling —
// e.g. a venue's physical table count — so a host can force a higher minimum
// but never more tables than can actually exist.

const ASSUMED_TABLE_SIZES = [3, 4, 5, 6];

/**
 * Given a headcount, finds which assumed table size (3-6) divides it most
 * evenly — using the *decimal* remainder of count/size (not the raw integer
 * remainder), so sizes are compared on a fair, normalized scale. A fraction
 * near 0 means it divides evenly; a fraction near 1 means the last table
 * would be nearly full anyway (also a good fit) — only fractions in the
 * middle (an awkward half-empty last table) score poorly. Ties prefer the
 * larger table size, since fewer/fuller tables is the actual goal.
 */
export function computeHeadcountTableFloor(count: number): number {
  if (count <= 0) return 0;

  let bestSize = ASSUMED_TABLE_SIZES[0];
  let bestDistance = Infinity;
  for (const size of ASSUMED_TABLE_SIZES) {
    const divided = count / size;
    const fraction = divided - Math.floor(divided);
    const distance = Math.min(fraction, 1 - fraction);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestSize = size;
    }
  }
  return Math.ceil(count / bestSize);
}

/**
 * Sums a per-tier table floor (via computeHeadcountTableFloor) across Light,
 * Medium, and Heavy preference counts. This is deliberately a heuristic, not
 * an exact optimizer: a lone person in a tier still reserves a full table's
 * worth of floor, which slightly over-provisions rather than under-provisions
 * — the safer direction for a "how many tables might we need" estimate.
 * Preferences that are null (never set via /myroles) don't count toward any
 * tier — they're flexible and don't force a dedicated table.
 */
export function computePreferenceSplitTableFloor(preferences: (string | null | undefined)[]): number {
  const counts = { Light: 0, Medium: 0, Heavy: 0 };
  for (const p of preferences) {
    if (p === 'Light' || p === 'Medium' || p === 'Heavy') counts[p]++;
  }
  return (
    computeHeadcountTableFloor(counts.Light) +
    computeHeadcountTableFloor(counts.Medium) +
    computeHeadcountTableFloor(counts.Heavy)
  );
}

export function computeEffectiveTableCount(
  rsvpCount: number,
  preferences: (string | null | undefined)[],
  configDefault: number,
  maxTableCount = 0,
): number {
  const computed = Math.max(
    computeHeadcountTableFloor(rsvpCount),
    computePreferenceSplitTableFloor(preferences),
    configDefault,
    1,
  );
  return maxTableCount > 0 ? Math.min(computed, maxTableCount) : computed;
}

/**
 * Resolves each RSVP'd (yes) member's /myroles complexity preference, for
 * feeding into computePreferenceSplitTableFloor. Skips (rather than throws
 * on) any member who's left the server or otherwise fails to resolve —
 * consistent with how mention/member resolution is handled elsewhere (e.g.
 * /room invite). Short-circuits before touching the client at all when
 * there's nobody to resolve, so callers/tests with no RSVPs never need a
 * working `guilds.fetch`.
 */
export async function resolveRsvpComplexityPreferences(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<(string | null)[]> {
  if (userIds.length === 0) return [];

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch {
    return [];
  }

  const preferences: (string | null)[] = [];
  for (const userId of userIds) {
    try {
      const member = await guild.members.fetch(userId);
      const prefs = await getMemberPreferences(guildId, member);
      preferences.push(prefs.complexity);
    } catch {
      // Member left the server, or preference lookup failed — skip them
      // rather than let one bad lookup abort the whole sizing calculation.
    }
  }
  return preferences;
}

export async function lockAndScheduleEvent(
  client: Client,
  gn: GameNight,
  config: Pick<
    GuildConfig,
    | 'scheduleTableCount'
    | 'maxTableCount'
    | 'lightBufferMinutes'
    | 'mediumBufferMinutes'
    | 'heavyBufferMinutes'
    | 'postBgStatsLinks'
    | 'heavyGameBreakMinutes'
    | 'maxGameRepeats'
    | 'breakMinutesBetweenGames'
    | 'flexTableCount'
  >,
): Promise<void> {
  gn.suggestionsLocked = true;

  const games = gn.eventChannelId ? await findGamesByChannel(gn.eventChannelId) : [];
  const schedulable = games.map((g) => toSchedulableGame(g, config));
  const windowMinutes = gn.endTimeISO
    ? (new Date(gn.endTimeISO).getTime() - new Date(gn.startTimeISO).getTime()) / 60000
    : Number.POSITIVE_INFINITY;

  const rsvpPreferences = await resolveRsvpComplexityPreferences(client, gn.guildId, gn.rsvps.yes);
  const tableCount = computeEffectiveTableCount(
    gn.rsvps.yes.length,
    rsvpPreferences,
    config.scheduleTableCount,
    config.maxTableCount,
  );
  const result = scheduleGames(schedulable, tableCount, windowMinutes, config);

  const assignmentsByBaseGame = new Map<string, ScheduleAssignment[]>();
  for (const a of result.assignments) {
    const baseId = baseGameId(a.gameId);
    const list = assignmentsByBaseGame.get(baseId) ?? [];
    list.push(a);
    assignmentsByBaseGame.set(baseId, list);
  }
  const walkUpGameIds = new Set(result.walkUps.map((w) => w.gameId));
  for (const game of games) {
    const sessions = assignmentsByBaseGame.get(game.id);
    if (sessions && sessions.length > 0) {
      sessions.sort((a, b) => a.startMinutes - b.startMinutes);
      game.scheduledSessions = sessions.map((a, i) => ({
        groupIndex: i + 1,
        table: a.table,
        startMinutes: a.startMinutes,
        endMinutes: a.endMinutes,
        playCount: a.playCount,
        mayNotFinish: a.mayNotFinish,
        attendingPlayerIds: a.attendingPlayerIds,
      }));
      // Mirror session 1 into the singular fields — every existing consumer
      // of scheduledTable/scheduledStartMinutes/etc. keeps working unchanged.
      const first = sessions[0];
      game.scheduledTable = first.table;
      game.scheduledStartMinutes = first.startMinutes;
      game.scheduledEndMinutes = first.endMinutes;
      game.scheduledPlayCount = first.playCount;
      game.scheduledMayNotFinish = first.mayNotFinish;
      await upsertGame(game);
    } else if (walkUpGameIds.has(game.id)) {
      game.scheduledWalkUp = true;
      await upsertGame(game);
    }
  }

  gn.scheduledAt = new Date().toISOString();
  await upsertGameNight(gn);

  // "Games to bring" cleanup + owner asking happens before the public
  // schedule post, so that post reflects the final state: drop any request
  // nobody signed up to play, then ask an owner for whatever's left — no
  // "please bring this" DM goes out before lock (see reconcileRequestCopies),
  // so this is the actual first ask for nearly every request, not a reminder.
  const zeroSignupTitles = games.filter((g) => g.seats.length === 0).map((g) => g.title);
  if (zeroSignupTitles.length > 0) {
    const dropped = await removeZeroSignupRequests(gn.id, zeroSignupTitles);
    for (const req of dropped) {
      for (const ask of req.pendingAsks) {
        await invalidateBringDm(client, ask, 'No longer needed — nobody signed up to play it.');
      }
    }
    if (dropped.length > 0) {
      try {
        await updateRequestPin(client, gn.id);
      } catch (err) {
        console.warn(`Could not refresh request pin for game night ${gn.id}:`, err);
      }
    }
  }

  const remainingRequests = await getRequestsForEvent(gn.id);
  for (const req of remainingRequests) {
    await reconcileRequestCopies(client, gn.guildId, gn.rsvps, req, gn.date);
  }

  if (gn.eventChannelId) {
    try {
      const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;
      await channel?.send({ embeds: [buildScheduleEmbed(gn, result.resolvedGames, result)] });
    } catch (err) {
      console.warn(`Could not post schedule for game night ${gn.id}:`, err);
    }
  }

  if (config.postBgStatsLinks) {
    await postBgStatsButtons(client, gn, games, result);
  }

  console.log(
    `Locked lineup and scheduled game night ${gn.id} (${result.assignments.length} scheduled, ${result.unscheduled.length} unscheduled)`,
  );
}

export async function checkPendingSchedules(client: Client): Promise<void> {
  const now = new Date();
  const nights = await loadGameNights();

  for (const gn of nights) {
    if (gn.cancelled || gn.archived || gn.suggestionsLocked) continue;

    const config = await getGuildConfig(gn.guildId);
    if (!config.lockHoursBeforeEvent || config.lockHoursBeforeEvent <= 0) continue;

    const lockAt = new Date(
      new Date(gn.startTimeISO).getTime() - config.lockHoursBeforeEvent * 60 * 60 * 1000,
    );
    if (now < lockAt) continue;

    await lockAndScheduleEvent(client, gn, config);
  }
}

/**
 * Admin-only dry run: computes and displays the schedule for the current
 * event channel without locking suggestions, persisting assignments, posting
 * to the event channel, or sending BG Stats buttons. Reuses scheduleGames()/
 * buildScheduleEmbed() verbatim so the preview always matches what a real
 * lock would produce.
 */
export async function previewSchedule(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nights = (await loadGameNights()).filter((gn) => !gn.cancelled && !gn.archived);
  const gn = nights.find((n) => n.eventChannelId === interaction.channelId);
  if (!gn) {
    await interaction.editReply("This isn't an event channel — run this inside the event's channel.");
    return;
  }

  const config = await getGuildConfig(interaction.guildId!);
  const games = gn.eventChannelId ? await findGamesByChannel(gn.eventChannelId) : [];
  const schedulable = games.map((g) => toSchedulableGame(g, config));
  const windowMinutes = gn.endTimeISO
    ? (new Date(gn.endTimeISO).getTime() - new Date(gn.startTimeISO).getTime()) / 60000
    : Number.POSITIVE_INFINITY;
  const rsvpPreferences = await resolveRsvpComplexityPreferences(interaction.client, gn.guildId, gn.rsvps.yes);
  const tableCount = computeEffectiveTableCount(
    gn.rsvps.yes.length,
    rsvpPreferences,
    config.scheduleTableCount,
    config.maxTableCount,
  );
  const result = scheduleGames(schedulable, tableCount, windowMinutes, config);

  const embed = buildScheduleEmbed(gn, result.resolvedGames, result)
    .setTitle(`🔍 Schedule Preview — ${gn.title ?? 'Game Night'}`)
    .setDescription(
      'Dry run only — suggestions are NOT locked, nothing is saved, and nothing is posted to the event channel.',
    );

  await interaction.editReply({ embeds: [embed] });
}
