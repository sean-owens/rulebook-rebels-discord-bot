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
  openEventChannels: boolean;
  eventCategoryName: string;
  archiveCategoryName: string;
  archivedChannelRetentionDays: number; // 0 = never auto-delete
  marketplaceChannelId: string;
  marketplaceNegotiationMode: 'public' | 'private';
  marketplaceTagIds: Record<string, string>;
  // Lineup lock + scheduler (see src/utils/scheduler.ts). 0 = disabled — this is
  // a new behavior that adds a restriction to /game suggest, so it's opt-in
  // rather than on by default for existing servers.
  lockHoursBeforeEvent: number;
  scheduleTableCount: number;
  lightBufferMinutes: number;
  mediumBufferMinutes: number;
  heavyBufferMinutes: number;
  // Post a "Log in BG Stats" button per scheduled game when the lineup locks
  // (see src/utils/bgStats.ts). Off by default — opt-in like the rest of the
  // scheduler behavior, since it posts extra messages existing servers didn't ask for.
  postBgStatsLinks: boolean;
  // /room private channels (see src/commands/room.ts).
  privateRoomCategoryName: string;
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
  openEventChannels: false,
  eventCategoryName: 'Game Nights',
  archiveCategoryName: 'Archive',
  archivedChannelRetentionDays: 0,
  marketplaceChannelId: '',
  marketplaceNegotiationMode: 'public',
  marketplaceTagIds: {},
  lockHoursBeforeEvent: 0,
  scheduleTableCount: 1,
  lightBufferMinutes: 20,
  mediumBufferMinutes: 30,
  heavyBufferMinutes: 40,
  postBgStatsLinks: false,
  privateRoomCategoryName: 'Private Rooms',
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
