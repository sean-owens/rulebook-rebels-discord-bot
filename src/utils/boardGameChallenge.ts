import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { getBGGGame, weightTag, BGGGame } from './bgg';
import { getTopRankedGames, editDistanceAtMost } from './bggCatalog';
import { buildBggAttachment } from './gameEmbeds';
import { getGuildConfig, getGuildIdsWithConfig, GuildConfig } from './config';
import { mondayOfWeekInTimeZone, todayInTimeZone, zonedTimeToUtc } from './timezone';
import {
  WeeklyChallenge,
  LeaderboardEntry,
  getActiveChallenge,
  getChallengesForGuild,
  createWeeklyChallenge,
  recordHintPosted,
  revealChallenge,
  getRecentGameIds,
  getLeaderboard,
  updateChallengeChannel,
} from './boardGameChallengeStorage';

// Picks a random game from BGG's top-ranked pool that this guild hasn't
// played recently — each guild gets its own independent pick (not synced
// across servers) so a member active in multiple opted-in servers can't
// spoil the answer for one server by discussing it in another.
export async function selectWeeklyGame(guildId: string): Promise<BGGGame | undefined> {
  const pool = getTopRankedGames(500);
  if (pool.length === 0) return undefined;

  const recentIds = await getRecentGameIds(guildId, 52);
  const eligible = pool.filter((g) => !recentIds.has(g.id));
  const candidates = eligible.length > 0 ? eligible : pool; // pool exhausted — allow repeats rather than stall forever

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return getBGGGame(pick.id);
}

function playerRangeText(game: BGGGame): string {
  return game.minPlayers === game.maxPlayers
    ? `${game.minPlayers} players`
    : `${game.minPlayers}–${game.maxPlayers} players`;
}

function playtimeRangeText(game: BGGGame): string {
  return game.minPlaytime === game.maxPlaytime
    ? `~${game.minPlaytime} min`
    : `~${game.minPlaytime}–${game.maxPlaytime} min`;
}

// Three tiers, each holding up to 3 facts and progressing vaguest → most
// specific, built entirely from BGG metadata — never the title or thumbnail:
//   1. player count, duration, genre/category — broad "what kind of game is this"
//   2. mechanics, weight/complexity, best player count — how it actually plays
//   3. year released, designer(s), publisher — specific enough to place it
// Best-effort throughout: an individual fact is simply omitted when BGG has
// no data for it (e.g. no categories tagged), so a thinly-documented game
// still gets a usable (if shorter) hint instead of an error. Hint 1's first
// two facts (player count, duration) always have a value — bgg.ts defaults
// min/max players/playtime rather than leaving them null — so hint 1 is
// never empty even when genre data is missing; likewise hint 2's "best with"
// fact always has a value. Hint 3 can end up empty for a very
// thinly-documented catalog entry (no year/designer/publisher on file), so it
// alone keeps a fallback line.
export function generateClues(game: BGGGame): [string, string, string] {
  const clue1Facts = [
    playerRangeText(game),
    playtimeRangeText(game),
    game.categories.length > 0 ? `${game.categories.join('/')} genre` : null,
  ].filter((f): f is string => f !== null);
  const clue1 = clue1Facts.join(' • ');

  const clue2Facts = [
    game.mechanics.length > 0 ? `Mechanics: ${game.mechanics.join(', ')}` : null,
    game.weight ? `${weightTag(game.weight)} weight/complexity` : null,
    `Best with ${game.suggestedPlayers} player${game.suggestedPlayers === 1 ? '' : 's'}`,
  ].filter((f): f is string => f !== null);
  const clue2 = clue2Facts.join(' • ');

  const clue3Facts = [
    game.yearPublished ? `Released in ${game.yearPublished}` : null,
    game.designers.length > 0 ? `Designed by ${game.designers.join(', ')}` : null,
    game.publishers.length > 0 ? `Published by ${game.publishers[0]}` : null,
  ].filter((f): f is string => f !== null);
  const clue3 = clue3Facts.length > 0 ? clue3Facts.join('. ') : "That's all the data we've got — good luck!";

  return [clue1, clue2, clue3];
}

const LEADING_ARTICLES = /^(the|a|an)\s+/;

