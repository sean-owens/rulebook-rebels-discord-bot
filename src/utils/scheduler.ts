import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { GameSuggestion, findGamesByChannel, upsertGame } from './gameStorage';
import { GuildConfig, getGuildConfig } from './config';
import { GameNight, loadGameNights, upsertGameNight } from './storage';

export const LOCK_MESSAGE =
  "This event's lineup is locked ahead of the scheduled start — suggestions and seats can no longer change.";

export function isLineupLocked(gn: Pick<GameNight, 'suggestionsLocked'>): boolean {
  return gn.suggestionsLocked === true;
}

export interface SchedulableGame {
  id: string;
  title: string;
  minPlayers: number;
  seatedPlayers: string[];
  effectiveDurationMinutes: number;
}

export interface ScheduleAssignment {
  gameId: string;
  round: number; // 1-indexed
  table: number; // 1-indexed
}

export interface UnscheduledGame {
  gameId: string;
  reason: string;
}

export interface ScheduleResult {
  assignments: ScheduleAssignment[];
  unscheduled: UnscheduledGame[];
  roundDurationsMinutes: number[]; // index 0 = round 1
  totalDurationMinutes: number;
  fitsInWindow: boolean;
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
    seatedPlayers: game.seats,
    effectiveDurationMinutes: game.maxPlaytime + complexityBufferMinutes(game.complexity, config),
  };
}

/**
 * Greedy scheduler: packs games into (round, table) slots across `tableCount`
 * parallel tables so that no player is double-booked in the same round.
 *
 * This is a heuristic, not an optimal solver — the underlying problem (pack
 * games into the fewest rounds possible without seat-sharing conflicts,
 * subject to a table-count limit per round) is a variant of graph coloring
 * combined with bin packing, which is NP-hard in general. For realistic game
 * night sizes (a few dozen games/players at most) a longest-game-first greedy
 * placement produces a reasonable schedule without needing a real solver.
 */
export function scheduleGames(
  games: SchedulableGame[],
  tableCount: number,
  windowMinutes: number,
): ScheduleResult {
  const unscheduled: UnscheduledGame[] = [];
  const viable = games.filter((g) => {
    if (g.seatedPlayers.length < g.minPlayers) {
      unscheduled.push({
        gameId: g.id,
        reason: `only ${g.seatedPlayers.length}/${g.minPlayers} minimum players seated`,
      });
      return false;
    }
    return true;
  });

  // Longest games first, then by seated player count — places the
  // hardest-to-fit games while rounds still have the most room.
  const ordered = [...viable].sort((a, b) => {
    if (b.effectiveDurationMinutes !== a.effectiveDurationMinutes) {
      return b.effectiveDurationMinutes - a.effectiveDurationMinutes;
    }
    return b.seatedPlayers.length - a.seatedPlayers.length;
  });

  interface Round {
    tables: (string | null)[]; // gameId per table slot
    playersUsed: Set<string>;
  }
  const rounds: Round[] = [];
  const assignments: ScheduleAssignment[] = [];

  for (const game of ordered) {
    let placed = false;
    for (let r = 0; r < rounds.length && !placed; r++) {
      const round = rounds[r];
      const tableIdx = round.tables.indexOf(null);
      if (tableIdx === -1) continue; // round is full
      const conflicts = game.seatedPlayers.some((p) => round.playersUsed.has(p));
      if (conflicts) continue;

      round.tables[tableIdx] = game.id;
      game.seatedPlayers.forEach((p) => round.playersUsed.add(p));
      assignments.push({ gameId: game.id, round: r + 1, table: tableIdx + 1 });
      placed = true;
    }

    if (!placed) {
      const newRound: Round = {
        tables: new Array(tableCount).fill(null),
        playersUsed: new Set(),
      };
      newRound.tables[0] = game.id;
      game.seatedPlayers.forEach((p) => newRound.playersUsed.add(p));
      rounds.push(newRound);
      assignments.push({ gameId: game.id, round: rounds.length, table: 1 });
    }
  }

  const gameById = new Map(viable.map((g) => [g.id, g]));
  const roundDurationsMinutes = rounds.map((round) =>
    Math.max(
      0,
      ...round.tables
        .filter((gameId): gameId is string => gameId !== null)
        .map((gameId) => gameById.get(gameId)!.effectiveDurationMinutes),
    ),
  );
  const totalDurationMinutes = roundDurationsMinutes.reduce((sum, m) => sum + m, 0);

  return {
    assignments,
    unscheduled,
    roundDurationsMinutes,
    totalDurationMinutes,
    fitsInWindow: totalDurationMinutes <= windowMinutes,
  };
}

