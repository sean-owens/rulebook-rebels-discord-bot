import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';

const FILE = 'bgg_removal_proposals.json';

// A pending proposal is a question to a member — "these left your BGG collection, remove
// them from the library too?" — that they answer with a button on a DM. Nothing is
// removed until they do. One that's never answered just lapses: the games stay in the
// library, and the proposal is dropped once it's this old (its buttons then say so).
export const REMOVAL_PROPOSAL_MAX_AGE_DAYS = 30;

export interface ProposedRemoval {
  bggGameId: string;
  gameName: string;
  isExpansion: boolean;
}

export interface BggRemovalProposal {
  id: string;
  guildId: string;
  userId: string;
  games: ProposedRemoval[];
  createdAt: string;
}

async function load(): Promise<BggRemovalProposal[]> {
  return readJson<BggRemovalProposal[]>(FILE, []);
}

export async function createRemovalProposal(
  guildId: string,
  userId: string,
  games: ProposedRemoval[],
  now: Date = new Date(),
): Promise<BggRemovalProposal> {
  const cutoff = now.getTime() - REMOVAL_PROPOSAL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  // Opportunistic cleanup of lapsed proposals, so the file can't grow without bound.
  const live = (await load()).filter((p) => Date.parse(p.createdAt) >= cutoff);

  const proposal: BggRemovalProposal = {
    id: randomUUID().slice(0, 12),
    guildId,
    userId,
    games,
    createdAt: now.toISOString(),
  };
  live.push(proposal);
  await writeJson(FILE, live);
  return proposal;
}

export async function getRemovalProposal(id: string): Promise<BggRemovalProposal | undefined> {
  return (await load()).find((p) => p.id === id);
}

// Called once the member has answered (either way) — or when the DM couldn't be
// delivered, since a proposal nobody can see can never be answered.
export async function resolveRemovalProposal(id: string): Promise<void> {
  const proposals = await load();
  const remaining = proposals.filter((p) => p.id !== id);
  if (remaining.length !== proposals.length) await writeJson(FILE, remaining);
}
