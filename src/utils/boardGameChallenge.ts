import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { getBGGGame, weightTag, BGGGame } from './bgg';
import { getTopRankedGames, editDistanceAtMost } from './bggCatalog';
import { buildBggAttachment } from './gameEmbeds';
import { getGuildConfig, getGuildIdsWithConfig } from './config';
import { nowInTimeZone, mondayOfWeekInTimeZone } from './timezone';
import {
  WeeklyChallenge,
  getActiveChallenge,
  createWeeklyChallenge,
  recordHintPosted,
  revealChallenge,
  getRecentGameIds,
  getLeaderboard,
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

// Three tiers, vaguest to most specific, built entirely from BGG metadata —
// never the title or thumbnail. Best-effort: individual facts are simply
// omitted when BGG has no data for them (e.g. no weight rating yet), so a
// thinly-documented game still gets a usable (if shorter) hint instead of an
// error.
export function generateClues(game: BGGGame): [string, string, string] {
  const decade = game.yearPublished ? `${Math.floor(game.yearPublished / 10) * 10}s` : null;
  const clue1Facts = [
    playerRangeText(game),
    playtimeRangeText(game),
    game.weight ? `${weightTag(game.weight)} weight/complexity` : null,
    decade ? `first published in the ${decade}` : null,
  ].filter((f): f is string => f !== null);
  const clue1 = clue1Facts.join(' • ');

  const tagsForClue2 = game.tags.slice(0, 3);
  const tagsForClue3 = game.tags.slice(3);
  const clue2 =
    tagsForClue2.length > 0
      ? `Tagged with: ${tagsForClue2.join(', ')}`
      : "No standout mechanics/categories on file for this one — save your guess for hint 3!";

  const clue3Facts = [
    game.designers.length > 0 ? `Designed by ${game.designers.join(', ')}` : null,
    game.yearPublished ? `Published in ${game.yearPublished}` : null,
    tagsForClue3.length > 0 ? `Also tagged: ${tagsForClue3.join(', ')}` : null,
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
    .setTitle(`🎲 Weekly Board Game Challenge — Hint ${hintIndex}/3`)
    .setDescription(challenge.clues[hintIndex - 1])
    .setFooter({
      text: `Reply in this channel with your guess! Correct right now = ${pointsByStage[hintIndex]} points. Answer revealed at week's end — see /challenge status for the exact time.`,
    })
    .setImage('attachment://powered_by_BGG_01_SM.png');

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
}

async function startNewChallenge(client: Client, guildId: string, channelId: string, timezone: string): Promise<void> {
  const game = await selectWeeklyGame(guildId);
  if (!game) {
    console.warn(`[BoardGameChallenge] No BGG catalog entries available — skipping guild ${guildId}`);
    return;
  }

  const challenge = await createWeeklyChallenge(guildId, {
    weekStart: mondayOfWeekInTimeZone(timezone),
    bggId: game.id,
    title: game.name,
    clues: generateClues(game),
    thumbnail: game.thumbnail,
    bggLink: game.bggLink,
    channelId,
  });
  await postHint(client, challenge, 1);
}

// Polled from the existing hourly ready.ts loop (idempotent — safe to call
// every tick, and safe to catch up after a missed tick/restart, since every
// decision is guarded by state already stored on the WeeklyChallenge record
// rather than a separate "did we already fire" timestamp; see
// checkBggCatalogReminder for the precedent this follows).
export async function checkAndAdvanceChallengeSchedule(client: Client): Promise<void> {
  const guildIds = await getGuildIdsWithConfig();

  for (const guildId of guildIds) {
    const config = await getGuildConfig(guildId);
    if (!config.boardGameChallengeEnabled || !config.boardGameChallengeChannelId) continue;

    const { weekday, hour } = nowInTimeZone(config.timezone);
    const channelId = config.boardGameChallengeChannelId;
    const active = await getActiveChallenge(guildId);

    // Safety net: if a challenge is still unrevealed a full week after it
    // started (e.g. the bot was down all Saturday evening), force the reveal
    // now instead of leaving it stuck forever and blocking every future
    // Monday's "!active" creation check.
    if (active && Date.now() - new Date(active.weekStart).getTime() > 7 * 24 * 60 * 60 * 1000) {
      await postReveal(client, active).catch((err) =>
        console.error(`[BoardGameChallenge] Catch-up reveal failed for guild ${guildId}:`, err),
      );
      continue;
    }

    try {
      if (weekday === config.challengeClue1Weekday && hour >= config.challengeClue1Hour && !active) {
        await startNewChallenge(client, guildId, channelId, config.timezone);
      } else if (
        weekday === config.challengeClue2Weekday &&
        hour >= config.challengeClue2Hour &&
        active?.hintsPostedCount === 1
      ) {
        await postHint(client, active, 2);
      } else if (
        weekday === config.challengeClue3Weekday &&
        hour >= config.challengeClue3Hour &&
        active?.hintsPostedCount === 2
      ) {
        await postHint(client, active, 3);
      } else if (weekday === config.challengeRevealWeekday && hour >= config.challengeRevealHour && active) {
        await postReveal(client, active);
      }
    } catch (err) {
      console.error(`[BoardGameChallenge] Schedule check failed for guild ${guildId}:`, err);
    }
  }
}

export { getLeaderboard };
