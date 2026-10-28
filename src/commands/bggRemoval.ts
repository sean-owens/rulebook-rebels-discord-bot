import { ButtonInteraction, MessageFlags } from 'discord.js';
import { getRemovalProposal, resolveRemovalProposal } from '../utils/bggRemovalStorage';
import { getGamesByUser, removeGame } from '../utils/libraryStorage';

const EXPIRED_MESSAGE = 'This question has expired — nothing was removed. Use `/library remove` if you still want a game off the list.';

// Shared preamble for both buttons: finds the proposal and makes sure the person
// tapping it is the member it was asked of.
async function loadOwnProposal(interaction: ButtonInteraction, proposalId: string) {
  const proposal = await getRemovalProposal(proposalId);
  if (!proposal) {
    await interaction.update({ content: EXPIRED_MESSAGE, components: [] });
    return null;
  }
  if (interaction.user.id !== proposal.userId) {
    await interaction.reply({ content: "This question isn't for you.", flags: MessageFlags.Ephemeral });
    return null;
  }
  return proposal;
}

// "🗑️ Remove" — takes each proposed game off the member's library, then closes the question.
export async function handleBggRemovalConfirm(interaction: ButtonInteraction, proposalId: string): Promise<void> {
  const proposal = await loadOwnProposal(interaction, proposalId);
  if (!proposal) return;

  // Only remove an entry that is still the BGG-sourced one we asked about. If the member
  // has since re-added the game by hand (no BGG id) they clearly want it, so it stays.
  const current = await getGamesByUser(proposal.guildId, proposal.userId);
  const removed: string[] = [];
  for (const game of proposal.games) {
    const entry = current.find((e) => e.gameName.toLowerCase() === game.gameName.toLowerCase());
    if (!entry || entry.objectid !== game.bggGameId) continue;
    if ((await removeGame(proposal.guildId, proposal.userId, entry.gameName)) === 'removed') removed.push(entry.gameName);
  }

  await resolveRemovalProposal(proposal.id);
  const content =
    removed.length > 0
      ? `✅ Removed ${removed.length === 1 ? `**${removed[0]}**` : `**${removed.length}** games`} from the library.`
      : 'Nothing to remove — those games were already off your library list.';
  await interaction.update({ content, components: [] });
}

// "✅ Keep in library" — closes the question and changes nothing. The games already left
// the stored BGG snapshot when the sync noticed them, so they won't be asked about again.
export async function handleBggRemovalKeep(interaction: ButtonInteraction, proposalId: string): Promise<void> {
  const proposal = await loadOwnProposal(interaction, proposalId);
  if (!proposal) return;

  await resolveRemovalProposal(proposal.id);
  await interaction.update({ content: '👍 Okay — leaving them in the library.', components: [] });
}