// Lowercases, drops a colon/parenthetical subtitle (so "Terraforming Mars:
// Ares Expedition" and "Terraforming Mars" normalize the same — a deliberate
// forgiveness call, see isCorrectGuess), strips punctuation, and drops a
// leading article.
export function normalizeGuess(text: string): string {
  return text
    .toLowerCase()
    .split(/[:(]/)[0]
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLES, '');
}

// Exact match after normalization, or a typo-tolerant fuzzy match bounded to
// ~15% of the title's length (min 1, max 6 edits) — forgiving of small typos
// without accepting a genuinely different title.
export function isCorrectGuess(guess: string, title: string): boolean {
  const normGuess = normalizeGuess(guess);
  const normTitle = normalizeGuess(title);
  if (!normGuess || !normTitle) return false;
  if (normGuess === normTitle) return true;

  const maxDist = Math.min(6, Math.max(1, Math.floor(normTitle.length * 0.15)));
  return editDistanceAtMost(normGuess, normTitle, maxDist);
}

// Shared by /challenge leaderboard (commands/boardgamechallenge.ts) and the
// auto-posted-and-pinned copy in postReveal below, so the two never drift.
export function buildLeaderboardEmbed(entries: LeaderboardEntry[]): EmbedBuilder {
  const lines =
    entries.length > 0
      ? entries
          .slice(0, 10)
          .map((e, i) => `**${i + 1}.** <@${e.userId}> — ${e.points} pt${e.points === 1 ? '' : 's'}`)
      : ['No points on the board yet — guess correctly in the board game challenge to get started!'];

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🏆 Board Game Challenge — Leaderboard')
    .setDescription(lines.join('\n'));
}

async function getTextChannel(client: Client, channelId: string): Promise<TextChannel | undefined> {
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased() && 'send' in channel ? (channel as TextChannel) : undefined;
  } catch {
    return undefined;
  }
}

// Side effect: posts one hint embed and records it. Isolated from the
// schedule-decision logic in checkAndAdvanceChallengeSchedule so posting can
// be tested/replaced independently (per CLAUDE.md 1c).
export async function postHint(
  client: Client,
  challenge: WeeklyChallenge,
  hintIndex: 1 | 2 | 3,
): Promise<void> {
  const channel = await getTextChannel(client, challenge.channelId);
  if (!channel) {
    console.warn(
      `[BoardGameChallenge] Channel ${challenge.channelId} unavailable for guild ${challenge.guildId} — skipping hint ${hintIndex}`,
    );
    return;
  }

  const pointsByStage = { 1: 100, 2: 80, 3: 50 } as const;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎲 Board Game Challenge — Hint ${hintIndex}/3`)
    .setDescription(challenge.clues[hintIndex - 1])
    .setFooter({
      text: `Reply in this channel with your guess! Correct right now = ${pointsByStage[hintIndex]} points. Answer revealed at the end of this cycle — see /challenge status for the exact time.`,
    })
    .setImage('attachment://powered_by_BGG_01_SM.png');

  // Full rules only on hint 1 — the weekly "first thing posted" moment new
  // members are most likely to see, without repeating the same block on hints 2/3.
  if (hintIndex === 1) {
    embed.addFields({
      name: 'How to play',
      value:
        'Reply right here in this channel with your guess for the mystery game — no command needed. ' +
        'Wrong guesses get a ❌ reaction so you know to try again. A correct guess is deleted immediately ' +
        "and confirmed privately by DM (with your point total), so the answer stays secret for everyone " +
        "else until the reveal. Guessing earlier (fewer hints) is worth more points, and everyone " +
        'who guesses right scores, not just the first person.',
    });
  }

  const message = await channel.send({ embeds: [embed], files: [buildBggAttachment()] });
  await recordHintPosted(challenge.guildId, challenge.id, hintIndex, message.id);
}

// Side effect: posts the reveal embed (title, thumbnail, BGG link, this
// round's correct guessers) and marks the challenge revealed.
export async function postReveal(client: Client, challenge: WeeklyChallenge): Promise<void> {
  const channel = await getTextChannel(client, challenge.channelId);
  if (!channel) {
    console.warn(
      `[BoardGameChallenge] Channel ${challenge.channelId} unavailable for guild ${challenge.guildId} — skipping reveal`,
    );
    await revealChallenge(challenge.guildId, challenge.id);
    return;
  }

  const winnerLines =
    challenge.correctGuesses.length > 0
      ? challenge.correctGuesses
          .sort((a, b) => b.points - a.points)
          .map((g) => `<@${g.userId}> — ${g.points} pts`)
          .join('\n')
      : 'Nobody guessed it this week!';

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`🎉 The answer was: ${challenge.title}`)
    .setURL(challenge.bggLink)
    .setDescription(`This week's game — full details on [BoardGameGeek](${challenge.bggLink}).`)
    .addFields({ name: 'Correct guessers', value: winnerLines })
    .setImage('attachment://powered_by_BGG_01_SM.png');
  if (challenge.thumbnail) embed.setThumbnail(challenge.thumbnail);

  await channel.send({ embeds: [embed], files: [buildBggAttachment()] });
  await revealChallenge(challenge.guildId, challenge.id);
  await postAndPinLeaderboard(client, channel, challenge.guildId);
}

