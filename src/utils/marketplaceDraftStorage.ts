import { readJson, writeJson } from './db';
import { Condition } from './marketplaceStorage';

// An in-progress /marketplace sell or /marketplace trade listing, built up
// across several buttons/modals/selects before the user confirms it. Persisted
// (in addition to the in-memory cache in src/commands/marketplace.ts) so a bot
// restart/redeploy mid-flow doesn't strand the user with dead "confirm"/
// "continue" buttons.
export interface SellDraft {
  listingType: 'sell' | 'trade';
  guildId: string;
  userId: string;
  username: string;
  itemName: string;
  bggId?: string;
  thumbnail?: string;
  isExpansion?: boolean;
  availableExpansions?: { bggId: string; name: string }[];
  expansions?: { bggId: string; name: string }[];
  parentItem?: { bggId: string; name: string };
  includesBaseGame?: boolean;
  condition: Condition;
  notes?: string;
  referenceLink?: string;
  bidsAllowed: boolean;
  lookingFor?: string;
  suggestedPrice?: number;
  priceCheckOnly?: boolean;
  expiresAt: number;
}

const FILE = 'marketplace-drafts.json';

type DraftStore = Record<string, SellDraft>;

export async function saveDraft(id: string, draft: SellDraft): Promise<void> {
  const store = await readJson<DraftStore>(FILE, {});
  store[id] = draft;
  await writeJson(FILE, store);
}

export async function deleteDraft(id: string): Promise<void> {
  const store = await readJson<DraftStore>(FILE, {});
  if (id in store) {
    delete store[id];
    await writeJson(FILE, store);
  }
}

// Excludes already-expired drafts — called once on bot startup to rehydrate
// the in-memory cache, so an expired draft from before a restart doesn't come
// back to life.
export async function loadUnexpiredDrafts(): Promise<DraftStore> {
  const store = await readJson<DraftStore>(FILE, {});
  const now = Date.now();
  const fresh: DraftStore = {};
  for (const [id, draft] of Object.entries(store)) {
    if (draft.expiresAt >= now) fresh[id] = draft;
  }
  return fresh;
}
