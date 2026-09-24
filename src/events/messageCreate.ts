import { ActionRowBuilder, Message, StringSelectMenuBuilder, TextChannel } from 'discord.js';
import { getGuildConfig } from '../utils/config';
import { getActiveChallenge, WeeklyChallenge } from '../utils/boardGameChallengeStorage';
import {
  classifyGuessMatch,
  findDisambiguationCandidates,
  awardCorrectGuess,
} from '../utils/boardGameChallenge';
import type { BGGCatalogEntry } from '../utils/bggCatalog';

export const CHALLENGE_DISAMBIG_PREFIX = 'bgchallenge_disambig_';

// Side effect: asks the guesser which of several same-base games they meant.
// The customId carries the challenge and guesser ids (no underscores in
// either) so the select handler can reject anyone else's click.
async function sendDisambiguationPrompt(
  message: Message,
  challenge: WeeklyChallenge,
  candidates: BGGCatalogEntry[],
): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${CHALLENGE_DISAMBIG_PREFIX}${challenge.id}_${message.author.id}`)
    .setPlaceholder('Which game did you mean?')
    .addOptions(
      candidates.map((c) => ({
        label: (c.year ? `${c.name} (${c.year})` : c.name).slice(0, 100),
        value: c.id,
      })),
    );

  await message
    .reply({
      content: '🤔 That could match more than one game — pick the one you meant:',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    })
    .catch((err: unknown) =>
      console.warn(`[BoardGameChallenge] Failed to send disambiguation prompt in guild ${challenge.guildId}:`, err),
    );
}

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

  const tier = classifyGuessMatch(message.content, challenge.title);
  if (tier === 'none') {
    await message.react('❌').catch(() => null);
    return;
  }

  // A base-only guess ("Star Wars") that several catalog games share isn't
  // scored on the spot — the guesser picks which one they meant instead.
  if (tier === 'base') {
    const candidates = findDisambiguationCandidates(message.content, challenge.bggId);
    if (candidates.length > 1) {
      await sendDisambiguationPrompt(message, challenge, candidates);
      return;
    }
  }

  const result = await awardCorrectGuess(
    message.client,
    message.guildId,
    challenge,
    message.author.id,
    message.channel as TextChannel,
  );
  if (!result) return; // already scored (race with another event) — nothing left to do

  // Delete the guess so the answer never sits visible in-channel for others
  // to copy before the reveal.
  await message.delete().catch((err) =>
    console.warn(`[BoardGameChallenge] Failed to delete correct guess in guild ${message.guildId}:`, err),
  );
}