// Keeps the leaderboard visible between weeks instead of requiring members to
// remember /challenge leaderboard exists. Best-effort: a missing Pin Messages
// permission (or any other failure) is logged and swallowed rather than
// blocking the reveal, which has already happened by the time this runs.
async function postAndPinLeaderboard(client: Client, channel: TextChannel, guildId: string): Promise<void> {
  try {
    const entries = await getLeaderboard(guildId);
    const message = await channel.send({ embeds: [buildLeaderboardEmbed(entries)] });

    const pins = await channel.messages.fetchPinned();
    for (const [, pinned] of pins) {
      if (pinned.author.id === client.user!.id) await pinned.unpin().catch(() => null);
    }
    await message.pin();
  } catch (err) {
    console.warn(`[BoardGameChallenge] Failed to post/pin leaderboard for guild ${guildId}:`, err);
  }
}

async function startNewChallenge(
  client: Client,
  guildId: string,
  channelId: string,
  periodStart: string,
): Promise<void> {
  const game = await selectWeeklyGame(guildId);
  if (!game) {
    console.warn(`[BoardGameChallenge] No BGG catalog entries available — skipping guild ${guildId}`);
    return;
  }

  const challenge = await createWeeklyChallenge(guildId, {
    weekStart: periodStart,
    bggId: game.id,
    title: game.name,
    clues: generateClues(game),
    thumbnail: game.thumbnail,
    bggLink: game.bggLink,
    channelId,
  });
  await postHint(client, challenge, 1);
}

function daysSinceMonday(weekday: number): number {
  return (weekday + 6) % 7; // Sun(0)->6, Mon(1)->0, Tue(2)->1, ... Sat(6)->5
}

// One challenge cycle's length in calendar days, by frequency — used both to
// size the "no active challenge" -> "force-reveal a stale one" staleness
// window and (for 'biweekly') to find which 14-day bucket "now" falls into.
function periodLengthDays(frequency: GuildConfig['challengeFrequency']): number {
  if (frequency === 'daily') return 1;
  if (frequency === 'biweekly') return 14;
  return 7;
}

// A stage's configured weekday only means anything when the cycle spans a
// full week ('weekly'/'biweekly') — a 'daily' cycle has no "day of week" of
// its own, so every stage falls on the cycle's own day (offset 0) regardless
// of what's stored in *Weekday, and only the *Hour fields matter for it.
function stageDayOffset(frequency: GuildConfig['challengeFrequency'], weekday: number): number {
  return frequency === 'daily' ? 0 : daysSinceMonday(weekday);
}

// The Monday ("YYYY-MM-DD") of the current 14-day bucket for 'biweekly' mode,
// counting in exact 14-day increments from `anchor` (itself always a Monday —
// see mondayOfDateInTimeZone in /admin challenge config's start_date
// handling). Returns undefined if `anchor` is still in the future (the
// bi-weekly cycle hasn't started yet) so the caller knows not to create a
// challenge yet. Landing in the "off" week of a bucket still resolves to that
// bucket's Monday — the same one the "on" week's challenge was created
// under — so the "already started this period" check below correctly finds
// it and doesn't start a second one; a new challenge only becomes possible
// again once a full 14 days have passed.
function biweeklyPeriodStart(anchor: string, timeZone: string): string | undefined {
  const thisMonday = mondayOfWeekInTimeZone(timeZone);
  const [anchorYear, anchorMonth, anchorDay] = anchor.split('-').map(Number);
  const [nowYear, nowMonth, nowDay] = thisMonday.split('-').map(Number);
  const anchorMs = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);
  const thisMondayMs = Date.UTC(nowYear, nowMonth - 1, nowDay);
  const daysSinceAnchor = Math.round((thisMondayMs - anchorMs) / (24 * 60 * 60 * 1000));
  if (daysSinceAnchor < 0) return undefined;
  const periodsElapsed = Math.floor(daysSinceAnchor / 14);
  const periodStartMs = anchorMs + periodsElapsed * 14 * 24 * 60 * 60 * 1000;
  return new Date(periodStartMs).toISOString().slice(0, 10);
}

