import { readJson, writeJson } from './db';

const FILE = 'config.json';

export interface GuildConfig {
  defaultLocation: string;
  defaultTime: string;
  defaultEndTime: string;
  defaultDescription: string;
  announcementsChannelId: string;
  welcomeChannelId: string;
  rulesChannelId: string;
  facebookGroupUrl: string;
  bggGroupUrl: string;
  openEventChannels: boolean;
  eventCategoryName: string;
  archiveCategoryName: string;
  archivedChannelRetentionDays: number; // 0 = never auto-delete
  marketplaceChannelId: string;
  marketplaceNegotiationMode: 'public' | 'private';
  marketplaceTagIds: Record<string, string>;
  gameNightTagIds: Record<string, string>;
  // Lineup lock + scheduler (see src/utils/scheduler.ts). 0 = disabled.
  // Defaults to 48h before the event; set to 0 via /host event config to opt out.
  lockHoursBeforeEvent: number;
  scheduleTableCount: number;
  lightBufferMinutes: number;
  mediumBufferMinutes: number;
  heavyBufferMinutes: number;
  // Post a "Log in BG Stats" button per scheduled game when the lineup locks
  // (see src/utils/bgStats.ts). Off by default — opt-in like the rest of the
  // scheduler behavior, since it posts extra messages existing servers didn't ask for.
  postBgStatsLinks: boolean;
  // Post-placement scheduling refinements (see src/utils/scheduler.ts). Unlike most
  // scheduler config these default to non-zero even though the feature itself is
  // opt-in via lockHoursBeforeEvent — once a server turns scheduling on at all,
  // these refinements should be on by default rather than silently inert.
  // Global break inserted before a round when any one table would play two
  // Heavy-complexity games in directly-adjacent rounds. 0 = disabled.
  heavyGameBreakMinutes: number;
  // Cap on total play count for a short game (<30 min raw playtime)
  // opportunistically repeating into leftover round time. Minimum 1 (= no repeats).
  maxGameRepeats: number;
  // /room private channels (see src/commands/room.ts).
  privateRoomCategoryName: string;
  // IANA timezone (e.g. "America/New_York") used to interpret /event
  // date/time input and display it back consistently. Defaults to UTC rather
  // than the host process's local zone, which has no relation to where the
  // community actually is.
  timezone: string;
}

const DEFAULT_CONFIG: GuildConfig = {
  defaultLocation: '',
  defaultTime: '',
  defaultEndTime: '',
  defaultDescription: '',
  announcementsChannelId: '',
  welcomeChannelId: '',
  rulesChannelId: '',
  facebookGroupUrl: '',
  bggGroupUrl: '',
  openEventChannels: false,
  eventCategoryName: 'Events',
  archiveCategoryName: 'Archive',
  archivedChannelRetentionDays: 0,
  marketplaceChannelId: '',
  marketplaceNegotiationMode: 'private',
  marketplaceTagIds: {},
  gameNightTagIds: {},
  lockHoursBeforeEvent: 48,
  scheduleTableCount: 1,
  lightBufferMinutes: 15,
  mediumBufferMinutes: 30,
  heavyBufferMinutes: 45,
  postBgStatsLinks: false,
  heavyGameBreakMinutes: 30,
  maxGameRepeats: 3,
  privateRoomCategoryName: 'Private Rooms',
  timezone: 'UTC',
};

type ConfigStore = Record<string, GuildConfig>;

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  return (await readJson<ConfigStore>(FILE, {}))[guildId] ?? { ...DEFAULT_CONFIG };
}

export async function updateGuildConfig(
  guildId: string,
  patch: Partial<GuildConfig>,
): Promise<GuildConfig> {
  const store = await readJson<ConfigStore>(FILE, {});
  store[guildId] = { ...(await getGuildConfig(guildId)), ...patch };
  await writeJson(FILE, store);
  return store[guildId];
}
