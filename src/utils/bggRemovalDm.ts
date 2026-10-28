import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { BggRemovalProposal, ProposedRemoval, resolveRemovalProposal } from './bggRemovalStorage';

export const BGG_REMOVE_YES_PREFIX = 'bggremove_yes_';
export const BGG_REMOVE_NO_PREFIX = 'bggremove_no_';
const DM_NAME_LIMIT = 15;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The question put to the member. It says plainly that nothing changes unless they tap
// Remove — a game leaving BGG may just mean it's lent out, mid-trade, or a glitch.
export function buildRemovalProposalDm(games: ProposedRemoval[]): string {
  const shown = games.slice(0, DM_NAME_LIMIT).map((g) => `• ${g.gameName}${g.isExpansion ? ' *(expansion)*' : ''}`);
  const more = games.length > DM_NAME_LIMIT ? [`…and ${games.length - DM_NAME_LIMIT} more`] : [];
  return [
    `🧹 ${plural(games.length, 'item is', 'items are')} no longer in your BoardGameGeek collection, but ${games.length === 1 ? 'is' : 'are'} still in the group library:`,
    ...shown,
    ...more,
    '',
    'Want them taken off the library too? **Nothing is removed unless you tap Remove.**',
  ].join('\n');
}

export function buildRemovalProposalButtons(
  proposalId: string,
  count: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BGG_REMOVE_YES_PREFIX}${proposalId}`)
      .setLabel(`🗑️ Remove ${count === 1 ? 'it' : `all ${count}`}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${BGG_REMOVE_NO_PREFIX}${proposalId}`)
      .setLabel('✅ Keep in library')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Side effect: DMs the proposal. Returns whether it was delivered. A proposal that
// couldn't be delivered is discarded — nobody can ever answer it — and the games simply
// stay in the library, exactly as if the member had tapped Keep.
export async function sendRemovalProposalDm(client: Client, proposal: BggRemovalProposal): Promise<boolean> {
  try {
    const user = await client.users.fetch(proposal.userId);
    await user.send({
      content: buildRemovalProposalDm(proposal.games),
      components: [buildRemovalProposalButtons(proposal.id, proposal.games.length)],
    });
    return true;
  } catch (err) {
    console.warn(`[BggAutoSync] Could not DM ${proposal.userId} a removal proposal; leaving the games in the library:`, err);
    await resolveRemovalProposal(proposal.id);
    return false;
  }
}
