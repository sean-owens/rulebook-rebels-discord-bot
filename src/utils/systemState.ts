import { readJson, writeJson } from './db';

const FILE = 'system_state.json';

// Bot-global state — not guild-scoped, so deliberately excluded from
// guildLifecycle.ts's ARRAY_FILES/KEYED_FILES purge lists (same rationale as
// shortLinkStorage.ts's own exclusion note).
interface SystemState {
  bggCatalogReminderSentAt?: string;
}

async function loadState(): Promise<SystemState> {
  return readJson<SystemState>(FILE, {});
}

async function saveState(patch: Partial<SystemState>): Promise<void> {
  const state = await loadState();
  await writeJson(FILE, { ...state, ...patch });
}

export async function getBggCatalogReminderSentAt(): Promise<Date | undefined> {
  const state = await loadState();
  return state.bggCatalogReminderSentAt ? new Date(state.bggCatalogReminderSentAt) : undefined;
}

export async function markBggCatalogReminderSent(): Promise<void> {
  await saveState({ bggCatalogReminderSentAt: new Date().toISOString() });
}
