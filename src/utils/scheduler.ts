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
// repeat into leftover round time — see the repeat-fill pass in scheduleGames().
const SHORT_GAME_MAX_RAW_MINUTES = 30;

export interface SchedulableGame {
  id: string;
  title: string;
  minPlayers: number;
  seatedPlayers: string[];
  effectiveDurationMinutes: number;
  rawMaxPlaytime: number;
  complexity?: string;
}

export interface ScheduleAssignment {
  gameId: string;
  round: number; // 1-indexed
  table: number; // 1-indexed
  playCount: number; // how many times this game is played within this round's slot
  // True if this game's round is projected to start and/or run past the
  // event's end time — a heads-up that starting it probably won't leave
  // enough time to finish before the event wraps up.
  mayNotFinish: boolean;
}

export interface UnscheduledGame {
  gameId: string;
  reason: string;
}

export interface LowInterestGame {
  gameId: string;
  reason: string;
}

export interface ScheduleResult {
  assignments: ScheduleAssignment[];
  unscheduled: UnscheduledGame[];
  lowInterest: LowInterestGame[];
  roundDurationsMinutes: number[]; // index 0 = round 1
  roundBreakMinutesBefore: number[]; // index i = break minutes inserted before round i+1
  totalDurationMinutes: number;
  fitsInWindow: boolean;
}

export interface RoundClock {
  round: number; // 1-indexed
  startUnix: number;
  endUnix: number;
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
    rawMaxPlaytime: game.maxPlaytime,
    complexity: game.complexity,
  };
}

interface RoundBin {
  tables: (string | null)[]; // gameId per table slot
  playersUsed: Set<string>;
}

/**
 * Detects a table playing two Heavy-complexity games in directly-adjacent
 * rounds and returns, per round, how many break minutes to insert beforehand.
 *
 * v1 limitation: only literally-adjacent round indices (r, r+1) are checked —
 * a table idle in round r+1 with Heavy games in r and r+2 is not detected.
 * The break is global (delays every table's next round, not just the
 * offending one) to keep a single shared clock rather than letting one
 * table's timeline drift independently of the others.
 */
function computeHeavyBreaks(
  rounds: RoundBin[],
  gameById: Map<string, SchedulableGame>,
  breakMinutes: number,
): number[] {
  const breaks = new Array(rounds.length).fill(0);
  if (breakMinutes <= 0) return breaks;

  for (let r = 0; r < rounds.length - 1; r++) {
    const tableCount = rounds[r].tables.length;
    for (let t = 0; t < tableCount; t++) {
      const a = rounds[r].tables[t];
      const b = rounds[r + 1].tables[t];
      if (!a || !b) continue;
      if (gameById.get(a)?.complexity === 'Heavy' && gameById.get(b)?.complexity === 'Heavy') {
        breaks[r + 1] = breakMinutes;
        break;
      }
    }
  }
  return breaks;
}

/**
 * Opportunistically fills leftover time within a table's already-decided
 * round slot with repeat plays of that same short game — never restructures
 * placement or extends the round's own duration, only uses time already
 * allocated because another table's game runs longer that round.
 */
