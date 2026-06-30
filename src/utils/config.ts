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
  eventCategoryName: 'Monthly Events',
  archiveCategoryName: 'Archive',
  archivedChannelRetentionDays: 0,
  marketplaceChannelId: '',
  marketplaceNegotiationMode: 'public',
  marketplaceTagIds: {},
};

type ConfigStore = Record<string, GuildConfig>;

export function getGuildConfig(guildId: string): GuildConfig {
  return readJson<ConfigStore>(FILE, {})[guildId] ?? { ...DEFAULT_CONFIG };
}

export function updateGuildConfig(guildId: string, patch: Partial<GuildConfig>): GuildConfig {
  const store = readJson<ConfigStore>(FILE, {});
  store[guildId] = { ...getGuildConfig(guildId), ...patch };
  writeJson(FILE, store);
  return store[guildId];
}