export function buildScheduleEmbed(
  gn: Pick<GameNight, 'title'>,
  games: Pick<GameSuggestion, 'id' | 'title'>[],
  result: ScheduleResult,
): EmbedBuilder {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const roundCount = result.roundDurationsMinutes.length;

  const embed = new EmbedBuilder()
    .setTitle(`🔒 Lineup Locked — ${gn.title ?? 'Game Night'}`)
    .setColor(result.fitsInWindow ? 0x57f287 : 0xf0b232)
    .setDescription(
      "Suggestions and seats are now locked. Here's a suggested schedule based on who's seated — times aren't enforced in person, just a guide to help fit everything in.",
    );

  for (let r = 1; r <= roundCount; r++) {
    const tablesInRound = result.assignments
      .filter((a) => a.round === r)
      .sort((a, b) => a.table - b.table)
      .map((a) => `Table ${a.table}: **${gameById.get(a.gameId)?.title ?? 'Unknown game'}**`)
      .join('\n');
    embed.addFields({
      name: `Round ${r} (~${result.roundDurationsMinutes[r - 1]} min)`,
      value: tablesInRound || '*(empty)*',
    });
  }

  if (result.unscheduled.length > 0) {
    embed.addFields({
      name: 'Not scheduled',
      value: result.unscheduled
        .map((u) => `**${gameById.get(u.gameId)?.title ?? 'Unknown game'}** — ${u.reason}`)
        .join('\n'),
    });
  }

  embed.setFooter({
    text: result.fitsInWindow
      ? `Estimated total: ${result.totalDurationMinutes} min — fits within the event window`
      : `Estimated total: ${result.totalDurationMinutes} min — may run past the event window`,
  });

  return embed;
}

export async function lockAndScheduleEvent(
  client: Client,
  gn: GameNight,
  config: Pick<GuildConfig, 'scheduleTableCount' | 'lightBufferMinutes' | 'mediumBufferMinutes' | 'heavyBufferMinutes'>,
): Promise<void> {
  gn.suggestionsLocked = true;

  const games = gn.eventChannelId ? await findGamesByChannel(gn.eventChannelId) : [];
  const schedulable = games.map((g) => toSchedulableGame(g, config));
  const windowMinutes = gn.endTimeISO
    ? (new Date(gn.endTimeISO).getTime() - new Date(gn.startTimeISO).getTime()) / 60000
    : Number.POSITIVE_INFINITY;

  const result = scheduleGames(schedulable, Math.max(1, config.scheduleTableCount), windowMinutes);

  const assignmentByGame = new Map(result.assignments.map((a) => [a.gameId, a]));
  for (const game of games) {
    const assignment = assignmentByGame.get(game.id);
    if (assignment) {
      game.scheduledRound = assignment.round;
      game.scheduledTable = assignment.table;
      await upsertGame(game);
    }
  }

  gn.scheduledAt = new Date().toISOString();
  await upsertGameNight(gn);

  if (gn.eventChannelId) {
    try {
      const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;
      await channel?.send({ embeds: [buildScheduleEmbed(gn, games, result)] });
    } catch (err) {
      console.warn(`Could not post schedule for game night ${gn.id}:`, err);
    }
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
