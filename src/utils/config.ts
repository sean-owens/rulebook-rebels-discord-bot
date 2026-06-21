import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'config.json');

export interface GuildConfig {
  defaultLocation: string;
  defaultTime: string;
  defaultEndTime: string;
  defaultDescription: string;
  announcementsChannelId: string;
}

type ConfigStore = Record<string, GuildConfig>;

function load(): ConfigStore {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as ConfigStore;
}

function save(store: ConfigStore): void {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

export function getGuildConfig(guildId: string): GuildConfig {
  return load()[guildId] ?? { defaultLocation: '', defaultTime: '', defaultEndTime: '', defaultDescription: '', announcementsChannelId: '' };
}

export function updateGuildConfig(guildId: string, patch: Partial<GuildConfig>): GuildConfig {
  const store = load();
  store[guildId] = { ...getGuildConfig(guildId), ...patch };
  save(store);
  return store[guildId];
}
