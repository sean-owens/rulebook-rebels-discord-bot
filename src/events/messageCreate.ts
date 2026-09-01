import { Message, TextChannel } from 'discord.js';
import { getGuildConfig } from '../utils/config';
import { getActiveChallenge, recordCorrectGuess } from '../utils/boardGameChallengeStorage';
import { isCorrectGuess } from '../utils/boardGameChallenge';

// Guesses for the weekly board game challenge (see boardGameChallenge.ts)
// arrive as plain messages in the guild's configured channel rather than a
// slash command, since that's the natural way to "reply with your guess" —
// this is the bot's only feature that reads message content.
export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || !message.guildId) return;

  const config = await getGuildConfig(message.guildId);
  if (!config.boardGameChallengeChannelId || message.channelId !== config.boardGameChallengeChannelId) return;

  const challenge = await getActiveChallenge(message.guildId);
  if (!challenge || challenge.hintsPostedCount === 0) return;
  if (challenge.correctGuesses.some((g) => g.userId === message.author.id)) return;

  if (!isCorrectGuess(message.content, challenge.title)) {
    await message.react('❌').catch(() => null);
    return;
  }

  const result = await recordCorrectGuess(
    message.guildId,
    challenge.id,
    message.author.id,
    challenge.hintsPostedCount,
  );
  if (!result) return; // already scored (race with another event) — nothing left to do

  // Delete the guess so the answer never sits visible in-channel for others
  // to copy before Saturday's reveal, and confirm privately instead.
  await message.delete().catch((err) =>
    console.warn(`[BoardGameChallenge] Failed to delete correct guess in guild ${message.guildId}:`, err),
  );

  // The delete above leaves no visible trace anything happened — post a
  // public, answer-free acknowledgement so a correct guess is obviously
  // recognized instead of just silently vanishing. The channel is always the
  // configured (guild text) challenge channel checked above, so it's always sendable.
  await (message.channel as TextChannel)
    .send(`🎉 <@${message.author.id}> guessed it! (+${result.points} points)`)
    .catch((err: unknown) =>
      console.warn(`[BoardGameChallenge] Failed to post correct-guess announcement in guild ${message.guildId}:`, err),
    );

  try {
    await message.author.send(
      `🎉 Correct! **${challenge.title}** was this cycle's board game challenge — you earned **${result.points} points** ` +
        `(guessed after hint ${challenge.hintsPostedCount}/3). Your running total is now **${result.totalPoints} points**. ` +
        "Keep it to yourself until the reveal!",
    );
  } catch (err) {
    console.warn(`[BoardGameChallenge] Failed to DM ${message.author.id} their guess result:`, err);
  }
}
