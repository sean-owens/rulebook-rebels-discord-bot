import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'gameroles.json');

export interface GameRole {
  roleId: string;
  name: string;
}

type Store = Record<string, GameRole[]>;

function load(): Store {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Store;
}

function save(store: Store): void {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

export function getGameRoles(guildId: string): GameRole[] {
  return load()[guildId] ?? [];
}

export function addGameRole(guildId: string, role: GameRole): void {
  const store = load();
  store[guildId] = [...(store[guildId] ?? []), role];
  save(store);
}

export function removeGameRole(guildId: string, roleId: string): void {
  const store = load();
  store[guildId] = (store[guildId] ?? []).filter(r => r.roleId !== roleId);
  save(store);
}