function applyRepeatFill(
  assignments: ScheduleAssignment[],
  roundDurationsMinutes: number[],
  gameById: Map<string, SchedulableGame>,
  maxGameRepeats: number,
): void {
  for (const a of assignments) {
    a.playCount = 1;
    const game = gameById.get(a.gameId);
    if (!game) continue;
    if (game.rawMaxPlaytime <= 0 || game.rawMaxPlaytime >= SHORT_GAME_MAX_RAW_MINUTES) continue;

    const roundDuration = roundDurationsMinutes[a.round - 1];
    const leftover = roundDuration - game.effectiveDurationMinutes;
    // Repeats skip the complexity buffer — the group already knows the game.
    if (leftover < game.rawMaxPlaytime) continue;

    const extraPlays = Math.floor(leftover / game.rawMaxPlaytime);
    a.playCount = Math.min(maxGameRepeats, 1 + extraPlays);
  }
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
  config: Pick<GuildConfig, 'heavyGameBreakMinutes' | 'maxGameRepeats'>,
): ScheduleResult {
  const lowInterest: LowInterestGame[] = [];
  const unscheduled: UnscheduledGame[] = [];

  // Games with exactly one seated player are unlikely to actually happen —
  // surface them separately rather than mixing them into the round-placement
  // path or the numeric-minimum "unscheduled" reasons below. This takes
  // priority even over a game whose own minPlayers is 1.
  const afterLowInterest = games.filter((g) => {
    if (g.seatedPlayers.length === 1) {
      lowInterest.push({
        gameId: g.id,
        reason: 'only 1 player interested — may not get played',
      });
      return false;
    }
    return true;
  });

  const viable = afterLowInterest.filter((g) => {
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

  const rounds: RoundBin[] = [];
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
      assignments.push({
        gameId: game.id,
        round: r + 1,
        table: tableIdx + 1,
        playCount: 1,
        mayNotFinish: false,
      });
      placed = true;
    }

    if (!placed) {
      const newRound: RoundBin = {
        tables: new Array(tableCount).fill(null),
        playersUsed: new Set(),
      };
      newRound.tables[0] = game.id;
      game.seatedPlayers.forEach((p) => newRound.playersUsed.add(p));
      rounds.push(newRound);
      assignments.push({
        gameId: game.id,
        round: rounds.length,
        table: 1,
        playCount: 1,
        mayNotFinish: false,
      });
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

  const roundBreakMinutesBefore = computeHeavyBreaks(rounds, gameById, config.heavyGameBreakMinutes);

  // A round "may not finish" if its own end — cumulative time from the event's
  // start, including every break and round before it — runs past the window.
  // Every game placed in that round is flagged, since all tables in a round
  // share the same start/end clock (see computeRoundClocks).
  let cursorMinutes = 0;
  const roundExceedsWindow = roundDurationsMinutes.map((durationMin, i) => {
    cursorMinutes += roundBreakMinutesBefore[i] ?? 0;
    cursorMinutes += durationMin;
    return cursorMinutes > windowMinutes;
  });
  for (const a of assignments) {
    a.mayNotFinish = roundExceedsWindow[a.round - 1] ?? false;
  }

  applyRepeatFill(assignments, roundDurationsMinutes, gameById, Math.max(1, config.maxGameRepeats));

  const totalDurationMinutes =
    roundDurationsMinutes.reduce((sum, m) => sum + m, 0) +
    roundBreakMinutesBefore.reduce((sum, m) => sum + m, 0);

  return {
    assignments,
    unscheduled,
    lowInterest,
    roundDurationsMinutes,
    roundBreakMinutesBefore,
    totalDurationMinutes,
    fitsInWindow: totalDurationMinutes <= windowMinutes,
  };
}

/**
 * Converts round durations + inserted breaks into real clock times, anchored
 * to the event's start. Kept separate from scheduleGames() so the core
 * placement algorithm stays free of Date/timezone concerns.
 */
export function computeRoundClocks(
  result: Pick<ScheduleResult, 'roundDurationsMinutes' | 'roundBreakMinutesBefore'>,
  eventStartISO: string,
): RoundClock[] {
  let cursor = Math.floor(new Date(eventStartISO).getTime() / 1000);
  return result.roundDurationsMinutes.map((durationMin, i) => {
    cursor += (result.roundBreakMinutesBefore[i] ?? 0) * 60;
    const startUnix = cursor;
    const endUnix = startUnix + durationMin * 60;
    cursor = endUnix;
    return { round: i + 1, startUnix, endUnix };
  });
}

export function buildScheduleEmbed(
  gn: Pick<GameNight, 'title' | 'startTimeISO' | 'greeters'>,
  games: Pick<GameSuggestion, 'id' | 'title'>[],
  result: ScheduleResult,
): EmbedBuilder {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const roundCount = result.roundDurationsMinutes.length;
  const clocks = computeRoundClocks(result, gn.startTimeISO);

  const embed = new EmbedBuilder()
    .setTitle(`🔒 Lineup Locked — ${gn.title ?? 'Game Night'}`)
    .setColor(result.fitsInWindow ? 0x57f287 : 0xf0b232)
    .setDescription(
      "Suggestions and seats are now locked. Here's a suggested schedule based on who's seated — times aren't enforced in person, just a guide to help fit everything in.",
    );

  if (gn.greeters && gn.greeters.length > 0) {
    embed.addFields({
      name: '🙋 Greeters',
      value: gn.greeters.map((userId) => `<@${userId}>`).join(' and '),
    });
  }

  for (let r = 1; r <= roundCount; r++) {
    const clock = clocks[r - 1];
    const breakMinutes = result.roundBreakMinutesBefore[r - 1] ?? 0;
    const breakNote = breakMinutes > 0 ? `*⏸ ${breakMinutes}-minute break beforehand*\n` : '';
    const roundAssignments = result.assignments
      .filter((a) => a.round === r)
      .sort((a, b) => a.table - b.table);
    const mayNotFinish = roundAssignments.some((a) => a.mayNotFinish);
    const lateNote = mayNotFinish
      ? "*⚠️ This round is projected to start and/or run past the event's end time*\n"
      : '';
    const tablesInRound = roundAssignments
      .map((a) => {
        const title = gameById.get(a.gameId)?.title ?? 'Unknown game';
        const repeatNote = a.playCount > 1 ? ` (${a.playCount}x)` : '';
        return `Table ${a.table}: **${title}**${repeatNote}`;
      })
      .join('\n');
    embed.addFields({
      name: `Round ${r} (<t:${clock.startUnix}:t> – <t:${clock.endUnix}:t>)`,
      value: breakNote + lateNote + (tablesInRound || '*(empty)*'),
    });
  }

  if (result.lowInterest.length > 0) {
    embed.addFields({
      name: 'Needs more players',
      value: result.lowInterest
        .map((u) => `**${gameById.get(u.gameId)?.title ?? 'Unknown game'}** — ${u.reason}`)
        .join('\n'),
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

  const totalBreakMinutes = result.roundBreakMinutesBefore.reduce((sum, m) => sum + m, 0);
  const breakFooterNote = totalBreakMinutes > 0 ? ` (includes ${totalBreakMinutes} min of breaks)` : '';
  embed.setFooter({
    text: result.fitsInWindow
      ? `Estimated total: ${result.totalDurationMinutes} min${breakFooterNote} — fits within the event window`
      : `Estimated total: ${result.totalDurationMinutes} min${breakFooterNote} — may run past the event window`,
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

  const scheduledGameIds = new Set(result.assignments.map((a) => a.gameId));
  const scheduledGames = games.filter((g) => scheduledGameIds.has(g.id));
  if (scheduledGames.length === 0) {
    console.log(
      `[BG Stats] Skipping post for game night ${gn.id} — no games were scheduled at lock time (${games.length} suggested, 0 met the minimum-player threshold).`,
    );
    return;
  }

  const assignmentByGame = new Map(result.assignments.map((a) => [a.gameId, a]));
  const clocks = computeRoundClocks(result, gn.startTimeISO);
  const allPlayerIds = [...new Set(scheduledGames.flatMap((g) => g.seats))];
  const nameMap = await resolvePlayerNames(client, gn.guildId, allPlayerIds);

  try {
    const channel = (await client.channels.fetch(gn.eventChannelId)) as TextChannel;
    if (!channel) return;

    for (const game of scheduledGames) {
      const assignment = assignmentByGame.get(game.id)!;
      const clock = clocks[assignment.round - 1];
      const url = buildBgStatsPlayUrl({
        gameName: game.title,
        bggId: game.bggId,
        location: gn.location,
        players: game.seats.map((id) => ({ name: nameMap[id] ?? id, sourcePlayerId: id })),
        sourcePlayId: game.id,
        playDate: new Date(gn.startTimeISO),
      });
      // With SHORT_LINK_BASE_URL configured this always fits (see bgStats.ts);
      // otherwise it falls back to the same length-check as before. The QR
      // code has no length limit either way, so it's the reliable fallback —
      // but it still scans more easily off the short link when one exists.
      const buttonUrl = await buildBgStatsButtonUrl(url);
      const qrFilename = `bgstats-${game.id}.png`;
      const qrAttachment = await buildBgStatsQrAttachment(buttonUrl ?? url, qrFilename);

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${game.title}`)
        .setDescription(
          `Round ${assignment.round}, Table ${assignment.table} — <t:${clock.startUnix}:t>–<t:${clock.endUnix}:t>\n` +
            (buttonUrl
              ? 'Tap the button or scan the QR code to log this play in BG Stats.'
              : 'Scan the QR code to log this play in BG Stats (too many players for a tappable link).'),
        )
        .addFields({
          name: 'Players',
          value: game.seats.map((id) => nameMap[id] ?? id).join('\n') || '*(no seats defined)*',
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
// still acts as a floor, so a host can always force a higher minimum.

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
): number {
  return Math.max(
    computeHeadcountTableFloor(rsvpCount),
    computePreferenceSplitTableFloor(preferences),
    configDefault,
    1,
  );
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
    | 'lightBufferMinutes'
    | 'mediumBufferMinutes'
    | 'heavyBufferMinutes'
    | 'postBgStatsLinks'
    | 'heavyGameBreakMinutes'
    | 'maxGameRepeats'
  >,
): Promise<void> {
  gn.suggestionsLocked = true;

  const games = gn.eventChannelId ? await findGamesByChannel(gn.eventChannelId) : [];
  const schedulable = games.map((g) => toSchedulableGame(g, config));
  const windowMinutes = gn.endTimeISO
    ? (new Date(gn.endTimeISO).getTime() - new Date(gn.startTimeISO).getTime()) / 60000
    : Number.POSITIVE_INFINITY;

  const rsvpPreferences = await resolveRsvpComplexityPreferences(client, gn.guildId, gn.rsvps.yes);
  const tableCount = computeEffectiveTableCount(gn.rsvps.yes.length, rsvpPreferences, config.scheduleTableCount);
  const result = scheduleGames(schedulable, tableCount, windowMinutes, config);

  const assignmentByGame = new Map(result.assignments.map((a) => [a.gameId, a]));
  for (const game of games) {
    const assignment = assignmentByGame.get(game.id);
    if (assignment) {
      game.scheduledRound = assignment.round;
      game.scheduledTable = assignment.table;
      game.scheduledPlayCount = assignment.playCount;
      game.scheduledMayNotFinish = assignment.mayNotFinish;
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

  if (config.postBgStatsLinks) {
    await postBgStatsButtons(client, gn, games, result);
  }

  console.log(
    `Locked lineup and scheduled game night ${gn.id} (${result.assignments.length} scheduled, ${result.unscheduled.length} unscheduled, ${result.lowInterest.length} low interest)`,
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
  const tableCount = computeEffectiveTableCount(gn.rsvps.yes.length, rsvpPreferences, config.scheduleTableCount);
  const result = scheduleGames(schedulable, tableCount, windowMinutes, config);

  const embed = buildScheduleEmbed(gn, games, result)
    .setTitle(`🔍 Schedule Preview — ${gn.title ?? 'Game Night'}`)
    .setDescription(
      'Dry run only — suggestions are NOT locked, nothing is saved, and nothing is posted to the event channel.',
    );

  await interaction.editReply({ embeds: [embed] });
}
