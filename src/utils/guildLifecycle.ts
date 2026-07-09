import { readJson, writeJson } from './db';

const DELETED_GUILDS_FILE = 'deleted_guilds.json';
const RETENTION_DAYS = 30;

// Files and their data shapes for purging
const ARRAY_FILES = ['gamenights.json', 'library.json', 'games.json', 'privateRooms.json'] as const;

const KEYED_FILES = [
  'config.json',
  'bgg_accounts.json',
  'gameroles.json',
  'user_collections.json',
] as const;

interface DeletedGuild {
  guildId: string;
  guildName: string;
  deletedAt: string;
}

function loadDeletedGuilds(): Promise<DeletedGuild[]> {
  return readJson<DeletedGuild[]>(DELETED_GUILDS_FILE, []);
}

function saveDeletedGuilds(guilds: DeletedGuild[]): Promise<void> {
  return writeJson(DELETED_GUILDS_FILE, guilds);
}

export async function markGuildDeleted(guildId: string, guildName: string): Promise<void> {
  const guilds = (await loadDeletedGuilds()).filter((g) => g.guildId !== guildId);
  guilds.push({ guildId, guildName, deletedAt: new Date().toISOString() });
  await saveDeletedGuilds(guilds);
}

// Returns true if the guild was pending deletion (bot was re-added before data expired)
export async function restoreGuild(guildId: string): Promise<boolean> {
  const guilds = await loadDeletedGuilds();
  const idx = guilds.findIndex((g) => g.guildId === guildId);
  if (idx === -1) return false;
  guilds.splice(idx, 1);
  await saveDeletedGuilds(guilds);
  return true;
}

async function purgeGuildData(guildId: string): Promise<void> {
  // Array-based files: filter out entries belonging to this guild
  for (const file of ARRAY_FILES) {
    const entries = await readJson<Array<{ guildId?: string }>>(file, []);
    await writeJson(
      file,
      entries.filter((e) => e.guildId !== guildId),
    );
  }

  // library_requests.json: requests reference eventIds, not guildIds directly.
  // Cross-reference against the guild's event IDs (already purged above from gamenights,
  // so load before purge would be needed — but we purge gamenights first in the loop above).
  // Instead, keep a set of all remaining event IDs after purge and remove orphaned requests.
  const remainingNights = await readJson<Array<{ id: string }>>('gamenights.json', []);
  const validEventIds = new Set(remainingNights.map((n) => n.id));
  const requests = await readJson<Array<{ eventId?: string }>>('library_requests.json', []);
  await writeJson(
    'library_requests.json',
    requests.filter((r) => !r.eventId || validEventIds.has(r.eventId)),
  );

  // Record-keyed files: delete the guild's top-level key
  for (const file of KEYED_FILES) {
    const store = await readJson<Record<string, unknown>>(file, {});
    delete store[guildId];
    await writeJson(file, store);
  }

  console.log(`[GuildLifecycle] Purged all data for guild ${guildId}`);
}

export async function runRetentionCleanup(): Promise<void> {
  const now = Date.now();
  const cutoff = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const guilds = await loadDeletedGuilds();
  const expired = guilds.filter((g) => now - new Date(g.deletedAt).getTime() > cutoff);

  for (const guild of expired) {
    console.log(
      `[GuildLifecycle] Retention window expired for "${guild.guildName}" (${guild.guildId}) — purging data`,
    );
    await purgeGuildData(guild.guildId);
  }

  if (expired.length > 0) {
    await saveDeletedGuilds(guilds.filter((g) => now - new Date(g.deletedAt).getTime() <= cutoff));
  }
}
