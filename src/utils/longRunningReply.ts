import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';

// Discord invalidates an interaction's token 15 minutes after it was created;
// after that, followUp/editReply fail with 50027 "Invalid Webhook Token". The
// margin keeps us from racing the deadline.
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const SAFETY_MARGIN_MS = 60 * 1000;

export function interactionTokenExpired(createdTimestamp: number, now: number = Date.now()): boolean {
  return now - createdTimestamp >= TOKEN_LIFETIME_MS - SAFETY_MARGIN_MS;
}

export type LongRunningResultRoute = 'followup' | 'dm' | 'failed';

// Reports the outcome of a command that can run past the 15-minute token
// window (e.g. /admin library syncall over a large library). While the token is
// still valid it's a normal ephemeral follow-up; once it isn't — or if the
// follow-up is rejected anyway — the result is delivered by DM through the
// bot's own connection instead, which has no such deadline. Never throws: the
// work it reports on has already finished, so a failure to say so is logged
// rather than surfaced as a command error.
export async function sendLongRunningResult(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<LongRunningResultRoute> {
  if (!interactionTokenExpired(interaction.createdTimestamp)) {
    try {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return 'followup';
    } catch (err) {
      console.warn('[longRunningReply] Follow-up rejected, falling back to a DM:', err);
    }
  }

  try {
    await interaction.user.send(`${content}\n\n_(This command ran longer than Discord allows for a reply, so the result is sent here instead.)_`);
    return 'dm';
  } catch (err) {
    console.error(`[longRunningReply] Could not deliver the result to ${interaction.user.id} by follow-up or DM: ${content}`, err);
    return 'failed';
  }
}