// The date a new challenge cycle would start on right now, per `config`'s
// frequency — undefined only for 'biweekly' before its anchor date has
// arrived. 'daily' starts fresh every day; 'weekly' every Monday; 'biweekly'
// every other Monday from challengeCycleAnchor (defaulting to "starting this
// week" if no anchor has been set yet — see handleChallengeConfig).
function currentPeriodStart(config: GuildConfig): string | undefined {
  if (config.challengeFrequency === 'daily') {
    const { year, month, day } = todayInTimeZone(config.timezone);
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  }
  if (config.challengeFrequency === 'biweekly') {
    return config.challengeCycleAnchor
      ? biweeklyPeriodStart(config.challengeCycleAnchor, config.timezone)
      : mondayOfWeekInTimeZone(config.timezone);
  }
  return mondayOfWeekInTimeZone(config.timezone);
}

// The absolute instant (UTC) that `weekday`/`hour` falls on within the cycle
// that starts on `periodStart` ("YYYY-MM-DD", as read on a clock in
// `timeZone`) — `weekday` is pre-resolved to a day offset via
// stageDayOffset so this works the same regardless of frequency. Comparing
// real instants — rather than "is today's weekday exactly X" — is what lets
// a stage catch up after an outage that spans past its scheduled day
// entirely (e.g. the bot is down all of Wednesday and comes back Friday): a
// same-day-only comparison would never match again once Wednesday has
// passed, permanently skipping that hint and every stage after it that
// depends on it, even though the challenge itself isn't stale enough yet to
// hit the force-reveal safety net below.
function stageInstant(periodStart: string, dayOffset: number, hour: number, timeZone: string): number {
  const [year, month, day] = periodStart.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  target.setUTCDate(target.getUTCDate() + dayOffset);
  return zonedTimeToUtc(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, 0, timeZone).getTime();
}

// How long after hint 1's scheduled moment the scheduler will still start a
// brand-new cycle for it — comfortably longer than the hourly check's own
// cadence (so normal jitter never causes a miss) but short enough that a
// genuinely-missed moment (bot off, data reset, etc.) waits for the next
// real occurrence instead of firing late. See the "start a new challenge"
// branch below.
const START_NEW_CHALLENGE_GRACE_MS = 90 * 60 * 1000;

