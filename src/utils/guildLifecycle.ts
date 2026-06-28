import { readJson, writeJson } from './db';

const DELETED_GUILDS_FILE = 'deleted_guilds.json';
const RETENTION_DAYS = 30;

// Files and their data shapes for purging
const ARRAY_FILES = [
  'gamenights.json',
  'library.json',
  'games.json',
] as const;

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

function loadDeletedGuilds(): DeletedGuild[] {
  return readJson<DeletedGuild[]>(DELETED_GUILDS_FILE, []);
}

function saveDeletedGuilds(guilds: DeletedGuild[]): void {
  writeJson(DELETED_GUILDS_FILE, guilds);
}

export function markGuildDeleted(guildId: string, guildName: string): void {
  const guilds = loadDeletedGuilds().filter(g => g.guildId !== guildId);
  guilds.push({ guildId, guildName, deletedAt: new Date().toISOString() });
  saveDeletedGuilds(guilds);
}

// Returns true if the guild was pending deletion (bot was re-added before data expired)
export function restoreGuild(guildId: string): boolean {
  const guilds = loadDeletedGuilds();
  const idx = guilds.findIndex(g => g.guildId === guildId);
  if (idx === -1) return false;
  guilds.splice(idx, 1);
  saveDeletedGuilds(guilds);
  return true;
}

function purgeGuildData(guildId: string): void {
  // Array-based files: filter out entries belonging to this guild
  for (const file of ARRAY_FILES) {
    const entries = readJson<Array<{ guildId?: string }>>(file, []);
    writeJson(file, entries.filter(e => e.guildId !== guildId));
  }

  // library_requests.json: requests reference eventIds, not guildIds directly.
  // Cross-reference against the guild's event IDs (already purged above from gamenights,
  // so load before purge would be needed — but we purge gamenights first in the loop above).
  // Instead, keep a set of all remaining event IDs after purge and remove orphaned requests.
  const remainingNights = readJson<Array<{ id: string }>>(
    'gamenights.json',
    []
  );
  const validEventIds = new Set(remainingNights.map(n => n.id));
  const requests = readJson<Array<{ eventId?: string }>>('library_requests.json', []);
  writeJson('library_requests.json', requests.filter(r => !r.eventId || validEventIds.has(r.eventId)));

  // Record-keyed files: delete the guild's top-level key
  for (const file of KEYED_FILES) {
    const store = readJson<Record<string, unknown>>(file, {});
    delete store[guildId];
    writeJson(file, store);
  }

  console.log(`[GuildLifecycle] Purged all data for guild ${guildId}`);
}

export function runRetentionCleanup(): void {
  const now = Date.now();
  const cutoff = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const guilds = loadDeletedGuilds();
  const expired = guilds.filter(g => now - new Date(g.deletedAt).getTime() > cutoff);

  for (const guild of expired) {
    console.log(`[GuildLifecycle] Retention window expired for "${guild.guildName}" (${guild.guildId}) — purging data`);
    purgeGuildData(guild.guildId);
  }

  if (expired.length > 0) {
    saveDeletedGuilds(guilds.filter(g => now - new Date(g.deletedAt).getTime() <= cutoff));
  }
}