// Polled from the existing hourly ready.ts loop (idempotent — safe to call
// every tick, and safe to catch up after a missed tick/restart, since every
// decision is guarded by state already stored on the WeeklyChallenge record
// rather than a separate "did we already fire" timestamp; see
// checkBggCatalogReminder for the precedent this follows).
export async function checkAndAdvanceChallengeSchedule(client: Client): Promise<void> {
  const guildIds = await getGuildIdsWithConfig();
  const now = Date.now();

  for (const guildId of guildIds) {
    const config = await getGuildConfig(guildId);
    if (!config.boardGameChallengeEnabled || !config.boardGameChallengeChannelId) continue;

    const channelId = config.boardGameChallengeChannelId;
    const active = await getActiveChallenge(guildId);
    const periodMs = periodLengthDays(config.challengeFrequency) * 24 * 60 * 60 * 1000;

    // Safety net: if a challenge is still unrevealed a full cycle after it
    // started (e.g. the bot was down for an extended stretch), force the
    // reveal now instead of leaving it stuck forever and blocking every
    // future cycle's "no active challenge" creation check. `weekStart` must
    // be interpreted as midnight in the guild's *own* timezone (via
    // stageInstant, same as every other stage) — plain `new Date(weekStart)`
    // reads it as UTC midnight instead, which for a zone behind UTC (e.g.
    // America/New_York) pulls this threshold hours earlier than a true full
    // cycle, and in daily mode (a 24h period) that error is large enough to
    // fire before hint 2/3 ever got a chance to catch up.
    if (active && now - stageInstant(active.weekStart, 0, 0, config.timezone) > periodMs) {
      await postReveal(client, active).catch((err) =>
        console.error(`[BoardGameChallenge] Catch-up reveal failed for guild ${guildId}:`, err),
      );
      continue;
    }

    try {
      if (!active) {
        const periodStart = currentPeriodStart(config);
        const hint1Instant = periodStart
          ? stageInstant(
              periodStart,
              stageDayOffset(config.challengeFrequency, config.challengeClue1Weekday),
              config.challengeClue1Hour,
              config.timezone,
            )
          : undefined;
        // Starting a brand-new cycle deliberately does NOT catch up like the
        // stages below do — only fires within a short window of hint 1's
        // actual moment (long enough to absorb the hourly check's own timing
        // jitter, per the "Note on timing precision" in TESTING.md 4.9), not
        // "any time after it, indefinitely." Once a cycle is already running,
        // losing it to an outage is worse than posting late, so hint 2/3/
        // reveal/hint-1-retry below still catch up no matter how overdue —
        // but deciding whether to START one is different: if the moment's
        // already passed (the bot was off, config/data just got reset, etc.),
        // members reasonably expect it to wait for the next real occurrence,
        // not suddenly post right now at an unexpected time.
        if (
          hint1Instant !== undefined &&
          now >= hint1Instant &&
          now - hint1Instant <= START_NEW_CHALLENGE_GRACE_MS
        ) {
          // Guards against restarting the cycle later in the same period
          // when the reveal is scheduled on/after hint 1's moment (e.g. a
          // same-day testing schedule, or 'daily' mode where they're always
          // the same day): right after a reveal, `active` is briefly
          // undefined again, and hint 1's moment has already passed for the
          // rest of the period, so the plain "!active" check above would
          // otherwise fire again on the next tick and start a second
          // challenge. Checking for an existing challenge this period
          // (revealed or not) prevents that.
          const startedThisPeriod = (await getChallengesForGuild(guildId)).some((c) => c.weekStart === periodStart);
          if (!startedThisPeriod) {
            await startNewChallenge(client, guildId, channelId, periodStart!);
          }
        }
      } else if (
        active.hintsPostedCount === 0 &&
        now >= stageInstant(
          active.weekStart,
          stageDayOffset(config.challengeFrequency, config.challengeClue1Weekday),
          config.challengeClue1Hour,
          config.timezone,
        )
      ) {
        // Hint 1 was recorded as started but never actually posted — most
        // likely the channel it was created against was unavailable at that
        // moment (e.g. deleted right after, or a stale config value). Retry
        // rather than leaving the challenge stuck forever with a blank
        // /challenge status and nothing posted. If the admin has since
        // pointed the config at a different channel, re-point this
        // still-unstarted challenge there too — nothing has posted yet, so
        // there's no prior channel to stay consistent with.
        const target = active.channelId === channelId
          ? active
          : (await updateChallengeChannel(guildId, active.id, channelId)) ?? active;
        await postHint(client, target, 1);
      } else if (
        active.hintsPostedCount === 1 &&
        now >= stageInstant(
          active.weekStart,
          stageDayOffset(config.challengeFrequency, config.challengeClue2Weekday),
          config.challengeClue2Hour,
          config.timezone,
        )
      ) {
        await postHint(client, active, 2);
      } else if (
        active.hintsPostedCount === 2 &&
        now >= stageInstant(
          active.weekStart,
          stageDayOffset(config.challengeFrequency, config.challengeClue3Weekday),
          config.challengeClue3Hour,
          config.timezone,
        )
      ) {
        await postHint(client, active, 3);
      } else if (
        now >= stageInstant(
          active.weekStart,
          stageDayOffset(config.challengeFrequency, config.challengeRevealWeekday),
          config.challengeRevealHour,
          config.timezone,
        )
      ) {
        await postReveal(client, active);
      }
    } catch (err) {
      console.error(`[BoardGameChallenge] Schedule check failed for guild ${guildId}:`, err);
    }
  }
}

export { getLeaderboard };
